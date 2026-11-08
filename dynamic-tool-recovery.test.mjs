import test from 'node:test'
import assert from 'node:assert/strict'
import {ComateAuthPlugin} from './index.mjs'

const read = {type:'function', function:{name:'read', parameters:{
  type:'object', properties:{path:{type:'string'}}, required:['path'], additionalProperties:false,
}}}
const search = {type:'function', function:{name:'tool_search', parameters:{
  type:'object', properties:{query:{type:'string'}}, required:['query'], additionalProperties:false,
}}}
const todo = {type:'function', function:{name:'todo_write', parameters:{
  type:'object', properties:{action:{type:'string', enum:['list']}}, required:['action'], additionalProperties:false,
}}}
const end = {content:{type:'ANSWER', detail:{end:true}}}
const native = (name, input, id) => ({content:{type:'FUNCTION_CALL_END', detail:{toolUse:[{name,input,id}]}}})
const text = value => ({content:{type:'ANSWER', detail:{delta:value, end:true}}})

function corrected(body, calls) {
  const marker = body.systemReminder.match(/<\|MAGPIE_TOOL_CALLS:([\w-]+)\|>/)
  assert.ok(marker, 'every eligible contract correction needs an explicit text route')
  return [text(marker[0] + JSON.stringify(calls) + '<|/MAGPIE_TOOL_CALLS:' + marker[1] + '|>')]
}

async function fixture(outputs) {
  const executions = []
  const hooks = await ComateAuthPlugin({}, {fetchImpl:async(url, init) => {
    const body = JSON.parse(init.body)
    if (url.endsWith('/conversation')) return Response.json({code:0, data:{id:1}})
    if (url.endsWith('/task')) return Response.json({code:0, data:{taskId:2}})
    executions.push(body)
    const output = outputs[executions.length - 1]
    assert.ok(output, 'correction must be bounded')
    const events = typeof output === 'function' ? await output(body,init) : output
    if (events instanceof Response) return events
    return new Response(events.map(event => 'data: ' + JSON.stringify(event) + '\n\n').join(''), {
      headers:{'content-type':'text/event-stream'},
    })
  }})
  const loader = await hooks.auth.loader(async() => ({type:'api', key:'synthetic-key'}))
  const messages = [{role:'user', content:'Synthetic dynamic tool contract test'}]
  const request = (stream, tools=[read,search], extra={}) => loader.fetch('https://unused', {
    headers:{'x-magpie-comate-session':'dynamic-fixture'},
    body:JSON.stringify({model:'fixture', messages, tools, stream, ...extra}),
  })
  return {executions, messages, request}
}

async function result(response, stream) {
  assert.equal(response.status, 200)
  if (!stream) return (await response.json()).choices[0].message
  const raw = await response.text()
  const events = raw.split('\n').filter(line => line.startsWith('data: {')).map(line => JSON.parse(line.slice(6)))
  assert.ok(events.every(event => !event.error && (event.choices?.length || event.usage)))
  assert.equal(raw.split('data: [DONE]').length - 1, 1)
  const fragments = events.flatMap(event => event.choices?.[0]?.delta?.tool_calls ?? [])
  return {role:'assistant', tool_calls:fragments.length ? [{...fragments[0], function:{
    ...fragments[0].function, arguments:fragments.map(fragment => fragment.function.arguments ?? '').join(''),
  }}] : undefined}
}

for (const stream of [false,true]) test(`an unavailable native todo can recover through an offered discovery tool (stream=${stream})`, async() => {
  const f = await fixture([
    [native('todo_write', {todos:'[]'}, 'rejected-todo'), end],
    body => corrected(body, [{name:'tool_search', arguments:{query:'planning capability'}}]),
    [native('todo_write', {action:'list'}, 'now-offered'), end],
  ])
  const first = await result(await f.request(stream), stream)
  const call = first.tool_calls[0]
  assert.equal(call.function.name, 'tool_search')
  assert.deepEqual(f.executions[0].tools, f.executions[1].tools)
  assert.deepEqual(f.executions[1].tools.map(tool => tool.function.name), ['read','tool_search'])
  assert.deepEqual(f.executions[1].toolUseResults.map(item => [item.name,item.success]), [['todo_write',false]])
  f.messages.push(first, {role:'tool',tool_call_id:call.id,content:'Synthetic client discovery result'})
  const next = await result(await f.request(stream, [search,todo]), stream)
  assert.equal(next.tool_calls[0].function.name, 'todo_write')
  assert.equal(f.executions[2].isFirstQuery, true)
  assert.deepEqual(f.executions[2].toolUseResults, [])
  assert.ok(f.executions[2].query.includes(call.id))
  assert.ok(f.executions[2].query.includes('Synthetic client discovery result'))
})

for (const reverse of [false,true]) test(`mixed batches receive truthful failure feedback (reverse=${reverse})`, async() => {
  const f = await fixture([
    [...(reverse ? [native('todo_write', {todos:'[]'}, 'bad-todo'), native('read', {path:'scratch.txt'}, 'withheld-read')] : [native('read', {path:'scratch.txt'}, 'withheld-read'), native('todo_write', {todos:'[]'}, 'bad-todo')]), end],
    body => corrected(body, [{name:'read', arguments:{path:'scratch.txt'}}]),
  ])
  const first = await result(await f.request(true), true)
  assert.equal(first.tool_calls[0].function.name, 'read')
  const rejected = f.executions[1].toolUseResults
  assert.deepEqual(rejected.map(item => [item.id,item.success]), reverse ? [['bad-todo',false],['withheld-read',false]] : [['withheld-read',false],['bad-todo',false]])
  assert.match(rejected.find(item => item.id === 'withheld-read').message, /withheld|batch/i)
})

for (const calls of [
  [{name:'todo_write', arguments:{action:'list'}}],
  [{name:'tool_search', arguments:{query:'planning',undeclared:true}}],
]) test(`text recovery validates selection and schema (${calls[0].name})`, async() => {
  const f = await fixture([
    [native('todo_write', {todos:'[]'}, 'bad-todo'), end],
    body => corrected(body, calls),
  ])
  const raw = await (await f.request(true)).text()
  assert.match(raw, /"error"/)
  assert.ok(!raw.includes('"tool_calls"'))
  assert.ok(!raw.includes('"usage":'))
  assert.equal(f.executions.length, 2)
})

for (const output of ['duplicate-id','text-native-mixed','second-text-invalid']) test(`recovery rejects an ambiguous or invalid batch (${output})`, async() => {
  const correction = body => {
    const events = corrected(body, [{name:'read', arguments:{path:'scratch.txt'}}, ...(output === 'second-text-invalid' ? [{name:'tool_search', arguments:{query:'plan', extra:true}}] : [])])
    return output === 'text-native-mixed' ? [native('read', {path:'scratch.txt'}, 'also-native'), ...events] : events
  }
  const f = await fixture(output === 'duplicate-id'
    ? [[native('read', {path:'scratch.txt'}, 'same'), native('todo_write', {todos:'[]'}, 'same'), end]]
    : [[native('todo_write', {todos:'[]'}, 'bad'), end], correction])
  const raw = await (await f.request(true)).text()
  assert.match(raw, /"error"/)
  assert.ok(!raw.includes('"tool_calls"'))
  assert.ok(!raw.includes('"usage":'))
  assert.equal(f.executions.length, output === 'duplicate-id' ? 1 : 2)
})

function incomplete(body) {
  const marker = body.systemReminder.match(/<\|MAGPIE_TOOL_CALLS:[\w-]+\|>/)
  assert.ok(marker)
  return [text(marker[0] + '[{"name":"read","arguments":{"path":"scratch')]
}

for (const stream of [false,true]) for (const mode of ['text','native']) test(`one incomplete correction is regenerated atomically with real client result correlation (${mode}, stream=${stream})`, async() => {
  const f = await fixture([
    [native('todo_write', {todos:'[]'}, 'bad-todo'), end],
    incomplete,
    body => mode === 'text' ? corrected(body,[{name:'read',arguments:{path:'scratch.txt'}}]) : [native('read',{path:'scratch.txt'},'accepted-native'),end],
    [text('Synthetic result received')],
  ])
  const first = await result(await f.request(stream),stream)
  assert.equal(first.tool_calls.length,1)
  const call = first.tool_calls[0]
  assert.equal(call.function.name,'read')
  assert.deepEqual(JSON.parse(call.function.arguments),{path:'scratch.txt'})
  assert.equal(f.executions.length,3)
  const [initial,correction,repair] = f.executions
  assert.deepEqual(correction.toolUseResults.map(item=>[item.id,item.success]),[['bad-todo',false]])
  assert.deepEqual(repair.toolUseResults,[],'format rejection must not invent a native result or replay prior failures')
  assert.deepEqual(repair.tools,initial.tools)
  assert.deepEqual(repair.contexts,[])
  assert.equal(repair.conversationId,initial.conversationId)
  assert.equal(repair.taskId,initial.taskId)
  assert.equal(repair.isFirstQuery,false)
  assert.equal(JSON.parse(repair.query).role,'system')
  assert.match(JSON.parse(repair.query).content,/incomplete|format/i)
  assert.ok(!repair.query.includes('Synthetic dynamic tool contract test'))
  assert.ok(!correction.systemReminder.includes('not textual tool markers'))
  f.messages.push(first,{role:'tool',tool_call_id:call.id,content:'Synthetic actual read result'})
  await result(await f.request(stream),stream)
  const next = f.executions[3]
  if(mode==='native') assert.deepEqual(next.toolUseResults,[{id:'accepted-native',name:'read',params:{path:'scratch.txt'},success:true,message:'Synthetic actual read result'}])
  else {
    assert.equal(next.isFirstQuery,true)
    assert.deepEqual(next.toolUseResults,[])
    assert.ok(next.query.includes(call.id))
    assert.ok(next.query.includes('Synthetic actual read result'))
  }
})

for (const stream of [false,true]) test(`a second incomplete correction exhausts exactly three executes (stream=${stream})`,async()=>{
  const f = await fixture([[native('todo_write',{todos:'[]'},'bad'),end],incomplete,incomplete])
  const response = await f.request(stream)
  assert.equal(response.status,stream?200:502)
  const raw = await response.text()
  assert.match(raw,/incomplete tool call block/)
  assert.ok(!raw.includes('"tool_calls"'))
  assert.ok(!raw.includes('"usage":'))
  if(stream) {
    assert.equal(raw.split('data: [DONE]').length-1,1)
    assert.ok(!raw.includes('"finish_reason":"stop"'))
  }
  assert.equal(f.executions.length,3)
})

test('an incomplete text response with a pending native call cannot be regenerated or silently discarded',async()=>{
  const f=await fixture([[native('todo_write',{todos:'[]'},'bad'),end],body=>[native('read',{path:'scratch.txt'},'pending'),...incomplete(body)]])
  const raw=await(await f.request(true)).text()
  assert.match(raw,/"error"/)
  assert.ok(!raw.includes('"tool_calls"'))
  assert.equal(f.executions.length,2)
})

test('the final formatting attempt still rejects unoffered tools and fails closed',async()=>{
  const f=await fixture([[native('todo_write',{todos:'[]'},'bad'),end],incomplete,body=>corrected(body,[{name:'todo_write',arguments:{action:'list'}}])])
  const raw=await(await f.request(true)).text()
  assert.match(raw,/tool name was not offered/)
  assert.ok(!raw.includes('"tool_calls"'))
  assert.ok(!raw.includes('"usage":'))
  assert.equal(f.executions.length,3)
})

for(const [label,last,extra] of [
  ['schema',body=>corrected(body,[{name:'read',arguments:{path:'scratch.txt',extra:true}}]),{}],
  ['choice',body=>corrected(body,[{name:'tool_search',arguments:{query:'read'}}]),{tool_choice:{type:'function',function:{name:'read'}}}],
  ['parallel',body=>corrected(body,[{name:'read',arguments:{path:'scratch.txt'}},{name:'tool_search',arguments:{query:'read'}}]),{parallel_tool_calls:false}],
  ['native execution',()=>[{content:{type:'TOOL',detail:{}}}],{}],
  ['network',()=>new Response('',{status:500}),{}],
]) test(`the final formatting turn preserves ${label} failure and never retries`,async()=>{
  const f=await fixture([[native('todo_write',{todos:'[]'},'bad'),end],incomplete,last])
  const raw=await(await f.request(true,[read,search],extra)).text()
  assert.match(raw,/"error"/)
  assert.ok(!raw.includes('"tool_calls"'))
  assert.ok(!raw.includes('"usage":'))
  assert.equal(f.executions.length,3)
})

test('an unterminated upstream stream is not a completed response eligible for formatting regeneration',async()=>{
  const f=await fixture([[native('todo_write',{todos:'[]'},'bad'),end],body=>{
    const events=incomplete(body)
    events[0].content.detail.end=false
    return events
  }])
  const raw=await(await f.request(true)).text()
  assert.match(raw,/stream ended before its completion event/)
  assert.ok(!raw.includes('"tool_calls"'))
  assert.equal(f.executions.length,2)
})

test('cancellation aborts the final formatting turn and releases the native session',async()=>{
  let entered,finalSignal
  const ready=new Promise(resolve=>{entered=resolve})
  const f=await fixture([
    [native('todo_write',{todos:'[]'},'bad'),end],incomplete,
    (_,init)=>new Promise((resolve,reject)=>{
      finalSignal=init.signal;entered()
      init.signal.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError')),{once:true})
    }),
    [text('Fresh synthetic request')],
  ])
  const response=await f.request(true),reader=response.body.getReader()
  await reader.read()
  const pending=reader.read().catch(()=>{})
  await ready
  await reader.cancel();await pending
  assert.equal(finalSignal.aborted,true)
  assert.equal(f.executions.length,3)
  await result(await f.request(false),false)
  assert.equal(f.executions[3].isFirstQuery,true)
})

function diagnosticsOf(raw,stream) {
  const error = stream ? raw.split('\n').filter(line=>line.startsWith('data: {')).map(line=>JSON.parse(line.slice(6))).find(event=>event.error)?.error : JSON.parse(raw).error
  assert.ok(error)
  const marker = ' [comate_diagnostics='
  const start = error.message.lastIndexOf(marker)
  assert.ok(start>=0,'failure must expose safe bounded turn diagnostics')
  return {error,diagnostics:JSON.parse(error.message.slice(start+marker.length,-1))}
}

test('correction uses only client names and sends one schema contract instead of duplicate alias contracts',async()=>{
  const largeSchema={...read,function:{...read.function,description:'Synthetic description '.repeat(500)}}
  const f=await fixture([[native('todo_write',{todos:'[]'},'bad'),end],body=>corrected(body,[{name:'read',arguments:{path:'scratch.txt'}}])])
  await result(await f.request(false,[largeSchema,search]),false)
  const correction=f.executions[1]
  assert.ok(!correction.systemReminder.includes('comate_client_'))
  assert.equal(correction.systemReminder.split('Client tool contract (JSON):').length-1,1)
  assert.ok(!correction.systemReminder.includes('Available function tools (JSON):'))
  assert.ok(correction.toolUseResults[0].message.length<2000)
  assert.match(correction.systemReminder,/smallest complete next call/)
  assert.deepEqual(correction.tools,f.executions[0].tools)
})

for(const stream of [false,true]) test(`exhausted recovery exposes per-turn counts without any argument, reasoning or marker values (stream=${stream})`,async()=>{
  const privateValue='SYNTHETIC_CONTENT_NEVER_IN_DIAGNOSTICS'
  const malformed=body=>{
    const marker=body.systemReminder.match(/<\|MAGPIE_TOOL_CALLS:[\w-]+\|>/)[0]
    return [{content:{type:'ANSWER',detail:{reasoningDelta:privateValue,delta:marker+'[{"name":"read","arguments":{"path":"'+privateValue,finish_reason:'length',end:true}}}]
  }
  const f=await fixture([[native('todo_write',{todos:privateValue},'bad-private-id'),end],malformed,malformed])
  const raw=await(await f.request(stream,[read,search],{max_tokens:16384})).text()
  const {error,diagnostics:d}=diagnosticsOf(raw,stream)
  assert.equal(d.version,1)
  assert.equal(d.execute_attempts,3)
  assert.equal(d.max_executes,3)
  assert.equal(d.format_regenerations,1)
  assert.equal(d.client_max_tokens,16384)
  assert.equal(d.client_output_limit_forwarded,false)
  assert.equal(d.turns.length,3)
  assert.deepEqual(d.turns.map(turn=>turn.phase),['initial','contract_correction','format_regeneration'])
  assert.deepEqual(d.turns.map(turn=>turn.terminal_answer),[true,true,true])
  assert.equal(d.turns[0].native_calls,1)
  assert.equal(d.turns[0].rejected_calls,1)
  assert.equal(d.turns[2].provider_stop,'output_limit')
  assert.equal(d.turns[2].block.start_markers,1)
  assert.equal(d.turns[2].block.closing_markers,0)
  assert.equal(d.turns[2].block.json_syntax,'invalid_or_truncated')
  assert.ok(d.turns[2].answer_chars>privateValue.length)
  assert.equal(d.turns[2].reasoning_chars,privateValue.length)
  for(const value of [privateValue,'bad-private-id','MAGPIE_TOOL_CALLS:','comate_client_']) assert.ok(!error.message.includes(value))
  assert.ok(JSON.stringify(d).length<4000)
  assert.ok(!raw.includes('"tool_calls"'))
  assert.ok(!raw.includes('"usage":'))
})

test('an unreported provider stop remains unknown, while a missing delimiter with complete JSON is distinguishable',async()=>{
  const missingClose=body=>[text(body.systemReminder.match(/<\|MAGPIE_TOOL_CALLS:[\w-]+\|>/)[0]+'[{"name":"read","arguments":{"path":"scratch.txt"}}]')]
  const f=await fixture([[native('todo_write',{todos:'[]'},'bad'),end],missingClose,missingClose])
  const {diagnostics:d}=diagnosticsOf(await(await f.request(true)).text(),true)
  assert.equal(d.turns[2].provider_stop,'not_reported')
  assert.equal(d.turns[2].block.json_syntax,'complete')
  assert.equal(d.turns[2].block.closing_markers,0)
  assert.equal(f.executions.length,3,'observability must not add executes or guess missing delimiters')
})

test('diagnostics distinguish a different closing marker without echoing it or unknown provider metadata',async()=>{
  const wrong=body=>[{
    content:{type:'ANSWER',detail:{delta:body.systemReminder.match(/<\|MAGPIE_TOOL_CALLS:[\w-]+\|>/)[0]+'[{"name":"read","arguments":{"path":"scratch.txt"}}]<|/MAGPIE_TOOL_CALLS:OTHER_PRIVATE_NONCE|>',finish_reason:'UNKNOWN_PRIVATE_METADATA',end:true}},
  }]
  const f=await fixture([[native('todo_write',{todos:'[]'},'bad'),end],wrong,wrong])
  const {error,diagnostics:d}=diagnosticsOf(await(await f.request(true)).text(),true)
  assert.equal(d.turns[2].block.other_closing_markers,1)
  assert.equal(d.turns[2].block.closing_markers,0)
  assert.equal(d.turns[2].provider_stop,'not_reported')
  assert.ok(!error.message.includes('OTHER_PRIVATE_NONCE'))
  assert.ok(!error.message.includes('UNKNOWN_PRIVATE_METADATA'))
  assert.equal(d.execute_attempts,3)
})

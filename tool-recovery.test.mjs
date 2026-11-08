import test from 'node:test'
import assert from 'node:assert/strict'
import {ComateAuthPlugin} from './index.mjs'

// Synthetic protocol fixtures only; no user requests or evaluation artifacts.
const tools = [
  {type:'function',function:{name:'read',parameters:{type:'object',properties:{path:{type:'string'},offset:{type:'integer'},limit:{type:'integer'}},required:['path'],additionalProperties:false}}},
  {type:'function',function:{name:'bash',parameters:{type:'object',properties:{command:{type:'string'},timeout_ms:{type:'integer'}},required:['command'],additionalProperties:false}}},
]
const nativeInput = {target_file:'scratch/obsolete.txt'}
const call = (name, input=nativeInput, id='rejected-native') => ({content:{type:'FUNCTION_CALL_END',detail:{toolUse:[{id,name,input}]}}})
const done = {content:{type:'ANSWER',detail:{end:true}}}
const answer = text => [{content:{type:'ANSWER',detail:{delta:text,end:true}}}]
const sse = events => new Response(events.map(event=>'data: '+JSON.stringify(event)+'\n\n').join(''),{headers:{'content-type':'text/event-stream'}})

async function fixture(replies) {
  const calls=[]
  const hooks=await ComateAuthPlugin({}, {fetchImpl:async(url,init)=>{
    assert.equal(new URL(url).origin,'https://comate.baidu.com')
    const body=JSON.parse(init.body);calls.push({url,body,signal:init.signal})
    if(url.endsWith('/conversation'))return Response.json({code:0,data:{id:1}})
    if(url.endsWith('/task'))return Response.json({code:0,data:{taskId:2}})
    if(url.endsWith('/upload'))return Response.json({code:0,data:{id:3,url:'https://comate.baidu.com/synthetic-image'}})
    const index=calls.filter(call=>call.url.endsWith('/execute')).length-1
    const value=await replies[index]?.(body,init)
    assert.ok(value,'unexpected additional cloud execute')
    return value instanceof Response?value:sse(value)
  }})
  const loader=await hooks.auth.loader(async()=>({type:'api',key:'synthetic-license'}))
  const request=(messages=[{role:'user',content:'Inspect scratch'}],extra={},signal)=>loader.fetch('https://unused/v1/chat/completions',{
    headers:{'x-magpie-comate-session':'recovery-fixture'},signal,
    body:JSON.stringify({model:'synthetic',messages,tools,...extra}),
  })
  return {request,calls,executions:()=>calls.filter(call=>call.url.endsWith('/execute')).map(call=>call.body)}
}

async function message(response,stream) {
  assert.equal(response.status,200)
  if(!stream)return (await response.json()).choices[0].message
  const text=await response.text(),frames=text.split('\n').filter(line=>line.startsWith('data: ')).map(line=>line.slice(6))
  assert.equal(frames.filter(frame=>frame==='[DONE]').length,1)
  const events=frames.filter(frame=>frame!=='[DONE]').map(JSON.parse)
  assert.ok(events.every(event=>!event.error&&(event.choices?.length||event.usage)),'successful strict OpenAI stream has only choices/usage events')
  assert.equal(events.filter(event=>event.usage).length,1)
  const deltas=events.flatMap(event=>event.choices?.[0]?.delta?.tool_calls??[])
  return {role:'assistant',tool_calls:deltas.length?[{...deltas[0],function:{...deltas[0].function,arguments:deltas.map(delta=>delta.function.arguments??'').join('')}}]:undefined,content:events.map(event=>event.choices?.[0]?.delta?.content??'').join('')}
}

async function failure(response,stream,pattern) {
  assert.equal(response.status,stream?200:502)
  const text=await response.text();assert.match(text,pattern)
  if(stream) {
    const events=text.split('\n').filter(line=>line.startsWith('data: {')).map(line=>JSON.parse(line.slice(6)))
    assert.equal(events.filter(event=>event.error).length,1)
    assert.ok(events.every(event=>!event.usage&&!event.choices?.some(choice=>choice.finish_reason)))
    assert.equal(text.split('data: [DONE]').length-1,1)
  }
}

for(const stream of [false,true])for(const isError of [false,true])test(`unknown delete_file becomes one real validation failure, then only an offered read reaches client (stream=${stream}, clientError=${isError})`,async()=>{
  const f=await fixture([
    ()=>[call('delete_file'),done],
    ()=>[call('read_file',{target_file:'scratch/keep.txt'},'accepted-native'),done],
    ()=>answer('continued from the actual client result'),
  ])
  const messages=[{role:'user',content:'Inspect scratch'}]
  const first=await message(await f.request(messages,{stream}),stream)
  assert.equal(first.tool_calls.length,1);const clientCall=first.tool_calls[0]
  assert.equal(clientCall.function.name,'read');assert.deepEqual(JSON.parse(clientCall.function.arguments),{path:'scratch/keep.txt'})
  const [initial,corrected]=f.executions()
  assert.deepEqual(corrected.toolUseResults,[{id:'rejected-native',name:'delete_file',params:nativeInput,success:false,message:corrected.toolUseResults[0].message}])
  assert.match(corrected.toolUseResults[0].message,/Validation rejected this call before execution; no client tool ran/)
  assert.match(corrected.toolUseResults[0].message,/Available client function names: \["bash","read"\]/)
  assert.equal(corrected.query,'');assert.deepEqual(corrected.contexts,[]);assert.equal(corrected.isFirstQuery,false);assert.equal(corrected.isUserQuery,false)
  assert.equal(corrected.conversationId,initial.conversationId);assert.equal(corrected.taskId,initial.taskId);assert.deepEqual(corrected.tools,initial.tools)
  assert.deepEqual(corrected.tools.map(tool=>tool.function.name),['read','bash'])
  messages.push(first,{role:'tool',tool_call_id:clientCall.id,content:'actual client boundary result',isError})
  await message(await f.request(messages,{stream}),stream)
  assert.deepEqual(f.executions()[2].toolUseResults,[{id:'accepted-native',name:'read_file',params:{target_file:'scratch/keep.txt'},success:!isError,message:'actual client boundary result'}])
  assert.equal(f.calls.filter(call=>call.url.endsWith('/task')).length,1)
})

for(const stream of [false,true])test(`a repeated unoffered function fails after exactly one correction (stream=${stream})`,async()=>{
  const f=await fixture([()=>[call('delete_file'),done],()=>[call('delete_file'),done]])
  await failure(await f.request(undefined,{stream}),stream,/client did not offer: delete_file/)
  assert.equal(f.executions().length,2)
})

for(const stream of [false,true])test(`native glob_path may be corrected to a declared find without guessing glob-to-find semantics (stream=${stream})`,async()=>{
  const find={type:'function',function:{name:'find',parameters:{type:'object',properties:{path:{type:'string'},pattern:{type:'string'},max_depth:{type:'integer'}},additionalProperties:false}}}
  const native={target_directory:'scratch',glob_pattern:'**/*.txt'}
  const correctedInput={path:'scratch',pattern:'*.txt',max_depth:2}
  const f=await fixture([()=>[call('glob_path',native),done],()=>[call('find',correctedInput,'accepted-find'),done]])
  const result=await message(await f.request(undefined,{stream,tools:[...tools,find]}),stream)
  assert.equal(result.tool_calls[0].function.name,'find')
  assert.deepEqual(JSON.parse(result.tool_calls[0].function.arguments),correctedInput)
  const correction=f.executions()[1]
  assert.equal(correction.toolUseResults[0].name,'glob_path')
  assert.deepEqual(correction.toolUseResults[0].params,native)
  assert.equal(correction.toolUseResults[0].success,false)
  assert.deepEqual(correction.tools.map(tool=>tool.function.name),['read','bash','find'])
})

for(const [label,events,extra] of [
  ['none',[call('delete_file'),done],{tool_choice:'none'}],
  ['no tools',[call('delete_file'),done],{tools:[]}],
  ['incomplete cloud turn',[call('delete_file')],{}],
  ['native server execution',[{content:{type:'TOOL',detail:{}}}],{}],
  ['parallel violation',[call('delete_file',nativeInput,'a'),call('unknown_tool',{},'b'),done],{parallel_tool_calls:false}],
])test(`${label} remains an explicit error without a correction or client execution`,async()=>{
  const f=await fixture([()=>events]);await failure(await f.request(undefined,{stream:true,...extra}),true,/error/);assert.equal(f.executions().length,1)
})

test('a repeated mixed batch fails after one correction without leaking the valid pending call',async()=>{
  const batch=()=>[call('read',{path:'scratch/keep.txt'},'valid'),call('delete_file'),done]
  const f=await fixture([batch,batch])
  const response=await f.request(undefined,{stream:true}),raw=await response.text()
  assert.match(raw,/client did not offer: delete_file/)
  assert.ok(!raw.includes('"tool_calls"'))
  assert.equal(f.executions().length,2)
  assert.deepEqual(f.executions()[1].toolUseResults.map(result=>[result.id,result.success]),[['valid',false],['rejected-native',false]])
})

test('malformed offered arguments remain a named contract failure after one bounded correction',async()=>{
  const invalid=()=>[call('read',{},'invalid-arguments'),done]
  const f=await fixture([invalid,invalid])
  await failure(await f.request(undefined,{stream:true}),true,/Comate tool.*read.*rejected arguments/)
  assert.equal(f.executions().length,2)
  assert.equal(f.executions()[1].toolUseResults[0].success,false)
})

test('named tool selection remains enforced after correction',async()=>{
  const f=await fixture([()=>[call('delete_file'),done],()=>[call('bash',{command:'printf synthetic'},'wrong-name'),done]])
  await failure(await f.request(undefined,{stream:true,tool_choice:{type:'function',function:{name:'read'}}}),true,/does not match tool_choice/)
  assert.match(f.executions()[1].toolUseResults[0].message,/Available client function names: \["read"\]/)
})

test('auto choice may honestly explain unavailable capability, while required still requires a valid call',async()=>{
  const f=await fixture([()=>[call('delete_file'),done],()=>answer('No file was deleted; this operation is unavailable.')])
  assert.match((await message(await f.request(undefined,{stream:true}),true)).content,/No file was deleted/)
  const required=await fixture([()=>[call('delete_file'),done],()=>answer('I cannot perform this operation')])
  await failure(await required.request(undefined,{stream:true,tool_choice:'required'}),true,/required tool call/)
})

test('cloud failures during correction are not retried or turned into success',async()=>{
  const f=await fixture([()=>[call('delete_file'),done],()=>new Response('',{status:500})])
  await failure(await f.request(undefined,{stream:true}),true,/Comate cloud HTTP 500/)
  assert.equal(f.executions().length,2)
})

test('correction never replays previous actual tool results or reuploads input images',async()=>{
  const f=await fixture([
    ()=>[call('read',{path:'scratch/keep.txt'},'first-read'),done],
    ()=>[call('delete_file'),done],
    ()=>answer('No file was deleted'),
  ])
  const messages=[{role:'user',content:[{type:'text',text:'Inspect scratch'},{type:'image_url',image_url:{url:'data:image/png;base64,aW1hZ2U='}}]}]
  const first=await message(await f.request(messages),false)
  messages.push(first,{role:'tool',tool_call_id:first.tool_calls[0].id,content:'actual previous read'})
  await message(await f.request(messages,{stream:true}),true)
  assert.equal(f.executions()[1].toolUseResults[0].message,'actual previous read')
  assert.deepEqual(f.executions()[2].toolUseResults.map(result=>result.name),['delete_file'])
  assert.deepEqual(f.executions()[2].contexts,[]);assert.equal(f.executions()[2].query,'')
  assert.equal(f.calls.filter(call=>call.url.endsWith('/upload')).length,1)
})

test('ordinary successful streams make no correction request',async()=>{
  const f=await fixture([()=>answer('ordinary success')])
  assert.equal((await message(await f.request(undefined,{stream:true}),true)).content,'ordinary success')
  assert.equal(f.executions().length,1)
})

test('failed correction evicts native state and releases the session for a fresh request',async()=>{
  const f=await fixture([()=>[call('delete_file'),done],()=>[call('delete_file'),done],()=>answer('fresh request')])
  await failure(await f.request(undefined,{stream:true}),true,/delete_file/)
  assert.equal((await message(await f.request(undefined,{stream:true}),true)).content,'fresh request')
  assert.equal(f.executions()[2].isFirstQuery,true)
  assert.equal(f.calls.filter(call=>call.url.endsWith('/task')).length,2)
})

test('client cancellation aborts the in-flight correction and never starts another attempt',async()=>{
  let entered,signal
  const ready=new Promise(resolve=>{entered=resolve})
  const f=await fixture([
    ()=>[call('delete_file'),done],
    (_,init)=>new Promise((resolve,reject)=>{
      signal=init.signal;entered()
      signal.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError')),{once:true})
    }),
    ()=>answer('fresh after cancellation'),
  ])
  const response=await f.request(undefined,{stream:true}),reader=response.body.getReader()
  await reader.read()
  const pending=reader.read().catch(()=>{})
  await ready;await reader.cancel();await pending
  assert.equal(signal.aborted,true);assert.equal(f.executions().length,2)
  assert.equal((await message(await f.request(undefined,{stream:true}),true)).content,'fresh after cancellation')
  assert.equal(f.executions()[2].isFirstQuery,true)
})

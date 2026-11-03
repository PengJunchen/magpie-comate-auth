import test from 'node:test'
import assert from 'node:assert/strict'
import {ComateAuthPlugin} from './index.mjs'
import {define,contracts,mappingCases} from './tool-contracts.fixture.mjs'

const call=(name,input,id)=>({content:{type:'FUNCTION_CALL_END',detail:{toolUse:[{name,input,id}]}}})
const done={content:{type:'ANSWER',detail:{end:true}}}
const answer=[{content:{type:'ANSWER',detail:{delta:'synthetic fixture complete',end:true}}}]
async function fixture(outputs,tools=contracts) {
  const executions=[]
  const hooks=await ComateAuthPlugin({}, {fetchImpl:async(url,init)=>{
    const body=JSON.parse(init.body)
    if(url.endsWith('/conversation'))return Response.json({code:0,data:{id:1}})
    if(url.endsWith('/task'))return Response.json({code:0,data:{taskId:2}})
    executions.push(body)
    const output=outputs[executions.length-1]
    const events=typeof output==='function'?output(body):output;assert.ok(events,'unexpected extra correction')
    return new Response(events.map(event=>'data: '+JSON.stringify(event)+'\n\n').join(''),{headers:{'content-type':'text/event-stream'}})
  }})
  const loader=await hooks.auth.loader(async()=>({type:'api',key:'synthetic-argument-license'}))
  const messages=[{role:'user',content:'synthetic contract test'}]
  const request=stream=>loader.fetch('https://unused',{headers:{'x-magpie-comate-session':'argument-matrix'},body:JSON.stringify({model:'synthetic',messages,tools,stream})})
  return {executions,messages,request}
}
async function readMessage(response,stream) {
  assert.equal(response.status,200)
  if(!stream)return (await response.json()).choices[0].message
  const raw=await response.text()
  const events=raw.split('\n').filter(line=>line.startsWith('data: {')).map(line=>JSON.parse(line.slice(6)))
  assert.ok(events.every(event=>!event.error&&(event.choices?.length||event.usage)))
  assert.equal(events.filter(event=>event.usage).length,1)
  assert.equal(raw.split('data: [DONE]').length-1,1)
  const parts=events.flatMap(event=>event.choices?.[0]?.delta?.tool_calls??[])
  return {role:'assistant',tool_calls:parts.length?[{...parts[0],function:{...parts[0].function,arguments:parts.map(part=>part.function.arguments??'').join('')}}]:undefined}
}

for(const [name,input,expected] of mappingCases)for(const stream of [false,true]) {
  test(`${name} aliases complete a native/client result round trip (stream=${stream})`,async()=>{
    const f=await fixture([[call(name,input,'native-valid'),done],answer])
    const first=await readMessage(await f.request(stream),stream),client=first.tool_calls[0]
    assert.equal(client.function.name,name);assert.deepEqual(JSON.parse(client.function.arguments),expected)
    assert.equal(f.executions.length,1)
    f.messages.push(first,{role:'tool',tool_call_id:client.id,content:'SYNTHETIC_CLIENT_RESULT',isError:true})
    await readMessage(await f.request(stream),stream)
    assert.deepEqual(f.executions[1].toolUseResults,[{id:'native-valid',name,params:input,success:false,message:'SYNTHETIC_CLIENT_RESULT'}])
  })
  test(`${name} rejects an undeclared parameter before one model correction (stream=${stream})`,async()=>{
    const invalid={...input,unknown_option:'REJECTED_PRIVATE_VALUE'}
    const f=await fixture([[call(name,invalid,'native-rejected'),done],[call(name,expected,'native-corrected'),done],answer])
    const first=await readMessage(await f.request(stream),stream),client=first.tool_calls[0]
    assert.deepEqual(JSON.parse(client.function.arguments),expected);assert.equal(f.executions.length,2)
    const result=f.executions[1].toolUseResults[0]
    assert.equal(result.name,name);assert.equal(result.id,'native-rejected');assert.equal(result.success,false)
    assert.deepEqual(result.params,invalid)
    assert.match(result.message,new RegExp('Comate tool "'+name+'" rejected arguments'))
    assert.ok(!result.message.includes('REJECTED_PRIVATE_VALUE'))
    assert.deepEqual(f.executions[1].tools,f.executions[0].tools)
    assert.equal(f.executions[1].query,'');assert.deepEqual(f.executions[1].contexts,[])
    f.messages.push(first,{role:'tool',tool_call_id:client.id,content:'SYNTHETIC_CLIENT_RESULT',isError:true})
    await readMessage(await f.request(stream),stream)
    assert.deepEqual(f.executions[2].toolUseResults,[{id:'native-corrected',name,params:expected,success:false,message:'SYNTHETIC_CLIENT_RESULT'}])
  })
}

test('the exact undeclared target_directory error is returned with the tool name and corrected, not permitted',async()=>{
  const tools=[define('custom_list',{path:{type:'string'}})]
  const f=await fixture([[call('custom_list',{target_directory:'scratch'},'bad'),done],[call('custom_list',{path:'scratch'},'good'),done]],tools)
  const first=await readMessage(await f.request(true),true)
  assert.deepEqual(JSON.parse(first.tool_calls[0].function.arguments),{path:'scratch'})
  assert.match(f.executions[1].toolUseResults[0].message,/Comate tool "custom_list" rejected arguments: Tool arguments \$\.target_directory: undeclared field/)
  assert.equal(f.executions[1].toolUseResults[0].success,false)
  assert.equal(f.executions[1].tools[0].function.parameters.additionalProperties,false)
  assert.match(f.executions[0].systemReminder,/Client tool contract \(JSON\):/)
  const visible=JSON.parse(f.executions[0].systemReminder.split('Client tool contract (JSON): ')[1])
  assert.deepEqual(visible.functions,[{name:'custom_list',parameters:tools[0].function.parameters}])
  assert.ok(!f.executions[0].systemReminder.includes('Do not invent functions or use Comate built-in tools'))
})

for(const order of ['name-then-arguments','arguments-then-name'])test(`unknown names and argument errors share one total correction budget (${order})`,async()=>{
  const unknown=call('unoffered_tool',{},'unknown'),invalid=call('ls',{all:'not JSON'},'invalid')
  const outputs=order==='name-then-arguments'?[[unknown,done],[invalid,done]]:[[invalid,done],[unknown,done]]
  const f=await fixture(outputs),response=await f.request(true),raw=await response.text()
  assert.match(raw,/"error"/);assert.ok(!raw.includes('"finish_reason":"stop"'));assert.ok(!raw.includes('"usage":'))
  assert.equal(f.executions.length,2);assert.equal(raw.split('data: [DONE]').length-1,1)
})

test('mixed valid and argument-invalid calls fail atomically before any client call or correction',async()=>{
  const f=await fixture([[call('read',{path:'scratch/file'},'valid'),call('ls',{all:'not JSON'},'invalid'),done]])
  const raw=await (await f.request(true)).text()
  assert.match(raw,/"error"/);assert.ok(!raw.includes('"tool_calls"'))
  assert.ok(!raw.includes('"usage":'));assert.equal(f.executions.length,1)
})

const actionTodo = define('todo_write', {
  action: {type:'string', enum:['add','update','list','remove']},
  content: {type:'string'}, id: {type:'string'}, status: {type:'string'}, priority: {type:'string'},
}, ['action'])
const nativeTodo = [call('todo_write',{todos:'[{"content":"Synthetic item","status":"pending"}]'},'native-batch'),done]

function todoBlock(body, calls) {
  const marker = body.systemReminder.match(/<\|MAGPIE_TOOL_CALLS:([\w-]+)\|>/)
  assert.ok(marker)
  return [{content:{type:'ANSWER',detail:{delta:marker[0]+JSON.stringify(calls)+'<|/MAGPIE_TOOL_CALLS:'+marker[1]+'|>',end:true}}}]
}

for(const stream of [false,true])test(`native todo array corrects to one client action with actual result replay (stream=${stream})`,async()=>{
  const args={action:'add',content:'Synthetic item',status:'pending'}
  const f=await fixture([nativeTodo,body=>todoBlock(body,[{name:'todo_write',arguments:args}]),answer],[actionTodo])
  const first=await readMessage(await f.request(stream),stream)
  const client=first.tool_calls[0]
  assert.equal(client.function.name,'todo_write')
  assert.deepEqual(JSON.parse(client.function.arguments),args)
  assert.equal(f.executions[1].toolUseResults[0].success,false)
  assert.equal(f.executions[1].toolUseResults[0].id,'native-batch')
  assert.deepEqual(f.executions[0].tools,f.executions[1].tools)
  f.messages.push(first,{role:'tool',tool_call_id:client.id,content:'ACTUAL_CLIENT_RESULT'})
  await readMessage(await f.request(stream),stream)
  assert.equal(f.executions[2].isFirstQuery,true)
  assert.deepEqual(f.executions[2].toolUseResults,[])
  assert.ok(f.executions[2].query.includes('ACTUAL_CLIENT_RESULT'))
  assert.ok(f.executions[2].query.includes(client.id))
})

test('todo correction rejects invalid or extra fields and multiple actions without another attempt',async()=>{
  for(const calls of [
    [{name:'todo_write',arguments:{action:'invented'}}],
    [{name:'todo_write',arguments:{action:'list',todos:[]}}],
    [{name:'todo_write',arguments:{action:'list'}},{name:'todo_write',arguments:{action:'list'}}],
  ]) {
    const f=await fixture([nativeTodo,body=>todoBlock(body,calls)],[actionTodo])
    const raw=await (await f.request(true)).text()
    assert.match(raw,/"error"/)
    assert.ok(!raw.includes('"tool_calls"'))
    assert.equal(f.executions.length,2)
  }
})

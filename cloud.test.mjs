import test from 'node:test'
import assert from 'node:assert/strict'
import { ComateAuthPlugin } from './index.mjs'
const auth = { type:'api', key:'test-secret', metadata:{source:'comate-paste'} }
const answer = (detail) => ({content:{type:'ANSWER',detail}})
const event = (type, input={}, name='echo') => ({content:{type,detail:{toolUse:[{id:'native-1', name, input}]}}})
const sse = (items) => new Response(items.map(x=>'data: '+JSON.stringify(x)+'\n\n').join(''),{headers:{'content-type':'text/event-stream'}})
async function setup(output, custom) {
  const calls=[]
  const fetchImpl=async(url,init)=>{
    calls.push({url,init,body:JSON.parse(init.body)})
    assert.ok(url.startsWith('https://comate.baidu.com/'), 'never contact local desktop')
    assert.equal(init.redirect,'error')
    if(custom){const r=await custom(url,init);if(r)return r}
    if(url.endsWith('/available'))return Response.json({code:0,data:[{modelId:'live-model',modelType:'alias',displayName:'Live',supportThinking:true}]})
    if(url.endsWith('/conversation'))return Response.json({code:0,data:{id:calls.length}})
    if(url.endsWith('/task'))return Response.json({code:0,data:{taskId:calls.length}})
    return sse(typeof output==='function'?output(calls.at(-1).body):output)
  }
  const hooks=await ComateAuthPlugin({}, {fetchImpl,timeoutMs:2000})
  const loader=await hooks.auth.loader(async()=>auth)
  const fetchChat=chat=>loader.fetch('https://unused/v1/chat/completions',{body:JSON.stringify({model:'live-model',messages:[{role:'user',content:'hello'}],...chat})})
  return {hooks,calls,fetchChat}
}
const tools=[{type:'function',function:{name:'echo',parameters:{type:'object',properties:{text:{type:'string'}}}}}]
test('cloud live catalog and alias resolution keep our capability projection',async()=>{
 const x=await setup([answer({delta:'ok',end:true})]);const models=await x.hooks.provider.models({id:'comate',models:{}},{auth});assert.equal(models['live-model'].capabilities.reasoning,true);await x.fetchChat({model:'comate/alias'});assert.equal(x.calls.at(-1).body.modelKey,'live-model')
})
for(const stream of [false,true])test(`cloud tool call fragments round trip through our parser (stream=${stream})`,async()=>{
 const x=await setup(body=>{const name=body.tools[0].function.name;return [event('FUNCTION_CALL_START',{text:'first'},name),event('FUNCTION_CALL_PARAMS_APPEND',{text:' second'},name),event('FUNCTION_CALL_END',{},name),answer({end:true})]});const r=await x.fetchChat({tools,tool_choice:'required',stream});assert.equal(r.status,200);const text=await r.text();assert.match(text,/echo/);assert.match(text,/first second/);assert.doesNotMatch(text,/comate_client_/)
})
test('full transcript replay carries client tool result on the next independent cloud turn',async()=>{
 const x=await setup([answer({delta:'ok',end:true})]);await x.fetchChat({});await x.fetchChat({messages:[{role:'user',content:'read'},{role:'assistant',tool_calls:[{id:'call1',type:'function',function:{name:'echo',arguments:'{}'}}]},{role:'tool',tool_call_id:'call1',content:'fresh challenge'}]});const executions=x.calls.filter(c=>c.url.endsWith('/execute'));assert.notEqual(executions[0].body.conversationId,executions[1].body.conversationId);assert.match(executions[1].body.query,/fresh challenge/);assert.match(executions[1].body.query,/call1/)
})
for(const status of [401,403,429,500])test(`cloud HTTP ${status} never falls back or retries mutation`,async()=>{
 const x=await setup([],()=>new Response('',{status}));const r=await x.fetchChat({});assert.equal(r.status,[401,403].includes(status)?401:502);assert.equal(x.calls.length,1)
})
for(const output of [[{content:{type:'TOOL',detail:{}}}],[event('FUNCTION_CALL_START'),answer({end:true})],[event('FUNCTION_CALL_END',{},'unoffered'),answer({end:true})],[],[{content:{type:'EXCEPTION'}}]])test(`bad cloud output fails closed: ${JSON.stringify(output)}`,async()=>{
 const x=await setup(output);const r=await x.fetchChat({tools});assert.equal(r.status,502)
})
test('strict tools still reject before any cloud network call',async()=>{
 const x=await setup([]);const r=await x.fetchChat({tools:[{type:'function',function:{name:'x',strict:true}}]});assert.equal(r.status,400);assert.equal(x.calls.length,0)
})
test('required choice rejects prose and none rejects native calls',async()=>{
 const x=await setup([answer({delta:'prose',end:true})]);assert.equal((await x.fetchChat({tools,tool_choice:'required'})).status,502)
 const y=await setup([event('FUNCTION_CALL_END'),answer({end:true})]);assert.equal((await y.fetchChat({tools,tool_choice:'none'})).status,502)
})
test('non-SSE and redirects do not become successful replies',async()=>{
 const x=await setup([],url=>url.endsWith('/execute')?Response.json({ok:true}):null);assert.equal((await x.fetchChat({})).status,502)
})
test('quota failures stay errors in a streaming completion',async()=>{
 const x=await setup([{content:{type:'QUOTA_EXCEED'}}]);const text=await(await x.fetchChat({stream:true})).text();assert.match(text,/error/);assert.doesNotMatch(text,/"finish_reason":"stop"/)
})
test('empty successful terminal is an error',async()=>{const x=await setup([answer({end:true})]);assert.equal((await x.fetchChat({})).status,502)})
test('cloud model aliases isolate accounts and plugin instances',async()=>{
 const fetchImpl=async(url,init)=>{const license=decodeURIComponent(init.headers['login-name']);return Response.json({code:0,data:[{modelId:license+'-model',modelType:'same'}]})}
 const hooks=await ComateAuthPlugin({}, {fetchImpl});const other=await ComateAuthPlugin({}, {fetchImpl});
 for(const key of ['account-a','account-b']){const models=await hooks.provider.models({id:'comate',models:{}},{auth:{type:'api',key}});assert.ok(models[key+'-model'])}
 const cfg={};await other.config(cfg);assert.deepEqual(cfg.provider.comate.models,{})
})
test('caller abort reaches the cloud fetch without a desktop cancel request',async()=>{
 const x=await setup([],async(url,init)=>{if(url.endsWith('/execute'))return await new Promise((resolve,reject)=>init.signal.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError')),{once:true}))})
 const controller=new AbortController();const loader=await x.hooks.auth.loader(async()=>auth);const result=loader.fetch('https://unused',{body:JSON.stringify({model:'live',messages:[{role:'user',content:'hello'}]}),signal:controller.signal});setTimeout(()=>controller.abort(),10);await assert.rejects(result,{name:'AbortError'});assert.equal(x.calls.length,3)
})
test('aborting an unread returned stream releases its session lock', async () => {
  const x = await setup([answer({delta:'ok', end:true})])
  const loader = await x.hooks.auth.loader(async () => auth)
  const request = signal => loader.fetch('https://unused', {
    headers: {'x-magpie-comate-session':'abort-before-read'},
    body: JSON.stringify({
      model:'live-model',
      messages:[{role:'user', content:'hello'}],
      stream:true,
    }),
    signal,
  })
  const controller = new AbortController()
  const first = await request(controller.signal)
  assert.equal(first.status, 200)
  controller.abort()

  const second = await request()
  assert.equal(second.status, 200)
  assert.match(await second.text(), /finish_reason/)
})

for (const boundary of ['"finish_reason":"tool_calls"', 'data: [DONE]']) {
  test(`late cancellation after ${boundary} cannot release a continued request lock`, async () => {
    let executeCount = 0
    let releaseSecond
    let markSecondStarted
    const secondStarted = new Promise(resolve => { markSecondStarted = resolve })
    const x = await setup(() => executeCount === 1
      ? [event('FUNCTION_CALL_END', {text:'from Comate'}), answer({end:true})]
      : [answer({delta:'continued', end:true})], async url => {
      if (url.endsWith('/execute')) {
        executeCount++
        if (executeCount === 2) {
          return await new Promise(resolve => {
            releaseSecond = resolve
            markSecondStarted()
          })
        }
      }
    })
    const loader = await x.hooks.auth.loader(async () => auth)
    const request = messages => loader.fetch('https://unused', {
      headers: {'x-magpie-comate-session':'finish-race'},
      body: JSON.stringify({model:'live-model', messages, tools, stream:true}),
    })
    const initial = [{role:'user', content:'call echo'}]
    const first = await request(initial)
    assert.equal(first.status, 200)

    const reader = first.body.getReader()
    const decoder = new TextDecoder()
    let output = ''
    while (!output.includes(boundary)) {
      const item = await reader.read()
      assert.equal(item.done, false)
      output += decoder.decode(item.value)
    }
    const callId = output.match(/"tool_calls":\[\{"index":0,"id":"([^"]+)"/)?.[1]
    assert.ok(callId)
    const continued = [
      ...initial,
      {role:'assistant', tool_calls:[{
        id:callId,
        type:'function',
        function:{name:'echo', arguments:'{"text":"from Comate"}'},
      }]},
      {role:'tool', tool_call_id:callId, content:'client result'},
    ]

    const secondPromise = request(continued)
    await secondStarted
    let second
    let secondText
    try {
      await reader.cancel()
      const callsBeforeThird = x.calls.length
      const third = await request(continued)
      assert.equal(third.status, 409)
      assert.equal(x.calls.length, callsBeforeThird)
    } finally {
      releaseSecond(sse([answer({delta:'continued', end:true})]))
      second = await secondPromise
      secondText = await second.text()
    }
    assert.equal(second.status, 200)
    assert.match(secondText, /finish_reason/)
  })
}

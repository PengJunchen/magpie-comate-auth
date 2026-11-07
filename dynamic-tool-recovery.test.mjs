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
    const events = typeof output === 'function' ? output(body) : output
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

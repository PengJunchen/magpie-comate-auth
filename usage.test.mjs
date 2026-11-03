import test from 'node:test'
import assert from 'node:assert/strict'
import { createUsageMeter } from './usage.mjs'
import { ComateAuthPlugin } from './index.mjs'

const auth = { type: 'api', key: 'usage-fixture' }
const answer = detail => ({ content: { type: 'ANSWER', detail } })
const tools = [{ type: 'function', function: { name: 'echo', parameters: { type: 'object', properties: { text: { type: 'string' } } } } }]
const messages = [{ role: 'user', content: 'Read the task and answer.' }]
async function setup(output) {
  const payloads = []
  const hooks = await ComateAuthPlugin({}, { fetchImpl: async (url, init) => {
    if (url.endsWith('/conversation')) return Response.json({ code: 0, data: { id: 1 } })
    if (url.endsWith('/task')) return Response.json({ code: 0, data: { taskId: 2 } })
    const body = JSON.parse(init.body)
    payloads.push(body)
    const items = typeof output === 'function' ? output(body, payloads.length) : output
    return new Response(items.map(x => 'data: ' + JSON.stringify(x) + '\n\n').join(''), { headers: { 'content-type': 'text/event-stream' } })
  } })
  const loader = await hooks.auth.loader(async () => auth)
  return { payloads, request: chat => loader.fetch('https://fixture/v1/chat/completions', { body: JSON.stringify({ model: 'usage-model', messages, ...chat }), headers: { 'x-magpie-comate-session': 'usage-session' } }) }
}
const frames = text => text.split('\n\n').filter(x => x.startsWith('data: {')).map(x => JSON.parse(x.slice(6)))
const valid = usage => {
  assert.ok(usage.prompt_tokens > 0)
  assert.ok(usage.completion_tokens > 0)
  assert.equal(usage.total_tokens, usage.prompt_tokens + usage.completion_tokens)
  assert.equal(usage.comate_usage.source, 'estimated')
  assert.ok(usage.completion_tokens_details.reasoning_tokens <= usage.completion_tokens)
}

test('usage density is independent of delta fragmentation and reasoning is not double-counted', () => {
  const whole = createUsageMeter(messages, tools, 'instructions')
  whole.text('abc中文😀xyz'); whole.reasoning('reason中文')
  const pieces = createUsageMeter(messages, tools, 'instructions')
  for (const char of 'abc中文😀xyz') pieces.text(char)
  for (const char of 'reason中文') pieces.reasoning(char)
  assert.deepEqual(pieces.value(), whole.value())
  valid(whole.value())
  assert.ok(whole.value().completion_tokens_details.reasoning_tokens > 0)
})

test('full history, tool schema, tool arguments and tool results affect the estimate', () => {
  const basic = createUsageMeter(messages, [], '').value().prompt_tokens
  const expanded = createUsageMeter([...messages, { role: 'assistant', tool_calls: [{ id: 'call', type: 'function', function: { name: 'echo', arguments: JSON.stringify({ text: 'x'.repeat(1000) }) } }] }, { role: 'tool', tool_call_id: 'call', content: 'result'.repeat(1000) }], tools, 'instructions').value().prompt_tokens
  assert.ok(expanded > basic + 1000)
  assert.ok(createUsageMeter(messages, tools, '').value().prompt_tokens > basic)
})

test('image accounting reserves visual tokens without pricing base64 length', async () => {
  // Fake upload response supplies the sole metadata field used by the transport.
  const hooks = await ComateAuthPlugin({}, { fetchImpl: async url => url.endsWith('/upload') ? Response.json({ code: 0, data: { id: 3 } }) : url.endsWith('/conversation') ? Response.json({ code: 0, data: { id: 1 } }) : url.endsWith('/task') ? Response.json({ code: 0, data: { taskId: 2 } }) : new Response('data: ' + JSON.stringify(answer({ delta: 'OK', end: true })) + '\n\n', { headers: { 'content-type': 'text/event-stream' } }) })
  const loader = await hooks.auth.loader(async () => auth)
  const usage = []
  for (const size of [3, 30000]) {
    const r = await loader.fetch('https://fixture', { body: JSON.stringify({ model: 'usage-model', messages: [{ role: 'user', content: [{ type: 'text', text: 'Describe' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,' + Buffer.alloc(size).toString('base64') } }] }] }) })
    assert.equal(r.status, 200)
    usage.push((await r.json()).usage)
  }
  assert.equal(usage[0].prompt_tokens, usage[1].prompt_tokens)
  assert.equal(usage[0].comate_usage.image_tokens, 1024)
})

test('stream and JSON responses agree and emit usage before DONE with explicit provenance', async () => {
  const output = [answer({ reasoningDelta: 'Think carefully.' }), answer({ delta: 'OK', end: true })]
  const a = await setup(output), b = await setup(output)
  const jsonResponse = await a.request({})
  const streamResponse = await b.request({ stream: true, stream_options: { include_usage: true } })
  assert.equal(jsonResponse.headers.get('x-comate-usage-source'), 'estimated')
  assert.equal(streamResponse.headers.get('x-comate-usage-source'), 'estimated')
  const json = await jsonResponse.json(), text = await streamResponse.text(), all = frames(text)
  const usage = all.filter(x => x.usage)
  assert.equal(usage.length, 1)
  assert.deepEqual(usage[0].choices, [])
  assert.deepEqual(usage[0].usage, json.usage)
  assert.equal(all.at(-2).choices[0].finish_reason, 'stop')
  assert.ok(text.endsWith('data: [DONE]\n\n'))
  valid(json.usage)
})

test('native continuation estimates retained context rather than only incremental input', async () => {
  const x = await setup((body, round) => round === 1 ? [
    { content: { type: 'FUNCTION_CALL_END', detail: { toolUse: [{ id: 'native1', name: body.tools[0].function.name, input: { text: 'large result' } }] } } }, answer({ end: true }),
  ] : [answer({ delta: 'Done', end: true })])
  const first = await (await x.request({ messages: [{ role: 'user', content: 'history'.repeat(3000) }], tools })).json()
  valid(first.usage)
  const next = await (await x.request({ messages: [{ role: 'user', content: 'history'.repeat(3000) }, first.choices[0].message, { role: 'tool', tool_call_id: first.choices[0].message.tool_calls[0].id, content: 'fresh'.repeat(500) }], tools })).json()
  valid(next.usage)
  assert.equal(x.payloads[1].isFirstQuery, false)
  assert.equal(x.payloads[1].query, '')
  assert.ok(next.usage.prompt_tokens > first.usage.prompt_tokens)
  assert.ok(next.usage.prompt_tokens > 5000)
})

test('failed streams never emit successful usage; explicit include_usage false is honored', async () => {
  const bad = await setup([answer({ delta: 'partial' }), { content: { type: 'EXCEPTION' } }])
  const failed = await (await bad.request({ stream: true })).text()
  assert.match(failed, /"error"/)
  assert.equal(frames(failed).filter(x => x.usage).length, 0)
  const good = await setup([answer({ delta: 'OK', end: true })])
  assert.equal(frames(await (await good.request({ stream: true, stream_options: { include_usage: false } })).text()).filter(x => x.usage).length, 0)
})

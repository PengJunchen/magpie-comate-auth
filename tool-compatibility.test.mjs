import test from 'node:test'
import assert from 'node:assert/strict'
import {clientToolCall} from './tool-adapter.mjs'
import {normalizeArguments} from './tool-schema.mjs'
import {buildQuery} from './protocol.mjs'
import {ComateAuthPlugin} from './index.mjs'
const tool=(name,properties,required=Object.keys(properties))=>({type:'function',function:{name,parameters:{type:'object',properties,required,additionalProperties:false}}})
const spec=tools=>buildQuery({messages:[{role:'user',content:'task'}],tools},'compat').toolSpec
const webTool = tool('web_search', { queries: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 4 } })
test('native web search query becomes a Harness queries array with client-owned result count', () => {
 const input = { query: 'Node.js official documentation', max_results: '5' }
 const mapped = clientToolCall({ name: 'web_search', input }, spec([webTool]))
 assert.deepEqual(mapped.input, { queries: ['Node.js official documentation'] })
 assert.deepEqual(input, { query: 'Node.js official documentation', max_results: '5' })
 for (const queries of [['first', 'second'], '["first","second"]']) {
  assert.deepEqual(clientToolCall({ name: 'web_search', input: { queries } }, spec([webTool])).input, { queries: ['first', 'second'] })
 }
 const aliased = spec([webTool])
 assert.deepEqual(clientToolCall({ name: aliased.tools[0].function.name, input }, aliased).input, mapped.input)
})
test('web search preserves declared result counts and single-query client formats', () => {
 const target = tool('WebSearch', { query: { type: 'string' }, maxResults: { type: 'integer' } })
 assert.deepEqual(clientToolCall({ name: 'web_search', input: { queries: ['first'], max_results: '3' } }, spec([target])), { name: 'WebSearch', input: { query: 'first', maxResults: 3 } })
 assert.throws(() => clientToolCall({ name: 'web_search', input: { queries: ['first', 'second'], max_results: 3 } }, spec([target])), /only one query/)
})
test('web search rejects missing, conflicting, excessive and unsupported arguments', () => {
 for (const input of [{}, {query:''}, {queries:[]}, {queries:'invalid'}, {query:'first',queries:['second']}, {query:'first',max_results:0}, {query:'first',allowed_domains:['example.com']}, {queries:['1','2','3','4','5']}]) {
  assert.throws(() => clientToolCall({ name: 'web_search', input }, spec([webTool])))
 }
 assert.throws(() => clientToolCall({ name: 'web_search', input: { query:'first' } }, spec([])))
})
for (const stream of [false, true]) test(`native web search retains original parameters across continuation (stream=${stream})`, async () => {
 const executions = []
 const hooks = await ComateAuthPlugin({}, { fetchImpl: async (url, init) => {
  if (url.endsWith('/conversation')) return Response.json({code:0,data:{id:1}})
  if (url.endsWith('/task')) return Response.json({code:0,data:{taskId:2}})
  executions.push(JSON.parse(init.body))
  const events = executions.length === 1 ? [
   {content:{type:'FUNCTION_CALL_START',detail:{toolUse:[{id:'native-search',name:'web_search',input:{query:'Node'}}]}}},
   {content:{type:'FUNCTION_CALL_PARAMS_APPEND',detail:{toolUse:[{id:'native-search',input:{query:'.js docs',max_results:'5'}}]}}},
   {content:{type:'FUNCTION_CALL_END',detail:{toolUse:[{id:'native-search',input:{}}]}}},
   {content:{type:'ANSWER',detail:{end:true}}},
  ] : [{content:{type:'ANSWER',detail:{delta:'done',end:true}}}]
  return new Response(events.map(e => 'data: '+JSON.stringify(e)+'\n\n').join(''), {headers:{'content-type':'text/event-stream'}})
 } })
 const loader = await hooks.auth.loader(async () => ({type:'api',key:'fake'}))
 const messages = [{role:'user',content:'Search docs'}]
 const request = stream => loader.fetch('https://unused', {headers:{'x-magpie-comate-session':'web-search-test'},body:JSON.stringify({model:'m',messages,tools:[webTool],stream})})
 const response = await request(stream)
 let call
 if (stream) {
  const parts = (await response.text()).split('\n').filter(line => line.startsWith('data: {')).map(line=>JSON.parse(line.slice(6))).flatMap(e=>e.choices?.[0]?.delta?.tool_calls??[])
  call = {...parts[0],function:{...parts[0].function,arguments:parts.map(p=>p.function.arguments??'').join('')}}
 } else call = (await response.json()).choices[0].message.tool_calls[0]
 assert.deepEqual(JSON.parse(call.function.arguments), {queries:['Node.js docs']})
 messages.push({role:'assistant',tool_calls:[call]}, {role:'tool',tool_call_id:call.id,content:'Client search result'})
 assert.equal((await request(false)).status, 200)
 assert.equal(executions[1].isFirstQuery, false)
 assert.deepEqual(executions[1].toolUseResults[0].params, {query:'Node.js docs',max_results:'5'})
})
const todos=[{content:'恢复 Kibana 查询环境并登录',status:'in_progress'},{content:'抓取开户时窗的 balance_adjust/balance_lookup 事件',status:'pending'},{content:'分析积点赋予未生效原因',status:'pending'},{content:'客户端日志交叉验证并输出结论',status:'pending'}]
const todoItems={type:'array',items:{type:'object',properties:{content:{type:'string'},status:{type:'string',enum:['pending','in_progress','completed']}},required:['content','status'],additionalProperties:false}}
for(const name of ['todo_write','TodoWrite','todowrite'])test(`encoded todos become a validated array for declared ${name}`,()=>{
 const input={todos:JSON.stringify(todos)};const mapped=clientToolCall({name:'todo_write',input},spec([tool(name,{todos:todoItems})]));assert.equal(mapped.name,name);assert.deepEqual(mapped.input.todos,todos);assert.equal(typeof input.todos,'string')
})
test('Codex update_plan uses declared plan/step fields, not vendor todos/content',()=>{
 const plan={...todoItems,items:{...todoItems.items,properties:{step:{type:'string'},status:todoItems.items.properties.status},required:['step','status']}}
 const mapped=clientToolCall({name:'todo_write',input:{todos:JSON.stringify(todos)}},spec([tool('update_plan',{plan})]));assert.deepEqual(mapped.input.plan,todos.map(item=>({step:item.content,status:item.status})))
})
for(const [name,properties,input,expected]of[
 ['bash',{command:{type:'string'},description:{type:'string'},workdir:{type:'string'}},{command:'printf ok',cwd:'/tmp'}, {command:'printf ok',description:'Run the requested command in the client',workdir:'/tmp'}],
 ['Bash',{command:{type:'string'},timeout:{type:'number'}},{command:'printf ok',timeout_ms:1200},{command:'printf ok',timeout:1200}],
 ['exec_command',{cmd:{type:'string'},workdir:{type:'string'}},{command:'printf ok',cwd:'/tmp'},{cmd:'printf ok',workdir:'/tmp'}],
])test(`native shell capability maps to ${name}'s declared schema`,()=>{
 const mapped=clientToolCall({name:'run_command',input},spec([tool(name,properties)]));assert.deepEqual(mapped,{name,input:expected})
})
for(const name of ['read','Read'])test(`native read_file maps fields and numeric types for ${name}`,()=>{
 const mapped=clientToolCall({name:'read_file',input:{target_file:'/tmp/file',offset:'2',limit:'10'}},spec([tool(name,{file_path:{type:'string'},offset:{type:'number'},limit:{type:'integer'}})]));assert.deepEqual(mapped.input,{file_path:'/tmp/file',offset:2,limit:10})
})
for(const [native,name,properties,input,expected]of[
 ['write_file','Write',{file_path:{type:'string'},content:{type:'string'}},{path:'/tmp/f',content:'[]'},{file_path:'/tmp/f',content:'[]'}],
 ['edit_file','edit',{file_path:{type:'string'},old_string:{type:'string'},new_string:{type:'string'}},{target_path:'/tmp/f',old_string:'a',new_string:'b'},{file_path:'/tmp/f',old_string:'a',new_string:'b'}],
 ['glob_path','Glob',{path:{type:'string'},pattern:{type:'string'}},{target_directory:'/tmp',glob_pattern:'*.js'},{path:'/tmp',pattern:'*.js'}],
 ['grep_content','grep',{path:{type:'string'},pattern:{type:'string'}},{target_directory:'/tmp',search_query:'word'},{path:'/tmp',pattern:'word'}],
])test(`profile ${native} maps to ${name} without dropping semantic fields`,()=>assert.deepEqual(clientToolCall({name:native,input},spec([tool(name,properties)])).input,expected))
test('schema conversion is recursive, lossless for string fields and limited to valid declared types',()=>{
 const schema={type:'object',properties:{config:{type:'object',properties:{flags:{type:'array',items:{type:'boolean'}}},required:['flags']},text:{type:'string'}}}
 assert.deepEqual(normalizeArguments({config:'{"flags":["true",false]}',text:'[1,2]'},schema),{config:{flags:[true,false]},text:'[1,2]'})
 for(const input of [{todos:'not JSON'},{todos:'{}'},{todos:'[{"content":"x","status":"invented"}]'},{todos:'[{"content":"x"}]'}])assert.throws(()=>clientToolCall({name:'todo_write',input},spec([tool('todo_write',{todos:todoItems})])))
 assert.throws(()=>normalizeArguments('1',{anyOf:[{type:'string'},{type:'integer'}]}))
})
for(const stream of [false,true])test(`encoded native todo arguments complete a cloud/client round trip (stream=${stream})`,async()=>{
 let count=0;const executions=[]
 const hooks=await ComateAuthPlugin({}, {fetchImpl:async(url,init)=>{
 const body=JSON.parse(init.body);if(url.endsWith('/conversation'))return Response.json({code:0,data:{id:1}});if(url.endsWith('/task'))return Response.json({code:0,data:{taskId:2}});executions.push(body)
 const events=count++===0?[{content:{type:'FUNCTION_CALL_START',detail:{toolUse:[{id:'native-todo',name:'todo_write',input:{todos:JSON.stringify(todos)}}]}}},{content:{type:'FUNCTION_CALL_END',detail:{toolUse:[{id:'native-todo',name:'todo_write',input:{}}]}}},{content:{type:'ANSWER',detail:{end:true}}}]:[{content:{type:'ANSWER',detail:{delta:'done',end:true}}}]
 return new Response(events.map(e=>'data: '+JSON.stringify(e)+'\n\n').join(''),{headers:{'content-type':'text/event-stream'}})
 }})
 const loader=await hooks.auth.loader(async()=>({type:'api',key:'fake'}));const messages=[{role:'user',content:'task'}];const request=stream=>loader.fetch('https://unused',{headers:{'x-magpie-comate-session':'todo-compat'},body:JSON.stringify({model:'m',messages,tools:[tool('todo_write',{todos:todoItems})],stream})})
 const response=await request(stream);let call
 if(stream){const parts=(await response.text()).split('\n').filter(l=>l.startsWith('data: {')).map(l=>JSON.parse(l.slice(6))).flatMap(e=>e.choices?.[0]?.delta?.tool_calls??[]);call={...parts[0],function:{...parts[0].function,arguments:parts.map(p=>p.function.arguments??'').join('')}}}else call=(await response.json()).choices[0].message.tool_calls[0]
 assert.deepEqual(JSON.parse(call.function.arguments).todos,todos)
 messages.push({role:'assistant',tool_calls:[call]},{role:'tool',tool_call_id:call.id,content:'saved by actual client boundary'})
 assert.equal((await request(false)).status,200);assert.equal(executions[1].toolUseResults[0].id,'native-todo');assert.equal(typeof executions[1].toolUseResults[0].params.todos,'string')
})

test('a declared tool without a schema retains its exact-name arguments without guessing types',()=>{
 const mapped=clientToolCall({name:'read',input:{file_path:'x',unknownOption:'unchanged'}},spec([{type:'function',function:{name:'read'}}]));assert.deepEqual(mapped.input,{file_path:'x',unknownOption:'unchanged'})
})
test('schema conversion does not pollute prototypes or accept unsafe numeric precision',()=>{
 const value=normalizeArguments(JSON.parse('{"__proto__":{"polluted":true}}'),{type:'object'});assert.equal(Object.hasOwn(value,'__proto__'),true);assert.equal({}.polluted,undefined);assert.throws(()=>normalizeArguments('9007199254740993',{type:'integer'}))
})

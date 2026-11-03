import test from 'node:test'
import {execFileSync} from 'node:child_process'
import {mkdtempSync,mkdirSync,writeFileSync,existsSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import assert from 'node:assert/strict'
import {buildQuery} from './protocol.mjs'
import {clientToolCall} from './tool-adapter.mjs'
import {ComateAuthPlugin} from './index.mjs'
const bash={type:'function',function:{name:'bash',parameters:{type:'object',properties:{command:{type:'string'},description:{type:'string'}},required:['command','description']}}}
const spec=(tools=[bash],extra={})=>buildQuery({messages:[{role:'user',content:'list'}],tools,...extra},'test').toolSpec
for(const path of ['.', '/tmp/with spaces', "/tmp/quo'te;$(touch NEVER)", '-flags', '/tmp/line\nbreak'])test(`list_dir safely adapts the literal path ${JSON.stringify(path)}`,()=>{
 const mapped=clientToolCall({name:'list_dir',input:{target_directory:path}},spec());assert.equal(mapped.name,'bash');assert.equal(mapped.input.command,"ls -la -- '"+path.replaceAll("'","'\\''")+"'");assert.ok(mapped.input.description);assert.deepEqual(Object.keys(mapped.input).sort(),['command','description'])
})
test('none, missing bash, unknown tools, incompatible schemas and unsupported options stay errors',()=>{
 for(const [call,s] of [[{name:'list_dir',input:{}},spec([bash],{tool_choice:'none'})],[{name:'list_dir',input:{}},spec([])],[{name:'delete_file',input:{}},spec()],[{name:'list_dir',input:{recursive:true}},spec()],[{name:'list_dir',input:{path:'a',directory:'b'}},spec()],[{name:'list_dir',input:{path:'a\0b'}},spec()],[{name:'list_dir',input:{}},spec([{...bash,function:{...bash.function,parameters:{properties:{command:{type:'string'}},required:['command','unavailable']}}}])]])assert.throws(()=>clientToolCall(call,s))
})
for(const [nativeName,nativeInput] of [["list_dir",{target_directory:'/tmp/scratch'}],["run_command",{command:'printf ok'}],["list_dir",{depth:'2',target_directory:'/tmp/scratch',ignore_globs:'[]'}],["list_dir",{depth:'2',target_directory:'/tmp/scratch',ignore_globs:'["**/node_modules/**",".git"]'}]])for(const stream of [false,true])test(`translated calls correlate client bash results to original cloud ${nativeName} ${JSON.stringify(nativeInput)} (stream=${stream})`,async()=>{
 const requests=[];let execute=0
 const hooks=await ComateAuthPlugin({}, {fetchImpl:async(url,init)=>{
 const body=JSON.parse(init.body);requests.push({url,body});
 if(url.endsWith('/conversation'))return Response.json({code:0,data:{id:1}})
 if(url.endsWith('/task'))return Response.json({code:0,data:{taskId:2}})
 const split=nativeInput.ignore_globs?.length>>1
 const events=execute++===0?[{content:{type:'FUNCTION_CALL_START',detail:{toolUse:[{id:'vendor-call',name:nativeName,input:{...nativeInput,...(nativeInput.ignore_globs?{ignore_globs:nativeInput.ignore_globs.slice(0,split)}:{})}}]}}},...(nativeInput.ignore_globs?[{content:{type:'FUNCTION_CALL_PARAMS_APPEND',detail:{toolUse:[{id:'vendor-call',input:{ignore_globs:nativeInput.ignore_globs.slice(split)}}]}}}]:[]),{content:{type:'FUNCTION_CALL_END',detail:{toolUse:[{id:'vendor-call',name:nativeName,input:{}}]}}},{content:{type:'ANSWER',detail:{end:true}}}]:[{content:{type:'ANSWER',detail:{delta:'listed',end:true}}}]
 return new Response(events.map(e=>'data: '+JSON.stringify(e)+'\n\n').join(''),{headers:{'content-type':'text/event-stream'}})
 }})
 const loader=await hooks.auth.loader(async()=>({type:'api',key:'fake'}));const messages=[{role:'user',content:'list'}];const request=stream=>loader.fetch('https://unused',{headers:{'x-magpie-comate-session':'adapter-test'},body:JSON.stringify({model:'model',messages,tools:[bash],stream})})
 const first=await request(stream);assert.equal(first.status,200);let call
 if(!stream)call=(await first.json()).choices[0].message.tool_calls[0]
 else {const items=(await first.text()).split('\n').filter(l=>l.startsWith('data: {')).map(l=>JSON.parse(l.slice(6))).flatMap(e=>e.choices?.[0]?.delta?.tool_calls??[]);call={...items[0],function:{...items[0].function,arguments:items.map(i=>i.function.arguments??'').join('')}}}
 assert.equal(call.function.name,'bash');assert.match(JSON.parse(call.function.arguments).command,nativeName==='list_dir'?nativeInput.depth?/find/:/ls -la/:/printf ok/)
 messages.push({role:'assistant',tool_calls:[call]},{role:'tool',tool_call_id:call.id,content:'actual listing'})
 assert.equal((await request(false)).status,200)
 const last=requests.at(-1).body;assert.deepEqual(last.toolUseResults,[{id:'vendor-call',name:nativeName,params:nativeInput,success:true,message:'actual listing'}]);assert.equal(last.isFirstQuery,false)
})

test('shell metacharacters in a directory name remain literal during real bash execution',()=>{
 const root=mkdtempSync(join(tmpdir(),'comate-quote-'))
 try {const path=join(root,"dir';touch PWNED;'$(touch ALSO_PWNED)");mkdirSync(path);writeFileSync(join(path,'entry.txt'),'fixture');const mapped=clientToolCall({name:'list_dir',input:{target_directory:path}},spec());const output=execFileSync('/bin/bash',['-c',mapped.input.command],{cwd:root,encoding:'utf8'});assert.match(output,/entry.txt/);assert.equal(existsSync(join(root,'PWNED')),false);assert.equal(existsSync(join(root,'ALSO_PWNED')),false)}finally{rmSync(root,{recursive:true,force:true})}
})

test('native depth strings preserve requested traversal without shell interpolation',()=>{
 const root=mkdtempSync(join(tmpdir(),'comate-depth-'))
 try {mkdirSync(join(root,'nested'));writeFileSync(join(root,'nested','child.txt'),'fixture');const mapped=clientToolCall({name:'list_dir',input:{target_directory:root,depth:'2'}},spec());assert.match(mapped.input.command,/-maxdepth 2/);assert.match(execFileSync('/bin/bash',['-c',mapped.input.command],{encoding:'utf8'}),/nested\/child.txt/);for(const depth of ['1;touch PWNED','0','1.5',65])assert.throws(()=>clientToolCall({name:'list_dir',input:{depth}},spec()))}finally{rmSync(root,{recursive:true,force:true})}
})

test('run_command maps commands and declared Harness fields without executing or adding permissions',()=>{
 const shell={...bash,function:{...bash.function,parameters:{...bash.function.parameters,properties:{...bash.function.parameters.properties,workdir:{type:'string'},timeoutMs:{type:'number'},run_in_background:{type:'boolean'}}}}}
 const native={name:'run_command',input:{command:'printf ok | cat',cwd:'/tmp/space dir',timeout_ms:1234,is_background:true}}
 const mapped=clientToolCall(native,spec([shell]));assert.deepEqual(mapped,{name:'bash',input:{command:'printf ok | cat',description:'Run the requested command in the client',workdir:'/tmp/space dir',timeoutMs:1234,run_in_background:true}})
 assert.equal(native.input.cwd,'/tmp/space dir');assert.equal(Object.hasOwn(mapped.input,'sandbox_permissions'),false)
})
test('run_command does not drop unsupported execution semantics or bypass none',()=>{
 for(const input of [{command:''},{command:'ls',cwd:'a',workdir:'b'},{command:'ls',timeout_ms:-1},{command:'ls',is_background:'true'},{command:'ls',sandbox_permissions:'danger-full-access'},{command:'ls',is_background:true}])assert.throws(()=>clientToolCall({name:'run_command',input},spec()))
 assert.throws(()=>clientToolCall({name:'run_command',input:{command:'ls'}},spec([bash],{tool_choice:'none'})))
 assert.throws(()=>clientToolCall({name:'run_command',input:{command:'ls'}},spec([])))
})

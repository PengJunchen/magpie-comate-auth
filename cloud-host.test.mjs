import test from 'node:test'
import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {once} from 'node:events'
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs'
import {execFileSync} from 'node:child_process'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {MagpieHost,findBun,findMagpieHost} from './host-process.mjs'
const bun=findBun(),hostPath=findMagpieHost()
for(const stream of [false,true])test(`filtered list_dir executes in the client and preserves native results through production Magpie host (stream=${stream})`,{skip:!bun||!hostPath?'Set MAGPIE_HOST and MAGPIE_BUN':false,timeout:30000},async t=>{
 const temp=mkdtempSync(join(tmpdir(),'comate-cloud-host-'));t.after(()=>rmSync(temp,{recursive:true,force:true}))
 const scratch=join(temp,'scratch');mkdirSync(join(scratch,'node_modules'),{recursive:true});writeFileSync(join(scratch,'keep.txt'),'fixture');writeFileSync(join(scratch,'node_modules','hidden.txt'),'fixture')
 const nativeInput={depth:'2',target_directory:scratch,ignore_globs:'["**/node_modules/**"]'}
 const payloads=[]
 const server=createServer(async(req,res)=>{
  let raw='';for await(const chunk of req)raw+=chunk
  const body=JSON.parse(raw)
  res.setHeader('content-type','application/json')
  if(req.url.endsWith('/available'))return res.end(JSON.stringify({code:0,data:[{modelId:'cloud-live',displayName:'Cloud Fixture'}]}))
  if(req.url.endsWith('/conversation'))return res.end(JSON.stringify({code:0,data:{id:1}}))
  if(req.url.endsWith('/task'))return res.end(JSON.stringify({code:0,data:{taskId:2}}))
  assert.ok(req.url.endsWith('/execute'));payloads.push(body)
  const done={content:{type:'ANSWER',detail:{end:true}}}
  const events=body.toolUseResults.length?[{content:{type:'ANSWER',detail:{delta:'CLIENT_TOOL_RESULT',end:true}}}]:[
   {content:{type:'FUNCTION_CALL_START',detail:{toolUse:[{id:'a',name:'list_dir',input:{...nativeInput,ignore_globs:'["**/node_'}}]}}},
   {content:{type:'FUNCTION_CALL_PARAMS_APPEND',detail:{toolUse:[{id:'a',input:{ignore_globs:'modules/**"]'}}]}}},
   {content:{type:'FUNCTION_CALL_END',detail:{toolUse:[{id:'a',name:'list_dir',input:{}}]}}},done]
  res.setHeader('content-type','text/event-stream');res.end(events.map(x=>'data: '+JSON.stringify(x)+'\n\n').join(''))
 });server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>{server.closeAllConnections();server.close()})
 const entry=join(temp,'entry.mjs'),settings=join(temp,'settings.json');writeFileSync(settings,JSON.stringify({'baidu.comate.license':'fake-host-license'}))
 writeFileSync(entry,`import {ComateAuthPlugin as plugin} from ${JSON.stringify(new URL('./index.mjs',import.meta.url).href)};export const ComateAuthPlugin=(input)=>plugin(input,{fetchImpl:globalThis.fetch,cloudOrigin:'http://127.0.0.1:${server.address().port}',discoveryOptions:{settingsPath:${JSON.stringify(settings)}}});`)
 const host=new MagpieHost({bun,host:hostPath,cwd:temp});t.after(()=>host.close())
 await host.call('init',{authPath:join(temp,'auth.json'),directory:temp,config:{},plugins:[{spec:'cloud-test',target:entry}]})
 const p=(await host.call('providers')).find(x=>x.id==='comate');const a=await host.call('authorize',{provider:'comate',method:p.methods.findIndex(x=>x.type==='oauth'),inputs:{}});const signed=await host.call('callback',{session:a.session});assert.equal(signed.ok,true)
 const models=(await host.call('providers')).find(x=>x.id==='comate').models;assert.ok(models.some(x=>x.id==='cloud-live'));await host.call('load',{provider:'comate',account:signed.account})
 const messages=[{role:'user',content:'List scratch ignoring node_modules'}],tools=[{type:'function',function:{name:'bash',parameters:{type:'object',properties:{command:{type:'string'},description:{type:'string'}},required:['command','description'],additionalProperties:false}}}]
 async function request(stream=false){const r=await host.fetch({provider:'comate',account:signed.account,model:'cloud-live',npm:'@ai-sdk/openai-compatible',url:'https://comate.baidu.com/v1/chat/completions',method:'POST',headers:{'content-type':'application/json'},body:Buffer.from(JSON.stringify({model:'cloud-live',messages,tools,stream})).toString('base64'),session:'cloud-host-session'});assert.equal(r.status,200,r.body.toString());return r.body.toString()}
 const raw=await request(stream);let first
 if(!stream)first=JSON.parse(raw).choices[0].message
 else {const parts=raw.split('\n').filter(line=>line.startsWith('data: {')).map(line=>JSON.parse(line.slice(6))).flatMap(event=>event.choices?.[0]?.delta?.tool_calls??[]);first={role:'assistant',tool_calls:[{...parts[0],function:{...parts[0].function,arguments:parts.map(part=>part.function.arguments??'').join('')}}]}}
 const call=first.tool_calls[0];assert.equal(call.function.name,'bash');const output=execFileSync('/bin/bash',['-c',JSON.parse(call.function.arguments).command],{encoding:'utf8'});assert.equal(output.trim(),join(scratch,'keep.txt'))
 messages.push(first,{role:'tool',tool_call_id:call.id,content:output});assert.equal(JSON.parse(await request()).choices[0].message.content,'CLIENT_TOOL_RESULT');assert.equal(payloads.length,2);assert.equal(payloads[1].isFirstQuery,false);assert.equal(payloads[1].conversationId,payloads[0].conversationId);assert.equal(payloads[1].taskId,payloads[0].taskId);assert.deepEqual(payloads[1].toolUseResults,[{id:'a',name:'list_dir',params:nativeInput,success:true,message:output}])
})

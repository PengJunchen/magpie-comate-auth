import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,writeFileSync,rmSync,existsSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {execFileSync,spawnSync} from 'node:child_process'
import {buildQuery} from './protocol.mjs'
import {clientToolCall} from './tool-adapter.mjs'
import {ComateAuthPlugin} from './index.mjs'
const grep={type:'function',function:{name:'grep',parameters:{type:'object',properties:{pattern:{type:'string'},path:{type:'string'},include:{type:'string'}},required:['pattern'],additionalProperties:false}}}
const shell=name=>({type:'function',function:{name,parameters:{type:'object',properties:{[name==='exec_command'?'cmd':'command']:{type:'string'},description:{type:'string'}},required:[name==='exec_command'?'cmd':'command'],additionalProperties:false}}})
const spec=(tools=[grep,shell('bash')])=>buildQuery({messages:[{role:'user',content:'search'}],tools},'search').toolSpec
const adapt=(input,tools)=>clientToolCall({name:'grep_content',input},spec(tools))

test('explicit content output maps to fixed-content Harness grep without dropping query semantics',()=>{
 assert.deepEqual(adapt({pattern:'word',path:'/tmp',output_mode:'content'}),{name:'grep',input:{pattern:'word',path:'/tmp'}})
})
test('a declared rich Grep receives its supported output_mode unchanged',()=>{
 const rich={type:'function',function:{name:'Grep',parameters:{type:'object',properties:{pattern:{type:'string'},output_mode:{type:'string',enum:['content','count','files_with_matches']}},required:['pattern'],additionalProperties:false}}}
 assert.deepEqual(adapt({pattern:'word',output_mode:'count'},[rich]),{name:'Grep',input:{pattern:'word',output_mode:'count'}})
})
for(const name of ['bash','Bash','exec_command'])test(`files/count modes use only the declared ${name} shell fields`,()=>{
 const mapped=adapt({pattern:'word',output_mode:'files_with_matches'},[grep,shell(name)]);assert.equal(mapped.name,name);assert.match(mapped.input[name==='exec_command'?'cmd':'command'],/--files-with-matches/);assert.equal(Object.hasOwn(mapped.input,'sandbox_permissions'),false)
})
test('shell mode results preserve matches, filenames, counts, regex failures and no matches',()=>{
 const root=mkdtempSync(join(tmpdir(),'comate-search-'))
 try {
  writeFileSync(join(root,'alpha.txt'),'Needle needle\nNeedle\n');writeFileSync(join(root,'beta.txt'),'Needle\n')
  for(const output_mode of ['content','files_with_matches','count']){
   const mapped=adapt({pattern:'Needle',path:root,output_mode,'-n':true,head_limit:100});const output=execFileSync('/bin/bash',['-c',mapped.input.command],{encoding:'utf8'})
   if(output_mode==='content')assert.match(output,/Needle/)
   if(output_mode==='files_with_matches'){assert.match(output,/alpha.txt/);assert.doesNotMatch(output,/Needle/)}
   if(output_mode==='count'){assert.match(output,/alpha.txt:2/);assert.match(output,/beta.txt:1/)}
  }
  const no=adapt({pattern:'absent-pattern',path:root,output_mode:'count'});assert.equal(spawnSync('/bin/bash',['-c',no.input.command]).status,0)
  const invalid=adapt({pattern:'[',path:root,output_mode:'count',head_limit:1});assert.equal(spawnSync('/bin/bash',['-c',invalid.input.command]).status,2)
  const limited=adapt({pattern:'Needle',path:root,output_mode:'files_with_matches',head_limit:'1',offset:'1'});assert.equal(execFileSync('/bin/bash',['-c',limited.input.command],{encoding:'utf8'}).trim().split('\n').length,1)
  const injection=adapt({pattern:"';touch PWNED;#",path:root,output_mode:'count'});execFileSync('/bin/bash',['-c',injection.input.command],{cwd:root});assert.equal(existsSync(join(root,'PWNED')),false)
 }finally{rmSync(root,{recursive:true,force:true})}
})
test('incompatible or unknown search modes/options do not get silently discarded',()=>{
 for(const input of [{pattern:'word',output_mode:'invented'},{pattern:'word',output_mode:'count',unexpected:true},{pattern:'word',path:'a',target_directory:'b'},{pattern:'word',output_mode:'count',head_limit:-1}])assert.throws(()=>adapt(input))
 assert.throws(()=>adapt({pattern:'word',output_mode:'files_with_matches'},[grep]),/compatible search or shell/)
})
for(const stream of [false,true])test(`output-mode transformation retains native result correlation (stream=${stream})`,async()=>{
 let execute=0;const bodies=[];const original={pattern:'word',path:'/tmp',output_mode:'count'}
 const hooks=await ComateAuthPlugin({}, {fetchImpl:async(url,init)=>{
  const body=JSON.parse(init.body);if(url.endsWith('/conversation'))return Response.json({code:0,data:{id:1}});if(url.endsWith('/task'))return Response.json({code:0,data:{taskId:2}});bodies.push(body)
  const events=execute++===0?[{content:{type:'FUNCTION_CALL_START',detail:{toolUse:[{id:'native-search',name:'grep_content',input:original}]}}},{content:{type:'FUNCTION_CALL_END',detail:{toolUse:[{id:'native-search',name:'grep_content',input:{}}]}}},{content:{type:'ANSWER',detail:{end:true}}}]:[{content:{type:'ANSWER',detail:{delta:'counted',end:true}}}]
  return new Response(events.map(e=>'data: '+JSON.stringify(e)+'\n\n').join(''),{headers:{'content-type':'text/event-stream'}})
 }})
 const loader=await hooks.auth.loader(async()=>({type:'api',key:'fake'}));const messages=[{role:'user',content:'search'}];const request=stream=>loader.fetch('https://unused',{headers:{'x-magpie-comate-session':'search'},body:JSON.stringify({model:'m',messages,tools:[grep,shell('bash')],stream})})
 const response=await request(stream);let call
 if(stream){const parts=(await response.text()).split('\n').filter(l=>l.startsWith('data: {')).map(l=>JSON.parse(l.slice(6))).flatMap(e=>e.choices?.[0]?.delta?.tool_calls??[]);call={...parts[0],function:{...parts[0].function,arguments:parts.map(p=>p.function.arguments??'').join('')}}}else call=(await response.json()).choices[0].message.tool_calls[0]
 assert.equal(call.function.name,'bash');messages.push({role:'assistant',tool_calls:[call]},{role:'tool',tool_call_id:call.id,content:'file.txt:3'})
 assert.equal((await request(false)).status,200);assert.deepEqual(bodies[1].toolUseResults[0],{id:'native-search',name:'grep_content',params:original,success:true,message:'file.txt:3'})
})

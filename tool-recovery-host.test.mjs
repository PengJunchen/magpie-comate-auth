import test from 'node:test'
import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {once} from 'node:events'
import {mkdtempSync,writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {MagpieHost,findBun,findMagpieHost} from './host-process.mjs'

const bun=findBun(),hostPath=findMagpieHost()
for(const scenario of ['unoffered','arguments'])for(const stream of [false,true])test(`production host corrects ${scenario} contract rejection without widening client capability (stream=${stream})`,{skip:!bun||!hostPath?'Set MAGPIE_HOST and MAGPIE_BUN':false,timeout:30000},async t=>{
  const root=mkdtempSync(join(tmpdir(),'comate-recovery-host-'))
  t.after(()=>rmSync(root,{recursive:true,force:true}))
  const file=join(root,'keep.txt');writeFileSync(file,'ACTUAL_READ_RESULT')
  const clientName=scenario==='arguments'?'custom_read':'read'
  const rejectedName=scenario==='arguments'?clientName:'delete_file'
  const rejectedInput=scenario==='arguments'?{path:file,target_directory:root}:{target_file:file}
  const acceptedName=scenario==='arguments'?clientName:'read_file'
  const acceptedInput=scenario==='arguments'?{path:file}:{target_file:file}
  const payloads=[]
  const server=createServer(async(req,res)=>{
    let raw='';for await(const chunk of req)raw+=chunk
    const body=JSON.parse(raw);res.setHeader('content-type','application/json')
    if(req.url.endsWith('/available'))return res.end(JSON.stringify({code:0,data:[{modelId:'fixture-model'}]}))
    if(req.url.endsWith('/conversation'))return res.end(JSON.stringify({code:0,data:{id:1}}))
    if(req.url.endsWith('/task'))return res.end(JSON.stringify({code:0,data:{taskId:2}}))
    payloads.push(body)
    const index=payloads.length
    const events=index===3?[{content:{type:'ANSWER',detail:{delta:'ACTUAL_READ_RESULT',end:true}}}]:[
      {content:{type:'FUNCTION_CALL_START',detail:{toolUse:[{id:index===1?'rejected':'accepted',name:index===1?rejectedName:acceptedName,input:index===1?rejectedInput:acceptedInput}]}}},
      {content:{type:'FUNCTION_CALL_END',detail:{toolUse:[{id:index===1?'rejected':'accepted',input:{}}]}}},
      {content:{type:'ANSWER',detail:{end:true}}},
    ]
    res.setHeader('content-type','text/event-stream');res.end(events.map(event=>'data: '+JSON.stringify(event)+'\n\n').join(''))
  })
  server.listen(0,'127.0.0.1');await once(server,'listening')
  t.after(()=>{server.closeAllConnections();server.close()})
  const entry=join(root,'entry.mjs'),settings=join(root,'settings.json')
  writeFileSync(settings,JSON.stringify({'baidu.comate.license':'fake-recovery-license'}))
  writeFileSync(entry,`import {ComateAuthPlugin as plugin} from ${JSON.stringify(new URL('./index.mjs',import.meta.url).href)};export const ComateAuthPlugin=input=>plugin(input,{fetchImpl:globalThis.fetch,cloudOrigin:'http://127.0.0.1:${server.address().port}',discoveryOptions:{settingsPath:${JSON.stringify(settings)}}});`)
  const host=new MagpieHost({bun,host:hostPath,cwd:root});t.after(()=>host.close())
  await host.call('init',{authPath:join(root,'auth.json'),directory:root,config:{},plugins:[{spec:'recovery-fixture',target:entry}]})
  const provider=(await host.call('providers')).find(provider=>provider.id==='comate')
  const authorized=await host.call('authorize',{provider:'comate',method:provider.methods.findIndex(method=>method.type==='oauth'),inputs:{}})
  const signed=await host.call('callback',{session:authorized.session});assert.equal(signed.ok,true)
  await host.call('load',{provider:'comate',account:signed.account})
  const tools=[{type:'function',function:{name:clientName,parameters:{type:'object',properties:{path:{type:'string'}},required:['path'],additionalProperties:false}}}]
  const messages=[{role:'user',content:'Read the scratch file; never delete anything'}]
  async function request(stream=false) {
    const response=await host.fetch({provider:'comate',account:signed.account,model:'fixture-model',npm:'@ai-sdk/openai-compatible',url:'https://comate.baidu.com/v1/chat/completions',method:'POST',headers:{'content-type':'application/json'},body:Buffer.from(JSON.stringify({model:'fixture-model',messages,tools,stream})).toString('base64'),session:'recovery-host'})
    assert.equal(response.status,200);return response.body.toString()
  }
  const raw=await request(stream);let first
  if(!stream)first=JSON.parse(raw).choices[0].message
  else {
    const events=raw.split('\n').filter(line=>line.startsWith('data: {')).map(line=>JSON.parse(line.slice(6)))
    assert.ok(events.every(event=>!event.error&&(event.choices?.length||event.usage)))
    const parts=events.flatMap(event=>event.choices?.[0]?.delta?.tool_calls??[])
    first={role:'assistant',tool_calls:[{...parts[0],function:{...parts[0].function,arguments:parts.map(part=>part.function.arguments??'').join('')}}]}
  }
  assert.equal(payloads.length,2);assert.equal(payloads[1].toolUseResults[0].success,false)
  assert.equal(payloads[1].toolUseResults[0].name,rejectedName)
  assert.deepEqual(payloads[1].toolUseResults[0].params,rejectedInput)
  if(scenario==='arguments')assert.match(payloads[1].toolUseResults[0].message,/custom_read.*Tool arguments \$\.target_directory: undeclared field/)
  assert.deepEqual(payloads[1].tools.map(tool=>tool.function.name),[clientName])
  const clientCall=first.tool_calls[0];assert.equal(clientCall.function.name,clientName)
  const result=readFileSync(JSON.parse(clientCall.function.arguments).path,'utf8')
  assert.equal(existsSync(file),true)
  messages.push(first,{role:'tool',tool_call_id:clientCall.id,content:result})
  assert.equal(JSON.parse(await request()).choices[0].message.content,result)
  assert.deepEqual(payloads[2].toolUseResults,[{id:'accepted',name:acceptedName,params:acceptedInput,success:true,message:result}])
  assert.equal(payloads[2].taskId,payloads[0].taskId);assert.equal(existsSync(file),true)
})

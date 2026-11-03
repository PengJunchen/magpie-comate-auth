import test from 'node:test'
import assert from 'node:assert/strict'
import {buildQuery} from './protocol.mjs'
import {clientToolCall,clientToolContract,ToolContractError,UnofferedToolError} from './tool-adapter.mjs'
import {define,contracts,mappingCases as cases} from './tool-contracts.fixture.mjs'

// Handwritten minimal contracts from public product interfaces. No private
// evaluation requests, prompts, tool receipts or task content are used here.
const spec=tools=>buildQuery({messages:[{role:'user',content:'synthetic contract check'}],tools},'contract-matrix').toolSpec
const map=(name,input,tools=contracts)=>clientToolCall({name,input},spec(tools))


for(const [name,input,expected] of cases) {
  test(`${name} projects only proven aliases into the exact declared fields`,()=>{
    const before=JSON.stringify(input),mapped=map(name,input)
    assert.equal(mapped.name,name);assert.deepEqual(mapped.input,expected);assert.equal(JSON.stringify(input),before)
    const schema=contracts.find(tool=>tool.function.name===name).function.parameters
    assert.equal(schema.additionalProperties,false)
    assert.ok(Object.keys(mapped.input).every(key=>Object.hasOwn(schema.properties,key)))
  })
  test(`${name} rejects an extra field without dropping it or leaking its value`,()=>{
    assert.throws(()=>map(name,{...input,unknown_option:'SYNTHETIC_REJECTED_VALUE'}),error=>{
      assert.ok(error instanceof ToolContractError)
      assert.match(error.message,new RegExp('Comate tool "'+name+'" rejected arguments'))
      assert.ok(!error.message.includes('SYNTHETIC_REJECTED_VALUE'));return true
    })
  })
}

test('the exact reported optional-path schema failure reproduces on unprofiled tools, with function identity preserved',()=>{
  const custom=define('custom_list',{path:{type:'string'}})
  assert.throws(()=>map('custom_list',{target_directory:'scratch'},[custom]),error=>error instanceof ToolContractError&&/custom_list/.test(error.message)&&/Tool arguments \$\.target_directory: undeclared field/.test(error.message))
})

test('directory aliases work symmetrically when that exact target field is declared',()=>{
  for(const name of ['ls','find'])for(const key of ['path','directory','target_directory']) {
    const target=define(name,{[key]:{type:'string'}})
    for(const alias of ['path','directory','target_directory'])assert.deepEqual(map(name,{[alias]:'scratch'},[target]).input,{[key]:'scratch'})
  }
})

test('file path aliases are symmetric across read/write/edit declarations',()=>{
  for(const name of ['read','write','edit'])for(const key of ['path','file_path','target_file','target_path']) {
    const target=define(name,{[key]:{type:'string'}})
    for(const alias of ['path','file_path','target_file','target_path'])assert.deepEqual(map(name,{[alias]:'scratch/file'},[target]).input,{[key]:'scratch/file'})
  }
})

test('equivalent duplicate aliases agree after schema decoding; conflicting or multiply mapped aliases fail',()=>{
  assert.deepEqual(map('find',{path:'scratch',target_directory:'scratch',depth:'2',max_depth:2}).input,{path:'scratch',max_depth:2})
  for(const name of ['read','ls','find','grep','write','edit']) {
    const base=cases.find(row=>row[0]===name)[1]
    assert.throws(()=>map(name,{...base,path:'one',...(name==='edit'?{file_path:'two'}:name==='ls'||name==='find'||name==='grep'?{target_directory:'two'}:{target_file:'two'})}),ToolContractError)
  }
  assert.throws(()=>map('bash',{command:'one',cmd:'two'}),ToolContractError)
  assert.throws(()=>map('read',{target_file:'scratch'},[define('read',{path:{type:'string'},file_path:{type:'string'}})]),/Ambiguous field mapping/)
})

test('invalid types, missing required values and enums remain schema errors',()=>{
  for(const [name,input] of [['read',{}],['ls',{all:'not JSON'}],['ls',{sort:'invented'}],['find',{depth:'-1'}],['find',{type:'invented'}],['grep',{pattern:[]}],['write',{path:'scratch',content:[]}],['edit',{file_path:'scratch',old_string:'old'}]])assert.throws(()=>map(name,input),ToolContractError)
})

test('working directories without a declared cwd field are not silently wrapped into shell commands',()=>{
  assert.throws(()=>map('bash',{command:'printf fixture',target_directory:'scratch'}),error=>error instanceof ToolContractError&&/target_directory: undeclared field/.test(error.message))
  const target=define('bash',{command:{type:'string'},workdir:{type:'string'}},['command'])
  assert.deepEqual(map('bash',{command:'printf fixture',target_directory:'scratch'},[target]).input,{command:'printf fixture',workdir:'scratch'})
})

test('listing depth and recursive-glob semantics are not guessed from incompatible fields',()=>{
  assert.throws(()=>map('ls',{target_directory:'scratch',depth:'2'}),ToolContractError)
  assert.throws(()=>map('find',{target_directory:'scratch',glob_pattern:'**/*.txt'}),ToolContractError)
  assert.throws(()=>map('glob_path',{target_directory:'scratch',glob_pattern:'**/*.txt'}),UnofferedToolError)
})

test('content grep keeps the client-declared glob field even after output-mode normalization',()=>{
  assert.deepEqual(map('grep',{target_directory:'scratch',search_query:'needle',include:'*.txt',output_mode:'content'}),{name:'grep',input:{path:'scratch',pattern:'needle',glob:'*.txt'}})
})

test('native list_dir retains bounded traversal on the declared shell',()=>{
  const result=map('list_dir',{target_directory:'scratch',depth:'2',ignore_globs:'[]'})
  assert.equal(result.name,'bash');assert.match(result.input.command,/-maxdepth 2/)
  assert.deepEqual(Object.keys(result.input),['command'])
})

for(const name of ['Bash','exec_command'])test(`${name} preserves its declared identity when equivalent shell fields need mapping`,()=>{
  const target=name==='Bash'?define(name,{command:{type:'string'},timeout:{type:'number'}}):define(name,{cmd:{type:'string'},workdir:{type:'string'}})
  const input=name==='Bash'?{cmd:'printf fixture',timeout_ms:'1000'}:{command:'printf fixture',target_directory:'scratch'}
  const expected=name==='Bash'?{command:'printf fixture',timeout:1000}:{cmd:'printf fixture',workdir:'scratch'}
  assert.deepEqual(map(name,input,[...contracts,target]),{name,input:expected})
})

test('the model-visible contract retains exact schemas and includes only declared-capability aliases',()=>{
  const contract=clientToolContract(spec(contracts))
  assert.deepEqual(contract.functions,contracts.map(tool=>({name:tool.function.name,parameters:tool.function.parameters})).sort((left,right)=>left.name<right.name?-1:1))
  assert.deepEqual(contract.native_aliases.read_file,['read'])
  assert.deepEqual(contract.native_aliases.run_command,['bash'])
  assert.deepEqual(contract.native_aliases.list_dir,['bash'])
  assert.ok(!Object.hasOwn(contract.native_aliases,'delete_file'))
  assert.ok(!Object.hasOwn(contract.native_aliases,'glob_path'))
})

test('read-only, none and named contracts do not advertise capabilities outside their selection',()=>{
  const read=contracts.filter(tool=>tool.function.name==='read')
  const readOnly=clientToolContract(spec(read))
  assert.deepEqual(readOnly.functions.map(tool=>tool.name),['read'])
  assert.ok(!Object.hasOwn(readOnly.native_aliases,'list_dir'))
  assert.ok(!Object.hasOwn(readOnly.native_aliases,'run_command'))
  const none=buildQuery({messages:[{role:'user',content:'fixture'}],tools:contracts,tool_choice:'none'},'none').toolSpec
  assert.deepEqual(clientToolContract(none),{functions:[],native_aliases:{}})
  const named=buildQuery({messages:[{role:'user',content:'fixture'}],tools:contracts,tool_choice:{type:'function',function:{name:'read'}}},'named').toolSpec
  assert.deepEqual(clientToolContract(named).functions,readOnly.functions)
  assert.deepEqual(clientToolContract(named).native_aliases,readOnly.native_aliases)
})

test('equivalent schemas and tool sets render identically despite input key order and random protocol aliases',()=>{
  const reverseKeys=value=>Array.isArray(value)?value.map(reverseKeys):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).reverse().map(key=>[key,reverseKeys(value[key])])):value
  const first=spec(contracts),second=spec(reverseKeys([...contracts].reverse()))
  assert.notEqual(first.tools[0].function.name,second.tools.at(-1).function.name)
  const rendered=JSON.stringify(clientToolContract(first))
  assert.equal(rendered,JSON.stringify(clientToolContract(second)))
  assert.ok(!rendered.includes('comate_client_'))
})

test('required keeps the full declared contract, while a named choice cannot advertise another declared name as an alias',()=>{
  const required=buildQuery({messages:[{role:'user',content:'fixture'}],tools:contracts,tool_choice:'required'},'required').toolSpec
  assert.deepEqual(clientToolContract(required),clientToolContract(spec(contracts)))
  const named=buildQuery({messages:[{role:'user',content:'fixture'}],tools:[...contracts,define('Read',{file_path:{type:'string'}})],tool_choice:{type:'function',function:{name:'read'}}},'named').toolSpec
  const contract=clientToolContract(named)
  assert.deepEqual(contract.functions.map(tool=>tool.name),['read'])
  assert.ok(!Object.hasOwn(contract.native_aliases,'Read'))
})

test('the explicit contract preserves the original tool description and its constraints without alias boilerplate',()=>{
  const read=define('read',{path:{type:'string'}})
  read.function.description='Read a client file.\nRespect client permission checks.'
  const contract=clientToolContract(spec([read]))
  assert.equal(contract.functions[0].description,read.function.description)
  assert.ok(!JSON.stringify(contract).includes('Use this offered alias'))
})

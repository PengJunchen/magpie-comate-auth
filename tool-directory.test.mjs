import test from 'node:test'
import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {mkdtempSync,mkdirSync,writeFileSync,existsSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {buildQuery} from './protocol.mjs'
import {clientToolCall} from './tool-adapter.mjs'

const shell=(name='bash')=>({type:'function',function:{name,parameters:{type:'object',properties:{[name==='exec_command'?'cmd':'command']:{type:'string'},...(name==='exec_command'?{}:{description:{type:'string'}})},required:name==='exec_command'?['cmd']:['command','description'],additionalProperties:false}}})
const spec=(tools=[shell()],extra={})=>buildQuery({messages:[{role:'user',content:'list scratch'}],tools,...extra},'directory').toolSpec
const adapt=(input,tools)=>clientToolCall({name:'list_dir',input},spec(tools))
const command=input=>adapt(input).input.command

for(const ignore_globs of [[], '[]'])test(`the reported string-valued depth/path payload accepts empty ignore_globs (${typeof ignore_globs})`,()=>{
 const input={depth:'2',target_directory:'.',ignore_globs};assert.equal(command(input),command({depth:'2',target_directory:'.'}));assert.deepEqual(input,{depth:'2',target_directory:'.',ignore_globs})
})

function fixture(t) {
 const root=mkdtempSync(join(tmpdir(),'comate-directory-'));t.after(()=>rmSync(root,{recursive:true,force:true}))
 for(const name of ['keep.txt','.hidden','trace.log','cache.tmp','cache1','cacheA','src/keep.js','src/debug.log','src/cache/secret','src/deep/cache/keep','src/one/cache/secret','src/one/deep/cache/keep','node_modules/private/data','.git/objects/data','src/node_modules/private/data','build/private/data','src/build/keep','file[1]','quote\'$(touch PWNED);.tmp']) {
  mkdirSync(join(root,name,'..'),{recursive:true});writeFileSync(join(root,name),'fixture')
 }
 return {root,list:(ignore_globs,depth='5',target=root)=>execFileSync('/bin/bash',['-c',command({target_directory:target,depth,ignore_globs})],{cwd:root,encoding:'utf8'}).trim().split('\n').filter(Boolean).map(path=>path.startsWith(root+'/')?path.slice(root.length+1):path).sort()}
}

test('basename and globstar exclusions prune hidden and nested directories for real shell execution',t=>{
 const {list}=fixture(t)
 for(const ignore_globs of [['node_modules','.git','**/build/**','*.log'],JSON.stringify(['**/node_modules/**','**/.git/**','**/build/**','*.log'])]) {
  const entries=list(ignore_globs);assert.ok(entries.includes('keep.txt'));assert.ok(entries.includes('.hidden'));assert.ok(entries.includes('src/keep.js'));assert.ok(!entries.some(path=>/(^|\/)(node_modules|\.git|build)(\/|$)|\.log$/.test(path)))
 }
})

test('single-star paths do not cross separators and globstar matches zero or multiple directories',t=>{
 const {list}=fixture(t)
 const shallow=list(['src/*/cache']);assert.ok(shallow.includes('src/cache'));assert.ok(!shallow.includes('src/one/cache'));assert.ok(shallow.includes('src/one/deep/cache/keep'))
 const recursive=list(['src/**/cache']);assert.ok(!recursive.some(path=>/(^|\/)cache(\/|$)/.test(path)));assert.ok(recursive.includes('src/keep.js'))
})

test('root anchors, trailing directory slashes, question marks and character classes retain their meaning',t=>{
 const {list}=fixture(t)
 for(const pattern of ['/build','./build']) {const entries=list([pattern]);assert.ok(!entries.includes('build'));assert.ok(entries.includes('src/build/keep'))}
 assert.ok(list(['keep.txt/']).includes('keep.txt'))
 assert.ok(!list(['src/cache/']).includes('src/cache/secret'))
 assert.ok(!list(['cache?']).includes('cacheA'))
 assert.ok(!list(['cache[0-9]']).includes('cache1'));assert.ok(list(['cache[0-9]']).includes('cacheA'))
 assert.ok(!list(['cache[!0-9]']).includes('cacheA'));assert.ok(list(['cache[!0-9]']).includes('cache1'))
 assert.ok(!list(['file\\[1\\]']).includes('file[1]'))
})

test('filtering preserves depth limits and works for relative roots and trailing slashes',t=>{
 const {root,list}=fixture(t)
 const shallow=list(['node_modules'],'1');assert.ok(!shallow.some(path=>path.includes('/')));assert.ok(shallow.includes('src'))
 for(const target of [root+'/',root+'//'])assert.deepEqual(list(['node_modules'],'2',target),list(['node_modules'],'2'))
 assert.ok(!list(['*.log'],'2','.').some(path=>path.endsWith('.log')))
 assert.ok(list(['node_modules'],'2','.').includes('./src/keep.js'))
})

test('directory and pattern shell metacharacters and regex punctuation remain literal',t=>{
 const {root}=fixture(t)
 const target=join(root,"root[1].+';$(touch PWNED);(x)");mkdirSync(target)
 const pattern="quote'$(touch ALSO_PWNED);*.tmp"
 writeFileSync(join(target,"quote'$(touch ALSO_PWNED);one.tmp"),'fixture');writeFileSync(join(target,'keep'),'fixture')
 const output=execFileSync('/bin/bash',['-c',command({target_directory:target,depth:'2',ignore_globs:JSON.stringify([pattern])})],{cwd:root,encoding:'utf8'})
 assert.equal(output.trim(),join(target,'keep'));assert.equal(existsSync(join(root,'PWNED')),false);assert.equal(existsSync(join(root,'ALSO_PWNED')),false)
})

for(const name of ['bash','Bash','exec_command'])test(`filtered listing uses only declared ${name} schema fields`,()=>{
 const input={target_directory:'.',depth:'2',ignore_globs:'["node_modules"]'}
 const mapped=adapt(input,[shell(name)]);assert.equal(mapped.name,name);assert.deepEqual(Object.keys(mapped.input).sort(),name==='exec_command'?['cmd']:['command','description']);assert.match(mapped.input.cmd??mapped.input.command,/-prune/)
 assert.equal(input.ignore_globs,'["node_modules"]')
})

test('invalid ignore encodings and unsupported semantics fail instead of being silently dropped',()=>{
 for(const ignore_globs of ['',null,'node_modules','{}','[1]',[1],[''],['a\0b'],['../outside'],['a//b'],['!keep'],['{a,b}'],['@(a)'],['[bad'],['[z-a]'],['[.-0]'],['bad\\'],Array(129).fill('x'),['x'.repeat(4097)]])assert.throws(()=>command({ignore_globs}))
 assert.throws(()=>command({depth:'1; touch PWNED',ignore_globs:'[]'}))
 assert.throws(()=>command({ignore_globs:'[]',recursive:true}),/unsupported options: recursive:boolean$/)
 assert.throws(()=>clientToolCall({name:'list_dir',input:{ignore_globs:'[]'}},spec([shell()],{tool_choice:'none'})))
 assert.throws(()=>adapt({ignore_globs:'["node_modules"]'},[]))
})

test('an exactly declared list_dir retains its own schema-directed argument conversion',()=>{
 const directory={type:'function',function:{name:'list_dir',parameters:{type:'object',properties:{target_directory:{type:'string'},depth:{type:'integer'},ignore_globs:{type:'array',items:{type:'string'}}},required:['target_directory','depth','ignore_globs'],additionalProperties:false}}}
 assert.deepEqual(adapt({target_directory:'.',depth:'2',ignore_globs:'["node_modules"]'},[directory]),{name:'list_dir',input:{target_directory:'.',depth:2,ignore_globs:['node_modules']}})
})

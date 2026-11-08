import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,writeFileSync,rmSync,readFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createHash} from 'node:crypto'
import {publishRelease} from './scripts/publish-release.mjs'

function fixture(t,{published=false,draft=false,wrongTag=false,wrongDraft=false,badDigest=false,badBuild=false,apiFailure=false,superseded=false}={}) {
 const dist=mkdtempSync(join(tmpdir(),'comate-release-test-'))
 t.after(()=>rmSync(dist,{recursive:true,force:true}))
 const repo='fixture/plugin',sha='a'.repeat(40),version='1.2.3',tag='v1.2.3'
 const names=['magpie-comate-auth-1.2.3.zip','pengjunchen-magpie-comate-auth-1.2.3.tgz','BUILD-INFO.json','SHA256SUMS']
 for(const name of names)writeFileSync(join(dist,name),name==='BUILD-INFO.json'?JSON.stringify({commit:badBuild?'b'.repeat(40):sha,version,dirty:false}):'synthetic '+name)
 const assets=names.map(name=>{const data=readFileSync(join(dist,name));return{name,size:data.length,digest:'sha256:'+createHash('sha256').update(data).digest('hex')}})
 let release=published||draft?{id:1,tag_name:tag,draft:!published,target_commitish:wrongDraft?'b'.repeat(40):sha,assets:published?assets:[],html_url:'https://github.com/fixture/plugin/releases/tag/'+tag}:undefined
 const commands=[]
 const api=async path=>{
  if(apiFailure)throw new Error('GitHub API returned HTTP 403')
  if(path.includes('/releases?'))return release?[release]:[]
  if(path.includes('/git/ref/'))return wrongTag?{object:{sha:'b'.repeat(40)}}:null
  if(path.endsWith('/commits/main'))return{sha:superseded?'b'.repeat(40):sha}
  if(path.includes('/commits/'))return{sha:'b'.repeat(40)}
  if(path.endsWith('/releases/1'))return release
  throw new Error('unexpected API request')
 }
 const gh=args=>{
  commands.push(args)
  if(args[1]==='create')release={id:1,tag_name:tag,draft:true,target_commitish:sha,assets:[]}
  if(args[1]==='upload')release.assets=assets.map(asset=>({...asset,...badDigest?{digest:'sha256:wrong'}:{}}))
  if(args[1]==='edit')release.draft=false
 }
 return {run:()=>publishRelease({repo,sha,version,dist,api,gh}),commands,getRelease:()=>release}
}

test('new version stages all assets in a draft and publishes only after digest verification',async t=>{
 const f=fixture(t),result=await f.run()
 assert.equal(result.status,'published')
 assert.deepEqual(f.commands.map(command=>command[1]),['create','upload','edit'])
 assert.ok(f.commands[0].includes('--draft'))
 assert.ok(f.commands[0].includes('a'.repeat(40)))
 assert.equal(f.getRelease().draft,false)
})
test('an already published version is immutable even when main moves',async t=>{
 const f=fixture(t,{published:true})
 assert.equal((await f.run()).status,'already-published')
 assert.deepEqual(f.commands,[])
})
test('an interrupted draft upload can resume at its original commit',async t=>{
 const f=fixture(t,{draft:true})
 assert.equal((await f.run()).status,'published')
 assert.deepEqual(f.commands.map(command=>command[1]),['upload','edit'])
})
for(const [label,options,pattern] of [
 ['existing tag conflict',{wrongTag:true},/tag points to another commit/],
 ['draft provenance conflict',{draft:true,wrongDraft:true},/draft targets another commit/],
 ['build provenance mismatch',{badBuild:true},/build provenance mismatch/],
 ['GitHub authorization failure',{apiFailure:true},/HTTP 403/],
]) test(`${label} cannot create or mutate a release`,async t=>{
 const f=fixture(t,options)
 await assert.rejects(f.run(),pattern)
 assert.deepEqual(f.commands,[])
})
test('an asset digest mismatch leaves the draft unpublished',async t=>{
 const f=fixture(t,{badDigest:true})
 await assert.rejects(f.run(),/asset digest mismatch/)
 assert.deepEqual(f.commands.map(command=>command[1]),['create','upload'])
 assert.equal(f.getRelease().draft,true)
})
test('a slower obsolete main build cannot move latest back to an older release',async t=>{
 const f=fixture(t,{superseded:true})
 assert.equal((await f.run()).status,'superseded')
 assert.deepEqual(f.commands,[])
})

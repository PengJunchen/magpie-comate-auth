import test from 'node:test'
import assert from 'node:assert/strict'
import { quotaUsage, createQuotaReader } from './quota.mjs'
import { ComateAuthPlugin } from './index.mjs'
const license='test / secret'
const auth={type:'api',key:license,metadata:{source:'comate-paste'}}
const data=[{type:'个人专业版',typeCode:'INDIVIDUAL'},{validDays:14},null]
function reader(values=data, fail={}) {
 const calls=[]
 const read=createQuotaReader({credential:async()=>({license}),origin:'https://comate.baidu.com',fetchImpl:async(url,init)=>{
  const i=url.includes('/key/type/')?0:url.includes('/expiring/')?1:2
  calls.push({url,init})
  if(fail[i]==='throw')throw new Error(license)
  if(fail[i])return new Response('',{status:fail[i]})
  return Response.json({status:'OK',data:values[i]})
 }})
 return {calls,read}
}
test('null allowance keeps the verified plan without inventing zero points or expiry',async()=>{
 const {read,calls}=reader();const value=await read(()=>auth)
 assert.equal(value.plan,'个人专业版 · 授权剩余 14 天')
 assert.match(value.balance,/积分暂不可用/);assert.deepEqual(value.windows,[])
 assert.equal(value.signIn,'kept');assert.equal(value.until,undefined);assert.equal(value.error,undefined)
 assert.equal(calls.length,3)
 for(const {url,init}of calls){assert.equal(new URL(url).origin,'https://comate.baidu.com');assert.equal(init.method,'GET');assert.equal(init.redirect,'error');assert.ok(init.signal);assert.equal(init.body,undefined);assert.equal(init.headers['login-name'],encodeURIComponent(license));assert.equal(init.headers['Uuap-login-name'],encodeURIComponent(license))}
 assert.ok(calls[0].url.endsWith('/api/key/type/'+encodeURIComponent(license)))
 assert.ok(calls[2].url.endsWith('/api/openapi/v3/agent/daily_cost?username='+encodeURIComponent(license)))
})
test('known desktop cost windows preserve real zero, overspend, and unspecified unit',()=>{
 const v=quotaUsage({quota:{usedDailyCost:0,maxDailyCost:100,usedMonthlyCost:120,maxMonthlyCost:100}})
 assert.equal(v.windows[0].used,0);assert.equal(v.windows[0].amount,0);assert.equal(v.windows[1].used,120)
 assert.ok(v.windows.every(w=>w.unit===undefined));assert.equal(v.balance,undefined)
})
test('unknown, malformed, missing and negative values never become zero balances',()=>{
 for(const quota of [null,{}, {remaining:100},{usedDailyCost:'0',maxDailyCost:100},{usedDailyCost:-1,maxDailyCost:100},{usedDailyCost:1,maxDailyCost:-2},{usedDailyCost:1,maxDailyCost:-0.5},{usedDailyCost:NaN,maxDailyCost:100},{usedDailyCost:0,maxDailyCost:Infinity}]){
  const v=quotaUsage({quota});assert.deepEqual(v.windows,[]);assert.match(v.balance,/暂不可用/)
 }
})
test('unlimited and explicit zero allowance match desktop semantics',()=>{
 const unlimited=quotaUsage({quota:{usedDailyCost:5,maxDailyCost:-1}}).windows[0]
 assert.equal(unlimited.aside,true);assert.equal(unlimited.used,0);assert.match(unlimited.display,/不限/)
 assert.equal(quotaUsage({quota:{usedDailyCost:0,maxDailyCost:0}}).windows[0].used,100)
})
test('partial quota failure retains subscription and login',async()=>{
 const {read}=reader(data,{2:500});const v=await read(()=>auth)
 assert.match(v.plan,/个人专业版/);assert.equal(v.signIn,'kept');assert.match(v.error,/保留套餐/)
})
test('network failures do not leak credentials or expire login',async()=>{
 const {read}=reader(data,{0:'throw',1:'throw',2:'throw'});const v=await read(()=>auth)
 assert.equal(v.signIn,'kept');assert.ok(v.error);assert.ok(!JSON.stringify(v).includes(license))
})
test('all unauthorized endpoints mark expired',async()=>{
 const {read}=reader(data,{0:401,1:401,2:401});assert.equal((await read(()=>auth)).signIn,'expired')
})
test('malformed envelope is an error, not a successful zero allowance',async()=>{
 const read=createQuotaReader({credential:async()=>({license}),origin:'https://comate.baidu.com',fetchImpl:async()=>Response.json({data:null})})
 const v=await read(()=>auth);assert.ok(v.error);assert.equal(v.signIn,'kept');assert.deepEqual(v.windows,[])
})
test('sensitive values echoed as a plan are redacted',async()=>{
 const {read}=reader([{type:license},null,null]);assert.ok(!(await read(()=>auth)).plan.includes(license))
})
test('plugin exposes auth.usage through the existing cloud hooks',async()=>{
 const hooks=await ComateAuthPlugin({}, {fetchImpl:async()=>Response.json({status:'OK',data:null})})
 assert.equal(typeof hooks.auth.usage,'function')
 const v=await hooks.auth.usage(()=>auth);assert.match(v.balance,/暂不可用/);assert.equal(v.signIn,'kept')
})

test('known plan codes are a fallback and arbitrary object keys are not plans',()=>{
 assert.equal(quotaUsage({plan:{typeCode:'INDIVIDUAL'}}).plan,'个人专业版')
 for(const typeCode of ['unknown','toString','__proto__'])assert.equal(quotaUsage({plan:{typeCode}}).plan,undefined)
})

test('validity failure preserves the plan without inventing remaining days',async()=>{
 const {read}=reader(data,{1:500});const v=await read(()=>auth)
 assert.equal(v.plan,'个人专业版');assert.equal(v.until,undefined);assert.equal(v.error,undefined)
})

test('plan failure preserves valid cost windows',async()=>{
 const {read}=reader([null,null,{usedDailyCost:20,maxDailyCost:100}],{0:500});const v=await read(()=>auth)
 assert.equal(v.windows[0].used,20);assert.ok(v.error);assert.equal(v.signIn,'kept')
})

test('a partial HTTP 401 does not expire an account accepted by other endpoints',async()=>{
 const {read}=reader(data,{2:401});const v=await read(()=>auth)
 assert.equal(v.signIn,'kept');assert.match(v.plan,/个人专业版/)
})

test('encoded credential echoes are redacted',async()=>{
 const {read}=reader([{type:encodeURIComponent(license)},null,null]);const v=await read(()=>auth)
 assert.ok(!JSON.stringify(v).includes(encodeURIComponent(license)))
})

test('missing credentials make no requests',async()=>{
 let requests=0
 const read=createQuotaReader({credential:async()=>null,origin:'https://comate.baidu.com',fetchImpl:async()=>{requests++;throw new Error('unexpected request')}})
 const v=await read(()=>null);assert.equal(requests,0);assert.ok(v.error);assert.equal(v.signIn,'kept')
})

test('credential read errors preserve the discovery sign-in decision without leaking diagnostics',async()=>{
 for(const signIn of ['kept','expired']){
  const read=createQuotaReader({credential:async()=>{throw Object.assign(new Error(license),{signIn})},origin:'https://comate.baidu.com',fetchImpl:async()=>{throw new Error('unexpected request')}})
  const v=await read(()=>auth);assert.equal(v.signIn,signIn);assert.ok(!JSON.stringify(v).includes(license))
 }
})

test('HTTP redirects are rejected without a replay',async()=>{
 const {read,calls}=reader(data,{0:302,1:302,2:302});const v=await read(()=>auth)
 assert.equal(calls.length,3);assert.ok(calls.every(c=>c.init.redirect==='error'));assert.ok(v.error);assert.equal(v.signIn,'kept')
})

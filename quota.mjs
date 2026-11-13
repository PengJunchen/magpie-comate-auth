// Read-only account queries used by the installed Comate desktop client.
// A null daily_cost response is unknown allowance, never a zero balance.
const number = value => typeof value === 'number' && Number.isFinite(value)
const fallbackPlans = { INDIVIDUAL: '个人专业版', TRIAL_INDIVIDUAL: '个人标准版', INTERNATIONAL: '个人标准版', ENTERPRISE: '企业公有云', PRO_ENTERPRISE: '企业专有云', TRIAL_ENTERPRISE: '企业公有云', PLUS_ENTERPRISE: '企业公有云', EDUCATIONAL: '企业标准版', CUSTOMIZED_ENTERPRISE: '混合云企业版', PRIVATE_ENTERPRISE: '企业公有云' }

function windowOf(name, amount, limit) {
  if (!number(amount) || amount < 0 || !number(limit) || (limit < 0 && limit !== -1)) return null
  if (limit === -1) return { name, used: 0, display: `已用 ${amount} / 不限`, aside: true }
  return { name, used: limit > 0 ? 100 * amount / limit : 100, display: `${amount} / ${limit}`, amount, limit }
}

export function quotaUsage({ plan, validity, quota }) {
  const out = { signIn: 'kept', windows: [] }
  if (typeof plan?.type === 'string' && plan.type.trim()) out.plan = plan.type.trim()
  else if (Object.hasOwn(fallbackPlans, plan?.typeCode)) out.plan = fallbackPlans[plan.typeCode]
  // The API supplies whole days, not an exact expiry timestamp. Do not invent one.
  if (out.plan && number(validity?.validDays) && validity.validDays >= 0) out.plan += ` · 授权剩余 ${validity.validDays} 天`
  for (const [name, used, limit] of [
    ['每日额度', quota?.usedDailyCost, quota?.maxDailyCost],
    ['每月额度', quota?.usedMonthlyCost, quota?.maxMonthlyCost],
  ]) {
    const window = windowOf(name, used, limit)
    if (window) out.windows.push(window)
  }
  // The client calls these cost amounts. Their currency/credit conversion is
  // unspecified; keep the raw counts without labelling them as points or yuan.
  if (!out.windows.length) out.balance = '积分暂不可用（官方接口未返回额度）'
  return out
}

export function createQuotaReader({ credential, fetchImpl, origin, timeoutMs = 15000 }) {
  return async getAuth => {
    let account
    try { account = await credential(getAuth) }
    catch (error) { return { error: error?.signIn === 'expired' ? 'Comate 未登录，请重新登录' : '无法读取 Comate 本机登录状态', signIn: error?.signIn === 'expired' ? 'expired' : 'kept' } }
    if (!account?.license) return { error: 'Comate 未登录，请重新登录', signIn: 'kept' }
    const license = account.license, encoded = encodeURIComponent(license)
    const paths = [
      `/api/key/type/${encoded}`,
      `/api/key/expiring/detail/${encoded}`,
      `/api/openapi/v3/agent/daily_cost?username=${encoded}`,
    ]
    const results = await Promise.allSettled(paths.map(async path => {
      const response = await fetchImpl(origin + path, {
        method: 'GET', redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
        headers: { accept: 'application/json', 'login-name': encoded, 'Uuap-login-name': encoded, 'X-Source': 'COMATE', 'plugin-version': '1.8.0' },
      })
      if (!response.ok) {
        await response.body?.cancel()
        throw Object.assign(new Error('Comate account query failed'), { status: response.status })
      }
      const value = await response.json()
      if (value?.status !== 'OK') throw new Error('Comate account query was rejected')
      return value.data
    }))
    const read = i => results[i].status === 'fulfilled' ? results[i].value : undefined
    const out = quotaUsage({ plan: read(0), validity: read(1), quota: read(2) })
    if (results.every(result => result.status === 'rejected')) {
      out.signIn = results.every(result => result.reason?.status === 401) ? 'expired' : 'kept'
      out.error = out.signIn === 'expired' ? 'Comate 登录已失效，请重新登录' : 'Comate 订阅和额度查询失败，请稍后刷新'
    } else if (results[0].status === 'rejected' || !out.plan) out.error = 'Comate 套餐信息暂不可用'
    else if (results[2].status === 'rejected') out.error = 'Comate 额度查询失败；已保留套餐信息'
    for (const field of ['plan', 'balance', 'error']) if (typeof out[field] === 'string') out[field] = out[field].split(license).join('[redacted]').split(encoded).join('[redacted]')
    return out
  }
}

import { readFileSync, appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Only called by the trusted main-branch release job; PR jobs have read access.
export async function publishRelease({repo, sha, version, dist, api, gh}) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !/^[a-f0-9]{40}$/.test(sha) || !/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Invalid release identity')
  const tag = `v${version}`
  const names = [`magpie-comate-auth-${version}.zip`, `pengjunchen-magpie-comate-auth-${version}.tgz`, 'BUILD-INFO.json', 'SHA256SUMS']
  const assets = names.map(name => {
    const data = readFileSync(join(dist, name))
    return {name, size:data.length, digest:'sha256:' + createHash('sha256').update(data).digest('hex')}
  })
  const info = JSON.parse(readFileSync(join(dist, 'BUILD-INFO.json'), 'utf8'))
  if (info.commit !== sha || info.version !== version || info.dirty !== false) throw new Error('Release build provenance mismatch')
  const main = await api(`repos/${repo}/commits/main`)
  if (main?.sha !== sha) return {status:'superseded',tag,url:`https://github.com/${repo}/actions`}
  const releases = []
  for (let page = 1; ; page++) {
    if (page > 20) throw new Error('Release history lookup limit exceeded')
    const batch = await api(`repos/${repo}/releases?per_page=100&page=${page}`)
    releases.push(...batch)
    if (batch.length < 100) break
  }
  const existing = releases.find(release => release.tag_name === tag)
  if (existing && !existing.draft) {
    if (!assets.every(asset => existing.assets.some(remote => remote.name === asset.name && remote.size > 0))) throw new Error('Published release is missing assets; refusing to overwrite it')
    return {status:'already-published',tag,url:existing.html_url}
  }
  const ref = await api(`repos/${repo}/git/ref/tags/${tag}`)
  if (ref) {
    const commit = await api(`repos/${repo}/commits/${tag}`)
    if (commit?.sha !== sha) throw new Error('Existing tag points to another commit')
  } else if (existing && existing.target_commitish !== sha) throw new Error('Existing draft targets another commit')
  if (!existing) gh(['release','create',tag,'--repo',repo,'--target',sha,'--title',tag,'--generate-notes','--draft'])
  // Clobber applies only to an unpublished draft, allowing interrupted uploads
  // to resume. Published releases and their tags are never replaced.
  gh(['release','upload',tag,...names.map(name => join(dist,name)),'--repo',repo,'--clobber'])
  const draft = existing
    ? await api(`repos/${repo}/releases/${existing.id}`)
    : (await api(`repos/${repo}/releases?per_page=100&page=1`)).find(release => release.tag_name === tag)
  if (!draft?.draft || draft.assets.length !== assets.length || !assets.every(asset => draft.assets.some(remote => remote.name === asset.name && remote.size === asset.size && remote.digest === asset.digest))) throw new Error('Uploaded draft asset digest mismatch')
  gh(['release','edit',tag,'--repo',repo,'--draft=false','--latest'])
  return {status:'published',tag,url:`https://github.com/${repo}/releases/tag/${tag}`}
}

async function main() {
  const root = fileURLToPath(new URL('../', import.meta.url))
  const repo = process.env.GITHUB_REPOSITORY, sha = process.env.GITHUB_SHA
  const version = JSON.parse(readFileSync(join(root,'package.json'),'utf8')).version
  const token = process.env.GH_TOKEN
  if (!token) throw new Error('GH_TOKEN is required')
  const api = async path => {
    const response = await fetch(`https://api.github.com/${path}`, {headers:{authorization:`Bearer ${token}`,accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28'},signal:AbortSignal.timeout(30_000)})
    if (response.status === 404) return null
    if (!response.ok) throw new Error(`GitHub API returned HTTP ${response.status}`)
    return response.json()
  }
  const gh = args => execFileSync('gh',args,{stdio:['ignore','pipe','pipe'],timeout:120_000})
  const result = await publishRelease({repo,sha,version,dist:join(root,'dist'),api,gh})
  console.log(JSON.stringify(result))
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY,`## Release\n\n${result.status}: [${result.tag}](${result.url})\n`)
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error instanceof Error && error.status ? `Release command failed (exit ${error.status})` : error.message); process.exitCode = 1 })
}

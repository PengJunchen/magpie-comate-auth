import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("../", import.meta.url))
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"))
const output = join(root, "dist")
const folder = "magpie-comate-auth"
const payload = join(output, folder)
const hash = data => createHash("sha256").update(data).digest("hex")
const names = [...new Set([...pkg.files, "package.json", "LICENSE"])].sort()
if (!process.env.npm_execpath || !existsSync(process.env.npm_execpath)) throw new Error("Build from the source checkout using npm run build")
const files = names.map(name => {
  if (name.includes("/") || name.includes("\\") || name === ".." || !lstatSync(join(root, name)).isFile()) throw new Error(`Payload must be a regular root file: ${name}`)
  return { name, data: readFileSync(join(root, name)) }
})

// Deterministic, uncompressed ZIP with UTF-8 paths and regular-file modes.
// No platform ZIP executable, dependencies or executable installer required.
const table = Array.from({ length: 256 }, (_, i) => {
  let value = i
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
  return value >>> 0
})
function crc32(data) {
  let crc = 0xffffffff
  for (const value of data) crc = table[(crc ^ value) & 255] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}
function zip(entries) {
  const local = [], central = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(`${folder}/${entry.name}`), data = entry.data
    if (data.length > 0xffffffff || offset > 0xffffffff) throw new Error("Payload exceeds ZIP32 bounds")
    const crc = crc32(data), header = Buffer.alloc(30), directory = Buffer.alloc(46)
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x800, 6)
    header.writeUInt16LE(33, 12); header.writeUInt32LE(crc, 14); header.writeUInt32LE(data.length, 18); header.writeUInt32LE(data.length, 22); header.writeUInt16LE(name.length, 26)
    directory.writeUInt32LE(0x02014b50); directory.writeUInt16LE((3 << 8) | 20, 4); directory.writeUInt16LE(20, 6); directory.writeUInt16LE(0x800, 8)
    directory.writeUInt16LE(33, 14); directory.writeUInt32LE(crc, 16); directory.writeUInt32LE(data.length, 20); directory.writeUInt32LE(data.length, 24); directory.writeUInt16LE(name.length, 28)
    directory.writeUInt32LE((0o100644 << 16) >>> 0, 38); directory.writeUInt32LE(offset, 42)
    local.push(header, name, data); central.push(directory, name)
    offset += header.length + name.length + data.length
  }
  const index = Buffer.concat(central), end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(index.length, 12); end.writeUInt32LE(offset, 16)
  return Buffer.concat([...local, index, end])
}

mkdirSync(output, { recursive: true })
// Only replace this script's known payload folder; never clean arbitrary dist files.
rmSync(payload, { recursive: true, force: true })
mkdirSync(payload)
for (const { name } of files) copyFileSync(join(root, name), join(payload, name))
const zipName = `${folder}-${pkg.version}.zip`
writeFileSync(join(output, zipName), zip(files))
const cache = mkdtempSync(join(tmpdir(), "magpie-comate-pack-"))
let archive
try {
  const result = JSON.parse(execFileSync(process.execPath, [process.env.npm_execpath, "pack", "--ignore-scripts", "--cache", cache, "--pack-destination", output, "--json"], { cwd: root, encoding: "utf8" }))
  archive = result[0].filename
  if (typeof archive !== "string" || basename(archive) !== archive || !archive.endsWith(".tgz")) throw new Error("Invalid npm archive path")
} finally { rmSync(cache, { recursive: true, force: true }) }
let commit = null, dirty = null
try {
  commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim()
  dirty = Boolean(execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim())
} catch { /* A downloaded source archive may not contain Git metadata. */ }
writeFileSync(join(output, "BUILD-INFO.json"), JSON.stringify({ name: pkg.name, version: pkg.version, commit, dirty, payload: `./dist/${folder}`, files: Object.fromEntries(files.map(file => [file.name, hash(file.data)])) }, null, 2) + "\n")
const artifacts = [zipName, archive, "BUILD-INFO.json"]
writeFileSync(join(output, "SHA256SUMS"), artifacts.map(name => `${hash(readFileSync(join(output, name)))}  ${name}`).join("\n") + "\n")
console.log(JSON.stringify({ version: pkg.version, payload: `./dist/${folder}`, artifacts: [...artifacts, "SHA256SUMS"].map(name => `./dist/${name}`) }, null, 2))

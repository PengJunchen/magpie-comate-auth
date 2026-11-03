// Adapt vendor directory-list and command requests only when the caller offers a
// compatible shell tool. Never execute it here or widen caller permissions.
const quote = text => "'" + text.replaceAll("'", "'\\''") + "'"

import { normalizeArguments } from "./tool-schema.mjs"
import { SHELL_TOOLS, RENAMED_TOOLS } from "./tool-profiles.mjs"
import { isSearchCall, searchCall } from "./tool-search.mjs"

const declared = spec => spec.tools.map(tool => ({ name: spec.byName.get(tool.function.name), schema: tool.function.parameters ?? {} }))
const finish = (target, input) => ({ name: target.name, input: normalizeArguments(input, target.schema) })

function renameFields(input, profile, target) {
  const properties = target.schema.properties ?? {}
  const output = new Map()
  for (const [key, value] of Object.entries(input)) {
    if (key === "explanation" && !Object.hasOwn(properties, key)) continue // Vendor rationale is not an execution option.
    const mapped = Object.hasOwn(properties, key) ? key : (Object.hasOwn(profile.fields, key) ? profile.fields[key] : undefined)?.find(candidate => Object.hasOwn(properties, candidate))
    if (!mapped) throw new Error(`Cannot preserve ${key} in the declared ${target.name} tool`)
    if (output.has(mapped) && JSON.stringify(output.get(mapped)) !== JSON.stringify(value)) throw new Error(`Ambiguous ${mapped} in ${target.name}`)
    let converted = value
    if (profile.items && ["todos", "plan"].includes(mapped)) {
      const items = normalizeArguments(value, { type: "array", items: { type: "object" } })
      converted = items.map(item => renameFields(item, profile.items, { name: target.name, schema: properties[mapped].items ?? {} }))
    }
    output.set(mapped, converted)
  }
  return Object.fromEntries(output)
}

// Ordered strategy registry: exact declared tools, equivalent named
// capabilities, then derived directory/shell operations. New capabilities
// belong in the profile table or a separately tested strategy.
export function clientToolCall(call, spec) {
  if (!spec.enabled) throw new Error(`Comate requested a tool the client did not offer: ${call.name}`)
  const targets = declared(spec)
  const name = spec.byName.get(call.name)
  const direct = targets.find(target => target.name === name)
  const profile = RENAMED_TOOLS.find(profile => profile.native.includes(call.name))
  const errors = []
  if (direct) {
    try { return finish(direct, profile && direct.schema.properties ? renameFields(call.input, profile, direct) : call.input) } catch (error) { errors.push(error.message) }
  }
  if (profile) {
    for (const candidate of profile.client) {
      const target = targets.find(target => target.name === candidate)
      if (!target) continue
      try { return finish(target, renameFields(call.input, profile, target)) } catch (error) { errors.push(error.message) }
    }
  }
  const strategy = STRATEGIES.find(strategy => strategy.matches(call))
  if (strategy) return strategy.adapt(call, spec)
  if (errors.length) throw new Error(errors.join("; "))
  throw new Error(`Comate requested a tool the client did not offer: ${call.name}`)
}

const STRATEGIES = [
  { matches: isSearchCall, adapt: searchCall },
  { matches: call => call.name === "run_command", adapt: commandCall },
  { matches: call => call.name === "list_dir", adapt: directoryCall },
]

function directoryCall(call, spec) {
  const allowed = new Set(["target_directory", "path", "directory", "depth", "explanation"])
  if (Object.keys(call.input).some(key => !allowed.has(key))) throw new Error("Comate list_dir contains unsupported options: " + Object.entries(call.input).map(([key,value])=>key+":"+typeof value).join(", "))
  const paths = [call.input.target_directory, call.input.path, call.input.directory].filter(value => value !== undefined)
  if (paths.some(value => typeof value !== "string" || !value.trim() || value.includes("\0")) || new Set(paths).size > 1) throw new Error("Comate list_dir contains an invalid or ambiguous directory")
  const path = paths[0] ?? "."
  const rawDepth = call.input.depth ?? 1
  const depth = typeof rawDepth === "number" ? rawDepth : typeof rawDepth === "string" && /^\d+$/.test(rawDepth) ? Number(rawDepth) : NaN
  if (!Number.isSafeInteger(depth) || depth < 1 || depth > 64) throw new Error("Comate list_dir depth must be an integer from 1 to 64")
  const operand = path.startsWith("/") || path.startsWith("./") || path.startsWith("../") || path === "." || path === ".." ? path : "./" + path
  const command = depth === 1 ? `ls -la -- ${quote(path)}` : `find ${quote(operand)} -mindepth 1 -maxdepth ${depth} -print`
  for (const profile of SHELL_TOOLS) {
    const target = declared(spec).find(tool => tool.name === profile.name)
    if (!target || target.schema.properties?.[profile.command]?.type !== "string") continue
    const input = { [profile.command]: command }
    if (target.schema.properties.description?.type === "string") input.description = depth === 1 ? "List immediate directory entries including hidden files" : "List directory entries to the requested depth"
    try { return finish(target, input) } catch { /* Try another declared compatible shell. */ }
  }
  throw new Error("Comate requested list_dir, but the client offers no compatible directory-list or bash tool")
}

function commandCall(call, spec) {
  const allowed = new Set(["command", "description", "explanation", "cwd", "workdir", "working_directory", "target_directory", "timeoutMs", "timeout_ms", "run_in_background", "is_background", "should_wait"])
  if (Object.keys(call.input).some(key => !allowed.has(key))) throw new Error("Comate run_command contains unsupported options: " + Object.keys(call.input).join(", "))
  const { command } = call.input
  if (typeof command !== "string" || !command.trim() || command.includes("\0")) throw new Error("Comate run_command requires a nonempty command")
  const directories = [call.input.cwd, call.input.workdir, call.input.working_directory, call.input.target_directory].filter(value => value !== undefined)
  if (directories.some(value => typeof value !== "string" || !value.trim() || value.includes("\0")) || new Set(directories).size > 1) throw new Error("Comate run_command has an invalid or ambiguous working directory")
  const timeouts = [call.input.timeoutMs, call.input.timeout_ms].filter(value => value !== undefined).map(value => normalizeArguments(value, { type: "integer", minimum: 1 }))
  if (timeouts.some(value => !Number.isSafeInteger(value) || value <= 0) || new Set(timeouts).size > 1) throw new Error("Comate run_command has an invalid or ambiguous timeout")
  const backgrounds = [call.input.run_in_background, call.input.is_background].filter(value => value !== undefined).map(value => normalizeArguments(value, { type: "boolean" }))
  if (call.input.should_wait !== undefined) backgrounds.push(!normalizeArguments(call.input.should_wait, { type: "boolean" }))
  if (backgrounds.some(value => typeof value !== "boolean") || new Set(backgrounds).size > 1) throw new Error("Comate run_command has an invalid or ambiguous background option")
  for (const profile of SHELL_TOOLS) {
    const target = declared(spec).find(tool => tool.name === profile.name)
    const props = target?.schema.properties
    if (props?.[profile.command]?.type !== "string") continue
    const input = { [profile.command]: command }
    if (props.description?.type === "string") input.description = typeof call.input.description === "string" && call.input.description.trim() ? call.input.description : "Run the requested command in the client"
    if (directories.length) {
      const key = profile.cwd.find(key => props[key]?.type === "string")
      if (!key) continue
      input[key] = directories[0]
    }
    if (timeouts.length) {
      const key = profile.timeout.find(key => ["number", "integer"].includes(props[key]?.type))
      if (!key) continue
      input[key] = timeouts[0]
    }
    if (backgrounds.some(Boolean)) {
      if (props.run_in_background?.type !== "boolean") continue
      input.run_in_background = true
    }
    try { return finish(target, input) } catch { /* Try another declared compatible shell. */ }
  }
  throw new Error("Comate requested run_command, but the client offers no compatible bash tool for its parameters")
}

// Adapt vendor directory-list and command requests only when the caller offers a
// compatible shell tool. Never execute it here or widen caller permissions.
const quote = text => "'" + text.replaceAll("'", "'\\''") + "'"

import { normalizeArguments, ToolArgumentError } from "./tool-schema.mjs"
import { SHELL_TOOLS, RENAMED_TOOLS } from "./tool-profiles.mjs"
import { isSearchCall, searchCall } from "./tool-search.mjs"

const declared = spec => spec.tools.map(tool => ({
  name: spec.byName.get(tool.function.name), schema: tool.function.parameters ?? {},
  // protocol.mjs prepends two alias-explanation lines. Keep the original
  // client's description/constraints without presenting that alias framing.
  description: (tool.function.description ?? "").split("\n").slice(2).join("\n"),
}))
const finish = (target, input) => ({ name: target.name, input: normalizeArguments(input, target.schema) })

// These failures occur before client execution. They may share one bounded
// correction, while schema/choice/permission checks remain authoritative.
export class UnofferedToolError extends Error {
  constructor(name) {
    super(`Comate requested a tool the client did not offer: ${name}`)
    this.name = "UnofferedToolError"
  }
}

export class ToolContractError extends Error {
  constructor(name, cause) {
    super(`Comate tool ${JSON.stringify(name)} rejected arguments: ${cause.message}`)
    this.name = "ToolContractError"
  }
}

// The cloud tools field alone does not guarantee that a vendor model sees
// custom client schemas. Render the same contract, plus only existing adapter
// equivalents, into its instructions as well. This never registers a tool.
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value
export function clientToolContract(spec) {
  const available = spec.enabled ? declared(spec).filter(tool => spec.choice !== "named" || tool.name === spec.requiredName) : []
  const allNames = new Set(declared(spec).map(tool => tool.name))
  const names = new Set(available.map(tool => tool.name))
  const aliases = new Map()
  for (const profile of RENAMED_TOOLS) {
    const targets = profile.client.filter(name => names.has(name))
    if (!targets.length) continue
    for (const name of profile.native) {
      if (allNames.has(name) && !names.has(name)) continue
      if (!names.has(name)) aliases.set(name, targets)
    }
  }
  const shells = SHELL_TOOLS.filter(profile => available.some(tool => tool.name === profile.name && tool.schema.properties?.[profile.command]?.type === "string")).map(profile => profile.name)
  if (shells.length) for (const name of ["run_command", "list_dir"]) {
    if (!allNames.has(name)) aliases.set(name, shells)
  }
  return canonical({
    functions: available.map(tool => ({ name: tool.name, ...(tool.description ? { description: tool.description } : {}), parameters: tool.schema })).sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0),
    native_aliases: Object.fromEntries([...aliases].map(([name, targets]) => [name, [...targets].sort()])),
  })
}

function renameFields(input, profile, target) {
  const properties = target.schema.properties ?? {}
  const output = new Map()
  for (const [key, value] of Object.entries(input)) {
    if (key === "explanation" && !Object.hasOwn(properties, key)) continue // Vendor rationale is not an execution option.
    const candidates = Object.hasOwn(properties, key) ? [key] : (Object.hasOwn(profile.fields, key) ? profile.fields[key] : []).filter(candidate => Object.hasOwn(properties, candidate))
    if (candidates.length > 1) throw new ToolArgumentError(`Ambiguous field mapping for ${key} in ${target.name}`)
    const mapped = candidates[0]
    if (!mapped) throw new ToolArgumentError(`Cannot preserve ${key} in the declared ${target.name} tool`)
    let converted = value
    if (profile.items && ["todos", "plan"].includes(mapped)) {
      const items = normalizeArguments(value, { type: "array", items: { type: "object" } })
      converted = items.map(item => renameFields(item, profile.items, { name: target.name, schema: properties[mapped].items ?? {} }))
    }
    converted = normalizeArguments(converted, properties[mapped])
    if (output.has(mapped) && JSON.stringify(output.get(mapped)) !== JSON.stringify(converted)) throw new ToolArgumentError(`Ambiguous ${mapped} in ${target.name}`)
    output.set(mapped, converted)
  }
  return Object.fromEntries(output)
}

// Ordered strategy registry: exact declared tools, equivalent named
// capabilities, then derived directory/shell operations. New capabilities
// belong in the profile table or a separately tested strategy.
export function clientToolCall(call, spec) {
  try { return adaptClientToolCall(call, spec) }
  catch (error) {
    if (error instanceof ToolArgumentError) throw new ToolContractError(call.name, error)
    throw error
  }
}

function adaptClientToolCall(call, spec) {
  if (!spec.enabled) throw new Error(`Comate requested a tool the client did not offer: ${call.name}`)
  const targets = declared(spec)
  const name = spec.byName.get(call.name)
  const direct = targets.find(target => target.name === name)
  const profile = RENAMED_TOOLS.find(profile => profile.native.includes(call.name))
  const errors = []
  if (direct) {
    try { return finish(direct, profile && direct.schema.properties ? renameFields(call.input, profile, direct) : call.input) } catch (error) { errors.push(error) }
  }
  if (profile) {
    for (const candidate of profile.client) {
      const target = targets.find(target => target.name === candidate)
      if (!target) continue
      try { return finish(target, renameFields(call.input, profile, target)) } catch (error) { errors.push(error) }
    }
  }
  const strategy = STRATEGIES.find(strategy => strategy.matches(call))
  if (strategy) {
    try { return strategy.adapt(call, spec) }
    catch (error) {
      if (!(error instanceof ToolArgumentError) || !errors.every(previous => previous instanceof ToolArgumentError)) throw error
      errors.push(error)
    }
  }
  if (errors.length) {
    const ErrorType = errors.every(error => error instanceof ToolArgumentError) ? ToolArgumentError : Error
    throw new ErrorType([...new Set(errors.map(error => error.message))].join("; "))
  }
  throw new UnofferedToolError(call.name)
}

const STRATEGIES = [
  { matches: isSearchCall, adapt: searchCall },
  { matches: call => call.name === "run_command" || SHELL_TOOLS.some(tool => tool.name === call.name), adapt: commandCall },
  { matches: call => call.name === "list_dir", adapt: directoryCall },
]

function directoryCall(call, spec) {
  const allowed = new Set(["target_directory", "path", "directory", "depth", "ignore_globs", "explanation"])
  const unknown = Object.entries(call.input).filter(([key]) => !allowed.has(key))
  if (unknown.length) throw new ToolArgumentError("Comate list_dir contains unsupported options: " + unknown.map(([key,value])=>key+":"+typeof value).join(", "))
  const paths = [call.input.target_directory, call.input.path, call.input.directory].filter(value => value !== undefined)
  if (paths.some(value => typeof value !== "string" || !value.trim() || value.includes("\0")) || new Set(paths).size > 1) throw new ToolArgumentError("Comate list_dir contains an invalid or ambiguous directory")
  const path = paths[0] ?? "."
  const rawDepth = call.input.depth ?? 1
  const depth = typeof rawDepth === "number" ? rawDepth : typeof rawDepth === "string" && /^\d+$/.test(rawDepth) ? Number(rawDepth) : NaN
  if (!Number.isSafeInteger(depth) || depth < 1 || depth > 64) throw new ToolArgumentError("Comate list_dir depth must be an integer from 1 to 64")
  const operand = path.startsWith("/") || path.startsWith("./") || path.startsWith("../") || path === "." || path === ".." ? path : "./" + path
  const ignores = directoryIgnores(call.input.ignore_globs)
  const command = ignores.length ? filteredDirectoryCommand(operand, depth, ignores) : depth === 1 ? `ls -la -- ${quote(path)}` : `find ${quote(operand)} -mindepth 1 -maxdepth ${depth} -print`
  for (const profile of SHELL_TOOLS) {
    const target = declared(spec).find(tool => tool.name === profile.name)
    if (!target || target.schema.properties?.[profile.command]?.type !== "string") continue
    const input = { [profile.command]: command }
    if (target.schema.properties.description?.type === "string") input.description = ignores.length ? "List directory entries to the requested depth, pruning ignored paths" : depth === 1 ? "List immediate directory entries including hidden files" : "List directory entries to the requested depth"
    try { return finish(target, input) } catch { /* Try another declared compatible shell. */ }
  }
  throw new ToolArgumentError("Comate requested list_dir, but the client offers no compatible directory-list or bash tool")
}

const escapeRegex = text => text.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")

function directoryIgnores(value) {
  if (value === undefined) return []
  const patterns = normalizeArguments(value, { type: "array", maxItems: 128, items: { type: "string" } })
  return patterns.map(pattern => {
    if (!pattern.length || pattern.length > 4096 || pattern.includes("\0")) throw new ToolArgumentError("Comate list_dir ignore_globs requires nonempty NUL-free glob strings of at most 4096 characters")
    // A list of exclusion globs, not a gitignore file or an extglob expression.
    if (pattern.startsWith("!") || /[{}]|[?*+@!]\(/.test(pattern)) throw new ToolArgumentError("Comate list_dir ignore_globs does not support negation, brace expansion or extglobs")
    const directoryOnly = pattern.endsWith("/")
    const anchored = pattern.startsWith("/") || pattern.startsWith("./")
    const glob = pattern.replace(/^(?:\.\/)+|^\//, "").replace(/\/+$/, "")
    if (!glob || glob.split("/").some(part => part === "." || part === ".." || !part)) throw new ToolArgumentError("Comate list_dir ignore_globs requires paths relative to the listed directory")
    let regex = !anchored && !glob.includes("/") ? "(.*/)?" : ""
    for (let i = 0; i < glob.length; i++) {
      const char = glob[i]
      if (char === "\\") {
        if (++i === glob.length) throw new ToolArgumentError("Comate list_dir ignore_globs has an incomplete escape")
        regex += escapeRegex(glob[i])
      } else if (char === "*") {
        let end = i + 1
        while (glob[end] === "*") end++
        const globstar = end - i > 1 && (i === 0 || glob[i - 1] === "/") && (end === glob.length || glob[end] === "/")
        if (globstar && glob[end] === "/") { regex += "([^/]+/)*"; end++ }
        else regex += globstar ? ".*" : "[^/]*"
        i = end - 1
      } else if (char === "?") regex += "[^/]"
      else if (char === "[") {
        const end = glob.indexOf("]", i + 1)
        const content = glob.slice(i + 1, end)
        if (end < 0 || !content || /[\\/\[\^]/.test(content) || content === "!") throw new ToolArgumentError("Comate list_dir ignore_globs contains an unsupported character class")
        const characterClass = "[" + (content.startsWith("!") ? "^/" + content.slice(1) : content) + "]"
        try {
          if (new RegExp(characterClass).test("/")) throw new ToolArgumentError("class includes a path separator")
        } catch { throw new ToolArgumentError("Comate list_dir ignore_globs contains an invalid character class") }
        regex += characterClass
        i = end
      } else if (char === "/" && glob.slice(i) === "/**") { regex += "(/.*)?"; break }
      else regex += escapeRegex(char)
    }
    return { regex, directoryOnly }
  })
}

function filteredDirectoryCommand(operand, depth, ignores) {
  const root = operand.replace(/\/+$/, "") || "/"
  const prefix = escapeRegex(root === "/" ? "/" : root + "/")
  const predicates = ignores.map(({ regex, directoryOnly }) => `\\( ${directoryOnly ? "-type d " : ""}-regex ${quote(prefix + regex)} \\)`)
  // BSD and GNU find use different switches for the same ERE dialect. Keep
  // matching/pruning inside the caller's shell; no new runtime dependency.
  return `case "$(uname -s)" in Darwin|*BSD|DragonFly) set -- -E ${quote(root)} ;; *) set -- ${quote(root)} -regextype posix-extended ;; esac; find "$@" -mindepth 1 -maxdepth ${depth} \\( ${predicates.join(" -o ")} \\) -prune -o -print`
}

function commandCall(call, spec) {
  const allowed = new Set(["command", "cmd", "description", "explanation", "cwd", "workdir", "working_directory", "target_directory", "timeoutMs", "timeout_ms", "run_in_background", "is_background", "should_wait"])
  const unknown = Object.keys(call.input).filter(key => !allowed.has(key))
  if (unknown.length) throw new ToolArgumentError("Comate shell call contains unsupported options: " + unknown.join(", "))
  const commands = [call.input.command, call.input.cmd].filter(value => value !== undefined)
  if (!commands.length || commands.some(value => typeof value !== "string" || !value.trim() || value.includes("\0")) || new Set(commands).size > 1) throw new ToolArgumentError("Comate shell call requires a nonempty, unambiguous command")
  const command = commands[0]
  const directories = [call.input.cwd, call.input.workdir, call.input.working_directory, call.input.target_directory].filter(value => value !== undefined)
  if (directories.some(value => typeof value !== "string" || !value.trim() || value.includes("\0")) || new Set(directories).size > 1) throw new ToolArgumentError("Comate run_command has an invalid or ambiguous working directory")
  const timeouts = [call.input.timeoutMs, call.input.timeout_ms].filter(value => value !== undefined).map(value => normalizeArguments(value, { type: "integer", minimum: 1 }))
  if (timeouts.some(value => !Number.isSafeInteger(value) || value <= 0) || new Set(timeouts).size > 1) throw new ToolArgumentError("Comate run_command has an invalid or ambiguous timeout")
  const backgrounds = [call.input.run_in_background, call.input.is_background].filter(value => value !== undefined).map(value => normalizeArguments(value, { type: "boolean" }))
  if (call.input.should_wait !== undefined) backgrounds.push(!normalizeArguments(call.input.should_wait, { type: "boolean" }))
  if (backgrounds.some(value => typeof value !== "boolean") || new Set(backgrounds).size > 1) throw new ToolArgumentError("Comate run_command has an invalid or ambiguous background option")
  const profiles = [...SHELL_TOOLS].sort((left, right) => Number(right.name === call.name) - Number(left.name === call.name))
  for (const profile of profiles) {
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
  throw new ToolArgumentError("Comate requested run_command, but the client offers no compatible bash tool for its parameters")
}

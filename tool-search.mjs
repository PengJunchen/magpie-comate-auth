import { normalizeArguments, ToolArgumentError } from "./tool-schema.mjs"
import { SHELL_TOOLS } from "./tool-profiles.mjs"

const quote = value => "'" + value.replaceAll("'", "'\\''") + "'"
const names = ["grep_content", "grep", "Grep"]
export const isSearchCall = call => names.includes(call.name)

// Search output modes are behavior, not ignorable presentation metadata.
// Prefer a declared search tool; derive an rg command only when that tool
// cannot express the requested options, still executed by the caller.
export function searchCall(call, spec) {
  const aliases = {
    pattern: "pattern", search_query: "pattern", query: "pattern",
    path: "path", target_directory: "path", include: "glob", glob: "glob",
    output_mode: "output_mode", type: "type", multiline: "multiline",
    "-i": "ignore_case", case_insensitive: "ignore_case", case_sensitive: "ignore_case", "-n": "line_number",
    "-A": "after", "-B": "before", "-C": "context",
    head_limit: "head_limit", offset: "offset",
  }
  const properties = {
    pattern: { type: "string", minLength: 1 }, path: { type: "string" }, glob: { type: "string" }, type: { type: "string" },
    output_mode: { type: "string", enum: ["content", "files_with_matches", "count"] },
    multiline: { type: "boolean" }, ignore_case: { type: "boolean" }, line_number: { type: "boolean" },
    after: { type: "integer", minimum: 0 }, before: { type: "integer", minimum: 0 }, context: { type: "integer", minimum: 0 },
    head_limit: { type: "integer", minimum: 0 }, offset: { type: "integer", minimum: 0 },
  }
  const options = {}
  for (const [key, value] of Object.entries(call.input)) {
    if (key === "explanation") continue
    if (!Object.hasOwn(aliases, key)) throw new ToolArgumentError(`Unsupported search option: ${key}`)
    const name = aliases[key]
    const parsed = normalizeArguments(value, properties[name])
    const normalized = key === "case_sensitive" ? !parsed : parsed
    if (Object.hasOwn(options, name) && options[name] !== normalized) throw new ToolArgumentError(`Ambiguous search option: ${name}`)
    options[name] = normalized
  }
  if (typeof options.pattern !== "string" || !options.pattern.length || Object.values(options).some(value => typeof value === "string" && value.includes("\0"))) throw new ToolArgumentError("Search requires a nonempty pattern and NUL-free string arguments")
  const targets = spec.tools.map(tool => ({ name: spec.byName.get(tool.function.name), schema: tool.function.parameters ?? {} }))
  const mode = options.output_mode ?? "content"
  // Harness-style grep has fixed content+line-number output. Only project
  // options whose meaning is already supplied by that capability.
  const neutral = { line_number: true, ignore_case: false, multiline: false, after: 0, before: 0, context: 0, offset: 0 }
  if (mode === "content" && Object.keys(options).every(key => ["pattern", "path", "glob", "output_mode"].includes(key) || Object.hasOwn(neutral, key) && options[key] === neutral[key])) {
    const target = targets.find(tool => tool.name === "grep" && tool.schema.properties?.pattern && !tool.schema.properties.output_mode)
    const globField = target && ["glob", "include"].find(key => Object.hasOwn(target.schema.properties, key))
    if (target && (options.glob === undefined || globField && options.glob.trim() && !options.glob.startsWith("!") && !options.glob.includes(","))) {
      const input = { pattern: options.pattern, ...(options.path !== undefined ? { path: options.path } : {}), ...(options.glob !== undefined ? { [globField]: options.glob } : {}) }
      try { return { name: target.name, input: normalizeArguments(input, target.schema) } } catch { /* Another declared capability may express this request. */ }
    }
  }
  const args = ["rg", "--color=never"]
  if (mode === "files_with_matches") args.push("--files-with-matches")
  else if (mode === "count") args.push("--count")
  else if (options.line_number !== false) args.push("--line-number")
  if (options.ignore_case) args.push("--ignore-case")
  if (options.multiline) args.push("--multiline", "--multiline-dotall")
  if (options.glob !== undefined) args.push(`--glob=${options.glob}`)
  if (options.type !== undefined) args.push(`--type=${options.type}`)
  for (const [key, flag] of [["after", "--after-context"], ["before", "--before-context"], ["context", "--context"]]) if (options[key] !== undefined) args.push(`${flag}=${options[key]}`)
  args.push(`--regexp=${options.pattern}`, "--", options.path ?? ".")
  let pipeline = args.map(quote).join(" ")
  if (options.offset || options.head_limit) {
    const start = (options.offset ?? 0) + 1
    const end = options.head_limit ? start + options.head_limit - 1 : null
    if (!Number.isSafeInteger(start) || end !== null && !Number.isSafeInteger(end)) throw new ToolArgumentError("Search pagination exceeds safe integer bounds")
    pipeline = `set -o pipefail; ${pipeline} | sed -n ${quote(end === null ? `${start},$p` : `${start},${end}p`)}`
  }
  // rg 1 means no matches, not a failed tool. Preserve actual errors (2+).
  const command = `${pipeline}; comate_search_status=$?; if [ "$comate_search_status" -eq 1 ]; then exit 0; else exit "$comate_search_status"; fi`
  for (const profile of SHELL_TOOLS) {
    const target = targets.find(tool => tool.name === profile.name)
    if (target?.schema.properties?.[profile.command]?.type !== "string") continue
    const input = { [profile.command]: command }
    if (target.schema.properties.description?.type === "string") input.description = `Search files using ${mode} output mode`
    try { return { name: target.name, input: normalizeArguments(input, target.schema) } } catch { /* Do not guess required arguments for a different shell. */ }
  }
  throw new ToolArgumentError(`Cannot preserve search output_mode=${mode} with the declared tools; a compatible search or shell capability is required`)
}

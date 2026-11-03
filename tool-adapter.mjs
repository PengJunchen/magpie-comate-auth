// Adapt vendor directory-list and command requests only when the caller offers a
// compatible shell tool. Never execute it here or widen caller permissions.
const quote = text => "'" + text.replaceAll("'", "'\\''") + "'"

export function clientToolCall(call, spec) {
  if (!spec.enabled) throw new Error(`Comate requested a tool the client did not offer: ${call.name}`)
  if (spec.byName.has(call.name)) return { name: call.name, input: call.input }
  if (call.name === "run_command") return commandCall(call, spec)
  if (call.name !== "list_dir") throw new Error(`Comate requested a tool the client did not offer: ${call.name}`)
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
  for (const tool of spec.tools) {
    const name = spec.byName.get(tool.function.name)
    if (!["bash", "Bash"].includes(name)) continue
    const schema = tool.function.parameters, props = schema?.properties
    if (props?.command?.type !== "string") continue
    const input = { command }
    if (props.description?.type === "string") input.description = depth === 1 ? "List immediate directory entries including hidden files" : "List directory entries to the requested depth"
    if ((schema.required ?? []).some(key => !Object.hasOwn(input, key))) continue
    return { name, input }
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
  const timeouts = [call.input.timeoutMs, call.input.timeout_ms].filter(value => value !== undefined)
  if (timeouts.some(value => !Number.isSafeInteger(value) || value <= 0) || new Set(timeouts).size > 1) throw new Error("Comate run_command has an invalid or ambiguous timeout")
  const backgrounds = [call.input.run_in_background, call.input.is_background, ...(call.input.should_wait === undefined ? [] : [!call.input.should_wait])].filter(value => value !== undefined)
  if ((call.input.should_wait !== undefined && typeof call.input.should_wait !== "boolean") || backgrounds.some(value => typeof value !== "boolean") || new Set(backgrounds).size > 1) throw new Error("Comate run_command has an invalid or ambiguous background option")
  for (const tool of spec.tools) {
    const name = spec.byName.get(tool.function.name)
    if (!["bash", "Bash"].includes(name)) continue
    const schema = tool.function.parameters, props = schema?.properties
    if (props?.command?.type !== "string") continue
    const input = { command }
    if (props.description?.type === "string") input.description = typeof call.input.description === "string" && call.input.description.trim() ? call.input.description : "Run the requested command in the client"
    if (directories.length) {
      const key = ["workdir", "cwd"].find(key => props[key]?.type === "string")
      if (!key) continue
      input[key] = directories[0]
    }
    if (timeouts.length) {
      const key = ["timeoutMs", "timeout_ms"].find(key => ["number", "integer"].includes(props[key]?.type))
      if (!key) continue
      input[key] = timeouts[0]
    }
    if (backgrounds.some(Boolean)) {
      if (props.run_in_background?.type !== "boolean") continue
      input.run_in_background = true
    }
    if ((schema.required ?? []).some(key => !Object.hasOwn(input, key))) continue
    return { name, input }
  }
  throw new Error("Comate requested run_command, but the client offers no compatible bash tool for its parameters")
}

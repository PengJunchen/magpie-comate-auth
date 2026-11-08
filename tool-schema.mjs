// Schema-directed wire normalization, deliberately narrower than a full JSON
// Schema implementation. No default values, value guessing, or string repairs.
const object = value => value !== null && typeof value === "object" && !Array.isArray(value)
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const matches = (type, value) => type === "object" ? object(value) : type === "array" ? Array.isArray(value) : type === "null" ? value === null : type === "integer" ? Number.isSafeInteger(value) : type === "number" ? typeof value === "number" && Number.isFinite(value) : typeof value === type
// Structured classification for failures at the adapter's validation boundary.
// The message describes the contract, never the rejected argument value.
export class ToolArgumentError extends Error {
  constructor(message) {
    super(message)
    this.name = "ToolArgumentError"
  }
}
const fail = (path, message) => { throw new ToolArgumentError(`Tool arguments ${path}: ${message}`) }

export function normalizeArguments(value, schema = {}) {
  function visit(input, rule, path, depth) {
    if (depth > 32) fail(path, "maximum nesting exceeded")
    if (rule === false) fail(path, "value is forbidden")
    if (!rule || typeof rule !== "object") return input
    if (rule.$ref?.startsWith("#/")) {
      const ref = rule.$ref.slice(2).split("/").reduce((node, key) => node && Object.hasOwn(node, key) ? node[key] : undefined, schema)
      if (ref) return visit(input, ref, path, depth + 1)
    }
    const variants = rule.anyOf ?? rule.oneOf
    if (Array.isArray(variants)) {
      const results = []
      for (const branch of variants) {
        try { results.push(visit(input, branch, path, depth + 1)) } catch { /* A different declared branch may match. */ }
      }
      if (!results.length) fail(path, "does not match a declared schema variant")
      if (results.some(result => !equal(result, results[0]))) fail(path, "ambiguous schema conversion")
      input = results[0]
    }
    const types = Array.isArray(rule.type) ? rule.type : rule.type ? [rule.type] : []
    if (types.length && !types.some(type => matches(type, input))) {
      if (typeof input !== "string" || types.includes("string")) fail(path, `expected ${types.join(" or ")}`)
      if (input.length > 256 * 1024) fail(path, "encoded JSON is too large")
      let parsed
      try { parsed = JSON.parse(input) } catch { fail(path, `expected valid JSON for ${types.join(" or ")}`) }
      if (!types.some(type => matches(type, parsed))) fail(path, `expected ${types.join(" or ")}`)
      input = parsed
    }
    if (Array.isArray(rule.enum) && !rule.enum.some(value => equal(value, input))) fail(path, "value is not in the declared enum")
    if (Object.hasOwn(rule, "const") && !equal(rule.const, input)) fail(path, "value does not match the declared constant")
    if (Array.isArray(input)) {
      if (rule.minItems !== undefined && input.length < rule.minItems || rule.maxItems !== undefined && input.length > rule.maxItems) fail(path, "array length is outside the declared bounds")
      return input.map((item, index) => visit(item, rule.prefixItems?.[index] ?? rule.items, `${path}[${index}]`, depth + 1))
    }
    if (object(input)) {
      for (const key of rule.required ?? []) if (!Object.hasOwn(input, key)) fail(path + "." + key, "required field is missing")
      return Object.fromEntries(Object.entries(input).map(([key, item]) => {
        const known = rule.properties && Object.hasOwn(rule.properties, key)
        if (!known && rule.additionalProperties === false) fail(path + "." + key, "undeclared field")
        return [key, visit(item, known ? rule.properties[key] : rule.additionalProperties, path + "." + key, depth + 1)]
      }))
    }
    if (typeof input === "number" && (rule.minimum !== undefined && input < rule.minimum || rule.maximum !== undefined && input > rule.maximum)) fail(path, "number is outside the declared bounds")
    return input
  }
  return visit(value, schema, "$", 0)
}

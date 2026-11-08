// Capability profiles describe wire equivalence, not the client's brand.
// A profile is usable only if the current request declares its target tool.
export const SHELL_TOOLS = [
  { name: "bash", command: "command", cwd: ["workdir", "cwd"], timeout: ["timeoutMs", "timeout_ms"] },
  { name: "Bash", command: "command", cwd: ["workdir", "cwd"], timeout: ["timeout", "timeoutMs", "timeout_ms"] },
  { name: "exec_command", command: "cmd", cwd: ["workdir"], timeout: [] },
]

const FILE_PATHS = ["path", "file_path", "target_file", "target_path"]
const fileFields = Object.fromEntries(FILE_PATHS.map(key => [key, FILE_PATHS]))
const directoryFields = { target_directory: ["path", "directory"], directory: ["path", "target_directory"], path: ["target_directory", "directory"] }

export const RENAMED_TOOLS = [
  { native: ["read_file", "read", "Read"], client: ["read", "Read", "read_file"], fields: fileFields },
  { native: ["write_file", "write", "Write"], client: ["write", "Write", "write_file"], fields: fileFields },
  { native: ["edit_file", "edit", "Edit"], client: ["edit", "Edit", "edit_file"], fields: fileFields },
  { native: ["ls"], client: ["ls"], fields: directoryFields },
  // Only path/depth aliases; a recursive glob is not a basename find pattern.
  { native: ["find"], client: ["find"], fields: { ...directoryFields, depth: ["max_depth"], max_depth: ["depth"] } },
  { native: ["glob_path", "glob", "Glob"], client: ["glob", "Glob", "glob_path"], fields: { target_directory: ["path"], glob_pattern: ["pattern"], pattern: ["pattern"] } },
  { native: ["grep_content", "grep", "Grep"], client: ["grep", "Grep", "grep_content"], fields: { ...directoryFields, search_query: ["pattern"], query: ["pattern"], include: ["glob"], glob: ["include"] } },
  { native: ["todo_write", "todowrite", "TodoWrite", "update_plan"], client: ["todo_write", "todowrite", "TodoWrite", "update_plan"], fields: { todos: ["todos", "plan"], plan: ["plan", "todos"] }, items: { fields: { content: ["content", "step"], step: ["step", "content"], status: ["status"] } } },
]

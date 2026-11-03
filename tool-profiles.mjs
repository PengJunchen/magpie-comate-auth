// Capability profiles describe wire equivalence, not the client's brand.
// A profile is usable only if the current request declares its target tool.
export const SHELL_TOOLS = [
  { name: "bash", command: "command", cwd: ["workdir", "cwd"], timeout: ["timeoutMs", "timeout_ms"] },
  { name: "Bash", command: "command", cwd: ["workdir", "cwd"], timeout: ["timeout", "timeoutMs", "timeout_ms"] },
  { name: "exec_command", command: "cmd", cwd: ["workdir"], timeout: [] },
]

export const RENAMED_TOOLS = [
  { native: ["read_file", "read", "Read"], client: ["read", "Read", "read_file"], fields: { target_file: ["file_path", "path"], path: ["file_path", "path"], file_path: ["file_path", "path"] } },
  { native: ["write_file", "write", "Write"], client: ["write", "Write", "write_file"], fields: { target_file: ["file_path", "path"], path: ["file_path", "path"], file_path: ["file_path", "path"] } },
  { native: ["edit_file", "edit", "Edit"], client: ["edit", "Edit", "edit_file"], fields: { target_path: ["file_path", "path"], path: ["file_path", "path"], file_path: ["file_path", "path"] } },
  { native: ["glob_path", "glob", "Glob"], client: ["glob", "Glob", "glob_path"], fields: { target_directory: ["path"], glob_pattern: ["pattern"], pattern: ["pattern"] } },
  { native: ["grep_content", "grep", "Grep"], client: ["grep", "Grep", "grep_content"], fields: { target_directory: ["path"], search_query: ["pattern"], query: ["pattern"] } },
  { native: ["todo_write", "todowrite", "TodoWrite", "update_plan"], client: ["todo_write", "todowrite", "TodoWrite", "update_plan"], fields: { todos: ["todos", "plan"], plan: ["plan", "todos"] }, items: { fields: { content: ["content", "step"], step: ["step", "content"], status: ["status"] } } },
]

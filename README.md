# Magpie Comate Auth — independent plugin

本地主线开发版本 `0.5.1`。通过 HTTPS 直接请求 Comate 云端，复用这台电脑的 Comate 登录态。
不调用 Comate 本地服务的会话、工具执行或取消接口；云端不可用时直接报错。
本插件独立维护，通过 Magpie 的非官方插件发现机制分发，未获官方市场审核批准。
仓库是公开的非 fork 项目，并带有 `magpie-plugin` GitHub topic。无需 npm 发布。

## 本机使用

```sh
magpie plugin add github:PengJunchen/magpie-comate-auth
magpie plugin login comate 1
```

选择 `Comate account (this computer)`，然后在 Magpie 中选择实时目录中的 `comate/<model ID>`。
也可在 Magpie → 插件 → 非官方 中查找此仓库并安装。GitHub 搜索索引及 Magpie 的十分钟缓存可能延迟显示。
插件升级后使用新会话测试，必要时重启 Magpie。
不需要 Comate 本地服务运行，但需可读的有效登录凭据和到 `https://comate.baidu.com` 的网络。
也支持手工输入 license。宿主会保存凭据；对话、系统提示、工具定义、图片、客户端返回的工具结果会发往 Comate 云端。
插件只读 Comate 设置，不修改该文件。macOS 默认位置为
`~/Library/Application Support/Comate/User/settings.json`；可用绝对路径 `COMATE_SETTINGS_PATH` 覆盖，支持 JSONC。
Windows/Linux 路径仍有单元测试，未做本版本原机验收。

## 工具和续聊

默认使用云端原生 conversation/task。Magpie 的 `chat.headers` 钩子将客户端 session ID
通过插件专用头传给插件；该头不发送给 Comate。同一账号、模型和会话的连续请求复用原 task，
只发送本轮新增输入。工具用云端原始函数名/参数发出，插件校验后转换为客户端 `tool_calls`；
客户端执行后，插件把返回的 call ID 映射到云端原始 ID，以 `toolUseResults` 原生回传。
原生工具结果可携带一张内联图片，客户端报告的执行失败会原样标为失败。
不会伪造执行成功，也不会把未声明工具交给客户端猜测。原生 `TOOL` 执行事件仍报错。
Comate 的 `list_dir` 若不在客户端目录内，但客户端提供参数兼容的 `bash`/`Bash`，
插件会将其转换为该客户端工具的 `ls -la -- '<目录>'` 调用，并补齐声明的 description。
目录作为完整 shell 字符串转义；原生 `depth` 支持 1–64 的整数或整数字符串，深度大于 1 时转换成有深度边界的 `find`。
不附加提权/审批绕过参数；仍由客户端的审批和沙箱控制执行。
工具结果回传时保留云端原始 `list_dir` 名称、ID 和参数。
同样，原生 `run_command` 转为客户端已声明的 `bash`/`Bash`，保留命令本身，并按客户端 schema 映射工作目录、超时和后台执行选项。
不执行插件内 shell、不生成成功结果、不增加提权参数；结果回传保留原生调用名及参数。
无兼容工具、`tool_choice:none`、歧义参数或无法保留的执行选项明确报错。

会话状态位于每个插件实例内，按账号、模型、session ID 隔离，最多保留 64 个会话。
同一会话正在生成时，再次提交返回 409，避免并发写坏云端任务。
没有 session ID、宿主重启/缓存淘汰、历史分叉、工具目录变更或中间有其他客户端产生的轮次时，
自动新建云端 task 并回放完整历史。失败、断流和取消会废弃受影响状态；待回传原生工具结果必须完整匹配 ID。
完整回放会重传历史图片，也会增加长历史的开销；正常原生续聊不重复上传已有图片。

支持文本、流式和非流式、`auto` / `none` / `required` / 指定函数。
工具参数需是 JSON 对象；不保证完整 JSON Schema 验证，拒绝 `strict: true`。
推理可返回，但不转发推理档位、temperature、max_tokens 等生成控制。
目录仅来自当前账号的云端实时列表，图片能力按该列表的 `supportImage` 字段展示；没有固定模型种子。

### 通用工具适配

插件按本次请求的工具目录工作，不依赖应用名称或固定的全局工具表。
`tool-adapter.mjs` 负责有序策略选择与结果关联；`tool-profiles.mjs` 声明等价能力及字段映射；
`tool-schema.mjs` 按客户端声明规范化参数并检查基础约束。`tool-search.mjs` 处理搜索输出模式和选项语义。
新增客户端通常只需增加能力描述或单独的策略及回归测试。

| 能力 | 已覆盖的客户端声明形式 |
| --- | --- |
| 命令/目录查看 | Harness `bash`、Claude Code `Bash`、Codex `exec_command` 的 `command`/`cmd` 及工作目录字段 |
| 文件操作 | `read`/`Read`、`write`/`Write`、`edit`/`Edit` 的路径字段；搜索用 `glob`/`Glob`、`grep`/`Grep` |
| 任务清单 | `todo_write`/`TodoWrite`/`todowrite`，以及 `update_plan` 的 `plan[].step` |

如果 schema 要求数组或对象而模型传来了合法 JSON 字符串，会解码并递归验证；如
`{"todos":"[{\"content\":\"检查工具\",\"status\":\"pending\"}]"}` 会变成真正的 todos 数组。
同理可处理声明为数值/布尔值的 JSON 编码标量。声明为字符串的命令、文件内容保持字符串，不按外观猜类型。
非法 JSON、类型不符、缺少 required 字段、enum 不符、歧义转换，以及无法保留的执行选项会报错。
这不是完整 JSON Schema 引擎，仍拒绝 `strict:true`；客户端仍负责最终参数和权限验证。

仅当前请求实际提供的工具才可能被选中，不创建不存在的能力，不降级绕过审批。
流式与非流式使用同一适配器，回传云端时保留原始工具名、参数及调用 ID，客户端参数转换不污染原始记录。
搜索支持 `content`、`files_with_matches`、`count`。优先使用能完整表达请求的客户端搜索工具；
Harness 固定内容搜索可等价接收 `content`，其他模式或额外选项则交给客户端已声明的 shell 执行转义后的 `rg`。
shell 路径需要客户端环境中可用的 ripgrep；插件不会在后台安装它或直接在本机执行搜索。
支持 glob/type、大小写、行号、上下文、跨行和输出分页；无匹配正常返回，非法正则及其他执行错误保留。
未知选项和没有可用表达能力的请求仍明确报错，不把文件列表、计数和内容三种语义混为一谈。
这里的 Codex/Claude Code 格式已通过兼容性测试；真实应用的完整联调范围以 VALIDATION.md 为准。

### 图片

支持 PNG、JPEG、WebP、GIF 的内联 base64：OpenAI `image_url` / `input_image`，
以及 Anthropic `image` + `source.type=base64`。
支持纯图片消息、文字与图片混合消息及工具图片结果。每次上传最多 5 张，每张解码后不超过 10 MiB。
图片通过 Comate 文件上传接口和 IMAGE contexts 传输，base64 不塞入文本提示。
不抓取远程图片 URL，不支持 PDF/文档/音视频；非法输入明确报错，不丢弃图片后降级成纯文本。

### 长任务

**没有生成总时限。** 持续输出的任务不会因运行超过五分钟而中断，用户仍可取消。
保留独立故障检测：元数据请求 15 秒、单张图片上传 30 秒、生成响应头 5 分钟，
流式首字节 5 分钟、收到首字节后连续无字节 3 分钟。每次收到字节（包括保活）重置空闲计时。
这些阶段/空闲预算不限制持续活动任务的累计时长。宿主、网关及调用客户端自身的限制独立存在。
云端请求拒绝重定向；创建会话/任务和执行 POST 不自动重试，防止重复提交含副作用的工具结果。

云端路径避免了旧桌面执行端点，但这不等同于服务端所有工具均关闭或社区已接受新方案。
真实 Codex/Claude Code 完整网关验收、维护者重新审核仍需分别记录。

## 验证

```sh
npm test
MAGPIE_HOST=/absolute/path/to/host.js MAGPIE_BUN=/absolute/path/to/bun npm test
```

`cloud.test.mjs` 和 `cloud-features.test.mjs` 验证新云端传输、原生续聊、图片及长任务，`cloud-host.test.mjs` 使用显式指定的生产 Magpie 宿主和假云端服务。
测试不会自行寻找邻近仓库。没有显式宿主/Bun 时宿主测试跳过。
`local-transport.fixture.mjs` 仅保留旧本地传输回归，未由生产入口导入，也不进入 npm 包。
旧 `models.test.mjs`、`protocol-transport.test.mjs` 和 `integration.test.mjs` 对它的测试不能作为新云端传输验收。
协议及发现测试继续覆盖两代实现的共有行为。

npm 载荷只有 LICENSE、README.md、index.mjs、cloud.mjs、cloud-session.mjs、tool-adapter.mjs、tool-profiles.mjs、tool-schema.mjs、tool-search.mjs、images.mjs、protocol.mjs、discovery.mjs、package.json。
没有安装器、二进制或生命周期脚本。当前使用 GitHub 分发；未来若发布 npm，也使用个人作用域包名。
详见源码中的 [VALIDATION.md](./VALIDATION.md)。

## 来源与维护

独立项目的运行源码来自 [PengJunchen/plugins](https://github.com/PengJunchen/plugins/tree/codex/comate-cloud-local-20261102/packages/comate) 提交 `48801b2`；保留 MIT 许可及贡献者声明。吸收 Liu-LingYu 0.2.13 的部分云端协议思路。后续以本仓库根目录源码和测试维护公开插件。

旧社区 PR [#77](https://github.com/magpie-community/plugins/pull/77) 已关闭；本项目不是该 PR 获批或市场重新上架的声明。

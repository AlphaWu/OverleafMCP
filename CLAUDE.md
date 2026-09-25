# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

Overleaf MCP 服务器：通过 Overleaf Git 集成，让 MCP 客户端（如 Claude Desktop）读取 Overleaf 项目的 LaTeX 文件、解析章节结构，并把章节级编辑推送回 Overleaf。纯 Node.js ESM 单文件实现，无构建步骤、无测试框架、无 lint 配置。

## 常用命令

```bash
npm install          # 安装依赖（唯一依赖是 @modelcontextprotocol/sdk）
npm start            # 启动服务器（stdio 传输，等待 stdin 上的 JSON-RPC）

# Shell 冒烟测试（无需 Claude Desktop）：
OVERLEAF_PROJECT_ID=... OVERLEAF_GIT_TOKEN=... node overleaf-mcp-server.js
# 成功标志：stderr 输出 "Overleaf MCP server running on stdio"

npm pack             # 打包成本地 tgz，用于发布前验证 npm 产物
```

## 架构要点

### 单文件服务器（overleaf-mcp-server.js）

全部逻辑在一个文件里，分四层：

1. **`parseSections(content)`** — 纯函数 LaTeX 章节解析器。括号平衡算法，正确处理嵌套宏标题（如 `\section{Use of \emph{X}}`）、星号变体和 `[short]{long}` 短标题形式。返回 `{title, type, index}` 数组，`index` 是章节命令在原文中的字符偏移。
2. **配置加载（`loadProjectsConfig`）** — 按优先级取第一个匹配源：
   - 环境变量 `OVERLEAF_PROJECT_ID` + `OVERLEAF_GIT_TOKEN`（或 `OVERLEAF_GIT_TOKEN_FILE`）→ 合成单项目 `default` 配置；可选 `OVERLEAF_SERVER_URL` 指向自托管实例
   - `OVERLEAF_PROJECTS_CONFIG` 显式路径（不可读/非 JSON 时直接退出，不静默降级）
   - 用户配置目录 `projects.json`（Windows: `%APPDATA%\overleaf-mcp\`，其他: `$XDG_CONFIG_HOME/overleaf-mcp/` 或 `~/.config/overleaf-mcp/`）
   - `$CWD/projects.json` → 包目录 `projects.json`（遗留）
   - 环境变量优先于文件时，会向 stderr 输出遮蔽提示。未找到任何配置时打印可操作的帮助并退出。
   - 每个项目可设可选 `serverUrl`（自托管 Overleaf，如 `https://latex.example.edu`）；`normalizeServerUrl()` 将其归一化为 origin（剥离路径/查询），拒绝非 http(s)、含凭据或空白的值。缺省即官方 overleaf.com。
3. **`OverleafGitClient`** — 每个项目克隆到 `os.tmpdir()` 下：官方实例用 `overleaf-<projectId>`（历史路径不变），自托管实例用 `overleaf-<host>-<projectId>`（host 参与路径，避免不同服务器上相同 projectId 共用检出）。clone URL：官方 `https://git:<token>@git.overleaf.com/<id>`，自托管 `<origin>/git/<id>`。**每个工具调用都会先 `cloneOrPull()`**（有 `.git` 则 pull，否则 clone），保证读到的是远端最新状态。首次 clone 后设置本地 `user.email`/`user.name`，使无全局 git 配置的环境也能 commit。
4. **MCP 工具层** — 8 个工具：`list_projects`、`list_files`、`read_file`、`get_sections`、`get_section_content`、`status_summary`、`write_file`、`write_section`。所有工具接受可选 `projectName`（默认 `"default"`）。5 个读工具另接受可选 `projectNamePattern`（与 `projectName` 互斥）：正则匹配已配置的项目键名，经 `resolveProjectKeys()` 解析后由 `runOnMatchedProjects()` 逐项目执行，结果按项目键名分组返回 JSON，单项目失败隔离为 `{error}`。写工具刻意不支持正则——批量 push 多项目风险过高。

### 关键不变量

- **stdout 属于 MCP stdio 传输** — 一切诊断、警告、帮助信息只能写 stderr（`console.error`），任何 stray stdout 写入都会破坏 JSON-RPC 流。
- **快照一致性** — `getSectionContent`/`writeSection` 用单次 readFile 的内容同时做解析和拼接，避免两次 pull 之间远端变化导致章节偏移错位（TOCTOU）。
- **写操作流程** — pull → 写文件 → `git add` → `commit` → `push`。push 被 rejected（non-fast-forward）时抛出可重试的错误提示；pull 出 CONFLICT 时提示用户去 Overleaf 解决。所有 git 调用设 `GIT_TERMINAL_PROMPT=0` 防止挂起等待凭据。
- **writeSection 的替换范围** — 从目标章节起到下一个同级或更高级章节（或 `\end{document}`）为止。章节层级：part < chapter < section < subsection < subsubsection。
- **令牌安全** — `maskToken()` 把 `https://git:<token>@` 从错误消息中遮蔽后再返回给 MCP 客户端。克隆 URL 中的 token 永不进入工具响应。分组（`projectNamePattern`）模式下逐项目错误进入正常响应体、不经过外层 catch，必须在 `runOnMatchedProjects()` 内显式 `maskToken()`。
- **路径安全** — `resolveSafePath()` 把工具传入的 `filePath` 限制在克隆目录内，拒绝 `..` 穿越和绝对路径。
- **projectId 校验** — 配置加载时拒绝空值或含空白字符的 projectId（它同时用作路径组件和 Git URL）。

### 遗留文件

`overleaf-git-client.js` 是旧的 CommonJS 版本，**未被任何代码引用**，也不在 package.json 的 `files` 发布列表中。服务器内嵌的 ESM `OverleafGitClient` 类是当前实现；改动应在 `overleaf-mcp-server.js` 中进行。

## 安全注意事项

- `projects.json`、`.env` 已被 `.gitignore` 排除 — 永远不要提交真实的 project ID 或 Git token。
- 需要示例配置时使用 `projects.example.json` 作为模板。

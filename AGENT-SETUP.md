# Agent setup

把下面这段 prompt 粘给任意具备 shell 与文件读写能力的编码 agent（pi、Claude Code、Codex、Cursor 等），
它会自行完成安装、注册与校验，并把登录方式交回给你。

````text
Install and register the `shanbay-mcp` MCP server on this machine. Work through the steps in order and
report results; do not skip verification.

1. Preconditions
   - `bun --version` must be >= 1.2. If bun is missing, install it (prefer `mise install bun` if mise is
     present, otherwise https://bun.sh/install) and confirm `bun --version` works in a non-interactive shell.
   - `git` must be available.

2. Checkout
   - Clone https://github.com/kvoon3/shanbay-mcp into a stable directory: reuse the code directory already in
     use on this machine (e.g. ~/i, ~/code, ~/src) if there is one, otherwise ~/.local/share/shanbay-mcp.
   - Run `bun install` there, then `bun run typecheck` to confirm the checkout is sound. Stop on failure.

3. Register with the MCP client you are running in
   - Locate the configuration file instead of guessing — check in this order and stop at the first that exists:
     pi            ~/.pi/agent/mcp.json
     Claude Code   ./.mcp.json (project) or ~/.claude.json (user scope)
     Claude Desktop  ~/Library/Application Support/Claude/claude_desktop_config.json (macOS)
     Cursor        ./.cursor/mcp.json (project) or ~/.cursor/mcp.json (global)
     VS Code       ./.vscode/mcp.json
     Codex CLI     ~/.codex/config.toml  ([mcp_servers.shanbay] table)
   - If several exist or none do, ask the user which client to configure.
   - Back the file up first, then add this entry with absolute paths (bun's absolute path from `which bun`,
     and the checkout path from step 2), leaving every existing server entry untouched:

     { "mcpServers": { "shanbay": { "command": "<absolute path to bun>", "args": ["<checkout>/src/index.ts"] } } }

     Keep the file valid JSON/TOML. Never write a cookie or token into it.

4. Verify
   - From the checkout, confirm the server answers over stdio with exactly these 7 tools:
     login, account_status, lookup, check_words, add_words, list_words, remove_words

     { printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"setup-check","version":"1"}}}' \
                    '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
                    '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'; sleep 3; } \
       | bun src/index.ts 2>/dev/null | bun -e '
         const want = ["login","account_status","lookup","check_words","add_words","list_words","remove_words"]
         const got = []
         for (const line of (await Bun.stdin.text()).split("\n")) {
           if (!line.trim()) continue
           let m; try { m = JSON.parse(line) } catch { continue }
           for (const t of m.result?.tools ?? []) got.push(t.name)
         }
         const missing = want.filter((n) => !got.includes(n))
         console.log(`${got.length} tools: ${got.join(" ")}`)
         if (missing.length) { console.error(`MISSING: ${missing.join(" ")}`); process.exit(1) }
         '
   - If it fails, report the stderr output and stop; do not edit the server code to make it pass.

5. Hand off login (the server needs the user's Shanbay session; you cannot create one)
   - Never ask for the user's password, and never print or log a Cookie value.
   - Tell the user the three options, in this order of preference:
     a. run `sb login` and paste a browser cURL (this is the shanbay-cli path; the cookie file is shared)
     b. call the `login` tool with the text of a "Copy as cURL" request from https://web.shanbay.com/wordsweb/
     c. export SHANBAY_COOKIE='csrftoken=…; auth_token=…' for the client process
   - After the user logs in, call `account_status` and report the account name, token expiry, collection size,
     and today's new/review counts.

Report at the end: checkout path, bun path, the config file you edited with the exact entry added, the
verification output, and the login instruction you gave. Do not commit anything to the user's dotfiles repository.
````

几点说明：

- 第 3 步的路径清单按「先项目级、后全局」排列，agent 遇到多个配置时应询问而不是同时写。
- 第 4 步的校验只看 `tools/list`，不触发任何写操作，也不需要登录态，因此可以在拿到 Cookie 之前跑。
- 第 5 步刻意禁止 agent 接触密码或回显 Cookie：登录态只存在 `~/.config/shanbay-cli/cookie`（0600）里。

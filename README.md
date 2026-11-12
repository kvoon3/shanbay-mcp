# shanbay-mcp

把生词加入[扇贝](https://web.shanbay.com/wordsweb/)生词本的 MCP server。

扇贝 web 端使用一套私有 apiv3；`src/decode.ts` 负责其 `{"data":"<bayDecode>"}` 混淆响应的编解码。
登录态与 [shanbay-cli](https://github.com/3b391433/shanbay-cli)（`sb`）共用同一个 cookie 文件。

## 工具

| 工具 | 说明 |
|---|---|
| `login` | 用浏览器 Cookie / cURL 登录，写入 `~/.config/shanbay-cli/cookie`（0600） |
| `account_status` | 账号、token 过期时间、生词本词数、今日新词与待复习 |
| `lookup` | 查词：释义、词性、音标、例句，并标明是否已在生词本 |
| `check_words` | 批量查重：词库是否存在、生词本是否已有 |
| `add_words` | 批量添加生词，自动去重，按 100 词分批，返回未添加的词 |
| `list_words` | 分页浏览生词本 |
| `remove_words` | 移除生词，需 `confirm: true` |

## 安装

```bash
git clone https://github.com/kvoon3/shanbay-mcp
cd shanbay-mcp
bun install
```

需要 [Bun](https://bun.sh) ≥ 1.2。无需构建，直接运行 TypeScript。
交给 agent 自动完成安装与注册：[AGENT-SETUP.md](AGENT-SETUP.md)（可粘贴的 prompt）。

## 登录

以下任选其一，均写入 `~/.config/shanbay-cli/cookie`：

1. `sb login`，粘贴浏览器复制的 cURL（推荐，与 CLI 共用）
2. 调用 `login` 工具，参数为 cURL 文本或裸 Cookie 字符串
3. 设置 `SHANBAY_COOKIE='csrftoken=…; auth_token=…'`（仅当前进程有效）

获取 Cookie：登录 <https://web.shanbay.com/wordsweb/>，打开开发者工具的「网络」面板，任选一条
`apiv3.shanbay.com` 请求，右键「复制为 cURL」。`auth_token` 有效期约三个月，过期后重新登录即可。

## 接入 MCP 客户端

pi（`~/.pi/agent/mcp.json`）：

```json
{
  "mcpServers": {
    "shanbay": {
      "command": "bun",
      "args": ["/absolute/path/to/shanbay-mcp/src/index.ts"]
    }
  }
}
```

修改后执行 `/reload`，用 `/mcp` 确认连接。Claude Desktop、Cursor 配置相同；GUI 应用不继承 shell 的
PATH，建议 `command` 填 `bun` 的绝对路径（`which bun`）。

设置 `SHANBAY_DEBUG=1` 可将全部请求与响应输出到 stderr。

## 自建部署（Cloudflare Workers）

除本地 stdio，也可以在 Workers 上跑一份，供手机或其他设备使用：

```bash
# 登录态：把本机 sb 的 cookie 文件直接推进去（也可省略重定向，改为交互粘贴）
bunx wrangler secret put SHANBAY_COOKIE < ~/.config/shanbay-cli/cookie

bunx wrangler secret put MCP_AUTH_TOKEN    # 自己生成，例如 openssl rand -hex 24
bunx wrangler deploy
```

`auth_token` 过期（约三个月）后重跑第一条即可，无需改代码或重新部署。

- `POST /mcp` 为 MCP 端点（Streamable HTTP，无状态），`GET /health` 用于探活。
- 每个请求都要带 `Authorization: Bearer <MCP_AUTH_TOKEN>`；未配置该 Secret 时 Worker 返回 500，不会裸奔。
- Worker 不写盘，`login` 工具在该模式下只返回提示；登录态过期后重新执行一次 `secret put`。

客户端用 header 认证：

```json
"shanbay": {
  "url": "https://<your-worker>/mcp",
  "headers": { "Authorization": "Bearer ${SHANBAY_MCP_TOKEN}" }
}
```

本地调试：`bun run dev:worker`，读取 `.dev.vars`（已 gitignore）。

## 开发

```bash
bun test            # 单元测试（离线）
bun run typecheck   # tsc --noEmit
bun src/index.ts    # 本地启动 stdio server
```

```
src/decode.ts               bayDecode 编解码（TinyMT PRNG + base32 前缀树）
src/auth.ts                 cookie 读取、解析、保存
src/api.ts                  apiv3 客户端：词条查询、生词本增删查、批量上传轮询
src/index.ts                MCP server 与 7 个工具
scripts/capture-fixture.ts  抓取真实响应到本地 testdata/
```

测试默认只依赖 `encode`/`decode` 往返，不包含任何第三方数据。如需验证解码器对线上响应仍然正确：

```bash
bun scripts/capture-fixture.ts serendipity   # 需已登录，写入 testdata/（已 gitignore）
bun test                                     # 追加 golden 校验：逐字节比对并重新加密还原原文
```

## 接口备忘（实测）

| 用途 | 请求 |
|---|---|
| 查词条 | `GET /wordsapp/words/vocab?word=` → `{"data": enc}`（不含 senses） |
| 释义 | `GET /wordsapp/words/vocab_senses?vocab_ids=1,2&dict_id=` → 解码，按 `vocabulary_id` 取 `senses` |
| 例句 | `GET /wordsapp/words/vocab_examples?vocab_ids=1,2&dict_id=` → 解码，`examples[].content_en` / `content_cn`（词头包在 `<vocab>` 中） |
| 加入生词本 | `POST /wordscollection/words` `{"vocab_id":"…","business_id":6}` |
| 批量加入 | `POST /wordscollection/words_bulk_upload` `{"business_id":6,"words":["a","b"]}` → `task_id`；轮询 `GET …?business_id=6&task_id=` 至 `status=4`，返回 `failed_words` |
| 批量查重 | `GET /wordscollection/words_check?vocab_ids=1,2` → `data.objects[].exists` |
| 列表 | `GET /wordscollection/words?page=1&ipp=20` |
| 移除 | `DELETE /wordscollection/words` `{"vocab_ids":[…]}` |
| 词数 | `GET /wordscollection/words?page=1&ipp=1` 的 `total`（`/words/count` 返回 `{"objects":null,"vocabulary":null}`） |

`business_id=6` 为 web 端生词本业务号；批量上传单次上限 100 词。

以上均为非官方接口，可能随扇贝改版失效，仅供个人账号自用。

## License

[MIT](LICENSE) © 2026 Kevin Kwong

## Credits

- [honwhy/shanbay-ext](https://github.com/honwhy/shanbay-ext) — `src/decode.ts` 移植自其 bayDecode 实现（MIT, © 2024 Honwhy Wang）
- [3b391433/shanbay-cli](https://github.com/3b391433/shanbay-cli) — 终端背单词工具，本项目与其共用登录态文件

第三方代码与许可详情见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。

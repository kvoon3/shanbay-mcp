# shanbay-mcp

扇贝（Shanbay）生词本的 MCP server — 边聊天边把遇到的新词扔进生词本。

MCP（Model Context Protocol）服务，暴露 7 个工具：

| 工具 | 作用 |
|---|---|
| `login` | 粘贴浏览器 Cookie / cURL 登录，写入 `~/.config/shanbay-cli/cookie`（0600） |
| `account_status` | 账号、token 过期时间、生词本词数、今日新词/待复习 |
| `lookup` | 查词：中英释义、词性、音标、例句，并告诉你是否已在生词本 |
| `check_words` | 批量查重：词库有没有、生词本有没有 |
| `add_words` | **批量加生词**（自动去重、每 100 个一批），返回没加进去的词 |
| `list_words` | 分页浏览生词本 |
| `remove_words` | 移除生词（需 `confirm: true`） |

## 为什么不直接用 shanbay-cli

[shanbay-cli](https://github.com/3b391433/shanbay-cli)（`sb`）解决的是「在终端里背单词」：拉取今日队列、评分、回写进度、打卡。
它**没有**往生词本添加词的能力。本项目补上这一段，并复用它的登录态（同一个 cookie 文件），所以 `sb login` 之后本服务直接可用。

接口来自扇贝 web 端（`web.shanbay.com/wordsweb`）的私有 apiv3：`wordscollection/*` 是生词本，
`wordsapp/words/*` 是词条。部分响应是 `{"data":"<bayDecode>"}` 的混淆字符串，`src/decode.ts` 是
[honwhy/shanbay-ext](https://github.com/honwhy/shanbay-ext)（MIT）里解码算法的 TypeScript 移植，
同时补了它的逆函数 `encode()`，所以解码器可以用自造数据做往返测试，不用把扇贝的词典内容塞进仓库。

`sb` 那个项目本身没有开源许可，因此本项目**没有复制它的任何代码**——它只是让我们看清了缺失的那一块是
「生词本接口」。详见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。

## 安装

```bash
git clone https://github.com/kvoon3/shanbay-mcp
cd shanbay-mcp
bun install
```

无需构建，`bun src/index.ts` 直接跑 TypeScript（需要 [Bun](https://bun.sh) ≥ 1.2）。

## 登录

任选一种，都写同一个文件：

1. `sb login` — 粘贴浏览器「复制为 cURL」（推荐）
2. 调 `login` 工具，参数传 cURL 文本或裸 Cookie 字符串
3. `export SHANBAY_COOKIE='csrftoken=...; auth_token=...'`（临时，不落盘）

取 cookie：浏览器打开 <https://web.shanbay.com/wordsweb/> 并登录 → F12 → 网络 → 任意 `apiv3.shanbay.com` 请求 → 右键「复制为 cURL」。
`auth_token` 约 3 个月过期，过期后重新登录一次。

## 注册到 MCP 客户端

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

改完在会话里跑 `/reload`，再用 `/mcp` 确认已连接。Claude Desktop / Cursor 同理——建议 `command`
写 `bun` 的绝对路径（`which bun`），GUI 应用不一定会继承你 shell 里的 PATH。

调试时加 `SHANBAY_DEBUG=1`，所有请求和响应会打到 stderr。

## 开发

```bash
bun test        # 解码 golden 向量 + cookie 解析
bun src/index.ts  # 本地起 stdio server，可直接喂 JSON-RPC
```

目录：

```
src/decode.ts   bayDecode 编解码（TinyMT PRNG + base32 前缀树），移植自 MIT 的 honwhy/shanbay-ext
src/auth.ts     cookie 读取/解析/保存（与 sb CLI 共用文件）
src/api.ts      apiv3 客户端：生词本增删查、词条查询、批量上传轮询
src/index.ts    MCP server 与 7 个工具
scripts/capture-fixture.ts  抓一份真实响应到本地 testdata/（可选，不入库）
```

想额外验证「解码器对线上响应仍然正确」：

```bash
bun scripts/capture-fixture.ts serendipity   # 需要已登录，写入 testdata/（.gitignore）
bun test                                     # 多跑一组 golden 校验：解码后逐字节比对 + 重新加密还原原文
```

`testdata/` 不进仓库：里面是扇贝的词典内容，抓不抓、留不留是你自己的事。默认测试用 `encode`/`decode`
往返自证，仓库里没有任何第三方内容。

## 接口备忘（实测）

| 用途 | 请求 |
|---|---|
| 查词条 | `GET /wordsapp/words/vocab?word=` → `{"data": enc}`（**没有** senses） |
| 释义 | `GET /wordsapp/words/vocab_senses?vocab_ids=1,2&dict_id=` → 解码，按 `vocabulary_id` 取 `senses` |
| 例句 | `GET /wordsapp/words/vocab_examples?vocab_ids=1,2&dict_id=` → 解码，`examples[].content_en/content_cn`（词头包在 `<vocab>` 里） |
| 加入生词本 | `POST /wordscollection/words` `{"vocab_id":"…","business_id":6}` |
| 批量加入 | `POST /wordscollection/words_bulk_upload` `{"business_id":6,"words":["a","b"]}` → `task_id`，然后 `GET …?business_id=6&task_id=` 轮询到 `status=4`，返回 `failed_words` |
| 批量查重 | `GET /wordscollection/words_check?vocab_ids=1,2` → `data.objects[].exists` |
| 列出 | `GET /wordscollection/words?page=1&ipp=20` |
| 移除 | `DELETE /wordscollection/words` `{"vocab_ids":[…]}` |
| 词数 | `GET /wordscollection/words?page=1&ipp=1` 的 `total`（`/words/count` 只返回 `{"objects":null,"vocabulary":null}`） |

`business_id=6` 是 web 端生词本用的业务号；批量上传单次上限 100 词（web 端硬限制）。

非官方接口，扇贝改版可能失效。仅供个人账号自用，别拿去做批量爬取。

## 许可

[MIT](LICENSE) © 2026 Kevin Kwong

解码算法移植自 [honwhy/shanbay-ext](https://github.com/honwhy/shanbay-ext)（MIT, © 2024 Honwhy Wang），
完整许可见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。
[shanbay-cli](https://github.com/3b391433/shanbay-cli) 未附许可，本项目未复制其代码，仅在致谢里注明启发。
与扇贝官方无关。

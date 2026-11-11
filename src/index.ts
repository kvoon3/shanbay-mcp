/**
 * shanbay-mcp — Model Context Protocol server for the Shanbay (扇贝) 生词本.
 *
 * Scope: everything about *collecting* words — look up a word, check whether it
 * is already in the collection, add one or many words, list them, remove them.
 * (Studying/reviewing stays in the `sb` CLI.)
 *
 * Auth reuses the cookie `sb login` writes, so no separate login setup.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import { z } from "zod"
import { ApiError, BULK_UPLOAD_LIMIT, Client, type CollectionEntry, type Vocabulary } from "./api.js"
import {
  AuthError,
  defaultCookiePath,
  isExpired,
  loadCredentials,
  parseCookieInput,
  saveCookie,
  type Credentials,
} from "./auth.js"

// ---------------------------------------------------------------------------
// helpers

let cached: { creds: Credentials; client: Client } | undefined

/** Credentials are read per call so `login` takes effect without a restart. */
async function getClient(): Promise<{ client: Client; creds: Credentials }> {
  if (!cached) {
    const creds = await loadCredentials()
    cached = { creds, client: new Client(creds) }
  }
  const { client, creds } = cached
  if (isExpired(creds)) {
    throw new AuthError(
      `扇贝登录态已于 ${creds.expiresAt?.toLocaleString()} 过期（auth_token 约 3 个月有效期）。请重新登录：`
        + `\n  - 调用 login 工具粘贴新的 cURL，或\n  - 运行 sb login`,
    )
  }
  return { client, creds }
}

function ok(text: string, json?: unknown): CallToolResult {
  const content: CallToolResult["content"] = [{ type: "text", text }]
  if (json !== undefined) content.push({ type: "text", text: "```json\n" + JSON.stringify(json, null, 2) + "\n```" })
  return { content }
}

function fail(err: unknown): CallToolResult {
  const message = err instanceof Error ? err.message : String(err)
  const hint = err instanceof AuthError ? "\n\n登录方式：login 工具（粘贴浏览器 cURL / Cookie），或 `sb login`。" : ""
  return { isError: true, content: [{ type: "text", text: `❌ ${message}${hint}` }] }
}

/** Accept an array, or newline/comma/semicolon separated text. */
function normalizeWords(input: string[] | string): string[] {
  const raw = Array.isArray(input) ? input : input.split(/[\n,;]+/)
  const seen = new Set<string>()
  const out: string[] = []
  for (const item of raw) {
    const word = item
      .replace(/[\u200b-\u200d\ufeff]/g, "")
      .replace(/^[\s"'“”‘’([{<.,!?]+/, "")
      .replace(/[\s"'“”‘’)\]}>,.!?;:]+$/, "")
      .replace(/\s+/g, " ")
      .trim()
    if (!word) continue
    const key = word.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(word)
  }
  return out
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

async function pMap<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = next++
      if (index >= items.length) return
      results[index] = await fn(items[index]!)
    }
  })
  await Promise.all(workers)
  return results
}

function sensesText(v: Vocabulary | CollectionEntry | undefined): string {
  const senses = (v?.senses ?? []) as Array<{ pos?: string; definition_cn?: string; definition_en?: string }>
  return senses
    .map((s) => [s.pos, s.definition_cn ?? s.definition_en].filter(Boolean).join(" "))
    .filter(Boolean)
    .join("；")
}

function ipaText(v: Vocabulary | CollectionEntry | undefined): string {
  const sound = (v?.sound ?? {}) as { ipa_uk?: string; ipa_us?: string }
  return [sound.ipa_uk && `UK /${sound.ipa_uk}/`, sound.ipa_us && `US /${sound.ipa_us}/`].filter(Boolean).join("  ")
}

/** Examples are `{content_en, content_cn}` with the headword wrapped in <vocab>. */
function stripVocabTags(s: string): string {
  return s.replace(/<\/?vocab[^>]*>/g, "")
}

function firstExample(examples: unknown[] | undefined): { en: string; cn?: string } | undefined {
  for (const e of examples ?? []) {
    if (typeof e === "string" && e) return { en: e }
    if (!e || typeof e !== "object") continue
    const o = e as Record<string, unknown>
    const en = o.content_en ?? o.content_en_v2 ?? o.example_en ?? o.en ?? o.sentence ?? o.example
    if (typeof en === "string" && en) {
      return { en: stripVocabTags(en), cn: typeof o.content_cn === "string" ? o.content_cn : undefined }
    }
  }
  return undefined
}

// ---------------------------------------------------------------------------
// server

/**
 * Register a tool through a loosely-typed helper. The SDK's `registerTool`
 * generics infer zod output types, which makes `tsc` either take gigabytes of
 * heap or bail with TS2589 on the bigger schemas. Arguments are validated by
 * zod at runtime regardless, so the wrapper only costs us compile-time inference.
 */
type ToolConfig = {
  title?: string
  description?: string
  inputSchema?: Record<string, z.ZodTypeAny>
  annotations?: {
    readOnlyHint?: boolean
    destructiveHint?: boolean
    idempotentHint?: boolean
    openWorldHint?: boolean
  }
}

const server = new McpServer(
  { name: "shanbay", version: "0.1.0" },
  {
    instructions:
      "扇贝（Shanbay）生词本工具。用户可以边聊边把遇到的新词加进扇贝生词本。\n"
      + "典型用法：add_words 批量添加（自动去重、单次最多 100 个），lookup 查释义/音标/例句，"
      + "check_words 查某个词是否已在词库/生词本，list_words 浏览生词本，remove_words 移除。\n"
      + "登录态与 sb CLI 共用 ~/.config/shanbay-cli/cookie。",
  },
)

// biome-ignore lint/suspicious/noExplicitAny: see ToolConfig note above
function register(name: string, config: ToolConfig, handler: (args: any) => Promise<CallToolResult>): void {
  // biome-ignore lint/suspicious/noExplicitAny: the SDK's generic signature is intentionally bypassed
  server.registerTool(name, config as any, handler as any)
}

register(
  "login",
  {
    title: "登录扇贝",
    description:
      "用浏览器 Cookie 登录扇贝。参数 input 可以是浏览器「复制为 cURL」的整条命令，也可以是裸 Cookie 字符串"
      + "（需含 csrftoken 与 auth_token）。Cookie 会写入 ~/.config/shanbay-cli/cookie（0600），与 sb CLI 共用。",
    inputSchema: {
      input: z.string().describe("浏览器 Copy as cURL 的命令文本，或裸 Cookie 字符串"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  },
  async ({ input }) => {
    try {
      const cookie = parseCookieInput(input)
      const creds = await saveCookie(cookie)
      cached = { creds, client: new Client(creds) }
      // Verify the cookie actually works before claiming success.
      try {
        await cached.client.collectionCount()
      } catch (err) {
        if (err instanceof AuthError) {
          return fail(new AuthError(`Cookie 已保存到 ${defaultCookiePath()}，但服务端拒绝：登录态无效。`))
        }
        // Other errors (e.g. 404 on count) still mean auth passed.
      }
      const who = creds.username ? `${creds.username} (id ${creds.userId})` : `id ${creds.userId ?? "未知"}`
      const exp = creds.expiresAt ? creds.expiresAt.toLocaleString() : "未知"
      return ok(`✅ 登录成功：${who}\nCookie 已保存到 ${defaultCookiePath()}（0600）\ntoken 过期时间：${exp}`)
    } catch (err) {
      return fail(err)
    }
  },
)

register(
  "account_status",
  {
    title: "账号与生词本状态",
    description: "查看当前登录账号、token 过期时间、生词本词数、今日待学/待复习数量。",
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  async () => {
    try {
      const { client, creds } = await getClient()
      const [count, learning] = await Promise.all([
        client.collectionCount().catch(() => undefined),
        client.learningCounts().catch(() => ({ newCount: undefined, reviewCount: undefined })),
      ])
      const lines = [
        `账号：${creds.username ?? "未知"}${creds.userId ? ` (id ${creds.userId})` : ""}`,
        `登录态来源：${creds.source}`,
        `token 过期：${creds.expiresAt ? creds.expiresAt.toLocaleString() : "未知"}`,
        `生词本词数：${count ?? "未知"}`,
        `今日新词：${learning.newCount ?? "未知"}　待复习：${learning.reviewCount ?? "未知"}`,
      ]
      return ok(lines.join("\n"), { username: creds.username, userId: creds.userId, count, ...learning })
    } catch (err) {
      return fail(err)
    }
  },
)

register(
  "lookup",
  {
    title: "查词",
    description:
      "查单词或短语在扇贝词库里的释义（中/英）、词性、音标，可选例句，并返回它是否已在生词本里。",
    inputSchema: {
      word: z.string().min(1).describe("要查的单词或短语，例如 serendipity"),
      examples: z.boolean().optional().describe("是否附带例句（默认 true）"),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ word, examples }) => {
    try {
      const { client } = await getClient()
      const vocab = await client.lookupVocab(word)
      if (!vocab) return ok(`「${word}」不在扇贝词库中（可能是拼写错误，或该词条未收录）。`, { word, found: false })
      const id = String(vocab.id ?? "")

      const withExamples = examples !== false
      const [examplesMap, collected] = await Promise.all([
        withExamples && id
          ? client.vocabExamples([id]).catch(() => ({}) as Record<string, unknown[]>)
          : Promise.resolve({} as Record<string, unknown[]>),
        id ? client.wordsCheck([id]).catch(() => ({}) as Record<string, boolean>) : Promise.resolve({} as Record<string, boolean>),
      ])
      const inCollection = Boolean(collected[id])
      const example = firstExample(examplesMap[id])

      const senseLines = (vocab.senses ?? [])
        .map((x) => `- ${[x.pos, x.definition_cn ?? x.definition_en].filter(Boolean).join(" ")}`.trim())
        .filter((x) => x !== "-")
      const lines = [
        `**${vocab.word ?? word}**  ${ipaText(vocab)}`.trim(),
        senseLines.length ? senseLines.join("\n") : "（无释义）",
      ]
      if (example) lines.push(`例：${example.en}${example.cn ? `\n　　${example.cn}` : ""}`)
      lines.push(inCollection ? "📌 已在生词本里" : "🆕 还没加入生词本")

      return ok(lines.join("\n"), {
        word: vocab.word ?? word,
        vocabId: id,
        collected: inCollection,
        ipa: { uk: vocab.sound?.ipa_uk, us: vocab.sound?.ipa_us },
        senses: vocab.senses ?? [],
        example,
      })
    } catch (err) {
      return fail(err)
    }
  },
)

register(
  "check_words",
  {
    title: "批量查重",
    description: "检查一组词：扇贝词库里有没有、是否已经在生词本里。添加前先用它过滤能省一次上传。",
    inputSchema: {
      words: z.array(z.string().min(1)).min(1).max(200).describe("要检查的单词列表"),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ words }) => {
    try {
      const { client } = await getClient()
      const unique = normalizeWords(words)
      const v = await pMap(unique, 6, async (w) => ({ word: w, vocab: await client.lookupVocab(w).catch(() => undefined) }))
      const ids = v.map((x) => x.vocab?.id).filter((id): id is string => Boolean(id)).map(String)
      const collected = await client.wordsCheck(ids).catch(() => ({}) as Record<string, boolean>)

      const rows = v.map((x) => ({
        word: x.word,
        inDictionary: Boolean(x.vocab?.id),
        inCollection: x.vocab?.id ? Boolean(collected[String(x.vocab.id)]) : false,
        vocabId: x.vocab?.id ? String(x.vocab.id) : undefined,
        meaning: sensesText(x.vocab),
      }))

      const notFound = rows.filter((r) => !r.inDictionary).length
      const already = rows.filter((r) => r.inCollection).length
      const todo = rows.length - notFound - already
      const table = rows
        .map(
          (r) =>
            `- ${r.word}: ${r.inCollection ? "✅ 已在生词本" : r.inDictionary ? "🆕 待添加" : "❔ 词库无此词"}${
              r.meaning ? ` — ${r.meaning}` : ""
            }`,
        )
        .join("\n")
      return ok(
        `共 ${rows.length} 个：待添加 ${todo}，已在生词本 ${already}，词库没有 ${notFound}\n${table}`,
        rows,
      )
    } catch (err) {
      return fail(err)
    }
  },
)

register(
  "add_words",
  {
    title: "添加生词",
    description:
      "把单词加入扇贝生词本（这就是「加生词」）。自动去重、自动按 100 个分批上传，返回服务端没认出来的词。"
      + "words 传数组，text 传一段文本（按换行/逗号切分），两者可只传一个。",
    inputSchema: {
      words: z.array(z.string().min(1)).max(500).optional().describe("要添加的单词/短语数组"),
      text: z.string().optional().describe("一整段文本，按换行、逗号、分号切分成单词"),
      dryRun: z.boolean().optional().describe("只检查不写入（默认 false）"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  },
  async ({ words, text, dryRun }) => {
    try {
      const { client } = await getClient()
      const input = [...(words ?? []), ...(text ? [text] : [])]
      const list = normalizeWords(input)
      if (list.length === 0) return ok("没有解析出任何单词。")

      if (dryRun) {
        const checked = await pMap(list.slice(0, 50), 6, async (w) => ({
          word: w,
          vocab: await client.lookupVocab(w).catch(() => undefined),
        }))
        const missing = checked.filter((c) => !c.vocab)
        return ok(
          `[dry-run] 将尝试添加 ${list.length} 个词；抽样检查 ${checked.length} 个，其中 ${missing.length} 个词库没有：`
            + (missing.length ? `\n${missing.map((m) => `- ${m.word}`).join("\n")}` : "\n（无）"),
          { count: list.length, notInDictionary: missing.map((m) => m.word) },
        )
      }

      // One word: use the precise single-item endpoint so we can report
      // "already collected" vs "not in dictionary" instead of a batch verdict.
      if (list.length === 1) {
        const word = list[0]!
        const vocab = await client.lookupVocab(word)
        if (!vocab?.id) return ok(`「${word}」不在扇贝词库中（拼写问题或该词条未收录），没有添加。`)
        const id = String(vocab.id)
        const collected = await client.wordsCheck([id]).catch(() => ({}) as Record<string, boolean>)
        if (collected[id]) return ok(`「${vocab.word ?? word}」已经在生词本里了，无需重复添加。`, { word, vocabId: id, alreadyCollected: true })
        await client.collect(id)
        return ok(`✅ 已加入生词本：**${vocab.word ?? word}**${sensesText(vocab) ? ` — ${sensesText(vocab)}` : ""}`, {
          word: vocab.word ?? word,
          vocabId: id,
          added: true,
        })
      }

      const before = await client.collectionCount().catch(() => undefined)
      const chunks = chunk(list, BULK_UPLOAD_LIMIT)
      const failed: string[] = []
      const batches: Array<{ words: string[]; total: number; failed: string[] }> = []

      for (const group of chunks) {
        const res = await client.bulkUpload(group)
        batches.push({ words: group, ...res })
        failed.push(...res.failed)
      }

      const after = await client.collectionCount().catch(() => undefined)
      const failedKeys = new Set(failed.map((w) => w.toLowerCase()))
      const added = list.filter((w) => !failedKeys.has(w.toLowerCase()))

      // Diagnose the rejects: not in dictionary vs something else.
      const diagnosis = failed.length
        ? await pMap(failed.slice(0, 30), 6, async (w) => ({
            word: w,
            inDictionary: Boolean(await client.lookupVocab(w).catch(() => undefined)),
          }))
        : []

      const lines = [
        `添加完成：成功 ${added.length} / ${list.length}${failed.length ? `，未添加 ${failed.length}` : ""}`,
      ]
      if (before !== undefined && after !== undefined) lines.push(`生词本词数：${before} → ${after}`)
      if (failed.length) {
        lines.push(
          "未添加的词：",
          ...diagnosis.map((d) => `- ${d.word}${d.inDictionary ? "（词库有该词，但服务端未添加，稍后重试）" : "（词库无此词/拼写检查）"}`),
          ...(failed.length > diagnosis.length ? [`- …其余 ${failed.length - diagnosis.length} 个`] : []),
        )
      }
      return ok(lines.join("\n"), { requested: list.length, added, failed, before, after, batches })
    } catch (err) {
      return fail(err)
    }
  },
)

register(
  "list_words",
  {
    title: "浏览生词本",
    description: "分页列出扇贝生词本里的词（含释义）。",
    inputSchema: {
      page: z.number().int().min(1).optional().describe("页码，默认 1"),
      ipp: z.number().int().min(1).max(50).optional().describe("每页数量，默认 20"),
      filter: z.string().optional().describe("服务端过滤参数（一般留空）"),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ page, ipp, filter }) => {
    try {
      const { client } = await getClient()
      const res = await client.listWords({ page, ipp, filter })
      if (res.objects.length === 0) return ok("生词本是空的（或该页没有数据）。", res)
      const rows = res.objects.map((o) => {
        const nested = (o.vocabulary ?? o.vocab ?? {}) as CollectionEntry
        return {
          word: String(o.word ?? nested.word ?? o.vocabulary_id ?? o.id ?? ""),
          meaning: sensesText(o) || sensesText(nested),
          vocabId: String(o.vocabulary_id ?? nested.id ?? o.id ?? ""),
        }
      })
      const totalPages = Math.max(1, Math.ceil(res.total / res.ipp))
      return ok(
        `生词本共 ${res.total} 个词，第 ${res.page}/${totalPages} 页：\n`
          + rows.map((r) => `- **${r.word}**${r.meaning ? ` — ${r.meaning}` : ""}`).join("\n"),
        { ...res, objects: rows, raw: res.objects },
      )
    } catch (err) {
      return fail(err)
    }
  },
)

register(
  "remove_words",
  {
    title: "移除生词",
    description:
      "从扇贝生词本移除词。破坏性操作：confirm 必须为 true 才真正删除；confirm 缺省时只返回将被移除的清单。",
    inputSchema: {
      words: z.array(z.string().min(1)).min(1).max(100).describe("要移除的单词"),
      confirm: z.boolean().optional().describe("必须显式传 true 才会真正删除"),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  },
  async ({ words, confirm }) => {
    try {
      const { client } = await getClient()
      const list = normalizeWords(words)
      const resolved = await pMap(list, 6, async (w) => ({
        word: w,
        vocab: await client.lookupVocab(w).catch(() => undefined),
      }))
      const ids = resolved
        .map((r) => r.vocab?.id)
        .filter((id): id is string => Boolean(id))
        .map(String)
      const unresolved = resolved.filter((r) => !r.vocab).map((r) => r.word)

      if (ids.length === 0) {
        return ok(`这些词在扇贝词库里都查不到，无法定位生词本条目：${unresolved.join(", ") || "（空）"}`)
      }
      const collected = await client.wordsCheck(ids).catch(() => ({}) as Record<string, boolean>)
      const present = resolved.filter((r) => r.vocab?.id && collected[String(r.vocab.id)])
      const absent = resolved.filter((r) => r.vocab?.id && !collected[String(r.vocab.id)]).map((r) => r.word)

      if (!confirm) {
        return ok(
          `将要移除 ${present.length} 个词（confirm 未设置，未执行）：`
            + (present.length ? `\n${present.map((p) => `- ${p.word}`).join("\n")}` : "\n（无）")
            + (absent.length ? `\n不在生词本里：${absent.join(", ")}` : ""),
          { willRemove: present.map((p) => p.word), notInCollection: absent },
        )
      }

      const presentIds = present.map((p) => String(p.vocab!.id))
      for (const group of chunk(presentIds, 100)) await client.deleteWords(group)

      return ok(
        `已移除 ${presentIds.length} 个词${absent.length ? `；本来就不在生词本：${absent.join(", ")}` : ""}`
          + (unresolved.length ? `\n词库查不到、跳过：${unresolved.join(", ")}` : ""),
        { removed: present.map((p) => p.word), notInCollection: absent, unresolved },
      )
    } catch (err) {
      return fail(err)
    }
  },
)

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // ApiError with a 4xx body is usually a shape change on shanbay's side; keep it visible.
  process.on("unhandledRejection", (reason) => {
    if (reason instanceof ApiError) console.error(`[shanbay] api error: ${reason.message}`)
    else console.error("[shanbay] unhandled rejection:", reason)
  })
  await server.connect(new StdioServerTransport())
  console.error("[shanbay] MCP server ready (stdio). 登录态: " + defaultCookiePath())
}

main().catch((err) => {
  console.error("[shanbay] fatal:", err)
  process.exit(1)
})

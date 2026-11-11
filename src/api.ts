// Thin client for shanbay's private apiv3 endpoints.
//
// Two response families:
//   * plain JSON — word-collection (生词本) mutations and listings
//   * {"data": "<enc>"} — dictionary/learning payloads that must pass the
//     bayDecode decoder first (see ./decode.ts)
import { AuthError, type Credentials } from "./auth.js"
import { checkVersion, decode } from "./decode.js"

export const BASE_URL = "https://apiv3.shanbay.com"

/** 生词本 (user word collection) is business 6 in shanbay's web client. */
export const COLLECTION_BUSINESS_ID = 6

/** The web client rejects bulk uploads above this many words. */
export const BULK_UPLOAD_LIMIT = 100

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly body?: string,
  ) {
    super(message)
    this.name = "ApiError"
  }
}

/** 412: the server is still computing the day's learning data. */
export class DataNotReadyError extends ApiError {
  constructor(path: string) {
    super(`${path}: 扇贝后端还在准备今日数据 (HTTP 412)`, 412)
    this.name = "DataNotReadyError"
  }
}

export type Sense = {
  definition_cn?: string
  definition_en?: string
  pos?: string
  sequence?: number
}

export type Sound = {
  ipa_uk?: string
  ipa_us?: string
  audio_uk_urls?: string[]
  audio_us_urls?: string[]
}

export type Vocabulary = {
  id?: string
  word?: string
  vocabulary_id?: string
  senses?: Sense[]
  sound?: Sound
}

export type CollectionEntry = {
  id?: string
  vocabulary_id?: string
  word?: string
  senses?: Sense[]
  sound?: Sound
  [key: string]: unknown
}

export type CollectionPage = {
  page: number
  ipp: number
  total: number
  objects: CollectionEntry[]
}

export type BulkResult = { total: number; failed: string[] }

type Query = Record<string, string | number | undefined>

const DEBUG = Boolean(process.env.SHANBAY_DEBUG)

function buildUrl(path: string, query?: Query): string {
  const url = new URL(BASE_URL + path)
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== "") url.searchParams.set(k, String(v))
    }
  }
  return url.toString()
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export class Client {
  constructor(private readonly creds: Credentials) {}

  private headers(hasBody: boolean): Record<string, string> {
    const h: Record<string, string> = {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      Accept: "application/json, text/plain, */*",
      "X-CSRFToken": this.creds.csrf,
      Origin: "https://web.shanbay.com",
      Referer: "https://web.shanbay.com/",
      Cookie: this.creds.cookie,
    }
    if (hasBody) h["Content-Type"] = "application/json"
    return h
  }

  private async request(
    method: string,
    path: string,
    opts: { query?: Query; body?: unknown } = {},
  ): Promise<string> {
    const url = buildUrl(path, opts.query)
    const hasBody = opts.body !== undefined
    const res = await fetch(url, {
      method,
      headers: this.headers(hasBody),
      body: hasBody ? JSON.stringify(opts.body) : undefined,
      signal: AbortSignal.timeout(30_000),
    })
    const text = await res.text()
    if (DEBUG) console.error(`[shanbay] ${method} ${url} -> ${res.status} ${text.slice(0, 500)}`)

    if (res.status === 401 || res.status === 403) {
      throw new AuthError(`登录态失效 (HTTP ${res.status} on ${path})。请重新登录扇贝（login 工具或 sb login）。`)
    }
    if (res.status === 412) throw new DataNotReadyError(path)
    if (res.status >= 400) {
      throw new ApiError(`${path}: HTTP ${res.status}: ${text.slice(0, 300)}`, res.status, text)
    }
    return text
  }

  private async getPlain<T>(path: string, query?: Query): Promise<T> {
    const text = await this.request("GET", path, { query })
    return JSON.parse(text) as T
  }

  /** GET an endpoint whose body is {"data":"<bayDecode string>"}. */
  private async getDecoded<T>(path: string, query?: Query): Promise<T> {
    const text = await this.request("GET", path, { query })
    const env = JSON.parse(text) as { data?: unknown }
    if (env.data === undefined) return env as T
    if (typeof env.data !== "string") return env.data as T // already plain
    if (!checkVersion(env.data)) return env as T
    const plain = decode(env.data)
    try {
      return JSON.parse(plain) as T
    } catch {
      throw new ApiError(`${path}: 解码成功但不是合法 JSON: ${plain.slice(0, 200)}`)
    }
  }

  // --- word collection (生词本) ---

  /** Add one word to 生词本 by vocabulary id. */
  async collect(vocabId: string, bookType?: number): Promise<void> {
    await this.request("POST", "/wordscollection/words", {
      query: bookType === undefined ? undefined : { book_type: bookType },
      body: { vocab_id: vocabId, business_id: COLLECTION_BUSINESS_ID },
    })
  }

  /** Which of these vocabulary ids are already in 生词本. */
  async wordsCheck(vocabIds: string[], bookType?: number): Promise<Record<string, boolean>> {
    if (vocabIds.length === 0) return {}
    const res = await this.getPlain<{
      data?: { objects?: Array<{ id?: string; vocabulary_id?: string; vocab_id?: string; exists?: boolean }> }
      objects?: Array<{ id?: string; vocabulary_id?: string; vocab_id?: string; exists?: boolean }>
    }>("/wordscollection/words_check", { vocab_ids: vocabIds.join(","), book_type: bookType })
    const objects = res.data?.objects ?? res.objects ?? []
    const out: Record<string, boolean> = {}
    for (const o of objects) {
      const id = o.vocabulary_id ?? o.vocab_id ?? o.id
      if (id) out[String(id)] = Boolean(o.exists)
    }
    // The single-id call the web client makes only reads objects[0].
    if (vocabIds.length === 1 && Object.keys(out).length === 0 && objects[0]) {
      out[vocabIds[0]!] = Boolean(objects[0].exists)
    }
    return out
  }

  async listWords(params: { page?: number; ipp?: number; filter?: string } = {}): Promise<CollectionPage> {
    const res = await this.getPlain<Partial<CollectionPage> & { data?: Partial<CollectionPage> }>(
      "/wordscollection/words",
      { page: params.page ?? 1, ipp: params.ipp ?? 20, filter: params.filter },
    )
    const page = res.data ?? res
    return {
      page: Number(page.page ?? params.page ?? 1),
      ipp: Number(page.ipp ?? params.ipp ?? 20),
      total: Number(page.total ?? 0),
      objects: page.objects ?? [],
    }
  }

  /** Remove words from 生词本 by vocabulary id. */
  async deleteWords(vocabIds: string[], bookType?: number): Promise<void> {
    await this.request("DELETE", "/wordscollection/words", {
      query: bookType === undefined ? undefined : { book_type: bookType },
      body: { vocab_ids: vocabIds },
    })
  }

  /**
   * Bulk-add plain words (max 100 per call). Returns the server's task id, then
   * polls it until it reports completion and hands back the words it could not
   * resolve.
   */
  async bulkUpload(words: string[]): Promise<BulkResult> {
    const text = await this.request("POST", "/wordscollection/words_bulk_upload", {
      body: { business_id: COLLECTION_BUSINESS_ID, words },
    })
    const created = JSON.parse(text) as { task_id?: string | number }
    const taskId = created.task_id
    if (taskId === undefined || taskId === null || taskId === "") {
      throw new ApiError(`words_bulk_upload: 上传成功但没返回 task_id: ${text.slice(0, 300)}`)
    }

    let last: { status?: unknown; failed_words?: string; total_count?: unknown } = {}
    for (let attempt = 0; attempt < 20; attempt++) {
      if (attempt > 0) await sleep(500)
      last = await this.getPlain<typeof last>("/wordscollection/words_bulk_upload", {
        business_id: COLLECTION_BUSINESS_ID,
        task_id: taskId,
      })
      if (Number(last.status) === 4) {
        return {
          total: Number(last.total_count ?? words.length),
          failed: (last.failed_words ?? "")
            .split(",")
            .map((w) => w.trim())
            .filter(Boolean),
        }
      }
    }
    throw new ApiError(
      `words_bulk_upload: 任务 ${taskId} 超过 10 秒仍未完成（status=${String(last.status)}）`,
    )
  }

  // --- dictionary ---

  /** Dictionary entry for a word (decoded): senses, IPA, audio urls. */
  async lookupVocab(word: string): Promise<Vocabulary | undefined> {
    let v: Vocabulary
    try {
      v = await this.getDecoded<Vocabulary>("/wordsapp/words/vocab", { word })
    } catch (err) {
      // A miss surfaces as 404 on some endpoints; treat it as "not in dictionary".
      if (err instanceof ApiError && err.status === 404) return undefined
      throw err
    }
    if (!v || typeof v !== "object" || (!v.id && !v.word)) return undefined
    return v
  }

  /** Example sentences for vocabulary ids (decoded), keyed by vocab id. */
  async vocabExamples(vocabIds: string[], dictId?: string): Promise<Record<string, unknown[]>> {
    if (vocabIds.length === 0) return {}
    const res = await this.getDecoded<{ objects?: Array<Record<string, unknown>> }>(
      "/wordsapp/words/vocab_examples",
      { vocab_ids: vocabIds.join(","), dict_id: dictId },
    )
    const out: Record<string, unknown[]> = {}
    for (const o of res.objects ?? []) {
      const id = String(o.vocab_id ?? o.vocabulary_id ?? o.id ?? "")
      if (!id) continue
      out[id] = (o.examples as unknown[]) ?? (o.example as unknown[]) ?? []
    }
    return out
  }

  /** How many words sit in 生词本. */
  async collectionCount(): Promise<number | undefined> {
    const res = await this.getPlain<{ count?: number; value?: number; data?: { count?: number } }>(
      "/wordscollection/words/count",
    )
    const n = res.count ?? res.value ?? res.data?.count
    return n === undefined ? undefined : Number(n)
  }

  /** Today's NEW/REVIEW counts for the current book (learning queue). */
  async learningCounts(): Promise<{ newCount?: number; reviewCount?: number }> {
    const get = async (typeOf: string) => {
      const res = await this.getPlain<{ value?: number }>("/wordscollection/learning/count", {
        type_of: typeOf,
      })
      return res.value
    }
    const [newCount, reviewCount] = await Promise.all([
      get("NEW").catch(() => undefined),
      get("REVIEW").catch(() => undefined),
    ])
    return { newCount, reviewCount }
  }
}

/**
 * Capture a live apiv3 payload as a local golden fixture.
 *
 *   bun scripts/capture-fixture.ts serendipity
 *
 * Writes testdata/vocab_<word>.{enc,json}. The directory is gitignored on
 * purpose: the payload is Shanbay's dictionary content and would be yours to
 * redistribute, not ours. With fixtures present, `bun test` also asserts that
 * the decoder still matches reality and that re-encoding reproduces the exact
 * ciphertext.
 */
import { mkdir, writeFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { BASE_URL } from "../src/api.js"
import { loadCredentials } from "../src/auth.js"
import { decode } from "../src/decode.js"

const word = process.argv[2]
if (!word) {
  console.error("usage: bun scripts/capture-fixture.ts <word>")
  process.exit(1)
}

const creds = await loadCredentials()
const url = `${BASE_URL}/wordsapp/words/vocab?word=${encodeURIComponent(word)}`
const res = await fetch(url, {
  headers: {
    Accept: "application/json, text/plain, */*",
    "X-CSRFToken": creds.csrf,
    Origin: "https://web.shanbay.com",
    Referer: "https://web.shanbay.com/",
    Cookie: creds.cookie,
  },
})
if (!res.ok) {
  console.error(`${url} -> HTTP ${res.status} ${(await res.text()).slice(0, 200)}`)
  process.exit(1)
}

const body = (await res.json()) as { data?: string }
if (!body.data) {
  console.error("response has no data envelope — the endpoint shape may have changed")
  process.exit(1)
}

const plain = decode(body.data)
const dir = fileURLToPath(new URL("../testdata/", import.meta.url))
await mkdir(dir, { recursive: true })
const base = `vocab_${word.replace(/[^a-z0-9]+/gi, "_").toLowerCase()}`
await writeFile(`${dir}${base}.enc`, `${body.data}\n`)
await writeFile(`${dir}${base}.json`, plain)
console.log(`wrote testdata/${base}.enc (${body.data.length} bytes) and .json (${plain.length} bytes)`)

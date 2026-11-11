/**
 * Shanbay web's response decoder ("bayDecode"), plus its inverse (encoder).
 *
 * Ported from honwhy/shanbay-ext `src/entrypoints/decodes.js`
 * (MIT License, Copyright (c) 2024 Honwhy Wang — see THIRD-PARTY-NOTICES.md).
 * The upstream file also carries a commented-out `encode()`; {@link encode}
 * here is that function completed, so the decoder can be tested without
 * shipping captured user data.
 *
 * Several apiv3.shanbay.com endpoints (today_learning_items, learning_items,
 * vocab, vocab_senses, ...) return a body like {"data":"<enc>", ...} where
 * <enc> is a custom-encoded string. {@link decode} recovers the JSON inside.
 *
 * How it works:
 *
 *  1. enc[0:4] is a "sign" used to seed a TinyMT-style PRNG; checkVersion gates it.
 *  2. The PRNG deterministically assigns each of the 64 base64 characters a
 *     1- or 2-character base32 symbol, building a prefix tree (trie) of
 *     base32 -> base64.
 *  3. Walking the trie over enc[4:] recovers a standard base64 string.
 *  4. base64-decode that string -> UTF-8 JSON.
 *
 * Numbers: the reference implementation emulates uint32 with `x >>> 0` and a
 * hand-rolled truncating multiply. This port keeps the same shape — `Math.imul`
 * for the multiply, `>>> 0` after every add / xor / shift, logical `>>>` for
 * right shifts — because TinyMT is sensitive to every wraparound.
 *
 * Deviations from the reference (all deliberate, see the notes on each function):
 *   * garbage input that would loop forever upstream throws instead;
 *   * base64 decoding is strict (length % 4, padding shape, alphabet only);
 *   * a payload that is not encoded throws instead of returning "".
 */

const BAY_SH0 = 1
const BAY_SH1 = 10
const BAY_SH8 = 8
const BAY_MASK = 0x7fffffff
const MIN_LOOP = 8
const PRE_LOOP = 8
const VERSION = 1

const B32_CODE = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"
const B64_CODE = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"

/**
 * Base32 symbol length for the i-th base64 char: the first 10 chars get 1, the
 * rest get 2. Upstream writes `CNT[parseInt((i + 1) / 11, 10)]`, which is the
 * same table with a float-to-int cast.
 */
const SYMBOL_LEN = [1, 2, 2, 2, 2, 2]

/** Sign used by {@link encode} when the caller does not bring its own. */
const DEFAULT_SIGN = "AAAA"

/** Sign bytes are raw char codes, and the trie is built from them as base32. */
class Prng {
  private readonly status = new Uint32Array(4)
  private mat1 = 0
  private mat2 = 0
  private tmat = 0

  constructor(sign: Uint8Array) {
    for (let i = 0; i < 4; i++) {
      this.status[i] = i < sign.length ? sign[i]! : 110
    }
    this.mat1 = this.status[1]!
    this.mat2 = this.status[2]!
    this.tmat = this.status[3]!
    this.init()
  }

  private init(): void {
    for (let idx = 0; idx < MIN_LOOP - 1; idx++) {
      const i1 = (idx + 1) & 3
      const prev = this.status[idx & 3]!
      this.status[i1] =
        (this.status[i1]! ^ ((idx + 1 + Math.imul(1812433253, (prev ^ (prev >>> 30)) >>> 0)) >>> 0)) >>> 0
    }
    if ((this.status[0]! & BAY_MASK) === 0 && this.status[1] === 0 && this.status[2] === 0 && this.status[3] === 0) {
      this.status[0] = 66
      this.status[1] = 65
      this.status[2] = 89
      this.status[3] = 83
    }
    for (let i = 0; i < PRE_LOOP; i++) this.nextState()
  }

  private nextState(): void {
    const s0 = this.status[0]!
    const s1 = this.status[1]!
    const s2 = this.status[2]!
    let y = this.status[3]!
    let x = ((s0 & BAY_MASK) ^ ((s1 ^ s2) >>> 0)) >>> 0
    x = (x ^ ((x << BAY_SH0) >>> 0)) >>> 0
    y = (y ^ (((y >>> BAY_SH0) ^ x) >>> 0)) >>> 0
    // Upstream's destructuring shifts the old s1/s2 down one slot.
    this.status[0] = s1
    this.status[1] = s2
    this.status[2] = (x ^ ((y << BAY_SH1) >>> 0)) >>> 0
    this.status[3] = y
    const negative = (-(y & 1)) >>> 0 // 0 or 0xFFFFFFFF
    this.status[1] = (this.status[1]! ^ (negative & this.mat1)) >>> 0
    this.status[2] = (this.status[2]! ^ (negative & this.mat2)) >>> 0
  }

  generate(max: number): number {
    this.nextState()
    let t0 = this.status[3]!
    const t1 = (this.status[0]! ^ (this.status[2]! >>> BAY_SH8)) >>> 0
    t0 = (t0 ^ t1) >>> 0
    t0 = ((((-(t1 & 1)) >>> 0) & this.tmat) ^ t0) >>> 0
    return t0 % max
  }
}

type TrieNode = {
  /** base64 char this node stands for; "." while the node is still internal. */
  char: string
  children: Map<string, TrieNode>
}

const newNode = (): TrieNode => ({ char: ".", children: new Map() })

/**
 * The sign determines the whole base32 -> base64 mapping, so build it once per
 * call: the trie is a pure function of the sign.
 */
function buildTrie(sign: Uint8Array): { root: TrieNode; symbols: Map<string, string> } {
  const prng = new Prng(sign)
  const root = newNode()
  const symbols = new Map<string, string>()

  for (let i = 0; i < 64; i++) {
    const char = B64_CODE[i]!
    const length = SYMBOL_LEN[(i + 1) / 11 | 0]!
    let ptr = root
    let symbol = ""
    for (let level = 0; level < length; level++) {
      let inner = B32_CODE[prng.generate(32)]!
      // Retry on collision with an already-assigned leaf at this level.
      while (ptr.children.has(inner) && ptr.children.get(inner)!.char !== ".") {
        inner = B32_CODE[prng.generate(32)]!
      }
      symbol += inner
      if (!ptr.children.has(inner)) ptr.children.set(inner, newNode())
      ptr = ptr.children.get(inner)!
    }
    ptr.char = char
    symbols.set(char, symbol)
  }
  symbols.set("=", "=")
  return { root, symbols }
}

/**
 * Walk the trie over enc[4:] and emit the base64 characters it encodes.
 *
 * Upstream appends the current node's char and does not advance the index when
 * a byte matches no edge, which loops forever on garbage (e.g. a lowercase
 * letter or "8" — neither is ever an edge). Well-formed payloads cannot hit
 * that, so this throws instead of hanging.
 */
function decodeTrie(root: TrieNode, enc: Uint8Array): string {
  let out = ""
  for (let i = 4; i < enc.length; ) {
    const byte = String.fromCharCode(enc[i]!)
    if (byte === "=") {
      out += "="
      i++
      continue
    }
    let ptr = root
    let advanced = false
    while (i < enc.length) {
      const next = ptr.children.get(String.fromCharCode(enc[i]!))
      if (!next) break
      ptr = next
      i++
      advanced = true
    }
    if (!advanced) {
      throw new Error(`decode: no trie transition for byte 0x${enc[i]!.toString(16)} at offset ${i}`)
    }
    out += ptr.char
  }
  return out
}

const B64_INV: Int16Array = (() => {
  const table = new Int16Array(128).fill(-1)
  for (let i = 0; i < 64; i++) table[B64_CODE.charCodeAt(i)] = i
  return table
})()

const PAD = 0x3d

/**
 * Strict base64 (RFC 4648 §4) decode. Upstream leans on `Buffer.from(b64)`
 * which silently skips invalid bytes; strictness here turns a corrupt payload
 * into an error instead of mojibake. Exported for tests.
 */
export function base64Decode(raw: Uint8Array): Uint8Array {
  const n = raw.length
  if (n % 4 !== 0) {
    throw new Error(`decode: invalid base64 length ${n} (not a multiple of 4)`)
  }
  let pad = 0
  while (pad < 2 && n - 1 - pad >= 0 && raw[n - 1 - pad] === PAD) pad++
  const body = n - pad
  for (let i = 0; i < body; i++) {
    const c = raw[i]!
    if (c >= 128 || B64_INV[c]! < 0) {
      throw new Error(`decode: illegal base64 byte 0x${c.toString(16)} at offset ${i}`)
    }
  }
  if (pad > 0 && body % 4 !== 4 - pad) {
    throw new Error("decode: illegal base64 padding")
  }
  const out = new Uint8Array((n / 4) * 3 - pad)
  let o = 0
  for (let i = 0; i < n; i += 4) {
    const last = i + 4 === n
    const c0 = B64_INV[raw[i]!]!
    const c1 = B64_INV[raw[i + 1]!]!
    const c2 = last && raw[i + 2] === PAD ? 0 : B64_INV[raw[i + 2]!]!
    const c3 = last && raw[i + 3] === PAD ? 0 : B64_INV[raw[i + 3]!]!
    const triple = ((c0 << 18) | (c1 << 12) | (c2 << 6) | c3) >>> 0
    const bytes = last ? 3 - pad : 3
    if (bytes > 0) out[o++] = (triple >>> 16) & 0xff
    if (bytes > 1) out[o++] = (triple >>> 8) & 0xff
    if (bytes > 2) out[o++] = triple & 0xff
  }
  return out
}

const B64_CODE_INV = new Map<string, number>()
for (let i = 0; i < 64; i++) B64_CODE_INV.set(B64_CODE[i]!, i)

/**
 * Inverse of {@link decode}: wrap `payload` (JSON text) as a bayDecode string.
 * Upstream ships this commented out; it is useful for round-trip tests and for
 * re-encoding a decoded payload with another sign. Pass the sign to reproduce
 * a captured response byte for byte.
 */
export function encode(payload: string, sign = DEFAULT_SIGN): string {
  const signBytes = new TextEncoder().encode(sign)
  if (signBytes.length < 4) throw new Error(`encode: sign must be 4 base32 chars, got ${JSON.stringify(sign)}`)
  if (!checkVersion(sign.slice(0, 4))) {
    // Not every 4-byte sign passes the gate; such output would not decode.
    throw new Error(`encode: sign ${JSON.stringify(sign.slice(0, 4))} fails the version check`)
  }
  const { symbols } = buildTrie(signBytes.subarray(0, 4))

  const base64 = base64Encode(new TextEncoder().encode(payload))
  let out = sign.slice(0, 4)
  for (const char of base64) {
    const symbol = symbols.get(char)
    if (symbol === undefined) throw new Error(`encode: no symbol for ${JSON.stringify(char)}`)
    out += symbol
  }
  return out
}

const B64_CODE_BYTE = new TextEncoder().encode(B64_CODE)

function base64Encode(bytes: Uint8Array): string {
  let out = ""
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]!
    const b1 = bytes[i + 1]
    const b2 = bytes[i + 2]
    out += String.fromCharCode(B64_CODE_BYTE[b0 >> 2]!)
    out += String.fromCharCode(B64_CODE_BYTE[((b0 & 0x03) << 4) | ((b1 ?? 0) >> 4)]!)
    out += b1 === undefined ? "=" : String.fromCharCode(B64_CODE_BYTE[((b1 & 0x0f) << 2) | ((b2 ?? 0) >> 6)]!)
    out += b2 === undefined ? "=" : String.fromCharCode(B64_CODE_BYTE[b2 & 0x3f]!)
  }
  return out
}

function base32Index(c: number): number {
  // 'A'..'Z' -> 0..25, '2'..'7' -> 26..31
  return c >= 65 ? c - 65 : c - 65 + 41
}

/** True when `enc` looks like a bayDecode string rather than plain JSON. */
export function checkVersion(enc: string): boolean {
  if (enc.length < 4) return false
  const wi = base32Index(enc.charCodeAt(0)) * 32 + base32Index(enc.charCodeAt(1))
  const x = base32Index(enc.charCodeAt(2))
  const check = base32Index(enc.charCodeAt(3))
  let m = (wi * x + check) % 32
  if (m < 0) m += 32
  return VERSION >= m
}

const ERR_NOT_ENCODED = "decode: payload failed version check (not an encoded string)"
const utf8 = new TextDecoder("utf-8", { ignoreBOM: true })

/** Recover the JSON text hidden in a bayDecode string. */
export function decode(enc: string): string {
  if (!checkVersion(enc)) throw new Error(ERR_NOT_ENCODED)
  const bytes = new TextEncoder().encode(enc)
  const { root } = buildTrie(bytes.subarray(0, 4))
  return utf8.decode(base64Decode(new TextEncoder().encode(decodeTrie(root, bytes))))
}

/**
 * TypeScript port of shanbay web's response decoder ("bayDecode").
 *
 * Several apiv3.shanbay.com endpoints (today_learning_items, learning_items,
 * unlearned_items, ...) return a body like {"data":"<enc>", ...} where <enc>
 * is a custom-encoded string. {@link decode} recovers the underlying JSON.
 *
 * This is a line-by-line port of shanbay-cli/internal/decode/decode.go. The
 * algorithm (ported there from honwhy/shanbay-ext src/entrypoints/decodes.js):
 *
 *  1. enc[0:4] is a "sign" used to seed a TinyMT-style PRNG; checkVersion gates it.
 *  2. The PRNG deterministically assigns each of the 64 base64 chars a 1- or 2-char
 *     base32 symbol, building a prefix tree (trie) of base32 -> base64.
 *  3. Walking the trie over enc[4:] recovers a standard base64 string.
 *  4. base64-decode that string -> UTF-8 JSON.
 *
 * All integer arithmetic in the Go original is uint32 with natural wraparound.
 * Here every multiply goes through `Math.imul(...) >>> 0` (32-bit truncating
 * multiply) and every add / xor / shift is re-masked with `>>> 0`; logical
 * (unsigned) shifts use `>>>`, never `>>`. `-(y & 1)` is replicated as
 * `(-(y & 1)) >>> 0`, i.e. 0 or 0xFFFFFFFF.
 *
 * The PRNG state is consumed in exactly the same order as the Go code
 * (seed -> init -> 8 pre-loop spins -> 64 addSymbol calls, each calling
 * generate() once per trie level, plus one extra call per collision retry),
 * so the two implementations stay bit-identical.
 *
 * Input strings are processed as their UTF-8 *bytes*, matching Go's byte
 * semantics for string indexing (enc[i]) and for enc[:4].
 */

const BAY_SH0 = 1;
const BAY_SH1 = 10;
const BAY_SH8 = 8;
const BAY_MASK = 0x7fffffff;
const MIN_LOOP = 8;
const PRE_LOOP = 8;
const VERSION = 1;

const B32_CODE = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const B64_CODE =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** CNT[(i+1)/11] is the base32 symbol length for the i-th base64 char. */
const CNT = [1, 2, 2, 2, 2, 2];

/** '.' — sentinel char of a not-yet-assigned trie node, as in Go's newNode(). */
const DOT = 0x2e;
/** '=' — pass-through marker in the encoded stream. */
const PAD = 0x3d;

const ERR_NOT_ENCODED =
  "decode: payload failed version check (not an encoded string)";

const textEncoder = new TextEncoder();
// ignoreBOM: keep a leading U+FEFF instead of stripping it, so the decoded
// string reflects the raw payload bytes (Go's string(bytes) does the same).
const textDecoder = new TextDecoder("utf-8", {
  fatal: false,
  ignoreBOM: true,
});

/** UTF-8 bytes of a string, mirroring what Go sees when indexing a string. */
function toBytes(s: string): Uint8Array {
  return textEncoder.encode(s);
}

/** TinyMT-style PRNG, identical to the Go `random` type. */
class Random {
  private readonly status = new Uint32Array(4);
  private mat1 = 0;
  private mat2 = 0;
  private tmat = 0;

  seed(sign: Uint8Array): void {
    for (let i = 0; i < 4; i++) {
      this.status[i] = i < sign.length ? sign[i] : 110;
    }
    this.mat1 = this.status[1];
    this.mat2 = this.status[2];
    this.tmat = this.status[3];
    this.init();
  }

  private init(): void {
    for (let idx = 0; idx < MIN_LOOP - 1; idx++) {
      const prev = this.status[idx & 3];
      const i1 = (idx + 1) & 3;
      const mixed = (prev ^ (prev >>> 30)) >>> 0;
      const add = ((idx + 1) + Math.imul(1812433253, mixed)) >>> 0;
      this.status[i1] = (this.status[i1] ^ add) >>> 0;
    }
    if (
      (this.status[0] & BAY_MASK) === 0 &&
      this.status[1] === 0 &&
      this.status[2] === 0 &&
      this.status[3] === 0
    ) {
      this.status[0] = 66;
      this.status[1] = 65;
      this.status[2] = 89;
      this.status[3] = 83;
    }
    for (let i = 0; i < PRE_LOOP; i++) this.nextState();
  }

  private nextState(): void {
    const s0 = this.status[0];
    const s1 = this.status[1];
    const s2 = this.status[2];
    let y = this.status[3];
    let x = ((s0 & BAY_MASK) ^ (s1 ^ s2)) >>> 0;
    x = (x ^ ((x << BAY_SH0) >>> 0)) >>> 0;
    y = (y ^ ((y >>> BAY_SH0) ^ x)) >>> 0;
    // -(y & 1) in uint32 terms: 0 or 0xFFFFFFFF.
    // `[, status[0], status[1]] = status` in the Go original shifts s1, s2 down.
    const ns0 = s1;
    const neg = (-(y & 1)) >>> 0;
    const ns1 = (s2 ^ (neg & this.mat1)) >>> 0;
    const ns2 = ((x ^ ((y << BAY_SH1) >>> 0)) ^ (neg & this.mat2)) >>> 0;
    const ns3 = y;
    this.status[0] = ns0;
    this.status[1] = ns1;
    this.status[2] = ns2;
    this.status[3] = ns3;
  }

  generate(max: number): number {
    this.nextState();
    let t0 = this.status[3];
    const t1 = (this.status[0] ^ (this.status[2] >>> BAY_SH8)) >>> 0;
    t0 = (t0 ^ t1) >>> 0;
    t0 = ((-(t1 & 1) >>> 0) & this.tmat) ^ t0;
    t0 = t0 >>> 0;
    return t0 % max;
  }
}

class TrieNode {
  char: number = DOT;
  readonly children = new Map<number, TrieNode>();
}

/** Base32 -> base64 prefix tree, identical to the Go `tree` type. */
class Trie {
  private readonly rnd = new Random();
  private head = new TrieNode();

  initTree(sign: Uint8Array): void {
    this.rnd.seed(sign);
    this.head = new TrieNode();
    for (let i = 0; i < 64; i++) {
      const length = CNT[Math.trunc((i + 1) / 11)];
      this.addSymbol(B64_CODE.charCodeAt(i), length);
    }
  }

  private addSymbol(char: number, length: number): void {
    let ptr = this.head;
    for (let level = 0; level < length; level++) {
      let inner = B32_CODE.charCodeAt(this.rnd.generate(32));
      // avoid colliding with an already-assigned leaf at this level
      for (;;) {
        const child = ptr.children.get(inner);
        if (child !== undefined && child.char !== DOT) {
          inner = B32_CODE.charCodeAt(this.rnd.generate(32));
          continue;
        }
        break;
      }
      let next = ptr.children.get(inner);
      if (next === undefined) {
        next = new TrieNode();
        ptr.children.set(inner, next);
      }
      ptr = next;
    }
    ptr.char = char;
  }

  decodeTrie(enc: Uint8Array): Uint8Array {
    const out: number[] = [];
    let i = 4;
    while (i < enc.length) {
      if (enc[i] === PAD) {
        out.push(PAD);
        i++;
        continue;
      }
      const start = i;
      let ptr = this.head;
      while (i < enc.length) {
        const child = ptr.children.get(enc[i]);
        if (child === undefined) break;
        ptr = child;
        i++;
      }
      // The Go original appends ptr.char without advancing i, which spins
      // forever (growing its buffer) when enc[i] has no edge from the root.
      // No well-formed payload can hit this; fail loudly instead of hanging.
      if (i === start) {
        throw new Error(
          `decode: no trie transition for byte 0x${enc[i].toString(16)} at offset ${i}`,
        );
      }
      out.push(ptr.char);
    }
    return Uint8Array.from(out);
  }
}

/** Go: `if c >= 65 { c - 65 } else { c - 65 + 41 }`. */
function getIdx(c: number): number {
  if (c >= 65) return c - 65;
  return c - 65 + 41;
}

/**
 * Version/format check used to distinguish encoded payloads from plain JSON.
 * Mirrors the Go `checkVersion`.
 */
export function checkVersion(enc: string): boolean {
  const b = toBytes(enc);
  if (b.length < 4) return false;
  const wi = getIdx(b[0]) * 32 + getIdx(b[1]);
  const x = getIdx(b[2]);
  const check = getIdx(b[3]);
  // Plain int arithmetic: Go's `int` here is 64-bit, so no uint32 truncation.
  let m = (wi * x + check) % 32;
  if (m < 0) m += 32;
  return VERSION >= m;
}

const B64_INV: Int16Array = (() => {
  const t = new Int16Array(128).fill(-1);
  for (let i = 0; i < 64; i++) t[B64_CODE.charCodeAt(i)] = i;
  return t;
})();

/**
 * Strict base64 (StdEncoding) decode, matching Go's
 * `base64.StdEncoding.DecodeString` for the inputs this decoder can produce:
 * length must be a multiple of 4, padding is required, only the final quantum
 * may be padded, and no non-alphabet bytes are accepted.
 *
 * Exported for tests only — {@link decode} is the public entry point.
 */
export function base64Decode(raw: Uint8Array): Uint8Array {
  const n = raw.length;
  if (n % 4 !== 0) {
    throw new Error(`decode: invalid base64 length ${n} (not a multiple of 4)`);
  }
  // Padding, if any, must be a suffix of the input (at most 2 bytes).
  let pad = 0;
  while (pad < 2 && n - 1 - pad >= 0 && raw[n - 1 - pad] === PAD) pad++;
  const body = n - pad;
  for (let i = 0; i < body; i++) {
    const c = raw[i];
    if (c >= 128 || B64_INV[c] < 0) {
      throw new Error(
        `decode: illegal base64 byte 0x${c.toString(16)} at offset ${i}`,
      );
    }
  }
  if (pad > 0 && body % 4 !== 4 - pad) {
    throw new Error("decode: illegal base64 padding");
  }
  const out = new Uint8Array((n / 4) * 3 - pad);
  let o = 0;
  for (let i = 0; i < n; i += 4) {
    const last = i + 4 === n;
    const c0 = B64_INV[raw[i]];
    const c1 = B64_INV[raw[i + 1]];
    const c2 = last && raw[i + 2] === PAD ? 0 : B64_INV[raw[i + 2]];
    const c3 = last && raw[i + 3] === PAD ? 0 : B64_INV[raw[i + 3]];
    const triple = ((c0 << 18) | (c1 << 12) | (c2 << 6) | c3) >>> 0;
    const bytes = last ? 3 - pad : 3;
    if (bytes > 0) out[o++] = (triple >>> 16) & 0xff;
    if (bytes > 1) out[o++] = (triple >>> 8) & 0xff;
    if (bytes > 2) out[o++] = triple & 0xff;
  }
  return out;
}

/**
 * Recover JSON text from a bayDecode-encoded string.
 *
 * Throws if `enc` fails the version check (plain JSON, short strings, ...) —
 * the analogue of the Go `ErrNotEncoded` — or if the recovered payload is not
 * valid base64.
 */
export function decode(enc: string): string {
  if (!checkVersion(enc)) {
    throw new Error(ERR_NOT_ENCODED);
  }
  const bytes = toBytes(enc);
  const trie = new Trie();
  trie.initTree(bytes.subarray(0, 4));
  const raw = trie.decodeTrie(bytes);
  return textDecoder.decode(base64Decode(raw));
}

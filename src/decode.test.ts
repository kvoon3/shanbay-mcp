import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync, readdirSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { base64Decode, checkVersion, decode, encode } from "./decode.js"

/**
 * No captured Shanbay data is committed: the suite is self-contained via
 * encode/decode round-trips. `scripts/capture-fixture.ts` writes real payloads
 * into ./testdata (gitignored) when you want a golden check against the live
 * service.
 */
const TESTDATA = fileURLToPath(new URL("../testdata/", import.meta.url))

describe("encode <-> decode round-trip", () => {
  const payloads = [
    '{"word":"serendipity","senses":[{"pos":"n.","definition_cn":"巧事，机缘凑巧"}]}',
    '{"objects":[{"exists":false,"vocab_id":"mqhgc"}],"page":1,"total":1621}',
    '{"empty":"","unicode":"日本語 / Ελληνικά / emoji 🎴","nested":{"a":[1,2,3]}}',
    "{}",
    "[]",
    '"just a string"',
    JSON.stringify({ pad: "x".repeat(1) }),
    JSON.stringify({ pad: "x".repeat(2) }),
    JSON.stringify({ pad: "x".repeat(3) }),
    JSON.stringify({ pad: "x".repeat(4) }),
  ]

  for (const payload of payloads) {
    test(`survives ${payload.length} bytes: ${payload.slice(0, 40)}`, () => {
      const encoded = encode(payload)
      expect(encoded.length).toBeGreaterThan(4)
      expect(decode(encoded)).toBe(payload)
    })
  }

  test("uses the sign verbatim and honours a custom sign that passes the gate", () => {
    expect(checkVersion("ABAB")).toBe(true)
    expect(encode("{}", "ABAB").slice(0, 4)).toBe("ABAB")
    expect(decode(encode('{"a":1}', "ABAB"))).toBe('{"a":1}')
  })

  test("rejects a sign that is too short", () => {
    expect(() => encode("{}", "AAA")).toThrow(/4 base32 chars/)
  })

  test("rejects a sign that fails the version check", () => {
    // "ZCJE" seeds a gate value above VERSION, so its output would not decode.
    expect(checkVersion("ZCJE")).toBe(false)
    expect(() => encode("{}", "ZCJE")).toThrow(/version check/)
  })
})

describe("checkVersion", () => {
  test("accepts an encoded payload and rejects plain JSON", () => {
    expect(checkVersion(encode('{"a":1}'))).toBe(true)
    expect(checkVersion('{"msg":"plain"}')).toBe(false)
  })

  test("rejects strings shorter than the 4-char sign", () => {
    for (const s of ["", "a", "ab", "abc"]) expect(checkVersion(s)).toBe(false)
  })
})

describe("decode hardening", () => {
  test("throws for plain JSON instead of returning an empty string", () => {
    expect(() => decode('{"errors":{},"msg":"登录信息过期"}')).toThrow(/not an encoded string/)
  })

  test("throws instead of looping forever on a byte that is never a trie edge", () => {
    // Lowercase letters and '8'/'9' are not in the base32 alphabet, so no edge
    // can match. The reference implementation spins here without advancing.
    const broken = `${encode('{"a":1}').slice(0, 4)}zzzz`
    expect(() => decode(broken)).toThrow(/no trie transition/)
  })

  test("throws on a truncated payload", () => {
    const encoded = encode('{"word":"truncated","x":"y"}')
    expect(() => decode(encoded.slice(0, encoded.length - 3))).toThrow()
  })
})

describe("base64Decode (strict RFC 4648)", () => {
  const bytes = (s: string) => new TextEncoder().encode(s)
  const text = (s: string) => new TextDecoder().decode(base64Decode(bytes(s)))

  test("decodes all three padding shapes", () => {
    expect(text("TWFu")).toBe("Man")
    expect(text("TWE=")).toBe("Ma")
    expect(text("TQ==")).toBe("M")
  })

  test("rejects a length that is not a multiple of 4", () => {
    expect(() => text("TWE")).toThrow(/multiple of 4/)
  })

  test("rejects interior padding", () => {
    expect(() => text("AA=A")).toThrow()
  })

  test("rejects non-alphabet bytes", () => {
    expect(() => text("TW.u")).toThrow(/illegal base64 byte/)
  })
})

// Optional golden vectors: `bun scripts/capture-fixture.ts <word>` writes
// testdata/<name>.{enc,json}; users who never run it just skip this block.
const hasFixtures = existsSync(TESTDATA)
describe.skipIf(!hasFixtures)("captured live payloads (local testdata/)", () => {
  // The describe body still runs when the block is skipped, so guard the read.
  const encFiles = hasFixtures ? readdirSync(TESTDATA).filter((f) => f.endsWith(".enc")) : []

  for (const file of encFiles) {
    const name = file.replace(/\.enc$/, "")
    test(`${name}: decodes to the captured plaintext and re-encodes byte for byte`, () => {
      const enc = readFileSync(TESTDATA + file, "utf8").trim()
      const want = readFileSync(`${TESTDATA}${name}.json`, "utf8").trimEnd()
      const got = decode(enc)
      expect(got.trimEnd()).toBe(want)
      expect(JSON.parse(got)).toBeDefined()
      expect(encode(got, enc.slice(0, 4))).toBe(enc)
    })
  }
})

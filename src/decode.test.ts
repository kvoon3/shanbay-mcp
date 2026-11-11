import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

import { base64Decode, checkVersion, decode } from "./decode";

const TESTDATA = fileURLToPath(new URL("../testdata/", import.meta.url));

/** Go's readTrim uses strings.TrimRight(s, "\r\n"); the Go test compares after
 * right-trimming CR/LF, and the captured files may carry trailing whitespace. */
const trimRight = (s: string): string => s.replace(/\s+$/, "");

const encFiles = readdirSync(TESTDATA)
  .filter((name) => name.endsWith(".enc"))
  .sort();

describe("golden vectors", () => {
  test("testdata contains captured encoded payloads", () => {
    expect(encFiles.length).toBeGreaterThan(0);
  });

  for (const file of encFiles) {
    const name = basename(file, ".enc");
    test(`${name}.enc decodes byte-for-byte to ${name}.json`, () => {
      const enc = readFileSync(join(TESTDATA, file), "utf8").trim();
      const expected = readFileSync(join(TESTDATA, name + ".json"), "utf8");

      expect(enc.length).toBeGreaterThan(4);
      expect(checkVersion(enc)).toBe(true);

      const got = decode(enc);

      expect(trimRight(got)).toBe(trimRight(expected));
      // Independent of the golden text: the payload a caller will see must be
      // valid JSON.
      expect(() => JSON.parse(got)).not.toThrow();
    });
  }
});

describe("rejects payloads that are not bayDecode-encoded", () => {
  const plainBodies = [
    '{"msg":"plain"}',
    '{"errors":{},"msg":"learning data not ready"}',
    '{"message":"method not allowed"}',
    '{"ipp":3,"objects":[],"page":1,"total":0}',
    "not encoded at all",
    "",
    "a",
    "abc",
  ];

  for (const body of plainBodies) {
    test(`throws for ${JSON.stringify(body)}`, () => {
      expect(checkVersion(body)).toBe(false);
      expect(() => decode(body)).toThrow(Error);
      expect(() => decode(body)).toThrow(/not an encoded string/);
    });
  }
});

describe("base64Decode (internal, Go StdEncoding parity)", () => {
  const enc = (s: string) => new TextEncoder().encode(s)
  const dec = (s: string) => new TextDecoder().decode(base64Decode(enc(s)))

  test("decodes all three padding shapes", () => {
    expect(dec("TWFu")).toBe("Man")
    expect(dec("TWE=")).toBe("Ma")
    expect(dec("TQ==")).toBe("M")
  })

  test("rejects a length that is not a multiple of 4", () => {
    expect(() => dec("TWE")).toThrow(/multiple of 4/)
  })

  test("rejects interior padding (regression: AA=A was accepted)", () => {
    expect(() => dec("AA=A")).toThrow()
  })

  test("rejects non-alphabet bytes", () => {
    expect(() => dec("TW.u")).toThrow(/illegal base64 byte/)
  })
})

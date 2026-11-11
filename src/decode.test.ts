import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

import { checkVersion, decode } from "./decode";

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

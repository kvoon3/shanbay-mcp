import { describe, expect, test } from "bun:test"
import { parseCookieInput } from "./auth.js"

const AUTH_JWT = [
  "eyJhbGciOiJIUzI1NiJ9",
  Buffer.from(JSON.stringify({ id: 42, username: "kw", exp: 1900000000 })).toString("base64url"),
  "sig",
].join(".")

const COOKIE = `csrftoken=abc123; auth_token=${AUTH_JWT}; _ga=GA1.1.1`

describe("parseCookieInput", () => {
  test("extracts the cookie from a copied cURL command", () => {
    const curl = `curl 'https://apiv3.shanbay.com/wordsapp/user_material_books/current' \\
  -H 'accept: application/json' \\
  -H 'cookie: ${COOKIE}' \\
  -H 'x-csrftoken: abc123'`
    expect(parseCookieInput(curl)).toBe(COOKIE)
  })

  test("accepts a bare cookie string", () => {
    expect(parseCookieInput(COOKIE)).toBe(COOKIE)
  })

  test("accepts double quotes and CRLF", () => {
    const curl = `curl "https://x" -H "Cookie: ${COOKIE}"\r\n`
    expect(parseCookieInput(curl)).toBe(COOKIE)
  })

  test("rejects input without csrftoken", () => {
    expect(() => parseCookieInput("auth_token=only")).toThrow(/csrftoken/)
  })

  test("rejects a logged-out cookie", () => {
    expect(() => parseCookieInput("curl -H 'cookie: csrftoken=abc; x=1'")).toThrow(/auth_token/)
  })
})

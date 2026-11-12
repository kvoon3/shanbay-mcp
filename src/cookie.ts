// Cookie handling that works in any runtime (Bun, Workers, browsers).
//
// Shanbay has no OAuth/token endpoint, so clients reuse a logged-in browser
// session: the user exports the Cookie header from web.shanbay.com once. This
// module turns that string into credentials; src/auth.ts adds the file I/O that
// only a local process can do.

export class AuthError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "AuthError"
  }
}

export type Credentials = {
  cookie: string
  csrf: string
  userId?: number
  username?: string
  expiresAt?: Date
  /** Where the cookie came from: a file path, an env var name, a secret name. */
  source: string
}

function cookieValue(cookie: string, name: string): string | undefined {
  for (const part of cookie.split(";")) {
    const trimmed = part.trim()
    const prefix = `${name}=`
    if (trimmed.startsWith(prefix)) return trimmed.slice(prefix.length)
  }
  return undefined
}

type JwtClaims = { id?: number; username?: string; exp?: number }

/** base64url -> UTF-8 text. `atob` exists in Workers, Bun and Node >= 16. */
function decodeBase64Url(input: string): string {
  const b64 = input.replace(/-/g, "+").replace(/_/g, "/")
  const padded = b64.padEnd(Math.ceil(b64.length / 4) * 4, "=")
  const binary = atob(padded)
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0))
  return new TextDecoder().decode(bytes)
}

function parseJwt(token: string): JwtClaims | undefined {
  const parts = token.split(".")
  if (parts.length !== 3) return undefined
  try {
    return JSON.parse(decodeBase64Url(parts[1]!)) as JwtClaims
  } catch {
    return undefined
  }
}

/** Parse `csrftoken` / `auth_token` out of a Cookie header value. */
export function credentialsFromCookie(cookie: string, source: string): Credentials {
  const csrf = cookieValue(cookie, "csrftoken")
  if (!csrf) {
    throw new AuthError(`cookie 里没有 csrftoken（来源: ${source}）。请重新复制 web.shanbay.com 的 Cookie 头。`)
  }
  const creds: Credentials = { cookie, csrf, source }
  const auth = cookieValue(cookie, "auth_token")
  if (auth) {
    const claims = parseJwt(auth)
    if (claims) {
      creds.userId = claims.id
      creds.username = claims.username
      if (claims.exp) creds.expiresAt = new Date(claims.exp * 1000)
    }
  }
  return creds
}

/** True when the auth_token JWT is past its exp (unknown exp counts as valid). */
export function isExpired(creds: Credentials): boolean {
  return creds.expiresAt !== undefined && Date.now() > creds.expiresAt.getTime()
}

/**
 * Accept a browser "Copy as cURL" command, a bare cookie string, or a single
 * `Cookie:` header line, and return the Cookie header value.
 *
 * Chrome/Firefox export cookies three different ways depending on the request:
 * `-H 'cookie: …'`, `-b '…'` / `--cookie '…'`, or a bare cookie on the clipboard.
 */
export function parseCookieInput(input: string): string {
  // Flatten shell line continuations, then work on one line.
  const s = input.replace(/\\\r?\n/g, " ").replace(/\r?\n/g, " ").trim()

  let value: string | undefined

  // -H 'cookie: …' / --header 'Cookie: …'
  const header = /(?:-H|--header)\s+(['"])\s*cookie:\s*([\s\S]*?)\1/i.exec(s)
  if (header) value = header[2]

  // -b '…' / --cookie '…'
  if (value === undefined) {
    const flag = /(?:^|\s)(?:-b|--cookie)\s+(['"])([\s\S]*?)\1(?:\s|$)/.exec(s)
    if (flag) value = flag[2]
  }

  // Bare paste: the whole input is the cookie (optionally quoted).
  if (value === undefined && !/\bcurl\b/i.test(s)) {
    value = s.replace(/^(['"])([\s\S]*)\1$/, "$2")
  }

  // Last resort: slice from csrftoken up to the next quote.
  if (value === undefined && s.includes("csrftoken=")) {
    value = s.slice(s.indexOf("csrftoken=")).replace(/['"][\s\S]*$/, "")
  }

  if (value === undefined) {
    throw new AuthError(
      "这段文本里找不到 Cookie：既没有 `-H 'cookie: …'` / `-b '…'`，也没有 csrftoken=。请粘贴 curl 命令或裸 Cookie 字符串。",
    )
  }

  const cookie = value.trim()
  if (!cookie.includes("csrftoken=")) throw new AuthError("Cookie 中缺少 csrftoken。")
  if (!cookie.includes("auth_token=")) {
    throw new AuthError("Cookie 中缺少 auth_token（请在登录后的页面复制请求）。")
  }
  return cookie
}
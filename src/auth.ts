// Shanbay has no OAuth/token endpoint, so both this server and the `sb` CLI
// reuse a logged-in browser session: the user exports the Cookie header from
// web.shanbay.com once. We read the exact same file `sb login` writes, so the
// two tools share one login.
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

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
  source: string
}

export function defaultCookiePath(): string {
  return process.env.SHANBAY_COOKIE_FILE ?? join(homedir(), ".config", "shanbay-cli", "cookie")
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

function parseJwt(token: string): JwtClaims | undefined {
  const parts = token.split(".")
  if (parts.length !== 3) return undefined
  try {
    const payload = Buffer.from(parts[1]!, "base64url").toString("utf8")
    return JSON.parse(payload) as JwtClaims
  } catch {
    return undefined
  }
}

function fromCookie(cookie: string, source: string): Credentials {
  const csrf = cookieValue(cookie, "csrftoken")
  if (!csrf) {
    throw new AuthError(
      `cookie 里没有 csrftoken（来源: ${source}）。请重新复制 web.shanbay.com 的 Cookie 头。`,
    )
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

/**
 * Read credentials from `SHANBAY_COOKIE` (raw cookie string) or the cookie file
 * (`SHANBAY_COOKIE_FILE`, else ~/.config/shanbay-cli/cookie — the same path the
 * `sb` CLI writes).
 */
export async function loadCredentials(): Promise<Credentials> {
  const inline = process.env.SHANBAY_COOKIE?.trim()
  if (inline) return fromCookie(inline, "SHANBAY_COOKIE")

  const path = defaultCookiePath()
  let cookie: string
  try {
    cookie = (await readFile(path, "utf8")).trim()
  } catch {
    throw new AuthError(
      `找不到扇贝登录态：${path}\n` +
        `任选一种方式登录：\n` +
        `  1. 运行 \`sb login\` 粘贴浏览器 cURL（推荐，本服务读取同一个文件）\n` +
        `  2. 调用 login 工具，粘贴 cURL 或裸 Cookie\n` +
        `  3. 设置环境变量 SHANBAY_COOKIE=<cookie 字符串>`,
    )
  }
  if (!cookie) throw new AuthError(`登录态文件是空的：${path}`)
  return fromCookie(cookie, path)
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

/** Persist a cookie to the shared shanbay-cli path (0600) and return creds. */
export async function saveCookie(cookie: string): Promise<Credentials> {
  const path = defaultCookiePath()
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await writeFile(path, `${cookie.trim()}\n`, { mode: 0o600 })
  await chmod(path, 0o600).catch(() => {})
  return fromCookie(cookie, path)
}

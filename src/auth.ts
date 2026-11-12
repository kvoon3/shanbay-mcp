// Local-process credential storage: the same cookie file `sb login` writes
// (~/.config/shanbay-cli/cookie), so the CLI and this server share one login.
//
// Runtime-safe parsing lives in src/cookie.ts; only this file touches the
// filesystem, which keeps the Cloudflare Workers entry free of node: imports.
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { AuthError, credentialsFromCookie, type Credentials } from "./cookie.js"

export { AuthError, credentialsFromCookie, isExpired, parseCookieInput } from "./cookie.js"
export type { Credentials } from "./cookie.js"

export function defaultCookiePath(): string {
  return process.env.SHANBAY_COOKIE_FILE ?? join(homedir(), ".config", "shanbay-cli", "cookie")
}

/**
 * Read credentials from `SHANBAY_COOKIE` (raw cookie string) or the cookie file
 * (`SHANBAY_COOKIE_FILE`, else ~/.config/shanbay-cli/cookie — the same path the
 * `sb` CLI writes).
 */
export async function loadCredentials(): Promise<Credentials> {
  const inline = process.env.SHANBAY_COOKIE?.trim()
  if (inline) return credentialsFromCookie(inline, "SHANBAY_COOKIE")

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
  return credentialsFromCookie(cookie, path)
}

/** Persist a cookie to the shared shanbay-cli path (0600) and return creds. */
export async function saveCookie(cookie: string): Promise<Credentials> {
  const path = defaultCookiePath()
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await writeFile(path, `${cookie.trim()}\n`, { mode: 0o600 })
  await chmod(path, 0o600).catch(() => {})
  return credentialsFromCookie(cookie, path)
}
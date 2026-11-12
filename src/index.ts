/**
 * stdio entry point: `bun src/index.ts`.
 *
 * Credentials come from the cookie file `sb login` writes (or SHANBAY_COOKIE),
 * so the CLI and this server share one login. For a hosted instance see
 * src/worker.ts.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { defaultCookiePath, loadCredentials, saveCookie } from "./auth.js"
import type { Credentials } from "./cookie.js"
import { createShanbayServer } from "./server.js"

const version = process.env.SHANBAY_MCP_VERSION ?? "0.1.0"

// Cache the file read, but `login` replaces it immediately.
let cached: Credentials | undefined

const server = createShanbayServer({
  resolveCredentials: async () => {
    cached ??= await loadCredentials()
    return cached
  },
  saveCookie: async (cookie) => {
    cached = await saveCookie(cookie)
    return cached
  },
  version,
})

async function main(): Promise<void> {
  // A 4xx from shanbay usually means their payload shape changed; keep it visible.
  process.on("unhandledRejection", (reason) => {
    console.error("[shanbay] unhandled rejection:", reason)
  })
  await server.connect(new StdioServerTransport())
  console.error(`[shanbay] MCP server ready (stdio). 登录态: ${defaultCookiePath()}`)
}

main().catch((err) => {
  console.error("[shanbay] fatal:", err)
  process.exit(1)
})

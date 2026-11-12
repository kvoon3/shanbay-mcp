/**
 * Cloudflare Workers entry: the same seven tools over Streamable HTTP.
 *
 *   POST /mcp    MCP endpoint (JSON responses, stateless)
 *   GET  /health readiness probe, no secrets
 *
 * Secrets (set with `wrangler secret put …`, never in wrangler.jsonc):
 *   SHANBAY_COOKIE   the browser Cookie header value (csrftoken + auth_token)
 *   MCP_AUTH_TOKEN   bearer token every request must present
 *
 * The endpoint serves one real Shanbay account, so it refuses to run without
 * MCP_AUTH_TOKEN. Put it behind Cloudflare Access as well if you want defence in
 * depth; the bearer check stays the floor.
 */
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import { AuthError, credentialsFromCookie, type Credentials } from "./cookie.js"
import { createShanbayServer } from "./server.js"

export type Env = {
  SHANBAY_COOKIE?: string
  MCP_AUTH_TOKEN?: string
  SHANBAY_MCP_VERSION?: string
}

/** Constant-time-ish bearer comparison (no crypto timing helper in Workers). */
export function bearerMatches(header: string | null, expected: string): boolean {
  const match = /^Bearer\s+(.+)$/i.exec(header ?? "")
  if (!match) return false
  const encoder = new TextEncoder()
  const got = encoder.encode(match[1]!.trim())
  const want = encoder.encode(expected)
  if (got.length !== want.length) return false
  let diff = 0
  for (let i = 0; i < got.length; i++) diff |= got[i]! ^ want[i]!
  return diff === 0
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(`${JSON.stringify(body)}\n`, {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  })
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)

    if (url.pathname === "/health") {
      return json(200, {
        ok: true,
        service: "shanbay-mcp",
        version: env.SHANBAY_MCP_VERSION ?? "0.1.0",
        cookieConfigured: Boolean(env.SHANBAY_COOKIE),
      })
    }
    if (url.pathname !== "/mcp") return json(404, { error: "not found" })

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: { Allow: "POST, GET, DELETE, OPTIONS", "Access-Control-Allow-Headers": "Authorization, Content-Type" },
      })
    }

    if (!env.MCP_AUTH_TOKEN) {
      return json(500, { error: "MCP_AUTH_TOKEN is not configured; refusing to serve an account unauthenticated" })
    }
    if (!bearerMatches(request.headers.get("Authorization"), env.MCP_AUTH_TOKEN)) {
      return json(401, { error: "unauthorized" }, { "WWW-Authenticate": 'Bearer realm="shanbay-mcp"' })
    }

    if (!env.SHANBAY_COOKIE?.trim()) {
      return json(500, { error: "SHANBAY_COOKIE is not configured" })
    }
    let creds: Credentials
    try {
      creds = credentialsFromCookie(env.SHANBAY_COOKIE.trim(), "wrangler secret SHANBAY_COOKIE")
    } catch (err) {
      if (err instanceof AuthError) return json(500, { error: err.message })
      throw err
    }

    // Stateless: one server + transport per request, no session bookkeeping.
    const server = createShanbayServer({
      resolveCredentials: async () => creds,
      version: env.SHANBAY_MCP_VERSION ?? "0.1.0",
    })
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    await server.connect(transport)
    return transport.handleRequest(request)
  },
}
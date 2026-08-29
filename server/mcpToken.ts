/**
 * Shared holder for the per-boot MCP bridge token (Phase J3).
 *
 * The Express server generates a random token on startup, writes it into the
 * discovery file (`<dataDir>/mcp-endpoint.json`) AND stashes it here. The stdio
 * MCP server reads the file and sends the token as `x-matteblack-token`; the
 * `requireMcpToken` middleware (see routes/agent.ts) validates the header against
 * this value so only the MCP process paired with THIS running app can drive the
 * MCP-only endpoints. Loopback + a per-boot secret; no cloud, no persistence.
 */
let currentToken: string | null = null;

export function setMcpToken(token: string): void {
  currentToken = token;
}

export function getMcpToken(): string | null {
  return currentToken;
}

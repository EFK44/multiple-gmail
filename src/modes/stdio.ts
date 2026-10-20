import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { buildMcpServer } from '../mcp/buildServer.js';

// Stdout carries JSON-RPC only. Anything that would print there goes to stderr instead.
export function redirectConsoleToStderr(): void {
  console.log = (...args: unknown[]) => console.error(...args);
  console.info = (...args: unknown[]) => console.error(...args);
  console.debug = (...args: unknown[]) => console.error(...args);
}

export function runStdio(): void {
  redirectConsoleToStderr();
  serveStdio(() => buildMcpServer(), {
    onerror: (e) => console.error('multiple-gmail stdio error:', e.message),
  });
}

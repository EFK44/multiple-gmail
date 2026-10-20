export type HttpSnippets = { cursor: string; vscode: string; generic: string };

export function httpSnippets(port: number, apiKey: string): HttpSnippets {
  const url = `http://127.0.0.1:${port}/mcp`;
  const headers = { Authorization: `Bearer ${apiKey}` };
  return {
    cursor: JSON.stringify({ mcpServers: { 'multiple-gmail': { url, headers } } }, null, 2),
    vscode: JSON.stringify({ servers: { 'multiple-gmail': { type: 'http', url, headers } } }, null, 2),
    generic: `URL: ${url}\nHeader: Authorization: Bearer ${apiKey}`,
  };
}

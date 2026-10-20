import { McpServer } from '@modelcontextprotocol/server';
import { loadConfig } from '../core/config.js';
import { getGmail } from '../gmail/client.js';
import { VERSION } from '../version.js';
import { registerAccountTools } from './tools/accounts.js';
import { registerComposeTools } from './tools/compose.js';
import { registerLabelTools } from './tools/labels.js';
import { registerReadTools } from './tools/read.js';
import type { Deps } from './tools/util.js';

// A fresh server per call: the HTTP transport builds one per request. Deps are injectable for tests.
export function buildMcpServer(deps: Partial<Deps> = {}): McpServer {
  const d: Deps = { getGmail: deps.getGmail ?? getGmail, loadConfig: deps.loadConfig ?? loadConfig };
  const server = new McpServer({ name: 'multiple-gmail', version: VERSION });
  registerAccountTools(server, d);
  registerReadTools(server, d);
  registerComposeTools(server, d);
  registerLabelTools(server, d);
  return server;
}

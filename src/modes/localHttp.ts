import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { loadConfig } from '../core/config.js';
import { openUrl as defaultOpenUrl } from '../core/openUrl.js';
import { configPath } from '../core/paths.js';
import { getLocalApiKey } from '../core/secrets.js';
import { createApi, type ApiDeps } from '../http/api.js';
import { createRouter } from '../http/router.js';
import { HandshakeStore } from '../http/handshake.js';
import { SessionStore } from '../http/session.js';
import { probeExistingInstance } from '../http/singleInstance.js';
import { buildMcpServer } from '../mcp/buildServer.js';
import { VERSION } from '../version.js';

export type LocalServerDeps = Partial<ApiDeps> & {
  log?: (s: string) => void;
  logError?: (s: string) => void;
  openUrl?: (url: string) => Promise<void>;
  now?: () => number;
};

export type LocalServer = { url: string; close(): Promise<void> };

const KEEP_OPEN =
  'Keep this window open. Closing it stops the local server. ' +
  'Claude Desktop and other stdio clients start their own copy and do not need this window.';

export async function startLocalServer(
  opts: { port: number; openBrowser: boolean },
  deps: LocalServerDeps = {},
): Promise<LocalServer> {
  const log = deps.log ?? ((s: string) => console.log(s));
  const logError = deps.logError ?? ((s: string) => console.error(s));
  // Create the key up front so the first /mcp call and a second instance agree on it.
  await getLocalApiKey();

  const sessions = new SessionStore(deps.now);
  // Default legacy posture ('stateless') keeps 2025-era clients working.
  const mcpHandler = createMcpHandler(() => buildMcpServer(), {
    onerror: (e) => logError(`multiple-gmail mcp error: ${e.message}`),
  });
  const mcpNode = toNodeHandler(mcpHandler, {
    onerror: (e) => logError(`multiple-gmail mcp error: ${e.message}`),
  });

  let port = 0;
  const launchUrl = () => `http://127.0.0.1:${port}/?t=${sessions.createLaunchToken()}`;
  const server = createServer(
    createRouter({
      port: () => port,
      sessions,
      handshake: new HandshakeStore(deps.now),
      api: createApi(deps),
      mcp: (req, res) => mcpNode(req, res),
      getApiKey: getLocalApiKey,
      launchUrl,
      logError,
    }),
  );

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  port = (server.address() as AddressInfo).port;
  server.on('error', (e) => logError(`multiple-gmail http error: ${e.message}`));

  const url = launchUrl();
  log(`multiple-gmail ${VERSION}`);
  log(`Setup: ${url}`);
  log(KEEP_OPEN);
  if (opts.openBrowser) void (deps.openUrl ?? defaultOpenUrl)(url).catch(() => {});

  let closing: Promise<void> | undefined;
  return {
    url,
    close: () =>
      (closing ??= (async () => {
        await mcpHandler.close().catch(() => {});
        await new Promise<void>((r) => {
          server.close(() => r());
          server.closeAllConnections();
        });
      })()),
  };
}

// No-args / --minimized entry: start the server, or hand off to an already running instance.
export async function runLocalMode(
  opts: { openBrowser: boolean },
  deps: LocalServerDeps = {},
): Promise<number> {
  const log = deps.log ?? ((s: string) => console.log(s));
  const logError = deps.logError ?? ((s: string) => console.error(s));
  const open = deps.openUrl ?? defaultOpenUrl;
  const { port } = await loadConfig();
  try {
    const srv = await startLocalServer({ port, openBrowser: opts.openBrowser }, deps);
    process.once('SIGINT', () => {
      void srv.close().finally(() => process.exit(0));
    });
    return 0;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code !== 'EADDRINUSE' && code !== 'EACCES') throw e;
    const found = code === 'EADDRINUSE' ? await probeExistingInstance(port, getLocalApiKey) : { kind: 'foreign' as const };
    if (found.kind === 'launch') {
      log('multiple-gmail is already running.');
      log(`Setup: ${found.url}`);
      if (opts.openBrowser) await open(found.url).catch(() => {});
      return 0;
    }
    logError(`Port ${port} is used by another program. Change "port" in ${configPath()}.`);
    return 1;
  }
}

import { homedir } from 'node:os';
import { join } from 'node:path';
import { hasMcpServer, mergeMcpServer } from './jsonMerge.js';
import type { LaunchSpec } from './launch.js';

export function geminiSettingsPath(): string {
  return join(process.env.USERPROFILE || homedir(), '.gemini', 'settings.json');
}

export const isGeminiConfigured = () => hasMcpServer(geminiSettingsPath());

// mergeMcpServer creates the .gemini folder when it is missing.
export async function addToGeminiCli(spec: LaunchSpec) {
  const path = geminiSettingsPath();
  return { path, ...(await mergeMcpServer(path, 'mcpServers', 'multiple-gmail', spec)) };
}

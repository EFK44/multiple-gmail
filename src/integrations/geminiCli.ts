import { homedir } from 'node:os';
import { join } from 'node:path';
import { combinedStatus, mergeMcpServer } from './jsonMerge.js';
import { stdioLaunchSpec, type LaunchSpec } from './launch.js';

export function geminiSettingsPath(): string {
  return join(process.env.USERPROFILE || homedir(), '.gemini', 'settings.json');
}

export const geminiStatus = (command: string = stdioLaunchSpec().command) => combinedStatus([geminiSettingsPath()], command);

// mergeMcpServer creates the .gemini folder when it is missing.
export async function addToGeminiCli(spec: LaunchSpec) {
  const path = geminiSettingsPath();
  return { path, ...(await mergeMcpServer(path, 'mcpServers', 'multiple-gmail', spec)) };
}

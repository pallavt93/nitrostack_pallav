import os from 'os';
import path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs-extra';
import type { AgentDescriptor } from './types.js';

const execAsync = promisify(exec);

/**
 * Returns true when the given CLI command is available in the system PATH.
 * Works cross-platform: uses `where` on Windows, `which` elsewhere.
 */
async function commandExists(cmd: string): Promise<boolean> {
  try {
    const whichCmd = process.platform === 'win32' ? `where ${cmd}` : `which ${cmd}`;
    await execAsync(whichCmd);
    return true;
  } catch {
    return false;
  }
}

/**
 * Returns true when a directory exists at `dirPath`.
 */
function dirExists(dirPath: string): boolean {
  try {
    return fs.existsSync(dirPath) && fs.statSync(dirPath).isDirectory();
  } catch {
    return false;
  }
}

const HOME = os.homedir();

interface AgentSpec {
  id: string;
  name: string;
  folderName: string;
  cmd?: string;
  customDetect?: () => Promise<boolean>;
  getSkillsDir?: (scope?: 'project' | 'global', projectDir?: string) => string;
}

/**
 * Helper to build an AgentDescriptor from a simpler specification,
 * reducing duplicate boilerplate for detect() and getSkillsDir().
 */
function createAgentDescriptor(spec: AgentSpec): AgentDescriptor {
  return {
    id: spec.id,
    name: spec.name,
    displayPath: `~/${spec.folderName}/skills`,
    async detect() {
      if (spec.customDetect) {
        return spec.customDetect();
      }
      const hasCmd = spec.cmd ? await commandExists(spec.cmd) : false;
      return hasCmd || dirExists(path.join(HOME, spec.folderName));
    },
    getSkillsDir(scope: 'project' | 'global' = 'global', projectDir: string = process.cwd()) {
      if (spec.getSkillsDir) {
        return spec.getSkillsDir(scope, projectDir);
      }
      const base = scope === 'project' ? projectDir : HOME;
      return path.join(base, spec.folderName, 'skills');
    },
  };
}

export const AGENTS: AgentDescriptor[] = [
  // ── Original 5 agents (must keep indices 0-4 for tests) ───────────────────
  createAgentDescriptor({
    id: 'cursor',
    name: 'Cursor',
    folderName: '.cursor',
  }),
  createAgentDescriptor({
    id: 'codex',
    name: 'Codex',
    folderName: '.codex',
    cmd: 'codex',
  }),
  createAgentDescriptor({
    id: 'claude-code',
    name: 'Claude Code',
    folderName: '.claude',
    cmd: 'claude',
  }),
  createAgentDescriptor({
    id: 'gemini-cli',
    name: 'Gemini CLI',
    folderName: '.gemini',
    cmd: 'gemini',
  }),
  createAgentDescriptor({
    id: 'antigravity',
    name: 'Antigravity',
    folderName: '.antigravity',
    cmd: 'antigravity',
  }),

  // ── Additional coding agents ──────────────────────────────────────────────
  createAgentDescriptor({
    id: 'windsurf',
    name: 'Windsurf',
    folderName: '.windsurf',
    cmd: 'windsurf',
  }),
  createAgentDescriptor({
    id: 'continue',
    name: 'Continue.dev',
    folderName: '.continue',
  }),
  createAgentDescriptor({
    id: 'vscode',
    name: 'VS Code Agent Mode',
    folderName: '.vscode',
    // Detect only by command presence — ~/.vscode exists on nearly every dev
    // machine regardless of whether Agent Mode is in use, causing false positives.
    customDetect: async () => commandExists('code'),
  }),
  createAgentDescriptor({
    id: 'zed',
    name: 'Zed',
    folderName: '.zed',
    cmd: 'zed',
  }),
  createAgentDescriptor({
    id: 'github-copilot',
    name: 'GitHub Copilot',
    // Copilot stores its config at ~/.config/github-copilot, not ~/.copilot
    folderName: '.config/github-copilot',
  }),
  createAgentDescriptor({
    id: 'goose',
    name: 'Goose',
    folderName: '.goose',
    cmd: 'goose',
  }),
  createAgentDescriptor({
    id: 'aider',
    name: 'Aider',
    folderName: '.aider',
    cmd: 'aider',
  }),
  createAgentDescriptor({
    id: 'openhands',
    name: 'OpenHands',
    folderName: '.openhands',
    cmd: 'openhands',
  }),
];

/**
 * Runs all agent detectors in parallel and returns only the agents that are
 * detected on the current machine.
 */
export async function detectAgents(): Promise<AgentDescriptor[]> {
  const results = await Promise.all(
    AGENTS.map(async (agent) => {
      try {
        const found = await agent.detect();
        return found ? agent : null;
      } catch {
        return null;
      }
    }),
  );

  return results.filter((a): a is AgentDescriptor => a !== null);
}

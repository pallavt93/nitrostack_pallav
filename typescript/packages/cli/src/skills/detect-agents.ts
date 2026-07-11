import os from 'os';
import path from 'path';
import { execSync } from 'child_process';
import fs from 'fs-extra';
import type { AgentDescriptor } from './types.js';

/**
 * Returns true when the given CLI command is available in the system PATH.
 * Works cross-platform: uses `where` on Windows, `which` elsewhere.
 */
function commandExists(cmd: string): boolean {
  try {
    const whichCmd = process.platform === 'win32' ? `where ${cmd}` : `which ${cmd}`;
    execSync(whichCmd, { stdio: 'pipe' });
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

/**
 * Registry of all supported AI coding agents.
 *
 * To add a new agent, append a plain object that satisfies AgentDescriptor:
 *
 * ```ts
 * {
 *   id: 'my-agent',
 *   name: 'My Agent',
 *   displayPath: '~/.my-agent/skills',
 *   async detect() { return commandExists('my-agent'); },
 *   getSkillsDir() { return path.join(HOME, '.my-agent', 'skills'); },
 * }
 * ```
 *
 * No other file needs to change.
 */
export const AGENTS: AgentDescriptor[] = [
  {
    id: 'cursor',
    name: 'Cursor',
    displayPath: '.cursor/skills',
    async detect() {
      return dirExists(path.join(HOME, '.cursor'));
    },
    getSkillsDir() {
      return path.join(HOME, '.cursor', 'skills');
    },
  },
  {
    id: 'codex',
    name: 'Codex',
    displayPath: '~/.codex/skills',
    async detect() {
      return commandExists('codex') || dirExists(path.join(HOME, '.codex'));
    },
    getSkillsDir() {
      return path.join(HOME, '.codex', 'skills');
    },
  },
  {
    id: 'claude-code',
    name: 'Claude Code',
    displayPath: '~/.claude/skills',
    async detect() {
      return commandExists('claude') || dirExists(path.join(HOME, '.claude'));
    },
    getSkillsDir() {
      return path.join(HOME, '.claude', 'skills');
    },
  },
  {
    id: 'gemini-cli',
    name: 'Gemini CLI',
    displayPath: '~/.gemini/skills',
    async detect() {
      return commandExists('gemini') || dirExists(path.join(HOME, '.gemini'));
    },
    getSkillsDir() {
      return path.join(HOME, '.gemini', 'skills');
    },
  },
  {
    id: 'antigravity',
    name: 'Antigravity',
    displayPath: '~/.antigravity/skills',
    async detect() {
      return commandExists('antigravity') || dirExists(path.join(HOME, '.antigravity'));
    },
    getSkillsDir() {
      return path.join(HOME, '.antigravity', 'skills');
    },
  },

  // ── Future agents ─────────────────────────────────────────────────────────
  // Uncomment and adjust as support is added:
  //
  // { id: 'vscode', name: 'VS Code Agent Mode', displayPath: '~/.vscode/skills',
  //   async detect() { return commandExists('code') || dirExists(path.join(HOME, '.vscode')); },
  //   getSkillsDir() { return path.join(HOME, '.vscode', 'skills'); } },
  //
  // { id: 'continue', name: 'Continue.dev', displayPath: '~/.continue/skills',
  //   async detect() { return dirExists(path.join(HOME, '.continue')); },
  //   getSkillsDir() { return path.join(HOME, '.continue', 'skills'); } },
  //
  // { id: 'windsurf', name: 'Windsurf', displayPath: '~/.windsurf/skills',
  //   async detect() { return commandExists('windsurf') || dirExists(path.join(HOME, '.windsurf')); },
  //   getSkillsDir() { return path.join(HOME, '.windsurf', 'skills'); } },
  //
  // { id: 'cline', name: 'Cline', displayPath: '~/.cline/skills',
  //   async detect() { return dirExists(path.join(HOME, '.cline')); },
  //   getSkillsDir() { return path.join(HOME, '.cline', 'skills'); } },
  //
  // { id: 'roo-code', name: 'Roo Code', displayPath: '~/.roo/skills',
  //   async detect() { return dirExists(path.join(HOME, '.roo')); },
  //   getSkillsDir() { return path.join(HOME, '.roo', 'skills'); } },
  //
  // { id: 'openhands', name: 'OpenHands', displayPath: '~/.openhands/skills',
  //   async detect() { return commandExists('openhands') || dirExists(path.join(HOME, '.openhands')); },
  //   getSkillsDir() { return path.join(HOME, '.openhands', 'skills'); } },
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

import fs from 'fs-extra';
import inquirer from 'inquirer';
import chalk from 'chalk';
import readline from 'readline';
import { cloneSkillsRepo, SkillsCloneError } from './clone.js';

// Monkeypatch Inquirer's CheckboxPrompt to remove the '<i> to invert selection' instruction
const checkboxConstructor = (inquirer.prompt as any).prompts?.checkbox;
if (checkboxConstructor) {
  const originalCheckboxRender = checkboxConstructor.prototype.render;
  if (originalCheckboxRender) {
    checkboxConstructor.prototype.render = function(error?: any) {
      const originalScreenRender = this.screen.render;
      this.screen.render = (msg: string, bottom: string) => {
        const cleanedMsg = msg.replace(/, .*?i.*? to invert selection, and /i, ', and ');
        return originalScreenRender.call(this.screen, cleanedMsg, bottom);
      };
      try {
        return originalCheckboxRender.call(this, error);
      } finally {
        this.screen.render = originalScreenRender;
      }
    };
  }
}
import { discoverSkills } from './discover.js';
import { detectAgents } from './detect-agents.js';
import { installSkills } from './installer.js';
import {
  printSkillsHeader,
  printCloned,
  printSkillList,
  printDetectedAgents,
  printNoAgentsWarning,
  printInstalling,
  printSuccess,
  printCloneError,
} from './ui.js';
import type { AgentDescriptor } from './types.js';

/**
 * Runs the full agent-skills installation flow.
 *
 * Steps:
 *  1. Clone the skills repository into a temporary directory.
 *  2. Discover all skills in the `skills/` subdirectory.
 *  3. Detect supported AI agents installed on the machine.
 *  4. Prompt the user to select which agents to install skills into.
 *  5. Install the skills and report results.
 *  6. Clean up the temporary clone.
 *
 * Graceful fallbacks:
 *  - Git unavailable or clone fails → print warning and return.
 *  - No agents detected → print warning and return.
 *  - User selects no agents → return silently.
 *  - Individual skill copy fails → reported per-agent, does not abort the run.
 *
 * @param force - When true, overwrite existing skill files.
 */
export async function runSkillsFlow(force: boolean = false, projectDir: string = process.cwd()): Promise<void> {
  printSkillsHeader();

  // ── Step 1: Clone ──────────────────────────────────────────────────────────
  let tempDir: string;

  try {
    tempDir = await cloneSkillsRepo();
  } catch (err: unknown) {
    const message =
      err instanceof SkillsCloneError
        ? err.message
        : err instanceof Error
        ? err.message
        : String(err);
    printCloneError(message);
    return;
  }

  try {
    printCloned();

    // ── Step 2: Discover skills ──────────────────────────────────────────────
    const skills = await discoverSkills(tempDir);

    if (skills.length === 0) {
      console.log(chalk.dim('  No skills found in the repository.\n'));
      return;
    }

    printSkillList(skills);

    // ── Step 3: Detect agents ────────────────────────────────────────────────
    const detected = await detectAgents();
    printDetectedAgents(detected.length);

    if (detected.length === 0) {
      printNoAgentsWarning();
      return;
    }

    // ── Step 4: Agent selection ──────────────────────────────────────────────
    console.log(chalk.dim('  Use space to toggle, enter to confirm.\n'));

    const { selectedIds } = await inquirer.prompt<{ selectedIds: string[] }>([
      {
        type: 'checkbox',
        name: 'selectedIds',
        message: chalk.white('Select agents to install skills to'),
        choices: detected.map((agent: AgentDescriptor) => ({
          name: `${chalk.white(agent.name)}  ${chalk.dim(agent.displayPath)}`,
          value: agent.id,
          checked: true,
        })),
        pageSize: 10,
      },
    ]);

    if (selectedIds.length === 0) {
      console.log(chalk.dim('\n  No agents selected — skipping skill installation.\n'));
      return;
    }

    const selectedAgents = detected.filter((a) => selectedIds.includes(a.id));

    // ── Step 4.5: Scope selection ───────────────────────────────────────────
    const scope = await promptScopeVertical();

    // ── Step 5: Install ──────────────────────────────────────────────────────
    const results = await installSkills(selectedAgents, skills, force, scope, projectDir);
    printInstalling(results);
    printSuccess();

  } finally {
    // ── Cleanup: always remove the temp clone ────────────────────────────────
    try {
      await fs.remove(tempDir);
    } catch {
      // best-effort; temp files will be cleaned by the OS
    }
  }
}

/**
 * Custom vertical scope selection prompt that dynamically displays option
 * descriptions/subtext only when that option is currently selected.
 */
async function promptScopeVertical(): Promise<'project' | 'global'> {
  return new Promise((resolve) => {
    let activeIndex = 0; // 0 = project, 1 = global
    const stdin = process.stdin;
    const stdout = process.stdout;

    const isRaw = stdin.isRaw;
    if (stdin.isTTY) {
      stdin.setRawMode(true);
    }
    readline.emitKeypressEvents(stdin);
    stdin.resume();

    // Hide cursor
    stdout.write('\u001B[?25l');

    const render = () => {
      readline.cursorTo(stdout, 0);
      readline.clearScreenDown(stdout);

      const qIcon = chalk.cyan('◆');
      const msg = chalk.bold('Installation scope');

      const projectDesc = activeIndex === 0
        ? ` ${chalk.dim('(Install in current directory (committed with your project))')}`
        : '';
      const projectLine = activeIndex === 0
        ? `${chalk.cyan('●')} ${chalk.cyan.bold('Project')}${projectDesc}`
        : `${chalk.dim('○ Project')}`;

      const globalDesc = activeIndex === 1
        ? ` ${chalk.dim('(Install in home directory (available across all projects))')}`
        : '';
      const globalLine = activeIndex === 1
        ? `${chalk.cyan('●')} ${chalk.cyan.bold('Global')}${globalDesc}`
        : `${chalk.dim('○ Global')}`;

      stdout.write(`${qIcon} ${msg}\n  ${projectLine}\n  ${globalLine}`);

      // Move cursor back up 2 lines to align on next render
      readline.moveCursor(stdout, 0, -2);
    };

    render();

    const onKeypress = (str: string, key: any) => {
      if (!key) return;

      if (key.name === 'up' || key.name === 'down') {
        activeIndex = activeIndex === 0 ? 1 : 0;
        render();
      } else if (key.name === 'return' || key.name === 'enter') {
        cleanup();

        readline.cursorTo(stdout, 0);
        readline.clearScreenDown(stdout);

        const checkMark = chalk.green('✔');
        const finalAns = activeIndex === 0 ? 'Project' : 'Global';
        stdout.write(`${checkMark} ${chalk.bold('Installation scope')} ${chalk.cyan(finalAns)}\n`);

        // Resolve after a small delay to prevent keypress bleeding
        setTimeout(() => {
          resolve(activeIndex === 0 ? 'project' : 'global');
        }, 100);
      } else if (key.ctrl && key.name === 'c') {
        cleanup();
        process.exit(130);
      }
    };

    const cleanup = () => {
      stdout.write('\u001B[?25h');
      stdin.removeListener('keypress', onKeypress);
      stdin.read();
      if (stdin.isTTY) {
        stdin.setRawMode(isRaw);
      }
    };

    stdin.on('keypress', onKeypress);
  });
}

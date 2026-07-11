import fs from 'fs-extra';
import inquirer from 'inquirer';
import chalk from 'chalk';
import { cloneSkillsRepo, SkillsCloneError } from './clone.js';
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
export async function runSkillsFlow(force: boolean = false): Promise<void> {
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
    const { selectedIds } = await inquirer.prompt<{ selectedIds: string[] }>([
      {
        type: 'checkbox',
        name: 'selectedIds',
        message: chalk.white('Select agents to install skills to'),
        suffix: chalk.dim('\n  (space to toggle, enter to confirm)\n'),
        choices: detected.map((agent: AgentDescriptor) => ({
          name: `${chalk.white(agent.name)}  ${chalk.dim(agent.displayPath)}`,
          value: agent.id,
          checked: false,
        })),
        pageSize: 10,
      },
    ]);

    if (selectedIds.length === 0) {
      console.log(chalk.dim('\n  No agents selected — skipping skill installation.\n'));
      return;
    }

    const selectedAgents = detected.filter((a) => selectedIds.includes(a.id));

    // ── Step 5: Install ──────────────────────────────────────────────────────
    const results = await installSkills(selectedAgents, skills, force);
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

import chalk from 'chalk';
import path from 'path';
import fs from 'fs-extra';
import os from 'os';
import inquirer from 'inquirer';
import {
  createHeader,
  createSuccessBox,
  createErrorBox,
  NitroSpinner,
  log,
  spacer,
  nextSteps,
  showFooter,
  brand,
  NITRO_BANNER_FULL
} from '../ui/branding.js';
import { trackEvent, shutdownAnalytics } from '../analytics/posthog.js';

interface CursorOptions {
  global?: boolean;
  local?: boolean;
  type?: 'command' | 'sse';
  url?: string;
  port?: string;
  force?: boolean;
}

export async function cursorCommand(options: CursorOptions): Promise<void> {
  console.log(NITRO_BANNER_FULL);
  console.log(createHeader('Cursor Integration', 'Configure MCP server in Cursor'));

  const startTime = Date.now();

  trackEvent('cli_command_invoked', {
    command: 'cursor',
    options: Object.keys(options).filter(k => options[k as keyof CursorOptions] !== undefined),
  });

  const projectRoot = process.cwd();
  const packageJsonPath = path.join(projectRoot, 'package.json');

  // Validate project
  if (!fs.existsSync(packageJsonPath)) {
    console.log(createErrorBox('Not a Valid Project', 'package.json not found in the current directory.'));
    trackEvent('cli_cursor_failed', {
      error: 'Not a valid project: package.json missing',
    });
    await shutdownAnalytics();
    process.exit(1);
  }

  let packageJson: any;
  try {
    packageJson = await fs.readJson(packageJsonPath);
  } catch (error) {
    console.log(createErrorBox('Invalid package.json', 'Could not parse project package.json.'));
    trackEvent('cli_cursor_failed', {
      error: 'Invalid package.json parsing error',
    });
    await shutdownAnalytics();
    process.exit(1);
  }

  const rawName = packageJson.name || path.basename(projectRoot);
  const serverName = rawName.includes('/') ? rawName.split('/').pop()! : rawName;

  let target: 'global' | 'local';
  if (options.global) {
    target = 'global';
  } else if (options.local) {
    target = 'local';
  } else {
    const answers = await inquirer.prompt([
      {
        type: 'list',
        name: 'target',
        message: chalk.white('Where would you like to install the Cursor MCP configuration?'),
        choices: [
          { name: `Project-level ${chalk.dim('(.cursor/mcp.json)')}`, value: 'local' },
          { name: `Global        ${chalk.dim('(~/.cursor/mcp.json)')}`, value: 'global' },
        ],
        default: 'local',
      }
    ]);
    target = answers.target;
  }

  let type = options.type;
  if (!type) {
    const answers = await inquirer.prompt([
      {
        type: 'list',
        name: 'type',
        message: chalk.white('Choose the connection type for Cursor:'),
        choices: [
          { name: `Command (Stdio)  ${chalk.dim('─ Starts subprocess (recommended for local dev)')}`, value: 'command' },
          { name: `SSE (HTTP URL)   ${chalk.dim('─ Connects to a running server (recommended for production/docker)')}`, value: 'sse' },
        ],
        default: 'command',
      }
    ]);
    type = answers.type;
  }

  let sseUrl = options.url;
  if (type === 'sse' && !sseUrl) {
    const port = options.port || '3000';
    const defaultUrl = `http://localhost:${port}/mcp`;
    const answers = await inquirer.prompt([
      {
        type: 'input',
        name: 'url',
        message: chalk.white('SSE connection URL:'),
        default: defaultUrl,
      }
    ]);
    sseUrl = answers.url;
  }

  let configFilePath: string;
  if (target === 'global') {
    configFilePath = path.join(os.homedir(), '.cursor', 'mcp.json');
  } else {
    configFilePath = path.join(projectRoot, '.cursor', 'mcp.json');
  }

  let entry: any;
  if (type === 'command') {
    const absIndexPath = path.join(projectRoot, 'dist', 'index.js');
    entry = {
      command: 'node',
      args: [absIndexPath],
      env: {}
    };
  } else {
    entry = {
      url: sseUrl
    };
  }

  const spinner = new NitroSpinner(`Configuring Cursor MCP server...`).start();
  try {
    await fs.ensureDir(path.dirname(configFilePath));
    let mcpConfig: any = { mcpServers: {} };
    if (await fs.pathExists(configFilePath)) {
      try {
        mcpConfig = await fs.readJson(configFilePath);
      } catch (e) {
        // Corrupted or empty file, initialize it
        mcpConfig = { mcpServers: {} };
      }
    }
    if (!mcpConfig.mcpServers) {
      mcpConfig.mcpServers = {};
    }

    // Check if it already exists
    if (mcpConfig.mcpServers[serverName] && !options.force) {
      spinner.stop();
      const { overwrite } = await inquirer.prompt([
        {
          type: 'confirm',
          name: 'overwrite',
          message: chalk.yellow(`MCP Server "${serverName}" is already registered in Cursor config. Overwrite?`),
          default: true,
        }
      ]);
      if (!overwrite) {
        log('Cancelled integration', 'warning');
        trackEvent('cli_cursor_cancelled', {
          server_name: serverName,
          target,
          type,
        });
        await shutdownAnalytics();
        return;
      }
      spinner.start();
    }

    mcpConfig.mcpServers[serverName] = entry;
    await fs.writeJson(configFilePath, mcpConfig, { spaces: 2 });
    spinner.succeed(`Registered "${serverName}" in Cursor config`);
  } catch (err) {
    spinner.fail('Failed to update Cursor configuration');
    console.log(createErrorBox('Integration Failed', err instanceof Error ? err.message : String(err)));
    trackEvent('cli_cursor_failed', {
      error: err instanceof Error ? err.message : String(err),
      target,
      type,
    });
    await shutdownAnalytics();
    return;
  }

  // Summary
  spacer();
  console.log(createSuccessBox('Cursor Integration Successful', [
    `Configured target: ${chalk.cyan(configFilePath)}`,
    `Server registered: ${chalk.cyan(serverName)}`,
    `Connection type:   ${chalk.cyan(type)}`,
    type === 'command'
      ? `Command path:      ${chalk.dim(path.join(projectRoot, 'dist', 'index.js'))}`
      : `SSE URL:           ${chalk.cyan(sseUrl)}`
  ]));

  if (type === 'command') {
    // Check if dist/index.js exists
    const distIndexPath = path.join(projectRoot, 'dist', 'index.js');
    if (!fs.existsSync(distIndexPath)) {
      log('Warning: dist/index.js not found. Remember to run "npm run build" first!', 'warning');
      spacer();
    }
  }

  nextSteps([
    'Restart/Reload your Cursor window to load the new MCP server',
    'Check active MCP servers in Cursor under Settings > Tools > MCP',
  ]);

  showFooter();

  trackEvent('cli_cursor_completed', {
    target,
    type,
    server_name: serverName,
    duration_ms: Date.now() - startTime,
  });
  await shutdownAnalytics();
}

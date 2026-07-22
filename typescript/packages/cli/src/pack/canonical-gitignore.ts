import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs-extra';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));

/**
 * Resolve the bundled canonical .gitignore shipped with the CLI package.
 */
export function getCanonicalGitignorePath(): string {
  return path.join(moduleDir, '../../assets/canonical.gitignore');
}

/**
 * Load canonical .gitignore rules from the bundled starter template copy.
 */
export async function loadCanonicalGitignore(): Promise<string> {
  const canonicalPath = getCanonicalGitignorePath();
  if (!(await fs.pathExists(canonicalPath))) {
    throw new Error(`Canonical .gitignore not found at ${canonicalPath}`);
  }
  return fs.readFile(canonicalPath, 'utf-8');
}

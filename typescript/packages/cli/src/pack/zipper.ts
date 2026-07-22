import path from 'path';
import fs from 'fs';
import { createWriteStream } from 'fs';
import type { Ignore } from 'ignore';
import archiver from 'archiver';
import { isPathIgnored } from './gitignore.js';

export interface ZipCollectionResult {
  filesIncluded: number;
  includedPaths: string[];
  excludedPaths: string[];
}

/**
 * Collect relative file paths that should be included, and pruned excluded roots.
 * Excluded directories are recorded once and not descended into.
 */
export async function collectFilesToPack(
  projectRoot: string,
  matcher: Ignore,
): Promise<ZipCollectionResult> {
  const includedPaths: string[] = [];
  const excludedPaths: string[] = [];

  async function walk(currentDir: string): Promise<void> {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    // Stable order for deterministic trees
    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      const absolutePath = path.join(currentDir, entry.name);
      const relativePath = path.relative(projectRoot, absolutePath).split(path.sep).join('/');

      if (isPathIgnored(matcher, projectRoot, absolutePath, entry.isDirectory())) {
        const displayPath = entry.isDirectory() ? `${relativePath}/` : relativePath;
        excludedPaths.push(displayPath);
        continue;
      }

      if (entry.isDirectory()) {
        await walk(absolutePath);
        continue;
      }

      if (entry.isFile() || entry.isSymbolicLink()) {
        includedPaths.push(relativePath);
      }
    }
  }

  await walk(projectRoot);
  includedPaths.sort();
  excludedPaths.sort();

  return {
    filesIncluded: includedPaths.length,
    includedPaths,
    excludedPaths,
  };
}

/**
 * Create an optimized zip archive from the project directory.
 */
export async function createOptimizedZip(
  projectRoot: string,
  outputPath: string,
  matcher: Ignore,
): Promise<ZipCollectionResult> {
  const collection = await collectFilesToPack(projectRoot, matcher);
  const outputDir = path.dirname(outputPath);
  await fs.promises.mkdir(outputDir, { recursive: true });

  await new Promise<void>((resolve, reject) => {
    const output = createWriteStream(outputPath);
    const archive = archiver('zip', { zlib: { level: 9 } });

    output.on('close', () => resolve());
    output.on('error', reject);
    archive.on('error', reject);

    archive.pipe(output);

    for (const relativePath of collection.includedPaths) {
      const absolutePath = path.join(projectRoot, relativePath);
      archive.file(absolutePath, { name: relativePath });
    }

    void archive.finalize();
  });

  return collection;
}

export async function getZipSizeBytes(outputPath: string): Promise<number> {
  const stats = await fs.promises.stat(outputPath);
  return stats.size;
}

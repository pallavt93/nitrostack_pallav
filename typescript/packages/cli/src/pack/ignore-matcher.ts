/**
 * Lightweight gitignore-style matcher implemented in-house (no external ignore package).
 * Supports the pattern subset used by nitrostack pack:
 * - Directory rules: dist/, .git/
 * - Recursive directory rules: slash-star-star/dist/
 * - Exact file names: .env, .DS_Store
 * - Simple globs: *.log, *.tsbuildinfo, npm-debug.log*, .env.*.local
 * - Path-anchored rules with / (match relative to project root)
 * - Negation with leading ! (last matching rule wins)
 */

export interface IgnoreMatcher {
  ignores(relativePath: string): boolean;
  add(patterns: string | string[]): IgnoreMatcher;
}

interface CompiledRule {
  raw: string;
  negated: boolean;
  directoryOnly: boolean;
  anchored: boolean;
  regex: RegExp;
}

function escapeRegex(value: string): string {
  return value.replace(/[.+^${}()|[\]\\]/g, '\\$&');
}

/**
 * Convert a single gitignore-like pattern into a RegExp that matches
 * the full relative path (forward-slash separated, no leading ./).
 */
function compilePattern(pattern: string): CompiledRule | null {
  let raw = pattern.trim();
  if (!raw || raw.startsWith('#')) {
    return null;
  }

  let negated = false;
  if (raw.startsWith('!')) {
    negated = true;
    raw = raw.slice(1);
  }

  if (raw.startsWith('\\!')) {
    raw = raw.slice(1);
  }

  let directoryOnly = false;
  if (raw.endsWith('/')) {
    directoryOnly = true;
    raw = raw.slice(0, -1);
  }

  if (!raw) {
    return null;
  }

  const anchored = raw.startsWith('/');
  if (anchored) {
    raw = raw.slice(1);
  }

  const hasSlash = raw.includes('/');
  const isRecursivePrefix = raw.startsWith('**/');
  const basenameOnly = !anchored && !hasSlash;

  let body = '';
  let i = 0;
  while (i < raw.length) {
    if (raw.startsWith('**/', i)) {
      body += '(?:.*/)?';
      i += 3;
      continue;
    }
    if (raw[i] === '*') {
      body += '[^/]*';
      i += 1;
      continue;
    }
    if (raw[i] === '?') {
      body += '[^/]';
      i += 1;
      continue;
    }
    body += escapeRegex(raw[i]);
    i += 1;
  }

  let source: string;
  if (isRecursivePrefix || raw.includes('**/')) {
    source = `^${body}(?:/.*)?$`;
  } else if (basenameOnly) {
    // Match the basename anywhere in the path (gitignore default)
    source = `(^|/)${body}(?:/.*)?$`;
  } else if (anchored || hasSlash) {
    source = `^${body}(?:/.*)?$`;
  } else {
    source = `(^|/)${body}(?:/.*)?$`;
  }

  return {
    raw: pattern.trim(),
    negated,
    directoryOnly,
    anchored,
    regex: new RegExp(source),
  };
}

function normalizeRelativePath(relativePath: string): string {
  return relativePath.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
}

/**
 * Create a matcher from a list of gitignore-style patterns.
 */
export function createIgnoreMatcher(patterns: string[] = []): IgnoreMatcher {
  const rules: CompiledRule[] = [];

  const matcher: IgnoreMatcher = {
    add(input: string | string[]): IgnoreMatcher {
      const list = Array.isArray(input) ? input : [input];
      for (const pattern of list) {
        const compiled = compilePattern(pattern);
        if (compiled) {
          rules.push(compiled);
        }
      }
      return matcher;
    },

    ignores(relativePath: string): boolean {
      const path = normalizeRelativePath(relativePath);
      if (!path || path === '.') {
        return false;
      }

      let ignored = false;

      for (const rule of rules) {
        if (rule.regex.test(path)) {
          ignored = !rule.negated;
        }
      }

      return ignored;
    },
  };

  if (patterns.length > 0) {
    matcher.add(patterns);
  }

  return matcher;
}

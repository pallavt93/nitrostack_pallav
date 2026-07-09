import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { isLocalDependency, compareVersions } from '../commands/upgrade.js';

describe('Upgrade Command', () => {
  beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('should export upgradeCommand function', async () => {
    const module = await import('../commands/upgrade.js');
    expect(typeof module.upgradeCommand).toBe('function');
  });

  describe('isLocalDependency', () => {
    it('should identify local workspace dependency patterns', () => {
      expect(isLocalDependency('file:../../core')).toBe(true);
      expect(isLocalDependency('link:../core')).toBe(true);
      expect(isLocalDependency('workspace:*')).toBe(true);
      expect(isLocalDependency('./local/folder')).toBe(true);
      expect(isLocalDependency('/absolute/path')).toBe(true);
    });

    it('should return false for registry semver versions', () => {
      expect(isLocalDependency('^1.0.8')).toBe(false);
      expect(isLocalDependency('~1.0.8')).toBe(false);
      expect(isLocalDependency('1.0.8')).toBe(false);
    });
  });

  describe('compareVersions', () => {
    it('should return 1 when v1 is greater than v2', () => {
      expect(compareVersions('1.0.12', '1.0.8')).toBe(1);
      expect(compareVersions('^1.1.0', '1.0.8')).toBe(1);
    });

    it('should return -1 when v1 is less than v2', () => {
      expect(compareVersions('1.0.6', '1.0.11')).toBe(-1);
      expect(compareVersions('^1.0.6', '1.0.11')).toBe(-1);
    });

    it('should return 0 when versions are equal', () => {
      expect(compareVersions('1.0.11', '1.0.11')).toBe(0);
      expect(compareVersions('^1.0.11', '1.0.11')).toBe(0);
    });
  });
});

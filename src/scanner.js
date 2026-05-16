import fs from 'node:fs/promises';
import path from 'node:path';
import { normalizeRel } from './utils.js';

// Простой матчер игнора без зависимостей.
// Поддерживает: точные имена, *.ext, совпадение по basename и по сегментам пути.
export function makeIgnoreMatcher(patterns) {
  const exact = new Set();
  const extGlobs = []; // *.ext

  for (const pat of patterns) {
    if (pat.startsWith('*.')) {
      extGlobs.push(pat.slice(1).toLowerCase()); // ".ext"
    } else {
      exact.add(pat);
    }
  }

  return function isIgnored(name, relPath) {
    if (exact.has(name)) return true;
    // совпадение по любому сегменту пути
    if (relPath) {
      const segs = relPath.split(/[\\/]/);
      for (const seg of segs) {
        if (exact.has(seg)) return true;
      }
    }
    const lower = name.toLowerCase();
    for (const ext of extGlobs) {
      if (lower.endsWith(ext)) return true;
    }
    return false;
  };
}

// Рекурсивный обход. Возвращает плоский массив { relPath, size, mtime } (relPath с forward slashes).
// Папка .synca всегда игнорируется.
// Symlinks пропускаются (с записью в onSkip если передан).
export async function scanDirectory(rootDir, ignorePatterns, { onSkip } = {}) {
  const matcher = makeIgnoreMatcher(ignorePatterns);
  const result = [];

  async function walk(currentDir, relDir) {
    let entries;
    try {
      entries = await fs.readdir(currentDir, { withFileTypes: true });
    } catch (err) {
      if (onSkip) onSkip({ relPath: relDir, reason: 'unreadable: ' + err.code });
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      const relPath = relDir ? path.join(relDir, entry.name) : entry.name;
      const rel = normalizeRel(relPath);

      if (matcher(entry.name, rel)) continue;

      if (entry.isSymbolicLink()) {
        if (onSkip) onSkip({ relPath: rel, reason: 'symlink' });
        continue;
      }

      if (entry.isDirectory()) {
        await walk(fullPath, relPath);
        continue;
      }

      if (!entry.isFile()) {
        if (onSkip) onSkip({ relPath: rel, reason: 'not-a-file' });
        continue;
      }

      let stat;
      try {
        stat = await fs.stat(fullPath);
      } catch (err) {
        if (onSkip) onSkip({ relPath: rel, reason: 'stat-failed: ' + err.code });
        continue;
      }

      result.push({
        relPath: rel,
        size: stat.size,
        mtime: stat.mtimeMs,
      });
    }
  }

  await walk(rootDir, '');
  return result;
}

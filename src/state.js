import fs from 'node:fs/promises';
import path from 'node:path';
import { writeJsonAtomic, readJson, pathExists } from './utils.js';

const STATE_VERSION = 1;

export function stateFilePath(destination) {
  return path.join(destination, '.synca', 'state.json');
}

export function emptyState() {
  return {
    version: STATE_VERSION,
    createdAt: new Date().toISOString(),
    files: [],
  };
}

// Читает state. Если файла нет — возвращает emptyState().
// Если файл битый — переименовывает в .broken-<ts>.json и возвращает emptyState().
export async function loadState(destination) {
  const stPath = stateFilePath(destination);
  if (!(await pathExists(stPath))) return emptyState();
  try {
    const data = await readJson(stPath);
    if (!data.version || !Array.isArray(data.files)) {
      throw new Error('invalid structure');
    }
    return data;
  } catch {
    const broken = stPath.replace(/\.json$/, '.broken-' + Date.now() + '.json');
    try {
      await fs.rename(stPath, broken);
    } catch {
      // если не получилось переименовать — пропустим
    }
    return emptyState();
  }
}

export async function saveState(destination, state) {
  const stPath = stateFilePath(destination);
  await fs.mkdir(path.dirname(stPath), { recursive: true });
  state.createdAt = new Date().toISOString();
  await writeJsonAtomic(stPath, state);
}

// Быстрый lookup по relPath
export function indexByRelPath(state) {
  const map = new Map();
  for (const f of state.files) {
    map.set(f.relPath, f);
  }
  return map;
}

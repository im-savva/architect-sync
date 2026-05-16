import fs from 'node:fs/promises';
import path from 'node:path';
import { toLongPath, nativeRel, pathExists } from './utils.js';

const TRASH_DIR = '.synca/trash';

// Создаёт батч-папку для корзины с timestamp.
export function makeTrashBatchPath(destination) {
  const now = new Date();
  const ts =
    now.toISOString().replace(/:/g, '-').replace(/\..+/, '').replace('T', '_');
  return path.join(destination, TRASH_DIR, ts);
}

// Перемещает файл в корзину. Сохраняет структуру папок относительно destination.
export async function moveToTrash(destination, relPath, batchDir) {
  const srcAbs = path.join(destination, nativeRel(relPath));
  const dstAbs = path.join(batchDir, nativeRel(relPath));
  await fs.mkdir(path.dirname(dstAbs), { recursive: true });

  try {
    await fs.rename(toLongPath(srcAbs), toLongPath(dstAbs));
  } catch (err) {
    if (err.code === 'EXDEV') {
      // cross-device — копируем и удаляем
      await fs.copyFile(toLongPath(srcAbs), toLongPath(dstAbs));
      await fs.unlink(toLongPath(srcAbs));
    } else {
      throw err;
    }
  }
}

// Удаляет пустые родительские папки, поднимаясь от directory вверх до stopAt (не включая).
// Не падает если папка не пуста или не существует.
export async function pruneEmptyDirs(directory, stopAt) {
  const stopResolved = path.resolve(stopAt);
  let current = path.resolve(directory);
  while (current !== stopResolved && current.startsWith(stopResolved)) {
    try {
      const entries = await fs.readdir(toLongPath(current));
      if (entries.length > 0) return; // не пуста — стоп
      await fs.rmdir(toLongPath(current));
    } catch {
      return; // не получилось — выходим
    }
    current = path.dirname(current);
  }
}

// Возвращает общий размер всех файлов в корзине + список батчей с размерами и mtime.
async function scanTrash(destination) {
  const trashRoot = path.join(destination, TRASH_DIR);
  if (!(await pathExists(trashRoot))) return { totalBytes: 0, batches: [] };

  const batchNames = await fs.readdir(trashRoot);
  const batches = [];
  let totalBytes = 0;

  for (const name of batchNames) {
    const batchPath = path.join(trashRoot, name);
    let stat;
    try {
      stat = await fs.stat(batchPath);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;
    const size = await dirSize(batchPath);
    totalBytes += size;
    batches.push({ name, path: batchPath, size, mtime: stat.mtimeMs });
  }
  return { totalBytes, batches };
}

async function dirSize(dir) {
  let total = 0;
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      total += await dirSize(full);
    } else if (entry.isFile()) {
      try {
        const st = await fs.stat(full);
        total += st.size;
      } catch {
        // молча
      }
    }
  }
  return total;
}

// Очистка корзины по лимиту 10% от размера destination.
// destinationSize — суммарный размер актуальных файлов destination (не считая корзины).
export async function enforceTrashLimit(destination, destinationSize, retentionPercent = 10) {
  const limit = Math.floor((destinationSize * retentionPercent) / 100);
  const { totalBytes, batches } = await scanTrash(destination);

  if (totalBytes <= limit) return { removed: 0, removedBytes: 0 };

  // Удаляем самые старые батчи пока не уложимся в лимит
  batches.sort((a, b) => a.mtime - b.mtime);
  let removed = 0;
  let removedBytes = 0;
  let remaining = totalBytes;
  for (const batch of batches) {
    if (remaining <= limit) break;
    try {
      await fs.rm(batch.path, { recursive: true, force: true });
      remaining -= batch.size;
      removedBytes += batch.size;
      removed++;
    } catch {
      // молча, не критично
    }
  }
  return { removed, removedBytes };
}

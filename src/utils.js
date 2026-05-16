import path from 'node:path';
import fs from 'node:fs';
import { createReadStream } from 'node:fs';
import xxhashAddon from 'xxhash-addon';
const { XXHash64 } = xxhashAddon;

export const isWindows = process.platform === 'win32';

const HASH_BUFFER = 64 * 1024;
const HASH_SEED = Buffer.from([0, 0, 0, 0, 0, 0, 0, 1]);

// Стримовое хэширование xxhash64. Возвращает hex-строку.
// Опциональный onChunk вызывается с длиной каждого прочитанного куска (для прогресс-бара).
export async function hashFile(filePath, onChunk) {
  return new Promise((resolve, reject) => {
    const hasher = new XXHash64(HASH_SEED);
    const stream = createReadStream(filePath, { highWaterMark: HASH_BUFFER });
    stream.on('data', (chunk) => {
      hasher.update(chunk);
      if (onChunk) onChunk(chunk.length);
    });
    stream.on('end', () => {
      resolve(hasher.digest().toString('hex'));
    });
    stream.on('error', reject);
  });
}

export function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const value = bytes / Math.pow(1024, i);
  return `${value.toFixed(value < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
}

export function formatDuration(ms) {
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec} сек`;
  const min = Math.floor(sec / 60);
  const rest = sec % 60;
  if (min < 60) return `${min} мин ${rest} сек`;
  const hrs = Math.floor(min / 60);
  const restMin = min % 60;
  return `${hrs} ч ${restMin} мин`;
}

export function normalizePath(p) {
  return path.normalize(p);
}

// Префикс для длинных путей на Windows.
// Применяется автоматически если путь > 240 символов.
export function toLongPath(p) {
  if (!isWindows) return p;
  if (p.length < 240) return p;
  if (p.startsWith('\\\\?\\')) return p;
  const abs = path.resolve(p);
  // UNC путь
  if (abs.startsWith('\\\\')) {
    return '\\\\?\\UNC\\' + abs.slice(2);
  }
  return '\\\\?\\' + abs;
}

// Проверка что childPath находится внутри parentPath
export function pathContains(parentPath, childPath) {
  const parent = path.resolve(parentPath);
  const child = path.resolve(childPath);
  if (parent === child) return true;
  const rel = path.relative(parent, child);
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}

// Проверка существования файла/папки
export async function pathExists(p) {
  try {
    await fs.promises.access(p);
    return true;
  } catch {
    return false;
  }
}

// Свободное место на диске через fs.statfs. Возвращает { free, total } в байтах или null при ошибке.
export async function getDiskStats(p) {
  try {
    const stats = await fs.promises.statfs(p);
    return {
      free: stats.bavail * stats.bsize,
      total: stats.blocks * stats.bsize,
    };
  } catch {
    return null;
  }
}

// Атомарная запись JSON: пишем во временный файл, fsync, rename.
export async function writeJsonAtomic(filePath, data) {
  const tmp = filePath + '.tmp-' + process.pid + '-' + Date.now();
  const json = JSON.stringify(data, null, 2);
  const fh = await fs.promises.open(tmp, 'w');
  try {
    await fh.writeFile(json, 'utf8');
    await fh.sync();
  } finally {
    await fh.close();
  }
  await fs.promises.rename(tmp, filePath);
}

export async function readJson(filePath) {
  const content = await fs.promises.readFile(filePath, 'utf8');
  return JSON.parse(content);
}

// Сон
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Обрезка длинных путей для вывода (с многоточием в начале).
export function truncatePath(p, max = 60) {
  if (p.length <= max) return p;
  return '...' + p.slice(-(max - 3));
}

// Нормализация relPath для манифеста (всегда forward slashes для кроссплатформенности).
export function normalizeRel(relPath) {
  return relPath.split(path.sep).join('/');
}

// Конвертация манифестного relPath в нативный для текущей платформы.
export function nativeRel(relPath) {
  if (path.sep === '/') return relPath;
  return relPath.split('/').join(path.sep);
}

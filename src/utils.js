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

// Человекочитаемая дата для UI: «только что», «2 ч назад», «вчера 18:40», «3 июн 14:02».
const MONTHS_RU = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
export function formatRelativeDate(value) {
  const d = value instanceof Date ? value : new Date(value);
  if (isNaN(d)) return '—';
  const now = new Date();
  const diffMs = now - d;
  const hhmm = `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (diffMs < 60 * 1000) return 'только что';
  if (diffMs < 60 * 60 * 1000) return `${Math.floor(diffMs / 60000)} мин назад`;
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (d >= startOfToday) return `сегодня ${hhmm}`;
  const startOfYesterday = new Date(startOfToday - 24 * 60 * 60 * 1000);
  if (d >= startOfYesterday) return `вчера ${hhmm}`;
  const sameYear = d.getFullYear() === now.getFullYear();
  const datePart = `${d.getDate()} ${MONTHS_RU[d.getMonth()]}${sameYear ? '' : ' ' + d.getFullYear()}`;
  return `${datePart} ${hhmm}`;
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

// Снимает «версионные хвосты» с имени файла (без расширения), оставляя «голое имя».
// Используется чтобы свести 'детская_1', 'детская_v2', 'детская_final' к 'детская'.
// Если в имени ничего нет кроме цифр/версионных маркеров — вернёт '' (это сигнал «не версия»).
//
// Удаляемые хвосты (повторяя пока что-то снимается):
//   _1, -1, .1, (1), пробел+1   — числовой суффикс с разделителем
//   _v2, -v2                    — версионный префикс v
//   _final, _финал, _итог       — финальный маркер (можно с цифрой: _final2)
//   _copy, _копия               — копия
//   (числа без разделителя в самом конце НЕ режем — это часть имени, например 'IMG_4022' остаётся как есть)
export function stripVersionSuffix(stemNoExt) {
  let s = stemNoExt.toLowerCase();
  let changed = true;
  while (changed) {
    changed = false;
    // (1), (2)
    const re1 = /[\s_-]*\(\d+\)$/;
    if (re1.test(s)) { s = s.replace(re1, ''); changed = true; continue; }
    // _final, -финал, .итог (опционально с цифрой)
    const re2 = /[\s_.-]+(final|финал|итог)\d*$/;
    if (re2.test(s)) { s = s.replace(re2, ''); changed = true; continue; }
    // _v3, -v12
    const re3 = /[\s_.-]+v\d+$/;
    if (re3.test(s)) { s = s.replace(re3, ''); changed = true; continue; }
    // _copy, _копия
    const re4 = /[\s_.-]+(copy|копия)\d*$/;
    if (re4.test(s)) { s = s.replace(re4, ''); changed = true; continue; }
    // _1, -1, .1, пробел+1 — числовой суффикс ТОЛЬКО с разделителем перед ним
    const re5 = /[\s_.-]+\d+$/;
    if (re5.test(s)) { s = s.replace(re5, ''); changed = true; continue; }
  }
  return s.trim();
}

// Расстояние Левенштейна с ранним выходом по порогу.
// Если расстояние превысит maxDistance — возвращает maxDistance + 1 не дочитывая.
// Без раннего выхода был бы O(m*n) на каждое сравнение, что для тысяч файлов медленно.
export function levenshtein(a, b, maxDistance = Infinity) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > maxDistance) return maxDistance + 1;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  // Сделаем a короче — экономим память
  if (a.length > b.length) [a, b] = [b, a];

  const prev = new Array(a.length + 1);
  const curr = new Array(a.length + 1);
  for (let i = 0; i <= a.length; i++) prev[i] = i;

  for (let j = 1; j <= b.length; j++) {
    curr[0] = j;
    let rowMin = curr[0];
    for (let i = 1; i <= a.length; i++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[i] = Math.min(
        prev[i] + 1,        // удаление
        curr[i - 1] + 1,    // вставка
        prev[i - 1] + cost  // замена
      );
      if (curr[i] < rowMin) rowMin = curr[i];
    }
    if (rowMin > maxDistance) return maxDistance + 1;
    for (let i = 0; i <= a.length; i++) prev[i] = curr[i];
  }
  return prev[a.length];
}

// Извлекает «номер версии» из имени файла. Возвращает число или null.
// Эвристика: ищем последнюю цифровую группу в стеме (без расширения).
// Также распознаём суффиксы final/итог/final2 как заведомо позднее. v3 > v2 > 3 > 2 > отсутствие.
export function extractVersion(filename) {
  const stem = filename.replace(/\.[^.]+$/, '').toLowerCase();
  // final / итог / финал — самый высокий приоритет, дадим базовый бонус 10000 + номер если есть
  const finalMatch = stem.match(/(?:final|итог|финал)(\d*)/);
  if (finalMatch) {
    const n = finalMatch[1] ? parseInt(finalMatch[1], 10) : 1;
    return 10000 + n;
  }
  // v3, v12 — версионный префикс
  const vMatch = stem.match(/v(\d+)(?!.*\d)/);
  if (vMatch) {
    return 1000 + parseInt(vMatch[1], 10);
  }
  // Любая последняя цифровая группа: детская_3, копия (2), house3
  const numMatch = stem.match(/(\d+)(?!.*\d)/);
  if (numMatch) {
    return parseInt(numMatch[1], 10);
  }
  return null;
}

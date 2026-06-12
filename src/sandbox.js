// Песочница для тестирования synca: создаёт фейковый проект архитектора
// в ~/Downloads/synca-sandbox. Используется dev-режимом (--dev) и scripts/sandbox.mjs.

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

export const SANDBOX_ROOT = path.join(os.homedir(), 'Downloads', 'synca-sandbox');
export const SOURCE = path.join(SANDBOX_ROOT, 'рабочая-папка', 'Дом-в-Лесном');
export const DEST = path.join(SANDBOX_ROOT, 'флешка', 'Дом-в-Лесном');
export const PROJECT_NAME = 'Песочница';

// Детерминированный псевдослучайный генератор (LCG) — чтобы init давал одно и то же.
function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

function randomBuffer(rng, size) {
  const buf = Buffer.allocUnsafe(size);
  for (let i = 0; i < size; i += 4) {
    buf.writeUInt32LE(Math.floor(rng() * 0xffffffff), Math.min(i, size - 4));
  }
  return buf;
}

const KB = 1024;
const MB = 1024 * KB;

// [относительный путь, размер, seed]. Одинаковый seed + размер = одинаковое содержимое (дубликат).
const FILES = [
  ['Чертежи/план-1-этаж.dwg', 800 * KB, 11],
  ['Чертежи/план-2-этаж.dwg', 750 * KB, 12],
  ['Чертежи/разрез-А-А.dwg', 400 * KB, 13],
  ['Чертежи/архив/план-1-этаж-старый.dwg', 800 * KB, 11], // дубликат план-1-этаж.dwg
  ['Модели/дом-основная.pln', 4 * MB, 21],
  ['Модели/дом-основная-копия.pln', 4 * MB, 21], // дубликат
  ['Модели/ландшафт.skp', 2 * MB, 23],
  ['Рендеры/фасад-день.jpg', 1.5 * MB, 31],
  ['Рендеры/фасад-ночь.jpg', 1.4 * MB, 32],
  ['Рендеры/гостиная_v1.jpg', 1.2 * MB, 33],
  ['Рендеры/гостиная_v2.jpg', 1.2 * MB, 34],
  ['Рендеры/гостиная_v3.jpg', 1.3 * MB, 35],
  ['Текстуры/дерево-дуб.png', 600 * KB, 41],
  ['Текстуры/камень-серый.png', 700 * KB, 42],
  ['Документы/смета.xlsx', 90 * KB, 51],
  ['Документы/ТЗ-от-заказчика.docx', 120 * KB, 52],
  ['Документы/договор.pdf', 300 * KB, 53],
];

async function writeFileDeep(absPath, content) {
  await fs.mkdir(path.dirname(absPath), { recursive: true });
  await fs.writeFile(absPath, content);
}

// Пересоздаёт песочницу с нуля. Возвращает описание.
export async function init() {
  await fs.rm(SANDBOX_ROOT, { recursive: true, force: true });
  for (const [relPath, size, seed] of FILES) {
    const rng = makeRng(seed);
    await writeFileDeep(path.join(SOURCE, relPath), randomBuffer(rng, Math.round(size)));
  }
  await fs.mkdir(DEST, { recursive: true });
  return { source: SOURCE, destination: DEST, fileCount: FILES.length };
}

// Сценарий изменений: имитирует рабочий день архитектора.
// Возвращает список строк-изменений.
export async function mutate() {
  const rng = makeRng(Date.now() & 0xffffffff);
  const changed = [];

  // 1. Изменились два файла (дописываем в конец)
  for (const rel of ['Чертежи/план-1-этаж.dwg', 'Модели/дом-основная.pln']) {
    const abs = path.join(SOURCE, rel);
    try {
      await fs.appendFile(abs, randomBuffer(rng, 64 * KB));
      changed.push('~ ' + rel);
    } catch {}
  }

  // 2. Появился новый рендер
  const newName = `Рендеры/спальня_v${Math.floor(rng() * 90 + 10)}.jpg`;
  await writeFileDeep(path.join(SOURCE, newName), randomBuffer(rng, Math.round(1.1 * MB)));
  changed.push('+ ' + newName);

  // 3. Один из рендеров удалён (берём первый существующий из серии «гостиная»)
  for (const rel of ['Рендеры/гостиная_v1.jpg', 'Рендеры/гостиная_v2.jpg', 'Рендеры/гостиная_v3.jpg']) {
    try {
      await fs.unlink(path.join(SOURCE, rel));
      changed.push('− ' + rel);
      break;
    } catch {}
  }

  return changed;
}

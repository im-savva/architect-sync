#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import pc from 'picocolors';

process.on('uncaughtException', (err) => {
  console.error(pc.red('\nНепредвиденная ошибка:'), err.message);
  if (process.env.SYNCA_DEBUG) console.error(err.stack);
  process.exit(1);
});

process.on('unhandledRejection', (err) => {
  console.error(pc.red('\nНепредвиденная ошибка:'), err);
  process.exit(1);
});

// Приложение работает из собранного dist/. Чтобы после git pull никто не
// запускал устаревшую сборку, сверяем mtime исходников с dist и при
// необходимости пересобираем (esbuild, доли секунды).
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distFile = path.join(root, 'dist', 'synca.js');

function newestMtime(dir) {
  let newest = 0;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) newest = Math.max(newest, newestMtime(full));
    else {
      try {
        newest = Math.max(newest, fs.statSync(full).mtimeMs);
      } catch {}
    }
  }
  return newest;
}

let needBuild = true;
try {
  const distMtime = fs.statSync(distFile).mtimeMs;
  const srcMtime = Math.max(
    newestMtime(path.join(root, 'src')),
    fs.statSync(path.join(root, 'build.mjs')).mtimeMs
  );
  needBuild = srcMtime > distMtime;
} catch {
  needBuild = true;
}

if (needBuild) {
  console.log(pc.dim('Исходники новее сборки — пересобираю…'));
  const result = spawnSync(process.execPath, [path.join(root, 'build.mjs')], {
    stdio: 'inherit',
    cwd: root,
  });
  if (result.status !== 0) {
    console.error(pc.red('Сборка не удалась. Попробуйте выполнить в папке программы: npm install'));
    process.exit(1);
  }
}

const dev = process.argv.includes('--dev');

const { main } = await import(pathToFileURL(distFile).href);

main({ dev }).catch((err) => {
  console.error(pc.red('\nОшибка:'), err.message || err);
  if (process.env.SYNCA_DEBUG) console.error(err.stack);
  process.exit(1);
});

#!/usr/bin/env node
// CLI-обёртка над src/sandbox.js — песочница для тестирования synca.
//
//   node scripts/sandbox.mjs init     — создать песочницу заново (сносит старую)
//   node scripts/sandbox.mjs mutate   — внести изменения в источник (новые/изменённые/удалённые файлы)
//   node scripts/sandbox.mjs status   — показать пути и содержимое
//
// Те же действия доступны из приложения: synca --dev → плитка «Тесты».

import fs from 'node:fs/promises';
import path from 'node:path';

export { init, mutate, SANDBOX_ROOT, SOURCE, DEST } from '../src/sandbox.js';
import { init, mutate, SANDBOX_ROOT, SOURCE, DEST } from '../src/sandbox.js';

async function status() {
  console.log('Песочница: ' + SANDBOX_ROOT);
  for (const [label, root] of [['Источник', SOURCE], ['Назначение', DEST]]) {
    console.log(`\n${label}: ${root}`);
    try {
      const files = [];
      async function walk(dir, rel = '') {
        for (const e of await fs.readdir(dir, { withFileTypes: true })) {
          const r = rel ? rel + '/' + e.name : e.name;
          if (e.isDirectory()) await walk(path.join(dir, e.name), r);
          else files.push(r);
        }
      }
      await walk(root);
      for (const f of files.sort()) console.log('  ' + f);
      if (!files.length) console.log('  (пусто)');
    } catch {
      console.log('  (не существует — запусти init)');
    }
  }
}

// CLI — только при прямом запуске (модуль также импортируется engine-test)
if (process.argv[1] && import.meta.url === new URL('file://' + process.argv[1]).href) {
  const cmd = process.argv[2] || 'status';
  if (cmd === 'init') {
    const info = await init();
    console.log('Песочница создана:');
    console.log('  Источник:   ' + info.source);
    console.log('  Назначение: ' + info.destination);
    console.log(`  Файлов в источнике: ${info.fileCount} (включая 2 пары дубликатов)`);
  } else if (cmd === 'mutate') {
    const changed = await mutate();
    console.log('Изменения в источнике:');
    for (const line of changed) console.log('  ' + line);
  } else {
    await status();
  }
}

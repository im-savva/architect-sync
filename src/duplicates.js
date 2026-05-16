import path from 'node:path';
import fs from 'node:fs/promises';
import ora from 'ora';
import pc from 'picocolors';
import { checkbox, select, confirm } from '@inquirer/prompts';
import { scanDirectory } from './scanner.js';
import { hashFile, formatBytes, toLongPath, nativeRel, truncatePath } from './utils.js';
import { moveToTrash, makeTrashBatchPath } from './trash.js';

// Базовое имя без расширения и без хвостов вроде " (1)", "_copy", "_v2", "-final".
function baseStem(filename) {
  let stem = filename.replace(/\.[^.]+$/, ''); // отрезаем расширение
  stem = stem.toLowerCase();
  // убираем типичные суффиксы копий
  stem = stem.replace(/[\s_-]*\(\d+\)$/, '');
  stem = stem.replace(/[\s_-]+copy$/i, '');
  stem = stem.replace(/[\s_-]+(final|v\d+|version\d+|new|old|backup|bak)$/i, '');
  return stem.trim();
}

// Группирует файлы по basename. Группа считается дублём если в ней >= 2 файлов.
function groupByBasename(files, sourceRoot) {
  const groups = new Map();
  for (const f of files) {
    const baseName = path.basename(f.relPath);
    const parent = path.dirname(f.relPath);
    const ext = path.extname(baseName).toLowerCase();
    const stem = baseStem(baseName);
    if (!stem) continue;
    // Ключ: stem+ext. Хотим объединять только файлы с одним расширением (.max и .max.bak — это разные)
    const key = stem + ext;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({
      relPath: f.relPath,
      size: f.size,
      mtime: f.mtime,
      parent,
      baseName,
      ext,
      absPath: path.join(sourceRoot, nativeRel(f.relPath)),
    });
  }
  // оставляем только группы >= 2
  return [...groups.entries()]
    .filter(([, files]) => files.length >= 2)
    .map(([key, files]) => ({ key, files }));
}

// Подтверждает идентичность через хэширование — оставляем только группы, где есть реально одинаковые файлы.
async function refineGroupsByHash(groups) {
  const refined = [];
  const total = groups.reduce((s, g) => s + g.files.length, 0);
  const spinner = ora({ text: `Сверяю содержимое (0 / ${total})…`, spinner: 'dots' }).start();
  let done = 0;

  for (const group of groups) {
    // Считаем хэш для каждого файла в группе
    for (const f of group.files) {
      try {
        f.hash = await hashFile(toLongPath(f.absPath));
      } catch {
        f.hash = null;
      }
      done++;
      spinner.text = `Сверяю содержимое (${done} / ${total})…`;
    }
    // Внутри группы — собираем подгруппы по hash. Если есть подгруппа >= 2, добавляем в refined.
    const byHash = new Map();
    for (const f of group.files) {
      if (!f.hash) continue;
      if (!byHash.has(f.hash)) byHash.set(f.hash, []);
      byHash.get(f.hash).push(f);
    }
    for (const [hash, files] of byHash) {
      if (files.length >= 2) {
        refined.push({ key: group.key + ':' + hash.slice(0, 8), files, hash });
      }
    }
  }

  spinner.succeed(`Сверка содержимого завершена (${total} файлов)`);
  return refined;
}

// Основной флоу поиска дубликатов
export async function findAndCleanDuplicates(sourceRoot, ignorePatterns) {
  console.log(pc.dim('  Источник: ' + sourceRoot));
  console.log();

  const spinner = ora({ text: 'Сканирую источник…', spinner: 'dots' }).start();
  const files = await scanDirectory(sourceRoot, ignorePatterns);
  spinner.succeed(`Найдено ${files.length} файлов`);

  const groups = groupByBasename(files, sourceRoot);
  if (groups.length === 0) {
    console.log();
    console.log(pc.green('  [OK] Дубликатов по имени не найдено'));
    return;
  }

  console.log(pc.dim(`  Кандидатов в дубликаты: ${groups.length} групп`));

  const realGroups = await refineGroupsByHash(groups);
  if (realGroups.length === 0) {
    console.log();
    console.log(pc.green('  [OK] Файлов с одинаковым содержимым не найдено'));
    return;
  }

  const totalDupes = realGroups.reduce((s, g) => s + g.files.length, 0);
  const wastedBytes = realGroups.reduce((s, g) => s + g.files[0].size * (g.files.length - 1), 0);

  console.log();
  console.log(pc.yellow(`  Найдено ${realGroups.length} групп дубликатов (${totalDupes} файлов)`));
  console.log(pc.dim(`  Можно освободить до ${formatBytes(wastedBytes)}`));
  console.log();

  const toDelete = [];

  for (let i = 0; i < realGroups.length; i++) {
    const group = realGroups[i];
    console.log();
    console.log(pc.bold(`  Группа ${i + 1} / ${realGroups.length}: ${group.files[0].baseName}`));
    console.log(pc.dim(`  Размер каждого: ${formatBytes(group.files[0].size)}`));
    console.log();

    // Сортируем — самый свежий первым (предположительно «оригинал»)
    group.files.sort((a, b) => b.mtime - a.mtime);

    const choices = group.files.map((f, idx) => ({
      name: `${truncatePath(f.relPath, 60).padEnd(62)}  ${new Date(f.mtime).toISOString().slice(0, 10)}`,
      value: f.relPath,
      checked: idx !== 0, // оставляем самый свежий, остальные предлагаем удалить
    }));

    const selected = await checkbox({
      message: 'Отметьте файлы для удаления (Space — отметить, Enter — подтвердить):',
      choices,
      pageSize: 15,
    });

    // Не дадим удалить все
    if (selected.length === group.files.length) {
      console.log(pc.yellow('  ! Нельзя удалить все файлы из группы — пропускаю эту группу'));
      continue;
    }
    for (const rel of selected) {
      const file = group.files.find((f) => f.relPath === rel);
      toDelete.push(file);
    }
  }

  if (toDelete.length === 0) {
    console.log();
    console.log(pc.dim('  Ничего не отмечено для удаления'));
    return;
  }

  const totalSize = toDelete.reduce((s, f) => s + f.size, 0);
  console.log();
  console.log(pc.yellow(`  К удалению: ${toDelete.length} файлов (${formatBytes(totalSize)})`));
  console.log(pc.dim('  Файлы будут перемещены в .synca/trash/ внутри источника'));

  const ok = await confirm({ message: 'Удалить отмеченные файлы?', default: false });
  if (!ok) {
    console.log(pc.dim('  Отменено'));
    return;
  }

  // Перемещаем в корзину внутри source (отдельная корзина для дубликатов)
  const trashBatch = makeTrashBatchPath(sourceRoot);
  let removed = 0;
  for (const f of toDelete) {
    try {
      await moveToTrash(sourceRoot, f.relPath, trashBatch);
      removed++;
    } catch (err) {
      console.log(pc.red(`  Не удалось удалить ${f.relPath}: ${err.code || err.message}`));
    }
  }

  console.log();
  console.log(pc.green(`  [OK] Удалено ${removed} файлов в корзину`));
  console.log(pc.dim(`  Корзина: ${trashBatch}`));
}

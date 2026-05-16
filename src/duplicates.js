import path from 'node:path';
import ora from 'ora';
import pc from 'picocolors';
import { checkbox, confirm } from '@inquirer/prompts';
import { scanDirectory } from './scanner.js';
import {
  hashFile,
  formatBytes,
  toLongPath,
  nativeRel,
  truncatePath,
  levenshtein,
  extractVersion,
} from './utils.js';
import { moveToTrash, makeTrashBatchPath, pruneEmptyDirs } from './trash.js';

// Порог Левенштейна = 30% длины более короткого имени (но не меньше 2 и не больше 6).
// Эмпирика: "детская_1" vs "детская_2" = 1 (ок), "детская" vs "кухня" = 6 (не дубликат).
// 30% даёт хороший баланс — захватывает "_1/_2/_v3/_final" но не сводит совершенно разные имена.
function distanceThreshold(a, b) {
  const minLen = Math.min(a.length, b.length);
  return Math.max(2, Math.min(6, Math.floor(minLen * 0.3)));
}

// «Стем для сравнения» — basename без расширения, нижний регистр.
// Используется как ключ для Левенштейна (расширение должно совпадать отдельно).
function compareStem(filename) {
  return filename.replace(/\.[^.]+$/, '').toLowerCase().trim();
}

// Группирует файлы по похожести имени **в рамках одной папки**.
// Алгоритм:
//   - идём по файлам в каждой папке отдельно
//   - объединяем в группы файлы с одинаковым расширением, чьи стемы близки по Левенштейну
//   - возвращаем только группы >= 2 файлов
function groupSimilarByName(files, sourceRoot) {
  // Сгруппируем по папке-родителю
  const byParent = new Map();
  for (const f of files) {
    const parent = path.dirname(f.relPath);
    if (!byParent.has(parent)) byParent.set(parent, []);
    byParent.get(parent).push(f);
  }

  const groups = [];

  for (const [parent, parentFiles] of byParent) {
    if (parentFiles.length < 2) continue;

    // По расширению
    const byExt = new Map();
    for (const f of parentFiles) {
      const ext = path.extname(f.relPath).toLowerCase();
      if (!byExt.has(ext)) byExt.set(ext, []);
      byExt.get(ext).push(f);
    }

    for (const [ext, extFiles] of byExt) {
      if (extFiles.length < 2) continue;

      // Готовим объекты со стемом для сравнения
      const items = extFiles.map((f) => ({
        ...f,
        baseName: path.basename(f.relPath),
        stem: compareStem(path.basename(f.relPath)),
        absPath: path.join(sourceRoot, nativeRel(f.relPath)),
        parent,
        ext,
      }));

      // Union-Find: объединяем близкие по Левенштейну
      const parent_uf = items.map((_, i) => i);
      const find = (i) => {
        while (parent_uf[i] !== i) {
          parent_uf[i] = parent_uf[parent_uf[i]];
          i = parent_uf[i];
        }
        return i;
      };
      const union = (a, b) => {
        const ra = find(a), rb = find(b);
        if (ra !== rb) parent_uf[ra] = rb;
      };

      for (let i = 0; i < items.length; i++) {
        for (let j = i + 1; j < items.length; j++) {
          const threshold = distanceThreshold(items[i].stem, items[j].stem);
          const dist = levenshtein(items[i].stem, items[j].stem, threshold);
          if (dist <= threshold) {
            union(i, j);
          }
        }
      }

      // Собираем компоненты связности
      const components = new Map();
      for (let i = 0; i < items.length; i++) {
        const root = find(i);
        if (!components.has(root)) components.set(root, []);
        components.get(root).push(items[i]);
      }

      for (const group of components.values()) {
        if (group.length >= 2) {
          groups.push({ parent, ext, files: group });
        }
      }
    }
  }

  return groups;
}

// Сравнение файлов внутри группы: какой «новее».
// Возвращает > 0 если a новее b, < 0 наоборот, 0 равны.
// Эвристика: max по версии (из имени), при равенстве — по mtime, при равенстве — по длине имени (длиннее = вероятно с суффиксом final).
function compareNewness(a, b) {
  const va = extractVersion(a.baseName);
  const vb = extractVersion(b.baseName);
  // Файл без номера версии считается «базовым» (старше любого пронумерованного)
  const na = va == null ? -1 : va;
  const nb = vb == null ? -1 : vb;
  if (na !== nb) return na - nb;
  if (a.mtime !== b.mtime) return a.mtime - b.mtime;
  return a.baseName.length - b.baseName.length;
}

// Группирует файлы по идентичному содержимому (xxhash).
// Только файлы одного размера попадают в один кандидат-пул, потом считаем хэш.
async function groupIdenticalByHash(files, sourceRoot) {
  // Сначала по размеру — отсекаем одиночек
  const bySize = new Map();
  for (const f of files) {
    if (!bySize.has(f.size)) bySize.set(f.size, []);
    bySize.get(f.size).push(f);
  }
  const candidates = [];
  for (const arr of bySize.values()) {
    if (arr.length >= 2) candidates.push(...arr);
  }
  if (candidates.length === 0) return [];

  const spinner = ora({
    text: `Сверяю содержимое (0 / ${candidates.length})…`,
    spinner: 'dots',
  }).start();

  const enriched = [];
  let done = 0;
  for (const f of candidates) {
    const absPath = path.join(sourceRoot, nativeRel(f.relPath));
    let hash = null;
    try {
      hash = await hashFile(toLongPath(absPath));
    } catch {
      // молча — файл не учтём
    }
    done++;
    spinner.text = `Сверяю содержимое (${done} / ${candidates.length})…`;
    if (hash) {
      enriched.push({
        ...f,
        baseName: path.basename(f.relPath),
        absPath,
        ext: path.extname(f.relPath).toLowerCase(),
        parent: path.dirname(f.relPath),
        hash,
      });
    }
  }
  spinner.succeed(`Сверка завершена (${candidates.length} файлов)`);

  const byHash = new Map();
  for (const f of enriched) {
    if (!byHash.has(f.hash)) byHash.set(f.hash, []);
    byHash.get(f.hash).push(f);
  }
  const groups = [];
  for (const [hash, fs] of byHash) {
    if (fs.length >= 2) groups.push({ hash, files: fs });
  }
  return groups;
}

// Интерактивно проходим по группам и собираем файлы к удалению.
// Возвращает массив отмеченных к удалению файлов.
async function interactiveSelectForDeletion(groups, { groupLabel }) {
  const toDelete = [];

  for (let i = 0; i < groups.length; i++) {
    const group = groups[i];
    // Сортируем: самый новый сверху (по compareNewness — bigger is newer, так что reverse)
    group.files.sort((a, b) => compareNewness(b, a));
    const best = group.files[0];

    console.log();
    console.log(pc.bold(`  Группа ${i + 1} / ${groups.length}: ${groupLabel(group)}`));
    console.log(pc.dim(`  Папка: ${group.files[0].parent || '/'}`));
    console.log();

    const choices = group.files.map((f, idx) => {
      const version = extractVersion(f.baseName);
      const versionLabel = version != null ? ` v=${version}` : '';
      const mtimeLabel = new Date(f.mtime).toISOString().slice(0, 10);
      const sizeLabel = formatBytes(f.size);
      const tag = idx === 0 ? pc.green(' [новейший]') : '';
      return {
        name: `${truncatePath(f.baseName, 50).padEnd(52)}  ${pc.dim(mtimeLabel)}  ${pc.dim(sizeLabel.padStart(10))}${pc.dim(versionLabel)}${tag}`,
        value: f.relPath,
        checked: idx !== 0, // самый новый по умолчанию НЕ помечен к удалению
      };
    });

    let selected;
    try {
      selected = await checkbox({
        message: 'Отметьте файлы для удаления (Space — отметить, Enter — подтвердить, Ctrl+C — пропустить группу):',
        choices,
        pageSize: 15,
      });
    } catch (err) {
      if (
        err?.name === 'AbortPromptError' ||
        err?.name === 'ExitPromptError' ||
        err?.code === 'ABORT_ERR'
      ) {
        console.log(pc.dim('  Группа пропущена'));
        continue;
      }
      throw err;
    }

    if (selected.length === group.files.length) {
      console.log(pc.yellow('  ! Нельзя удалить все файлы из группы — пропускаю эту группу'));
      continue;
    }
    for (const rel of selected) {
      const file = group.files.find((f) => f.relPath === rel);
      toDelete.push(file);
    }
  }

  return toDelete;
}

// Перемещает отмеченные файлы в корзину источника. Возвращает количество.
// После каждого удаления подчищаем опустевшие родительские папки.
async function moveDeletionsToTrash(sourceRoot, toDelete) {
  if (toDelete.length === 0) return { removed: 0, batch: null };
  const trashBatch = makeTrashBatchPath(sourceRoot);
  let removed = 0;
  for (const f of toDelete) {
    try {
      await moveToTrash(sourceRoot, f.relPath, trashBatch);
      const srcDir = path.dirname(path.join(sourceRoot, nativeRel(f.relPath)));
      await pruneEmptyDirs(srcDir, sourceRoot);
      removed++;
    } catch (err) {
      console.log(pc.red(`  Не удалось удалить ${f.relPath}: ${err.code || err.message}`));
    }
  }
  return { removed, batch: trashBatch };
}

// Режим 1: поиск похожих по имени (в одной папке)
export async function findSimilarByName(sourceRoot, ignorePatterns) {
  console.log(pc.dim('  Источник: ' + sourceRoot));
  console.log();

  const spinner = ora({ text: 'Сканирую источник…', spinner: 'dots' }).start();
  const files = await scanDirectory(sourceRoot, ignorePatterns);
  spinner.succeed(`Найдено ${files.length} файлов`);

  const groups = groupSimilarByName(files, sourceRoot);
  if (groups.length === 0) {
    console.log();
    console.log(pc.green('  [OK] Похожих файлов не найдено'));
    return;
  }

  const totalDupes = groups.reduce((s, g) => s + g.files.length, 0);
  const totalExtraSize = groups.reduce(
    (s, g) => s + g.files.slice(1).reduce((ss, f) => ss + f.size, 0),
    0
  );

  console.log();
  console.log(pc.yellow(`  Найдено ${groups.length} групп похожих файлов (${totalDupes} файлов)`));
  console.log(pc.dim(`  Если удалить все кроме новейших — освободится ~${formatBytes(totalExtraSize)}`));

  const toDelete = await interactiveSelectForDeletion(groups, {
    groupLabel: (g) => {
      // Берём имя «самого новейшего» как лейбл группы
      const sorted = [...g.files].sort((a, b) => compareNewness(b, a));
      return `${sorted[0].baseName} (всего ${g.files.length})`;
    },
  });

  if (toDelete.length === 0) {
    console.log();
    console.log(pc.dim('  Ничего не отмечено для удаления'));
    return;
  }

  await confirmAndApply(sourceRoot, toDelete);
}

// Режим 2: поиск идентичных по содержимому
export async function findIdenticalByContent(sourceRoot, ignorePatterns) {
  console.log(pc.dim('  Источник: ' + sourceRoot));
  console.log();

  const spinner = ora({ text: 'Сканирую источник…', spinner: 'dots' }).start();
  const files = await scanDirectory(sourceRoot, ignorePatterns);
  spinner.succeed(`Найдено ${files.length} файлов`);

  const groups = await groupIdenticalByHash(files, sourceRoot);
  if (groups.length === 0) {
    console.log();
    console.log(pc.green('  [OK] Идентичных файлов не найдено'));
    return;
  }

  const totalDupes = groups.reduce((s, g) => s + g.files.length, 0);
  const wastedBytes = groups.reduce((s, g) => s + g.files[0].size * (g.files.length - 1), 0);

  console.log();
  console.log(pc.yellow(`  Найдено ${groups.length} групп идентичных файлов (${totalDupes} файлов)`));
  console.log(pc.dim(`  Можно освободить до ${formatBytes(wastedBytes)}`));

  const toDelete = await interactiveSelectForDeletion(groups, {
    groupLabel: (g) =>
      `${g.files[0].baseName} (${g.files.length} копий, ${formatBytes(g.files[0].size)})`,
  });

  if (toDelete.length === 0) {
    console.log();
    console.log(pc.dim('  Ничего не отмечено для удаления'));
    return;
  }

  await confirmAndApply(sourceRoot, toDelete);
}

async function confirmAndApply(sourceRoot, toDelete) {
  const totalSize = toDelete.reduce((s, f) => s + f.size, 0);
  console.log();
  console.log(pc.yellow(`  К удалению: ${toDelete.length} файлов (${formatBytes(totalSize)})`));
  console.log(pc.dim('  Файлы будут перемещены в .synca/trash/ внутри источника'));

  let ok;
  try {
    ok = await confirm({ message: 'Удалить отмеченные файлы?', default: false });
  } catch (err) {
    if (
      err?.name === 'AbortPromptError' ||
      err?.name === 'ExitPromptError' ||
      err?.code === 'ABORT_ERR'
    ) {
      console.log(pc.dim('  Отменено'));
      return;
    }
    throw err;
  }
  if (!ok) {
    console.log(pc.dim('  Отменено'));
    return;
  }

  const { removed, batch } = await moveDeletionsToTrash(sourceRoot, toDelete);
  console.log();
  console.log(pc.green(`  [OK] Удалено ${removed} файлов в корзину`));
  if (batch) console.log(pc.dim(`  Корзина: ${batch}`));
}

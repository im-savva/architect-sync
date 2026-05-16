import path from 'node:path';
import ora from 'ora';
import pc from 'picocolors';
import { checkboxWithCancel, confirmWithCancel } from './prompts.js';
import { scanDirectory } from './scanner.js';
import {
  hashFile,
  formatBytes,
  toLongPath,
  nativeRel,
  truncatePath,
  extractVersion,
  stripVersionSuffix,
} from './utils.js';
import { moveToTrash, makeTrashBatchPath, pruneEmptyDirs } from './trash.js';

// Минимальная длина «голого имени» (после снятия версионных хвостов).
// Имена короче 4 символов — не считаем версионной серией. Это отсекает
// 1.jpg, 2.jpg, 3.jpg или IMG_4022 / IMG_4023 от ложного склеивания в группу.
const MIN_BASE_NAME_LEN = 4;

// Группирует файлы по «голому имени» в рамках одной папки.
// «Голое имя» = basename без расширения, без версионных хвостов (_1, _v2, _final…).
// Если у двух файлов в одной папке голые имена совпадают точно — это версии одного файла.
function groupSimilarByName(files, sourceRoot) {
  // Ключ: parent + ':' + ext + ':' + bareName
  const groupsMap = new Map();

  for (const f of files) {
    const parent = path.dirname(f.relPath);
    const baseName = path.basename(f.relPath);
    const ext = path.extname(baseName).toLowerCase();
    const stem = baseName.slice(0, baseName.length - ext.length);
    const bare = stripVersionSuffix(stem);

    if (bare.length < MIN_BASE_NAME_LEN) continue; // слишком короткое — не группируем

    const key = parent + ':' + ext + ':' + bare;
    if (!groupsMap.has(key)) groupsMap.set(key, { parent, ext, bare, files: [] });
    groupsMap.get(key).files.push({
      ...f,
      baseName,
      absPath: path.join(sourceRoot, nativeRel(f.relPath)),
      parent,
      ext,
    });
  }

  const groups = [];
  for (const g of groupsMap.values()) {
    if (g.files.length >= 2) groups.push(g);
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
//
// Ctrl+C на любой группе = пропустить её. После Ctrl+C явно восстанавливаем stdin,
// иначе на Windows следующий чекбокс перестаёт реагировать на клавиатуру.
async function interactiveSelectForDeletion(groups, { groupLabel }) {
  const toDelete = [];

  for (let i = 0; i < groups.length; i++) {
    const group = groups[i];
    // Сортируем: самый новый сверху (по compareNewness — bigger is newer, reverse)
    group.files.sort((a, b) => compareNewness(b, a));

    // Файлы могут быть из разных папок (особенно в режиме «идентичные по содержимому»).
    // Показываем заголовок группы и общую часть пути если он общий, иначе намёк «в N папках».
    const parents = [...new Set(group.files.map((f) => f.parent))];
    const parentLabel =
      parents.length === 1
        ? parents[0] || '/'
        : `в ${parents.length} разных папках`;

    console.log();
    console.log(pc.bold(`  Группа ${i + 1} / ${groups.length}: ${groupLabel(group)}`));
    console.log(pc.dim(`  ${parentLabel}`));
    console.log();

    const choices = group.files.map((f, idx) => {
      const version = extractVersion(f.baseName);
      const versionLabel = version != null ? ` v=${version}` : '';
      const mtimeLabel = new Date(f.mtime).toISOString().slice(0, 10);
      const sizeLabel = formatBytes(f.size);
      const tag = idx === 0 ? pc.green(' [новейший]') : '';
      // Показываем полный относительный путь — пользователю важно видеть в какой именно подпапке файл.
      const displayPath = truncatePath(f.relPath, 60).padEnd(62);
      return {
        name: `${displayPath}  ${pc.dim(mtimeLabel)}  ${pc.dim(sizeLabel.padStart(10))}${pc.dim(versionLabel)}${tag}`,
        value: f.relPath,
        checked: idx !== 0,
      };
    });

    let selected;
    try {
      selected = await checkboxWithCancel({
        message: 'Отметьте файлы для удаления:',
        choices,
        pageSize: 15,
      });
    } catch (err) {
      if (err?.isBack) {
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
    ok = await confirmWithCancel({ message: 'Удалить отмеченные файлы?', default: false });
  } catch (err) {
    if (err?.isBack) {
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

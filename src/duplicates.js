import path from 'node:path';
import { scanDirectory } from './scanner.js';
import {
  hashFile,
  toLongPath,
  nativeRel,
  extractVersion,
  stripVersionSuffix,
} from './utils.js';
import { moveToTrash, makeTrashBatchPath, pruneEmptyDirs } from './trash.js';

// Минимальная длина «голого имени» (после снятия версионных хвостов).
// Имена короче 4 символов — не считаем версионной серией. Это отсекает
// 1.jpg, 2.jpg, 3.jpg или IMG_4022 / IMG_4023 от ложного склеивания в группу.
const MIN_BASE_NAME_LEN = 4;

// Папки и расширения, которые исключаем ИЗ ПОИСКА ДУБЛИКАТОВ (но не из синхронизации).
// Текстуры и растровые картинки часто имеют похожие имена (palette_1, brick_2) или дублируются
// между проектами как материалы — пользователю обычно неинтересно их разгребать.
const DUP_IGNORE_DIR_NAMES = new Set(['textures', 'текстуры']);
const DUP_IGNORE_EXTS = new Set([
  '.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.tiff', '.tif',
]);

// Фильтр: оставить только те файлы, которые подходят для поиска дубликатов.
function filterForDuplicates(files) {
  return files.filter((f) => {
    const ext = path.extname(f.relPath).toLowerCase();
    if (DUP_IGNORE_EXTS.has(ext)) return false;
    // Проверяем каждый сегмент пути (без учёта регистра)
    const segments = f.relPath.split(/[\\/]/).map((s) => s.toLowerCase());
    for (const seg of segments) {
      if (DUP_IGNORE_DIR_NAMES.has(seg)) return false;
    }
    return true;
  });
}

// Сканирует источник и отдаёт файлы-кандидаты для поиска дубликатов.
export async function scanForDuplicates(sourceRoot, ignorePatterns) {
  const allFiles = await scanDirectory(sourceRoot, ignorePatterns);
  const files = filterForDuplicates(allFiles);
  return { files, totalScanned: allFiles.length };
}

// Группирует файлы по «голому имени» в рамках одной папки.
// «Голое имя» = basename без расширения, без версионных хвостов (_1, _v2, _final…).
// Если у двух файлов в одной папке голые имена совпадают точно — это версии одного файла.
export function groupSimilarByName(files, sourceRoot) {
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
    if (g.files.length >= 2) {
      // самый новый — первым
      g.files.sort((a, b) => compareNewness(b, a));
      groups.push(g);
    }
  }
  return groups;
}

// Сравнение файлов внутри группы: какой «новее».
// Возвращает > 0 если a новее b, < 0 наоборот, 0 равны.
// Эвристика: max по версии (из имени), при равенстве — по mtime, при равенстве — по длине имени (длиннее = вероятно с суффиксом final).
export function compareNewness(a, b) {
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
// onProgress({ done, total })
export async function groupIdenticalByHash(files, sourceRoot, { onProgress } = {}) {
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
    if (onProgress) onProgress({ done, total: candidates.length });
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

  const byHash = new Map();
  for (const f of enriched) {
    if (!byHash.has(f.hash)) byHash.set(f.hash, []);
    byHash.get(f.hash).push(f);
  }
  const groups = [];
  for (const [hash, groupFiles] of byHash) {
    if (groupFiles.length >= 2) {
      groupFiles.sort((a, b) => compareNewness(b, a));
      groups.push({ hash, files: groupFiles });
    }
  }
  return groups;
}

// Перемещает отмеченные файлы в корзину источника (.synca/trash/ внутри источника).
// После каждого удаления подчищаем опустевшие родительские папки.
// Возвращает { removed, batch, errors }.
export async function moveDuplicatesToTrash(sourceRoot, toDelete) {
  if (toDelete.length === 0) return { removed: 0, batch: null, errors: [] };
  const trashBatch = makeTrashBatchPath(sourceRoot);
  let removed = 0;
  const errors = [];
  for (const f of toDelete) {
    try {
      await moveToTrash(sourceRoot, f.relPath, trashBatch);
      const srcDir = path.dirname(path.join(sourceRoot, nativeRel(f.relPath)));
      await pruneEmptyDirs(srcDir, sourceRoot);
      removed++;
    } catch (err) {
      errors.push({ relPath: f.relPath, reason: err.code || err.message });
    }
  }
  return { removed, batch: trashBatch, errors };
}

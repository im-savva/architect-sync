import path from 'node:path';
import ora from 'ora';
import { hashFile, nativeRel } from './utils.js';

// Phase 1: сравнение по метаданным.
// sourceFiles: [{ relPath, size, mtime }]
// destFiles:   [{ relPath, size, mtime }]
// stateIndex:  Map<relPath, { relPath, size, mtime, xxhash }>
//
// Возвращает:
//   added       — в source, нет в destination
//   modifiedCandidates — есть в обеих, но размер или mtime отличаются (нужна phase 2)
//   identicalCandidates — есть в обеих, метаданные совпадают (страховочная выборка в phase 2)
//   trashed     — в destination, нет в source
export function diffPhase1(sourceFiles, destFiles, stateIndex) {
  const destMap = new Map(destFiles.map((f) => [f.relPath, f]));

  const added = [];
  const modifiedCandidates = [];
  const identicalCandidates = [];

  for (const src of sourceFiles) {
    const dst = destMap.get(src.relPath);
    if (!dst) {
      added.push(src);
      continue;
    }
    // Сравниваем по размеру и mtime источника
    const sameSize = src.size === dst.size;
    // mtime может отличаться на доли мс из-за разных FS, сравниваем с допуском 2 сек
    const sameMtime = Math.abs(src.mtime - dst.mtime) < 2000;
    if (sameSize && sameMtime) {
      identicalCandidates.push(src);
    } else {
      modifiedCandidates.push(src);
    }
  }

  const sourceSet = new Set(sourceFiles.map((f) => f.relPath));
  const trashed = destFiles.filter((f) => !sourceSet.has(f.relPath));

  return { added, modifiedCandidates, identicalCandidates, trashed };
}

// Phase 2: хэшируем кандидатов на изменение со стороны source
// и сравниваем с хэшем из state.json. Если хэш совпадает — файл не изменился.
// Дополнительно: страховочная выборка из identicalCandidates (1 из 200) для защиты от bitrot.
//
// Возвращает:
//   modified — реально изменённые (нужно перекопировать)
//   newHashes — Map<relPath, xxhash> — хэши source файлов, посчитанные в этой фазе (для будущего state.json)
export async function diffPhase2(sourceRoot, modifiedCandidates, identicalCandidates, stateIndex) {
  const modified = [];
  const newHashes = new Map();

  const totalCandidates = modifiedCandidates.length;
  const bitrotSample = identicalCandidates.filter((_, i) => i % 200 === 0);
  const totalToHash = totalCandidates + bitrotSample.length;

  if (totalToHash === 0) {
    return { modified, newHashes };
  }

  const totalBytes =
    modifiedCandidates.reduce((s, f) => s + f.size, 0) +
    bitrotSample.reduce((s, f) => s + f.size, 0);

  const spinner = ora({
    text: `Проверяю содержимое (0 / ${totalToHash})…`,
    spinner: 'dots',
  }).start();

  let done = 0;
  let bytesDone = 0;

  for (const src of modifiedCandidates) {
    const srcPath = path.join(sourceRoot, nativeRel(src.relPath));
    let hash;
    try {
      hash = await hashFile(srcPath);
    } catch {
      // не смогли посчитать — считаем что изменён
      modified.push(src);
      done++;
      continue;
    }
    newHashes.set(src.relPath, hash);

    const known = stateIndex.get(src.relPath);
    if (known && known.xxhash === hash) {
      // содержимое не изменилось, mtime обманул
    } else {
      modified.push(src);
    }
    done++;
    bytesDone += src.size;
    spinner.text = `Проверяю содержимое (${done} / ${totalToHash})…`;
  }

  // Страховочная выборка — проверяем что source файл действительно совпадает с тем что в state.json
  for (const src of bitrotSample) {
    const srcPath = path.join(sourceRoot, nativeRel(src.relPath));
    let hash;
    try {
      hash = await hashFile(srcPath);
    } catch {
      done++;
      continue;
    }
    newHashes.set(src.relPath, hash);
    const known = stateIndex.get(src.relPath);
    if (known && known.xxhash !== hash) {
      // хэш source не совпадает с тем что записано в state — значит файл изменился, но mtime/size не выдали
      modified.push(src);
    }
    done++;
    bytesDone += src.size;
    spinner.text = `Проверяю содержимое (${done} / ${totalToHash})…`;
  }

  spinner.succeed(`Проверка содержимого завершена (${totalToHash} файлов)`);

  return { modified, newHashes };
}

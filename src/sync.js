import fs from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import xxhashAddon from 'xxhash-addon';
const { XXHash64 } = xxhashAddon;
import { toLongPath, nativeRel, sleep } from './utils.js';
import { pruneEmptyDirs } from './trash.js';

const HASH_SEED = Buffer.from([0, 0, 0, 0, 0, 0, 0, 1]);
const COPY_BUFFER = 64 * 1024;
const LOCK_RETRIES = 3;
const LOCK_DELAY_MS = 1000;

// Transform-стрим, считающий xxhash проходящих байт.
function hashTransform(onChunk) {
  const hasher = new XXHash64(HASH_SEED);
  const stream = new Transform({
    transform(chunk, _enc, cb) {
      hasher.update(chunk);
      if (onChunk) onChunk(chunk.length);
      cb(null, chunk);
    },
  });
  stream.getHash = () => hasher.digest().toString('hex');
  return stream;
}

// Копирует один файл атомарно. Возвращает { hash } или бросает.
export async function copyOneFile(srcAbs, dstAbs, { verifyAfterCopy, onChunk } = {}) {
  await fs.mkdir(path.dirname(dstAbs), { recursive: true });
  const tmpAbs = dstAbs + '.synca-tmp';

  // Удалим висящий tmp если есть
  try {
    await fs.unlink(toLongPath(tmpAbs));
  } catch {
    // не было — это норма
  }

  const hasher = hashTransform(onChunk);
  const readStream = createReadStream(toLongPath(srcAbs), { highWaterMark: COPY_BUFFER });
  const writeStream = createWriteStream(toLongPath(tmpAbs), { highWaterMark: COPY_BUFFER });

  try {
    await pipeline(readStream, hasher, writeStream);
  } catch (err) {
    try {
      await fs.unlink(toLongPath(tmpAbs));
    } catch {}
    throw err;
  }

  // fsync — гарантия что данные на диске
  try {
    const fh = await fs.open(toLongPath(tmpAbs), 'r+');
    try {
      await fh.sync();
    } finally {
      await fh.close();
    }
  } catch {
    // sync может не поддерживаться — не критично, но лучше когда работает
  }

  const sourceHash = hasher.getHash();

  // Переносим mtime/atime источника на временный файл, чтобы phase 1 на следующем
  // запуске мог быстро определить идентичность без хэширования.
  try {
    const srcStat = await fs.stat(toLongPath(srcAbs));
    await fs.utimes(toLongPath(tmpAbs), srcStat.atime, srcStat.mtime);
  } catch {
    // не критично — phase 2 разберётся хэшом
  }

  // На некоторых FS rename падает если назначение существует — удалим предварительно
  try {
    await fs.unlink(toLongPath(dstAbs));
  } catch {
    // не было — норма
  }
  await fs.rename(toLongPath(tmpAbs), toLongPath(dstAbs));

  // Верификация: пересчитываем хэш с диска (защита от тихих ошибок записи)
  if (verifyAfterCopy) {
    const verifyHasher = new XXHash64(HASH_SEED);
    await new Promise((resolve, reject) => {
      const s = createReadStream(toLongPath(dstAbs), { highWaterMark: COPY_BUFFER });
      s.on('data', (c) => verifyHasher.update(c));
      s.on('end', resolve);
      s.on('error', reject);
    });
    const verifyHash = verifyHasher.digest().toString('hex');
    if (verifyHash !== sourceHash) {
      // удаляем битый файл
      try {
        await fs.unlink(toLongPath(dstAbs));
      } catch {}
      const err = new Error('verify-mismatch');
      err.code = 'VERIFY_MISMATCH';
      throw err;
    }
  }

  return { hash: sourceHash };
}

// Копирует с retry на EBUSY/EPERM
export async function copyWithRetry(srcAbs, dstAbs, options) {
  let lastErr;
  for (let attempt = 1; attempt <= LOCK_RETRIES; attempt++) {
    try {
      return await copyOneFile(srcAbs, dstAbs, options);
    } catch (err) {
      lastErr = err;
      if (err.code === 'EBUSY' || err.code === 'EPERM' || err.code === 'EACCES') {
        if (attempt < LOCK_RETRIES) {
          await sleep(LOCK_DELAY_MS);
          continue;
        }
      }
      // verify-mismatch — пробуем ещё раз
      if (err.code === 'VERIFY_MISMATCH' && attempt < LOCK_RETRIES) {
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

// Применяет изменения. Никакого вывода — о прогрессе сообщает через колбэки.
//
//   sourceRoot, destination — корни
//   added, modified, trashed — списки { relPath, size, mtime }
//   newHashesFromDiff — Map<relPath, hash> — хэши из phase 2
//   stateFiles — текущий list state.json (стартовое состояние)
//   log — объект из createRunLog (мутируется по ходу)
//   snapshot — SnapshotWriter | null: старые версии перезаписанных/удалённых файлов
//              уезжают туда (вместо безвозвратной потери)
//   verifyAfterCopy — пересчитывать хэш после записи
//   onPartialState(stateFiles) — вызывается после каждого успешного файла (для graceful abort)
//   onProgress({ phase, bytesDone, totalBytes, filesDone, filesTotal, relPath }) — прогресс
//   abortSignal — { aborted: bool }, читается между файлами
export async function applyChanges({
  sourceRoot,
  destination,
  added,
  modified,
  trashed,
  newHashesFromDiff,
  stateFiles,
  log,
  snapshot,
  verifyAfterCopy,
  onPartialState,
  onProgress,
  abortSignal,
}) {
  // Индекс существующих файлов в state — будем обновлять
  const stateMap = new Map(stateFiles.map((f) => [f.relPath, f]));

  // Сначала удаления (в снэпшот) — освобождают место.
  // После каждого удаления убираем опустевшие родительские папки.
  let trashedDone = 0;
  for (const f of trashed) {
    if (abortSignal && abortSignal.aborted) break;
    if (onProgress) {
      onProgress({
        phase: 'trash',
        filesDone: trashedDone,
        filesTotal: trashed.length,
        relPath: f.relPath,
      });
    }
    try {
      const prior = stateMap.get(f.relPath);
      if (snapshot) {
        await snapshot.stash(f.relPath, 'deleted', { xxhash: prior?.xxhash });
      } else {
        await fs.unlink(toLongPath(path.join(destination, nativeRel(f.relPath))));
      }
      log.trashed.push({ relPath: f.relPath, size: f.size });
      stateMap.delete(f.relPath);
      const srcDir = path.dirname(path.join(destination, nativeRel(f.relPath)));
      await pruneEmptyDirs(srcDir, destination);
      if (onPartialState) await onPartialState([...stateMap.values()]);
    } catch (err) {
      log.skipped.push({ relPath: f.relPath, reason: 'trash-failed: ' + err.code });
    }
    trashedDone++;
  }

  // Копирования: added + modified
  const toCopy = [...added, ...modified];
  const totalBytes = toCopy.reduce((s, f) => s + f.size, 0);
  let bytesDone = 0;
  let filesDone = 0;

  const report = (relPath, extraBytes = 0) => {
    if (onProgress) {
      onProgress({
        phase: 'copy',
        bytesDone: bytesDone + extraBytes,
        totalBytes,
        filesDone,
        filesTotal: toCopy.length,
        relPath,
      });
    }
  };

  for (const f of toCopy) {
    if (abortSignal && abortSignal.aborted) break;

    const srcAbs = path.join(sourceRoot, nativeRel(f.relPath));
    const dstAbs = path.join(destination, nativeRel(f.relPath));
    const prior = stateMap.get(f.relPath);
    const isNew = !prior;

    report(f.relPath);

    // Перед перезаписью существующий файл уезжает в снэпшот
    let stashed = false;
    if (!isNew && snapshot) {
      try {
        stashed = await snapshot.stash(f.relPath, 'overwritten', { xxhash: prior?.xxhash });
      } catch {
        // не получилось сохранить старую версию — копируем поверх, как раньше
      }
    }

    try {
      const { hash } = await copyWithRetry(srcAbs, dstAbs, {
        verifyAfterCopy,
        onChunk: (n) => report(f.relPath, n),
      });
      bytesDone += f.size;
      filesDone++;
      report(f.relPath);

      const entry = {
        relPath: f.relPath,
        size: f.size,
        mtime: f.mtime,
        xxhash: hash,
      };
      stateMap.set(f.relPath, entry);
      log.totalBytes += f.size;
      if (isNew) {
        log.added.push(entry);
        if (snapshot) snapshot.recordAdded(f.relPath);
      } else {
        log.modified.push(entry);
      }

      if (onPartialState) await onPartialState([...stateMap.values()]);
    } catch (err) {
      // Копирование сорвалось: вернём старую версию из снэпшота на место,
      // чтобы бэкап не остался без файла вовсе.
      if (stashed) {
        await snapshot.unstash(f.relPath);
      }
      if (err.code === 'VERIFY_MISMATCH') {
        log.verifyFailures.push({ relPath: f.relPath, reason: 'verify-mismatch' });
      } else if (err.code === 'EBUSY' || err.code === 'EPERM' || err.code === 'EACCES') {
        log.skipped.push({ relPath: f.relPath, reason: 'locked: ' + err.code });
      } else if (err.code === 'ENOENT') {
        log.skipped.push({ relPath: f.relPath, reason: 'source-gone' });
      } else {
        log.skipped.push({ relPath: f.relPath, reason: (err.code || 'error') + ': ' + err.message });
      }
      bytesDone += f.size;
      filesDone++;
    }
  }

  return { stateFiles: [...stateMap.values()] };
}

// Чистка хвостовых .synca-tmp файлов в destination (восстановление после сбоя).
export async function cleanupTmpFiles(destination) {
  let removed = 0;
  async function walk(dir) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === '.synca') continue; // не заходим внутрь .synca
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile() && entry.name.endsWith('.synca-tmp')) {
        try {
          await fs.unlink(toLongPath(full));
          removed++;
        } catch {
          // молча
        }
      }
    }
  }
  await walk(destination);
  return removed;
}

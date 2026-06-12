import fs from 'node:fs/promises';
import path from 'node:path';
import {
  SnapshotWriter,
  makeRunId,
  readManifest,
  rewriteManifest,
  listSnapshots,
  buildSnapshotIndex,
  snapshotFilesDir,
  moveFile,
} from './snapshots.js';
import { loadState, saveState } from './state.js';
import { createRunLog, writeLog, readLogs } from './logger.js';
import { copyWithRetry } from './sync.js';
import { pruneEmptyDirs } from './trash.js';
import { toLongPath, nativeRel, pathExists } from './utils.js';

export { buildSnapshotIndex } from './snapshots.js';

// История запусков для UI: логи + наличие снэпшота по runId.
// Возвращает [{ ...log, hasSnapshot }] от новых к старым.
export async function listRuns(destination) {
  const logs = await readLogs(destination);
  const snapshots = await listSnapshots(destination);
  const snapIds = new Set(snapshots.map((m) => m.runId));
  return logs.map((log) => ({ ...log, hasSnapshot: snapIds.has(log.runId) }));
}

// Откат одного запуска синхронизации: возвращает бэкап к состоянию «до».
//  - перезаписанные/удалённые файлы возвращаются из снэпшота на место
//  - файлы, добавленные тем запуском, убираются
// Текущие версии при этом уезжают в НОВЫЙ снэпшот — откат можно откатить.
//
// Важно: следующая синхронизация снова приведёт бэкап к состоянию рабочей
// папки — откат бэкапа имеет смысл для «достать старую версию», а не для
// постоянного возврата.
//
// onProgress({ done, total, relPath })
// Возвращает { log, logPath, newRunId, restored, removedAdded, errors }
export async function rollbackRun({ destination, runId, onProgress }) {
  const manifest = await readManifest(destination, runId);
  if (!manifest) {
    return { error: 'Снэпшот этого запуска не найден (мог быть удалён по лимиту места)' };
  }

  const newRunId = makeRunId();
  const writer = new SnapshotWriter(destination, newRunId, {
    source: manifest.source,
    kind: 'rollback',
  });
  const log = createRunLog({
    runId: newRunId,
    kind: 'rollback',
    source: manifest.source,
    destination,
  });
  log.rolledBackRunId = runId;

  const state = await loadState(destination);
  const stateMap = new Map(state.files.map((f) => [f.relPath, f]));

  const entries = manifest.entries ?? [];
  const addedByRun = manifest.addedByRun ?? [];
  const total = entries.length + addedByRun.length;
  let done = 0;
  const errors = [];
  const tick = (relPath) => {
    done++;
    if (onProgress) onProgress({ done, total, relPath });
  };

  const remainingEntries = [];

  // 1. Вернуть из снэпшота перезаписанные и удалённые файлы
  for (const entry of entries) {
    const snapAbs = path.join(snapshotFilesDir(destination, runId), nativeRel(entry.relPath));
    const dstAbs = path.join(destination, nativeRel(entry.relPath));
    try {
      // текущую версию (если есть) — в новый снэпшот
      const prior = stateMap.get(entry.relPath);
      const hadCurrent = await writer.stash(entry.relPath, 'overwritten', { xxhash: prior?.xxhash });
      // старую версию — на место
      await moveFile(snapAbs, dstAbs);
      // файла не было (откат воссоздаёт удалённый) — для отката отката это «добавление»
      if (!hadCurrent) writer.recordAdded(entry.relPath);
      log.restored.push({ relPath: entry.relPath, size: entry.size, from: runId });
      // state: метаданные восстановленного файла
      let stat = null;
      try {
        stat = await fs.stat(toLongPath(dstAbs));
      } catch {}
      if (entry.xxhash) {
        stateMap.set(entry.relPath, {
          relPath: entry.relPath,
          size: stat ? stat.size : entry.size,
          mtime: stat ? stat.mtimeMs : entry.mtime,
          xxhash: entry.xxhash,
        });
      } else {
        // хэш старой версии неизвестен — пусть следующая синхронизация перепроверит
        stateMap.delete(entry.relPath);
      }
    } catch (err) {
      errors.push({ relPath: entry.relPath, reason: err.code || err.message });
      remainingEntries.push(entry); // не смогли вернуть — остаётся в старом снэпшоте
    }
    tick(entry.relPath);
  }

  // 2. Убрать файлы, добавленные откатываемым запуском
  const remainingAdded = [];
  for (const relPath of addedByRun) {
    const dstAbs = path.join(destination, nativeRel(relPath));
    if (!(await pathExists(dstAbs))) {
      tick(relPath);
      continue;
    }
    try {
      const prior = stateMap.get(relPath);
      await writer.stash(relPath, 'deleted', { xxhash: prior?.xxhash });
      stateMap.delete(relPath);
      log.trashed.push({ relPath, size: prior?.size ?? 0 });
      await pruneEmptyDirs(path.dirname(dstAbs), destination);
    } catch (err) {
      errors.push({ relPath, reason: err.code || err.message });
      remainingAdded.push(relPath);
    }
    tick(relPath);
  }

  // 3. Старый снэпшот: восстановленное из него уехало — переписываем манифест
  //    (если всё забрали, снэпшот удаляется)
  await rewriteManifest(destination, {
    ...manifest,
    entries: remainingEntries,
    addedByRun: remainingAdded,
  }).catch(() => {});

  await writer.finalize().catch(() => {});
  await saveState(destination, { ...state, files: [...stateMap.values()] });

  log.result = errors.length ? 'partial' : 'success';
  log.skipped.push(...errors.map((e) => ({ relPath: e.relPath, reason: e.reason })));
  const logPath = await writeLog(destination, log);

  return {
    log,
    logPath,
    newRunId,
    restored: log.restored.length,
    removedAdded: log.trashed.length,
    errors,
  };
}

// Версии файла, доступные для восстановления:
//   текущая в бэкапе + все версии из снэпшотов.
// snapshotIndex — результат buildSnapshotIndex (чтобы не перечитывать на каждый файл).
export async function listVersions(destination, relPath, snapshotIndex) {
  const versions = [];
  const dstAbs = path.join(destination, nativeRel(relPath));
  try {
    const stat = await fs.stat(toLongPath(dstAbs));
    versions.push({
      from: 'current',
      label: 'Сейчас в бэкапе',
      size: stat.size,
      mtime: stat.mtimeMs,
    });
  } catch {
    // файла в бэкапе нет (удалён) — будут только снэпшотные версии
  }
  for (const v of snapshotIndex.get(relPath) ?? []) {
    versions.push({
      from: v.runId,
      label: v.action === 'deleted' ? 'Перед удалением' : 'Перед перезаписью',
      size: v.size,
      mtime: v.mtime,
    });
  }
  return versions;
}

// Подготовка восстановления в рабочую папку: какие файлы поедут и какие
// из них конфликтуют (файл в источнике существует и новее восстанавливаемого).
//
// items: [{ relPath, from }] — from: 'current' | runId
export async function previewRestore({ sourceRoot, destination, items }) {
  const files = [];
  const conflicts = [];
  let totalBytes = 0;

  for (const item of items) {
    const fromAbs =
      item.from === 'current'
        ? path.join(destination, nativeRel(item.relPath))
        : path.join(snapshotFilesDir(destination, item.from), nativeRel(item.relPath));
    let stat;
    try {
      stat = await fs.stat(toLongPath(fromAbs));
    } catch {
      conflicts.push({ relPath: item.relPath, reason: 'missing' });
      continue;
    }
    const file = { ...item, fromAbs, size: stat.size, mtime: stat.mtimeMs };

    const srcAbs = path.join(sourceRoot, nativeRel(item.relPath));
    try {
      const srcStat = await fs.stat(toLongPath(srcAbs));
      file.sourceExists = true;
      file.sourceMtime = srcStat.mtimeMs;
      file.sourceNewer = srcStat.mtimeMs > stat.mtimeMs + 2000;
      if (file.sourceNewer) {
        conflicts.push({ relPath: item.relPath, reason: 'source-newer', file });
      }
    } catch {
      file.sourceExists = false;
    }

    files.push(file);
    totalBytes += stat.size;
  }

  return { files, conflicts, totalBytes };
}

// Восстановление файлов в рабочую папку (источник).
// files — из previewRestore. Копируем атомарно с верификацией.
// state бэкапа не трогаем: источник — главный, следующая синхронизация всё увидит сама.
//
// onProgress({ done, total, bytesDone, totalBytes, relPath })
export async function restoreToSource({ sourceRoot, files, onProgress, abortSignal }) {
  const totalBytes = files.reduce((s, f) => s + f.size, 0);
  let bytesDone = 0;
  let done = 0;
  const errors = [];
  const restored = [];

  for (const f of files) {
    if (abortSignal && abortSignal.aborted) break;
    const srcAbs = path.join(sourceRoot, nativeRel(f.relPath));
    try {
      await copyWithRetry(f.fromAbs, srcAbs, {
        verifyAfterCopy: true,
        onChunk: (n) => {
          if (onProgress) {
            onProgress({ done, total: files.length, bytesDone: bytesDone + n, totalBytes, relPath: f.relPath });
          }
        },
      });
      restored.push(f.relPath);
    } catch (err) {
      errors.push({ relPath: f.relPath, reason: err.code || err.message });
    }
    bytesDone += f.size;
    done++;
    if (onProgress) onProgress({ done, total: files.length, bytesDone, totalBytes, relPath: f.relPath });
  }

  return { restored, errors };
}

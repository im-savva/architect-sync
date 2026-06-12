import fs from 'node:fs/promises';
import path from 'node:path';
import { toLongPath, nativeRel, pathExists, writeJsonAtomic, readJson } from './utils.js';

const SNAPSHOTS_DIR = '.synca/snapshots';
const MANIFEST_VERSION = 1;

// runId — человекочитаемый timestamp, общий для лога и снэпшота одного запуска.
// Миллисекунды + счётчик гарантируют уникальность даже при запусках в одну секунду
// (иначе откат может писать свой снэпшот в ту же папку, из которой восстанавливает).
let lastRunId = '';
let runIdSeq = 0;
export function makeRunId(date = new Date()) {
  const iso = date.toISOString(); // 2026-06-12T10:33:31.123Z
  let id = iso.slice(0, 23).replace(/:/g, '-').replace('T', '_').replace('.', '-');
  if (id === lastRunId.slice(0, id.length)) {
    runIdSeq++;
    id += '_' + runIdSeq;
  } else {
    runIdSeq = 0;
  }
  lastRunId = id;
  return id;
}

export function snapshotDir(destination, runId) {
  return path.join(destination, SNAPSHOTS_DIR, runId);
}

export function snapshotFilesDir(destination, runId) {
  return path.join(snapshotDir(destination, runId), 'files');
}

function manifestPath(destination, runId) {
  return path.join(snapshotDir(destination, runId), 'manifest.json');
}

// rename с фолбэком на копирование (cross-device).
export async function moveFile(absFrom, absTo) {
  await fs.mkdir(path.dirname(absTo), { recursive: true });
  try {
    await fs.rename(toLongPath(absFrom), toLongPath(absTo));
  } catch (err) {
    if (err.code === 'EXDEV') {
      await fs.copyFile(toLongPath(absFrom), toLongPath(absTo));
      await fs.unlink(toLongPath(absFrom));
    } else {
      throw err;
    }
  }
}

// Копит старые версии файлов во время одного запуска синхронизации.
// Перед перезаписью или удалением файла в destination вызывается stash() —
// файл уезжает в .synca/snapshots/<runId>/files/<relPath>, а в манифест
// пишется что с ним произошло. Манифест сохраняется в finalize().
export class SnapshotWriter {
  constructor(destination, runId, { source, kind = 'sync' } = {}) {
    this.destination = destination;
    this.runId = runId;
    this.source = source ?? null;
    this.kind = kind; // 'sync' | 'rollback'
    this.entries = []; // { relPath, action: 'overwritten'|'deleted', size, mtime, xxhash }
    this.addedByRun = []; // relPath файлов, появившихся в этом запуске (для отката добавлений)
    this.finalized = false;
  }

  // Перемещает destination/<relPath> в снэпшот. meta — известные метаданные
  // (обычно из state.json: size, mtime, xxhash); size/mtime уточняются по факту.
  // Возвращает true если файл был и уехал, false если файла не было.
  async stash(relPath, action, meta = {}) {
    const absFrom = path.join(this.destination, nativeRel(relPath));
    let stat;
    try {
      stat = await fs.stat(toLongPath(absFrom));
    } catch {
      return false; // файла нет — нечего сохранять
    }
    const absTo = path.join(snapshotFilesDir(this.destination, this.runId), nativeRel(relPath));
    await moveFile(absFrom, absTo);
    this.entries.push({
      relPath,
      action,
      size: stat.size,
      mtime: stat.mtimeMs,
      xxhash: meta.xxhash ?? null,
    });
    return true;
  }

  // Возврат файла из снэпшота обратно (когда копирование нового содержимого сорвалось).
  async unstash(relPath) {
    const idx = this.entries.findIndex((e) => e.relPath === relPath);
    if (idx === -1) return false;
    const absFrom = path.join(snapshotFilesDir(this.destination, this.runId), nativeRel(relPath));
    const absTo = path.join(this.destination, nativeRel(relPath));
    try {
      await moveFile(absFrom, absTo);
    } catch {
      return false;
    }
    this.entries.splice(idx, 1);
    return true;
  }

  recordAdded(relPath) {
    this.addedByRun.push(relPath);
  }

  get isEmpty() {
    return this.entries.length === 0 && this.addedByRun.length === 0;
  }

  // Пишет манифест (если есть что писать). Возвращает манифест или null.
  async finalize() {
    if (this.finalized) return null;
    this.finalized = true;
    if (this.isEmpty) {
      // пустой снэпшот не оставляем
      try {
        await fs.rm(snapshotDir(this.destination, this.runId), { recursive: true, force: true });
      } catch {}
      return null;
    }
    const manifest = {
      version: MANIFEST_VERSION,
      runId: this.runId,
      kind: this.kind,
      createdAt: new Date().toISOString(),
      source: this.source,
      entries: this.entries,
      addedByRun: this.addedByRun,
    };
    await fs.mkdir(snapshotDir(this.destination, this.runId), { recursive: true });
    await writeJsonAtomic(manifestPath(this.destination, this.runId), manifest);
    return manifest;
  }
}

export async function readManifest(destination, runId) {
  try {
    return await readJson(manifestPath(destination, runId));
  } catch {
    return null;
  }
}

// Переписывает манифест с новым списком entries/addedByRun.
// Если всё опустело — сносит снэпшот целиком.
export async function rewriteManifest(destination, manifest) {
  if ((manifest.entries?.length ?? 0) === 0 && (manifest.addedByRun?.length ?? 0) === 0) {
    await fs.rm(snapshotDir(destination, manifest.runId), { recursive: true, force: true });
    return;
  }
  await writeJsonAtomic(manifestPath(destination, manifest.runId), manifest);
}

// Список всех снэпшотов (с манифестами), от новых к старым.
export async function listSnapshots(destination) {
  const root = path.join(destination, SNAPSHOTS_DIR);
  if (!(await pathExists(root))) return [];
  let names;
  try {
    names = await fs.readdir(root);
  } catch {
    return [];
  }
  const result = [];
  for (const name of names.sort().reverse()) {
    const manifest = await readManifest(destination, name);
    if (manifest) result.push(manifest);
  }
  return result;
}

// Индекс «relPath → версии в снэпшотах» для браузера восстановления.
// Возвращает Map<relPath, [{ runId, action, size, mtime, createdAt }]> (новые первыми).
export async function buildSnapshotIndex(destination) {
  const index = new Map();
  const snapshots = await listSnapshots(destination);
  for (const m of snapshots) {
    for (const e of m.entries ?? []) {
      if (!index.has(e.relPath)) index.set(e.relPath, []);
      index.get(e.relPath).push({
        runId: m.runId,
        action: e.action,
        size: e.size,
        mtime: e.mtime,
        xxhash: e.xxhash ?? null,
        createdAt: m.createdAt,
      });
    }
  }
  return index;
}

async function dirSize(dir) {
  let total = 0;
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += await dirSize(full);
    else if (entry.isFile()) {
      try {
        total += (await fs.stat(full)).size;
      } catch {}
    }
  }
  return total;
}

// Лимит на суммарный размер снэпшотов: retentionPercent от размера бэкапа.
// Самые старые сносятся целиком, но минимум minKeep последних остаются всегда.
export async function enforceSnapshotLimit(
  destination,
  destinationSize,
  retentionPercent = 10,
  minKeep = 3
) {
  const root = path.join(destination, SNAPSHOTS_DIR);
  if (!(await pathExists(root))) return { removed: 0, removedBytes: 0 };

  let names;
  try {
    names = (await fs.readdir(root)).sort(); // старые первыми
  } catch {
    return { removed: 0, removedBytes: 0 };
  }

  const limit = Math.floor((destinationSize * retentionPercent) / 100);
  const batches = [];
  let totalBytes = 0;
  for (const name of names) {
    const p = path.join(root, name);
    const size = await dirSize(p);
    totalBytes += size;
    batches.push({ name, path: p, size });
  }

  let removed = 0;
  let removedBytes = 0;
  let remaining = totalBytes;
  let count = batches.length;
  for (const batch of batches) {
    if (remaining <= limit || count <= minKeep) break;
    try {
      await fs.rm(batch.path, { recursive: true, force: true });
      remaining -= batch.size;
      removedBytes += batch.size;
      removed++;
      count--;
    } catch {
      // молча, не критично
    }
  }
  return { removed, removedBytes };
}

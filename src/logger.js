import fs from 'node:fs/promises';
import path from 'node:path';
import { writeJsonAtomic, readJson } from './utils.js';
import { makeRunId } from './snapshots.js';

const MAX_LOGS = 60;

export function createRunLog({ source, destination, runId, kind = 'sync' }) {
  return {
    runId: runId ?? makeRunId(),
    kind, // 'sync' | 'rollback'
    startedAt: new Date().toISOString(),
    finishedAt: null,
    source,
    destination,
    added: [],
    modified: [],
    trashed: [],
    restored: [], // для kind: 'rollback'
    skipped: [],
    verifyFailures: [],
    totalBytes: 0,
    durationMs: 0,
    result: 'pending',
  };
}

function logsDir(destination) {
  return path.join(destination, '.synca', 'logs');
}

export async function writeLog(destination, log) {
  await fs.mkdir(logsDir(destination), { recursive: true });

  log.finishedAt = new Date().toISOString();
  log.durationMs = Date.parse(log.finishedAt) - Date.parse(log.startedAt);

  const logPath = path.join(logsDir(destination), `${log.runId}.json`);
  await writeJsonAtomic(logPath, log);
  return logPath;
}

// Все логи запусков, от новых к старым.
export async function readLogs(destination) {
  let entries;
  try {
    entries = await fs.readdir(logsDir(destination));
  } catch {
    return [];
  }
  const result = [];
  for (const name of entries.filter((n) => n.endsWith('.json')).sort().reverse()) {
    try {
      const log = await readJson(path.join(logsDir(destination), name));
      // у старых логов не было runId — берём из имени файла
      if (!log.runId) log.runId = name.replace(/\.json$/, '');
      if (!log.kind) log.kind = 'sync';
      result.push(log);
    } catch {
      // битый лог пропускаем
    }
  }
  return result;
}

// Удаляет логи старше MAX_LOGS штук, оставляя самые свежие.
export async function rotateLogs(destination) {
  let entries;
  try {
    entries = await fs.readdir(logsDir(destination));
  } catch {
    return;
  }
  const logs = entries.filter((n) => n.endsWith('.json')).sort();
  if (logs.length <= MAX_LOGS) return;
  const toDelete = logs.slice(0, logs.length - MAX_LOGS);
  for (const name of toDelete) {
    try {
      await fs.unlink(path.join(logsDir(destination), name));
    } catch {
      // молча игнорируем — лог не критичен
    }
  }
}

import fs from 'node:fs/promises';
import path from 'node:path';
import { writeJsonAtomic } from './utils.js';

const MAX_LOGS = 30;

export function createRunLog({ source, destination }) {
  return {
    startedAt: new Date().toISOString(),
    finishedAt: null,
    source,
    destination,
    added: [],
    modified: [],
    trashed: [],
    skipped: [],
    verifyFailures: [],
    totalBytes: 0,
    durationMs: 0,
    result: 'pending',
  };
}

export async function writeLog(destination, log) {
  const logsDir = path.join(destination, '.synca', 'logs');
  await fs.mkdir(logsDir, { recursive: true });

  log.finishedAt = new Date().toISOString();
  log.durationMs = Date.parse(log.finishedAt) - Date.parse(log.startedAt);

  const ts = log.startedAt.replace(/:/g, '-').replace(/\..+/, '').replace('T', '_');
  const logPath = path.join(logsDir, `${ts}.json`);
  await writeJsonAtomic(logPath, log);
  return logPath;
}

// Удаляет логи старше MAX_LOGS штук, оставляя самые свежие.
export async function rotateLogs(destination) {
  const logsDir = path.join(destination, '.synca', 'logs');
  let entries;
  try {
    entries = await fs.readdir(logsDir);
  } catch {
    return;
  }
  const logs = entries.filter((n) => n.endsWith('.json')).sort();
  if (logs.length <= MAX_LOGS) return;
  const toDelete = logs.slice(0, logs.length - MAX_LOGS);
  for (const name of toDelete) {
    try {
      await fs.unlink(path.join(logsDir, name));
    } catch {
      // молча игнорируем — лог не критичен
    }
  }
}

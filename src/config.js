import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { isWindows, writeJsonAtomic, readJson, pathExists, pathContains } from './utils.js';

const CONFIG_VERSION = 1;

const DEFAULT_IGNORE = [
  '*.tmp',
  '*.bak',
  'node_modules',
  '.git',
  '.DS_Store',
  'Thumbs.db',
  '.synca',
];

// Скрытый dev-режим (--dev): отдельный конфиг, чтобы тесты не трогали боевой.
let devMode = false;
export function setDevMode(on) {
  devMode = Boolean(on);
}
export function isDevMode() {
  return devMode;
}

export function getConfigPath() {
  const fileName = devMode ? 'config.dev.json' : 'config.json';
  if (isWindows) {
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appData, 'synca', fileName);
  }
  const xdg = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(xdg, 'synca', fileName);
}

export function defaultConfig() {
  return {
    version: CONFIG_VERSION,
    projects: [],
    ignore: [...DEFAULT_IGNORE],
    trashRetentionPercent: 10,
    snapshotMinKeep: 3,
    verifyAfterCopy: true,
  };
}

export async function loadConfig() {
  const configPath = getConfigPath();
  if (!(await pathExists(configPath))) return null;
  try {
    const cfg = await readJson(configPath);
    if (!cfg.projects) cfg.projects = [];
    if (!cfg.ignore) cfg.ignore = [...DEFAULT_IGNORE];
    if (cfg.trashRetentionPercent == null) cfg.trashRetentionPercent = 10;
    if (cfg.snapshotMinKeep == null) cfg.snapshotMinKeep = 3;
    if (cfg.verifyAfterCopy == null) cfg.verifyAfterCopy = true;
    return cfg;
  } catch {
    // Битый конфиг — переименуем и начнём заново.
    const broken = configPath + '.broken-' + Date.now() + '.json';
    try {
      await fs.rename(configPath, broken);
    } catch {
      // если переименовать не получилось, ничего страшного
    }
    return null;
  }
}

export async function saveConfig(cfg) {
  const configPath = getConfigPath();
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await writeJsonAtomic(configPath, cfg);
}

// Валидация одного проекта. Возвращает строку-ошибку или null.
export async function validateProject(project) {
  const { source, destination } = project;
  if (!source || !destination) return 'Не указан источник или назначение.';

  const srcAbs = path.resolve(source);
  const dstAbs = path.resolve(destination);

  if (srcAbs === dstAbs) {
    return 'Источник и назначение — одна и та же папка.';
  }
  if (pathContains(srcAbs, dstAbs)) {
    return 'Папка назначения находится внутри источника.';
  }
  if (pathContains(dstAbs, srcAbs)) {
    return 'Папка источника находится внутри назначения.';
  }
  return null;
}

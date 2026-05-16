import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import pc from 'picocolors';
import { inputWithBack as input } from './prompts.js';
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

export function getConfigPath() {
  if (isWindows) {
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appData, 'synca', 'config.json');
  }
  const xdg = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(xdg, 'synca', 'config.json');
}

export function defaultConfig() {
  return {
    version: CONFIG_VERSION,
    projects: [],
    ignore: [...DEFAULT_IGNORE],
    trashRetentionPercent: 10,
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
    if (cfg.verifyAfterCopy == null) cfg.verifyAfterCopy = true;
    return cfg;
  } catch (err) {
    // Битый конфиг — переименуем и начнём заново.
    const broken = configPath + '.broken-' + Date.now() + '.json';
    try {
      await fs.rename(configPath, broken);
      console.error(pc.yellow(`Конфиг повреждён, переименован в ${broken}`));
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

// Wizard для добавления нового проекта. Возвращает project object или null если отменили
// (пользователь нажал Ctrl+C на любом шаге).
// Заголовок раздела рисует вызывающая сторона через screen().
export async function projectWizard(existingNames = []) {
  try {
    const name = await input({
      message: 'Название проекта (для отображения в меню):',
      validate: (v) => {
        if (!v.trim()) return 'Название не может быть пустым';
        if (existingNames.includes(v.trim())) return 'Проект с таким названием уже есть';
        return true;
      },
    });

    const source = await input({
      message: 'Путь к папке источника (откуда копировать):',
      validate: async (v) => {
        const trimmed = v.trim();
        if (!trimmed) return 'Путь не может быть пустым';
        if (!(await pathExists(trimmed))) return 'Папка не существует';
        try {
          const st = await fs.stat(trimmed);
          if (!st.isDirectory()) return 'Это не папка';
        } catch {
          return 'Не удаётся прочитать';
        }
        return true;
      },
    });

    const destination = await input({
      message: 'Путь к папке назначения (куда копировать, бэкап):',
      validate: async (v) => {
        const trimmed = v.trim();
        if (!trimmed) return 'Путь не может быть пустым';
        const err = await validateProject({ source: source.trim(), destination: trimmed });
        if (err) return err;
        return true;
      },
    });

    return {
      name: name.trim(),
      source: path.resolve(source.trim()),
      destination: path.resolve(destination.trim()),
    };
  } catch (err) {
    if (err?.isBack) return null;
    throw err;
  }
}

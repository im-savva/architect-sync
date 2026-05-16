import fs from 'node:fs/promises';
import path from 'node:path';
import ora from 'ora';
import pc from 'picocolors';
import { confirm } from '@inquirer/prompts';
import {
  loadConfig,
  saveConfig,
  defaultConfig,
  projectWizard,
  validateProject,
} from './config.js';
import {
  screen,
  divider,
  info,
  success,
  warn,
  error as uiError,
  renderSummary,
  buildChangeList,
  renderFinal,
  renderProjectsTable,
  renderDiskInfo,
} from './ui.js';
import {
  mainMenu,
  settingsMenu,
  duplicatesMenu,
  chooseProject,
  confirmApply,
  viewChangeList,
  pickProject,
  inputWithBack,
  BackError,
} from './prompts.js';
import { scanDirectory } from './scanner.js';
import { diffPhase1, diffPhase2 } from './differ.js';
import { loadState, saveState, indexByRelPath } from './state.js';
import {
  applyChanges,
  cleanupTmpFiles,
} from './sync.js';
import { enforceTrashLimit } from './trash.js';
import { createRunLog, writeLog, rotateLogs } from './logger.js';
import {
  pathExists,
  getDiskStats,
  formatBytes,
} from './utils.js';
import { findSimilarByName, findIdenticalByContent } from './duplicates.js';

export async function main() {
  let cfg = await loadConfig();
  if (!cfg) {
    screen('Первоначальная настройка');
    info('Конфигурация не найдена — настроим первый проект');
    cfg = defaultConfig();
    const project = await projectWizard([]);
    if (!project) {
      // Пользователь нажал Ctrl+C в wizard'е первого запуска — выходим
      console.log();
      info('Настройка прервана. До свидания.');
      return;
    }
    cfg.projects.push(project);
    await saveConfig(cfg);
    success('Проект сохранён');
  }

  // Цикл главного меню
  while (true) {
    if (cfg.projects.length === 0) {
      screen('Первоначальная настройка');
      info('Нет настроенных проектов — добавим первый');
      const project = await projectWizard([]);
      if (!project) {
        console.log();
        info('Настройка прервана. До свидания.');
        return;
      }
      cfg.projects.push(project);
      await saveConfig(cfg);
      success('Проект сохранён');
    }

    screen('Выбор проекта');
    const choice = await chooseProject(cfg.projects);
    if (choice === 'exit') {
      console.log();
      info('До свидания.');
      return;
    }
    if (choice === 'add') {
      screen('Добавление проекта');
      const project = await projectWizard(cfg.projects.map((p) => p.name));
      if (project) {
        cfg.projects.push(project);
        await saveConfig(cfg);
        success(`Проект «${project.name}» добавлен`);
        await pressEnterToContinue();
      }
      continue;
    }

    const project = cfg.projects[choice];

    // Меню для выбранного проекта.
    // Esc / выбор «К выбору проекта» — возврат в chooseProject.
    let stay = true;
    while (stay) {
      screen(project.name);
      console.log(pc.dim(`  Источник:   ${project.source}`));
      console.log(pc.dim(`  Назначение: ${project.destination}`));
      console.log();

      let action;
      try {
        action = await mainMenu();
      } catch (err) {
        if (err?.isBack) {
          stay = false;
          break;
        }
        throw err;
      }

      if (action === '__back__') {
        stay = false;
        break;
      }

      switch (action) {
        case 'sync':
          screen(`${project.name} — синхронизация`);
          await runSync(project, cfg);
          await pressEnterToContinue();
          break;
        case 'duplicates':
          await runDuplicates(project, cfg);
          break;
        case 'settings':
          await runSettings(cfg);
          // если проект был удалён — выходим из этого подменю
          if (!cfg.projects.includes(project)) stay = false;
          break;
        case 'exit':
          return;
      }
    }
  }
}

async function pressEnterToContinue() {
  divider();
  try {
    await inputWithBack({ message: pc.dim('Нажмите Enter чтобы продолжить'), default: '' });
  } catch (err) {
    // Ctrl+C на этом экране — просто продолжаем (как Enter)
    if (!err?.isBack) throw err;
  }
}

async function runSync(project, cfg) {
  // 1. Валидация путей
  const validateErr = await validateProject(project);
  if (validateErr) {
    uiError('Конфигурация проекта: ' + validateErr);
    return;
  }

  if (!(await pathExists(project.source))) {
    uiError(`Источник не найден: ${project.source}`);
    return;
  }
  // Назначение — создаём если не существует
  if (!(await pathExists(project.destination))) {
    try {
      await fs.mkdir(project.destination, { recursive: true });
    } catch (err) {
      uiError(`Не удалось создать папку назначения: ${err.message}`);
      return;
    }
  }

  // Информация о диске назначения
  const dstStats = await getDiskStats(project.destination);
  renderDiskInfo('Диск назначения', dstStats);

  // 2. Восстановление после сбоя
  const cleanupSpinner = ora({ text: 'Подготовка…', spinner: 'dots' }).start();
  const tmpRemoved = await cleanupTmpFiles(project.destination);
  await rotateLogs(project.destination);
  cleanupSpinner.succeed(
    tmpRemoved > 0
      ? `Подготовка: удалено ${tmpRemoved} незавершённых файлов`
      : 'Подготовка завершена'
  );

  // 3. Сканирование source
  const srcSpinner = ora({ text: 'Сканирую источник…', spinner: 'dots' }).start();
  const sourceSkipped = [];
  const sourceFiles = await scanDirectory(project.source, cfg.ignore, {
    onSkip: (s) => sourceSkipped.push(s),
  });
  srcSpinner.succeed(`Источник: ${sourceFiles.length} файлов`);

  // 4. Сканирование destination
  const dstSpinner = ora({ text: 'Сканирую бэкап…', spinner: 'dots' }).start();
  const destFiles = await scanDirectory(project.destination, cfg.ignore);
  dstSpinner.succeed(`Бэкап: ${destFiles.length} файлов`);

  // 5. Загрузка прошлого state
  const state = await loadState(project.destination);
  const stateIndex = indexByRelPath(state);

  // 6. Phase 1 diff по метаданным
  const phase1 = diffPhase1(sourceFiles, destFiles, stateIndex);

  // 7. Phase 2 — хэшируем кандидатов
  const { modified, newHashes } = await diffPhase2(
    project.source,
    phase1.modifiedCandidates,
    phase1.identicalCandidates,
    stateIndex
  );

  // Если делать совсем нечего — выходим
  if (phase1.added.length === 0 && modified.length === 0 && phase1.trashed.length === 0) {
    console.log();
    success('Всё уже синхронизировано');
    return;
  }

  // Превью
  renderSummary({
    added: phase1.added,
    modified,
    trashed: phase1.trashed,
  });

  // Проверка места ДО копирования
  const needBytes =
    phase1.added.reduce((s, f) => s + f.size, 0) +
    modified.reduce((s, f) => s + f.size, 0);

  if (dstStats && needBytes > dstStats.free) {
    uiError(
      `Недостаточно места на диске назначения. Нужно: ${formatBytes(needBytes)}, свободно: ${formatBytes(dstStats.free)}`
    );
    return;
  }

  // 8. Подтверждение. Esc внутри confirmApply / viewChangeList = отмена.
  let decision;
  while (true) {
    try {
      decision = await confirmApply();
    } catch (err) {
      if (err?.isBack) {
        decision = 'cancel';
        break;
      }
      throw err;
    }
    if (decision === 'list') {
      const lines = buildChangeList({
        added: phase1.added,
        modified,
        trashed: phase1.trashed,
      });
      try {
        await viewChangeList(lines);
      } catch (err) {
        if (!err?.isBack) throw err;
      }
      continue;
    }
    break;
  }
  if (decision === 'cancel') {
    info('Отменено');
    return;
  }

  // 9. Применение
  const log = createRunLog({
    source: project.source,
    destination: project.destination,
  });
  log.skipped.push(...sourceSkipped); // скипы со сканирования (symlinks и т.п.)

  // SIGINT handler
  const abortSignal = { aborted: false };
  const sigintHandler = () => {
    if (!abortSignal.aborted) {
      abortSignal.aborted = true;
      console.log();
      console.log(pc.yellow('  Прерывание… (доделаю текущий файл и сохраню прогресс)'));
    }
  };
  process.on('SIGINT', sigintHandler);

  try {
    // Стартовое состояние state — берём текущий files, потом мутируем
    const stateFiles = [...state.files];

    // Частичное сохранение state каждые ~5 сек или после каждого файла (упрощённо — после каждого)
    let lastSaved = 0;
    const onPartialState = async (files) => {
      // Сохраняем не чаще раз в 2 секунды, чтобы не давить FS
      const now = Date.now();
      if (now - lastSaved < 2000) return;
      lastSaved = now;
      await saveState(project.destination, { ...state, files });
    };

    const result = await applyChanges({
      sourceRoot: project.source,
      destination: project.destination,
      added: phase1.added,
      modified,
      trashed: phase1.trashed,
      newHashesFromDiff: newHashes,
      stateFiles,
      log,
      verifyAfterCopy: cfg.verifyAfterCopy,
      onPartialState,
      abortSignal,
    });

    // Финальное сохранение state
    await saveState(project.destination, { ...state, files: result.stateFiles });

    log.result = abortSignal.aborted
      ? 'partial'
      : log.skipped.length || log.verifyFailures.length
      ? 'partial'
      : 'success';

    // Лимит корзины
    const destinationSize = result.stateFiles.reduce((s, f) => s + f.size, 0);
    const trashCleanup = await enforceTrashLimit(
      project.destination,
      destinationSize,
      cfg.trashRetentionPercent
    );
    if (trashCleanup.removed > 0) {
      info(
        `Очистка корзины: удалено ${trashCleanup.removed} старых батчей (${formatBytes(trashCleanup.removedBytes)})`
      );
    }

    const logPath = await writeLog(project.destination, log);
    renderFinal({ log, logPath });

    if (abortSignal.aborted) {
      warn('Синхронизация прервана пользователем. Прогресс сохранён — следующий запуск продолжит с того же места.');
    }
  } finally {
    process.off('SIGINT', sigintHandler);
  }
}

async function runSettings(cfg) {
  while (true) {
    screen('Настройки');
    renderProjectsTable(cfg.projects);
    console.log();

    let action;
    try {
      action = await settingsMenu();
    } catch (err) {
      if (err?.isBack) return;
      throw err;
    }
    if (action === 'back') return;

    if (action === 'add') {
      screen('Настройки — добавление проекта');
      const project = await projectWizard(cfg.projects.map((p) => p.name));
      if (project) {
        cfg.projects.push(project);
        await saveConfig(cfg);
        success(`Проект «${project.name}» добавлен`);
        await pressEnterToContinue();
      }
      continue;
    }

    if (action === 'remove') {
      if (cfg.projects.length === 0) {
        info('Нет проектов');
        await pressEnterToContinue();
        continue;
      }
      screen('Настройки — удаление проекта');
      const idx = await pickProject(cfg.projects, 'Какой проект удалить?');
      if (idx === -1) continue;
      const removed = cfg.projects.splice(idx, 1)[0];
      await saveConfig(cfg);
      success(`Проект «${removed.name}» удалён (файлы на диске не тронуты)`);
      await pressEnterToContinue();
      // если проектов больше нет — возвращаемся
      if (cfg.projects.length === 0) return;
      continue;
    }

    if (action === 'edit') {
      if (cfg.projects.length === 0) {
        info('Нет проектов');
        await pressEnterToContinue();
        continue;
      }
      screen('Настройки — изменение проекта');
      const idx = await pickProject(cfg.projects, 'Какой проект изменить?');
      if (idx === -1) continue;
      const p = cfg.projects[idx];

      let name, source, destination;
      try {
        console.log();
        console.log(pc.dim(`  Текущее имя: ${p.name}`));
        name = await inputWithBack({ message: 'Новое имя (Enter — оставить):', default: p.name });
        console.log(pc.dim(`  Текущий источник: ${p.source}`));
        source = await inputWithBack({ message: 'Новый источник (Enter — оставить):', default: p.source });
        console.log(pc.dim(`  Текущее назначение: ${p.destination}`));
        destination = await inputWithBack({ message: 'Новое назначение (Enter — оставить):', default: p.destination });
      } catch (err) {
        if (err?.isBack) {
          info('Изменение отменено');
          await pressEnterToContinue();
          continue;
        }
        throw err;
      }

      const updated = {
        name: name.trim(),
        source: path.resolve(source.trim()),
        destination: path.resolve(destination.trim()),
      };
      const err = await validateProject(updated);
      if (err) {
        uiError(err);
        await pressEnterToContinue();
        continue;
      }
      cfg.projects[idx] = updated;
      await saveConfig(cfg);
      success('Проект обновлён');
      await pressEnterToContinue();
    }
  }
}

async function runDuplicates(project, cfg) {
  while (true) {
    screen(`${project.name} — поиск дубликатов`);

    let mode;
    try {
      mode = await duplicatesMenu();
    } catch (err) {
      if (err?.isBack) return;
      throw err;
    }
    if (mode === 'back') return;

    if (mode === 'similar') {
      screen(`${project.name} — похожие по имени`);
      await findSimilarByName(project.source, cfg.ignore);
      await pressEnterToContinue();
    } else if (mode === 'identical') {
      screen(`${project.name} — идентичные по содержимому`);
      await findIdenticalByContent(project.source, cfg.ignore);
      await pressEnterToContinue();
    }
  }
}

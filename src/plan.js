import fs from 'node:fs/promises';
import { validateProject } from './config.js';
import { scanDirectory } from './scanner.js';
import { diffPhase1, diffPhase2 } from './differ.js';
import { loadState, saveState, indexByRelPath } from './state.js';
import { applyChanges, cleanupTmpFiles } from './sync.js';
import { SnapshotWriter, makeRunId, enforceSnapshotLimit } from './snapshots.js';
import { createRunLog, writeLog, rotateLogs } from './logger.js';
import { pathExists, getDiskStats } from './utils.js';

// Планирование синхронизации: валидация, очистка tmp, сканирование, diff.
// Ничего не меняет в данных (кроме удаления .synca-tmp хвостов и ротации логов).
//
// onStage(stage, payload) — стадии: 'validate', 'prepare', 'scan-source',
//   'scan-dest', 'diff', 'hash' (payload { done, total } из onHashProgress)
//
// Возвращает { error } либо { plan }.
export async function planSync(project, cfg, { onStage } = {}) {
  const stage = (s, payload) => {
    if (onStage) onStage(s, payload);
  };

  stage('validate');
  const validateErr = await validateProject(project);
  if (validateErr) return { error: 'Конфигурация проекта: ' + validateErr };

  if (!(await pathExists(project.source))) {
    return { error: `Источник не найден: ${project.source}` };
  }
  if (!(await pathExists(project.destination))) {
    try {
      await fs.mkdir(project.destination, { recursive: true });
    } catch (err) {
      return { error: `Не удалось создать папку назначения: ${err.message}` };
    }
  }

  const dstStats = await getDiskStats(project.destination);

  stage('prepare');
  const tmpRemoved = await cleanupTmpFiles(project.destination);
  await rotateLogs(project.destination);

  stage('scan-source');
  const sourceSkipped = [];
  const sourceFiles = await scanDirectory(project.source, cfg.ignore, {
    onSkip: (s) => sourceSkipped.push(s),
  });

  stage('scan-dest');
  const destFiles = await scanDirectory(project.destination, cfg.ignore);

  stage('diff');
  const state = await loadState(project.destination);
  const stateIndex = indexByRelPath(state);
  const phase1 = diffPhase1(sourceFiles, destFiles, stateIndex);

  const { modified, newHashes } = await diffPhase2(
    project.source,
    phase1.modifiedCandidates,
    phase1.identicalCandidates,
    stateIndex,
    { onProgress: (p) => stage('hash', p) }
  );

  const needBytes =
    phase1.added.reduce((s, f) => s + f.size, 0) +
    modified.reduce((s, f) => s + f.size, 0);

  const plan = {
    added: phase1.added,
    modified,
    trashed: phase1.trashed,
    newHashes,
    sourceSkipped,
    state,
    dstStats,
    tmpRemoved,
    sourceCount: sourceFiles.length,
    destCount: destFiles.length,
    needBytes,
    isEmpty:
      phase1.added.length === 0 && modified.length === 0 && phase1.trashed.length === 0,
  };

  if (dstStats && needBytes > dstStats.free) {
    return {
      error: 'not-enough-space',
      plan,
    };
  }

  return { plan };
}

// Применение плана: снэпшот старых версий, копирование, state, лог, ретеншн.
//
//   onProgress — прокидывается в applyChanges (см. sync.js)
//   abortSignal — { aborted: bool }: установить true → доделает текущий файл и остановится
//
// Возвращает { log, logPath, runId, aborted, snapshotCleanup }.
export async function applySync(project, cfg, plan, { onProgress, abortSignal } = {}) {
  const runId = makeRunId();
  const log = createRunLog({
    runId,
    kind: 'sync',
    source: project.source,
    destination: project.destination,
  });
  log.skipped.push(...plan.sourceSkipped); // скипы со сканирования (symlinks и т.п.)

  const snapshot = new SnapshotWriter(project.destination, runId, {
    source: project.source,
  });

  const state = plan.state;
  const stateFiles = [...state.files];

  // Частичное сохранение state — не чаще раза в 2 секунды, чтобы не давить FS
  let lastSaved = 0;
  const onPartialState = async (files) => {
    const now = Date.now();
    if (now - lastSaved < 2000) return;
    lastSaved = now;
    await saveState(project.destination, { ...state, files });
  };

  let result;
  try {
    result = await applyChanges({
      sourceRoot: project.source,
      destination: project.destination,
      added: plan.added,
      modified: plan.modified,
      trashed: plan.trashed,
      newHashesFromDiff: plan.newHashes,
      stateFiles,
      log,
      snapshot,
      verifyAfterCopy: cfg.verifyAfterCopy,
      onPartialState,
      onProgress,
      abortSignal,
    });
  } finally {
    // Манифест снэпшота пишем даже если упали/прервались —
    // уже уехавшие в снэпшот файлы не должны потеряться.
    await snapshot.finalize().catch(() => {});
  }

  await saveState(project.destination, { ...state, files: result.stateFiles });

  const aborted = Boolean(abortSignal && abortSignal.aborted);
  log.result = aborted
    ? 'partial'
    : log.skipped.length || log.verifyFailures.length
    ? 'partial'
    : 'success';

  // Лимит снэпшотов (старые сносятся, минимум cfg.snapshotMinKeep остаются)
  const destinationSize = result.stateFiles.reduce((s, f) => s + f.size, 0);
  const snapshotCleanup = await enforceSnapshotLimit(
    project.destination,
    destinationSize,
    cfg.trashRetentionPercent,
    cfg.snapshotMinKeep
  );

  const logPath = await writeLog(project.destination, log);

  return { log, logPath, runId, aborted, snapshotCleanup };
}

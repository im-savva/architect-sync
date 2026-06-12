import React, { useState, useEffect, useRef, useMemo } from 'react';
import { Box, Text, useInput } from 'ink';
import { useAppCtx } from '../App.jsx';
import { Frame, Menu, ScrollList, ProgressBar, StageList, Buttons, hints } from '../components.jsx';
import { color, marks } from '../theme.js';
import { useTerminalSize, useThrottledValue, useSpeedometer } from '../hooks.js';
import { planSync, applySync } from '../../plan.js';
import { formatBytes, formatDuration, truncatePath } from '../../utils.js';

const STAGE_LABELS = [
  { key: 'prepare', label: 'Подготовка (очистка незавершённых файлов)' },
  { key: 'scan-source', label: 'Сканирую рабочую папку (компьютер)' },
  { key: 'scan-dest', label: 'Сканирую бэкап (внешний диск)' },
  { key: 'diff', label: 'Сравниваю' },
  { key: 'hash', label: 'Проверяю содержимое изменённых файлов' },
];

const FILTERS = [
  { key: 'all', label: 'Все' },
  { key: 'added', label: '+ Новые' },
  { key: 'modified', label: '~ Изменённые' },
  { key: 'trashed', label: '− Удаляемые' },
];

export function SyncScreen({ projectIndex }) {
  const { cfg, nav } = useAppCtx();
  const project = cfg.projects[projectIndex];

  const [phase, setPhase] = useState('planning'); // planning | error | empty | preview | applying | done
  const [plan, setPlan] = useState(null);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);

  // planning
  const [stage, setStage] = useState(null);
  const [hashProgress, setHashProgressNow] = useThrottledValue(120);

  // applying
  const [progress, setProgress] = useThrottledValue(90);
  const speedo = useSpeedometer();
  const abortRef = useRef({ aborted: false });
  const [stopping, setStopping] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      const res = await planSync(project, cfg, {
        onStage: (s, payload) => {
          if (!alive) return;
          if (s === 'hash') setHashProgressNow(payload);
          else setStage(s);
        },
      });
      if (!alive) return;
      if (res.error === 'not-enough-space') {
        setError(
          `Недостаточно места на диске назначения.\nНужно: ${formatBytes(res.plan.needBytes)}, свободно: ${formatBytes(res.plan.dstStats.free)}`
        );
        setPhase('error');
      } else if (res.error) {
        setError(res.error);
        setPhase('error');
      } else if (res.plan.isEmpty) {
        setPlan(res.plan);
        setPhase('empty');
      } else {
        setPlan(res.plan);
        setPhase('preview');
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const startApply = async () => {
    setPhase('applying');
    speedo.reset();
    const res = await applySync(project, cfg, plan, {
      abortSignal: abortRef.current,
      onProgress: (p) => {
        if (p.phase === 'copy') speedo.feed(p.bytesDone);
        setProgress(p);
      },
    });
    setResult(res);
    setPhase('done');
  };

  if (phase === 'planning') {
    const stages = STAGE_LABELS.map((s, i) => ({
      ...s,
      done: STAGE_LABELS.findIndex((x) => x.key === stage) > i,
    }));
    return (
      <Frame title={`${project.name} · синхронизация`} footer={hints('Esc отмена')}>
        <PlanningView stages={stages} current={stage} hashProgress={hashProgress} onBack={() => nav.pop()} />
      </Frame>
    );
  }

  if (phase === 'error' || phase === 'empty') {
    return (
      <Frame title={`${project.name} · синхронизация`} footer={hints('Enter / Esc назад')}>
        <Box flexDirection="column" gap={1}>
          {phase === 'empty' ? (
            <Text color={color.ok}>✔ Всё уже синхронизировано</Text>
          ) : (
            <Text color={color.bad}>{error}</Text>
          )}
          {phase === 'empty' && plan ? (
            <Text color={color.dim}>
              Файлов на компьютере: {plan.sourceCount}, на внешнем диске: {plan.destCount}
            </Text>
          ) : null}
          <BackOnAnyKey onBack={() => nav.pop()} />
        </Box>
      </Frame>
    );
  }

  if (phase === 'preview') {
    return <PreviewView project={project} plan={plan} onApply={startApply} onCancel={() => nav.pop()} />;
  }

  if (phase === 'applying') {
    return (
      <ApplyingView
        project={project}
        plan={plan}
        progress={progress}
        speedo={speedo}
        stopping={stopping}
        onStop={() => {
          abortRef.current.aborted = true;
          setStopping(true);
        }}
      />
    );
  }

  // done
  return <DoneView project={project} result={result} onBack={() => nav.pop()} />;
}

function BackOnAnyKey({ onBack }) {
  useInput((input, key) => {
    if (key.return || key.escape) onBack();
  });
  return null;
}

function PlanningView({ stages, current, hashProgress, onBack }) {
  useInput((input, key) => {
    if (key.escape) onBack();
  });
  return (
    <Box flexDirection="column" gap={1}>
      <StageList stages={stages} current={current} />
      {hashProgress ? (
        <Text color={color.dim}>
          проверено {hashProgress.done} / {hashProgress.total}
        </Text>
      ) : null}
    </Box>
  );
}

// ── Превью изменений: сводка, фильтр, прокручиваемый список ────────────────
function PreviewView({ project, plan, onApply, onCancel }) {
  const { rows } = useTerminalSize();
  const [filter, setFilter] = useState('all');
  const [cursor, setCursor] = useState(0);

  const lists = useMemo(() => {
    const added = plan.added.map((f) => ({ ...f, mark: 'added' }));
    const modified = plan.modified.map((f) => ({ ...f, mark: 'modified' }));
    const trashed = plan.trashed.map((f) => ({ ...f, mark: 'trashed' }));
    return { all: [...added, ...modified, ...trashed], added, modified, trashed };
  }, [plan]);
  const items = lists[filter];

  useInput((input, key) => {
    if (key.escape) {
      onCancel();
      return;
    }
    if (key.return) {
      onApply();
      return;
    }
    if (key.tab || key.leftArrow || key.rightArrow) {
      const dir = key.leftArrow ? -1 : 1;
      const idx = FILTERS.findIndex((f) => f.key === filter);
      const next = FILTERS[(idx + dir + FILTERS.length) % FILTERS.length].key;
      setFilter(next);
      setCursor(0);
      return;
    }
    if (key.upArrow) setCursor((c) => Math.max(0, c - 1));
    if (key.downArrow) setCursor((c) => Math.min(items.length - 1, c + 1));
    if (key.pageUp) setCursor((c) => Math.max(0, c - 10));
    if (key.pageDown) setCursor((c) => Math.min(items.length - 1, c + 10));
  });

  const bytes = (arr) => formatBytes(arr.reduce((s, f) => s + f.size, 0));
  const markColor = { added: color.ok, modified: color.warn, trashed: color.bad };
  const listHeight = Math.max(4, rows - 13);

  return (
    <Frame
      title={`${project.name} · что изменилось`}
      footer={hints('↑↓ список', 'Tab/←→ фильтр', 'Enter применить', 'Esc отмена')}
    >
      <Box flexDirection="column">
        <Box gap={3}>
          <Text color={color.ok}>
            + {plan.added.length} новых <Text color={color.dim}>({bytes(plan.added)})</Text>
          </Text>
          <Text color={color.warn}>
            ~ {plan.modified.length} изменено <Text color={color.dim}>({bytes(plan.modified)})</Text>
          </Text>
          <Text color={color.bad}>
            − {plan.trashed.length} удалено <Text color={color.dim}>({bytes(plan.trashed)})</Text>
          </Text>
        </Box>
        <Box marginTop={1} gap={1}>
          {FILTERS.map((f) => (
            <Text
              key={f.key}
              inverse={f.key === filter}
              color={f.key === filter ? color.accent : color.dim}
            >
              {` ${f.label} (${lists[f.key].length}) `}
            </Text>
          ))}
        </Box>
        <Box marginTop={1} flexDirection="column">
          <ScrollList
            items={items}
            cursor={cursor}
            height={listHeight}
            renderItem={(f, i, isSel) => (
              <Box key={f.mark + f.relPath}>
                <Text color={color.accent}>{isSel ? '❯ ' : '  '}</Text>
                <Text color={markColor[f.mark]}>{marks[f.mark]} </Text>
                <Text bold={isSel} wrap="truncate">
                  {truncatePath(f.relPath, 60).padEnd(62)}
                </Text>
                <Text color={color.dim}>{formatBytes(f.size).padStart(10)}</Text>
              </Box>
            )}
          />
        </Box>
        <Box marginTop={1}>
          <Text color={color.dim}>
            Изменения коснутся только внешнего диска. Старые версии уедут в снэпшот —
            откат доступен в «Истории».
          </Text>
        </Box>
      </Box>
    </Frame>
  );
}

// ── Прогресс применения ────────────────────────────────────────────────────
function ApplyingView({ project, plan, progress, speedo, stopping, onStop }) {
  const { columns } = useTerminalSize();
  useInput((input, key) => {
    if (key.escape && !stopping) onStop();
  });

  const p = progress ?? {};
  const isCopy = p.phase === 'copy';
  const ratio = isCopy && p.totalBytes > 0 ? p.bytesDone / p.totalBytes : 0;
  const speed = speedo.speed();
  const eta = isCopy ? speedo.eta(p.bytesDone ?? 0, p.totalBytes ?? 0) : null;

  return (
    <Frame
      title={`${project.name} · копирую`}
      footer={stopping ? 'останавливаю после текущего файла…' : hints('Esc остановить (прогресс сохранится)')}
    >
      <Box flexDirection="column" gap={1}>
        {p.phase === 'trash' ? (
          <Text>
            Убираю удалённые файлы в снэпшот… {p.filesDone + 1} / {p.filesTotal}
          </Text>
        ) : null}
        <Box>
          <ProgressBar ratio={ratio} width={Math.max(20, columns - 30)} />
          <Text> {Math.floor(ratio * 100)}%</Text>
        </Box>
        <Text>
          {formatBytes(p.bytesDone ?? 0)} / {formatBytes(p.totalBytes ?? plan.needBytes)}
          <Text color={color.dim}>
            {'   '}
            {speed > 0 ? formatBytes(speed) + '/с' : ''}
            {eta != null && eta > 1 ? '   осталось ~' + formatDuration(eta * 1000) : ''}
          </Text>
        </Text>
        <Text color={color.dim}>
          файл {Math.min((p.filesDone ?? 0) + 1, p.filesTotal ?? 0)} из {p.filesTotal ?? 0}:{' '}
          {truncatePath(p.relPath ?? '', 60)}
        </Text>
        {stopping ? <Text color={color.warn}>Останавливаю — доделаю текущий файл и сохраню прогресс…</Text> : null}
      </Box>
    </Frame>
  );
}

// ── Итог ───────────────────────────────────────────────────────────────────
function DoneView({ project, result, onBack }) {
  const { rows } = useTerminalSize();
  const [cursor, setCursor] = useState(0);
  const { log, aborted, snapshotCleanup } = result;

  const problems = [
    ...log.skipped.map((s) => ({ ...s, kind: 'skip' })),
    ...log.verifyFailures.map((s) => ({ ...s, kind: 'verify' })),
  ];

  useInput((input, key) => {
    if (key.return || key.escape) {
      onBack();
      return;
    }
    if (key.upArrow) setCursor((c) => Math.max(0, c - 1));
    if (key.downArrow) setCursor((c) => Math.min(problems.length - 1, c + 1));
  });

  return (
    <Frame
      title={`${project.name} · готово`}
      footer={hints(problems.length > 3 ? '↑↓ список проблем' : null, 'Enter / Esc назад')}
    >
      <Box flexDirection="column" gap={1}>
        {aborted ? (
          <Text color={color.warn}>
            ◼ Прервано. Прогресс сохранён — следующий запуск продолжит с того же места.
          </Text>
        ) : log.result === 'success' ? (
          <Text color={color.ok} bold>
            ✔ Готово
          </Text>
        ) : (
          <Text color={color.warn} bold>
            ✔ Готово, но есть пропуски (см. ниже)
          </Text>
        )}
        <Box flexDirection="column">
          {log.added.length > 0 && (
            <Text color={color.ok}>
              + {log.added.length} файлов добавлено{' '}
              <Text color={color.dim}>({formatBytes(log.added.reduce((s, f) => s + f.size, 0))})</Text>
            </Text>
          )}
          {log.modified.length > 0 && (
            <Text color={color.warn}>
              ~ {log.modified.length} файлов обновлено{' '}
              <Text color={color.dim}>({formatBytes(log.modified.reduce((s, f) => s + f.size, 0))})</Text>
            </Text>
          )}
          {log.trashed.length > 0 && (
            <Text color={color.bad}>
              − {log.trashed.length} файлов убрано с внешнего диска (в снэпшот){' '}
              <Text color={color.dim}>({formatBytes(log.trashed.reduce((s, f) => s + f.size, 0))})</Text>
            </Text>
          )}
        </Box>
        <Text color={color.dim}>
          Время: {formatDuration(log.durationMs)}
          {snapshotCleanup?.removed > 0
            ? `   ·   очистка снэпшотов: −${snapshotCleanup.removed} (${formatBytes(snapshotCleanup.removedBytes)})`
            : ''}
        </Text>
        {problems.length > 0 && (
          <Box flexDirection="column">
            <Text color={color.warn}>Пропущено / ошибки ({problems.length}):</Text>
            <ScrollList
              items={problems}
              cursor={cursor}
              height={Math.max(3, rows - 16)}
              renderItem={(s, i, isSel) => (
                <Text key={i} color={s.kind === 'verify' ? color.bad : color.warn}>
                  {isSel ? '❯ ' : '  '}
                  {truncatePath(s.relPath ?? '', 50)} <Text color={color.dim}>{s.reason}</Text>
                </Text>
              )}
            />
          </Box>
        )}
      </Box>
    </Frame>
  );
}

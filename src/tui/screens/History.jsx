import React, { useState, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import { useAppCtx } from '../App.jsx';
import { Frame, ScrollList, Buttons, Busy, hints } from '../components.jsx';
import { color, marks } from '../theme.js';
import { useTerminalSize } from '../hooks.js';
import { listRuns, rollbackRun } from '../../restore.js';
import { formatBytes, formatDuration, formatRelativeDate, truncatePath } from '../../utils.js';

function runSummary(run) {
  if (run.kind === 'rollback') {
    return `откат → ${run.restored?.length ?? 0} восстановлено, ${run.trashed?.length ?? 0} убрано`;
  }
  return `+${run.added.length} ~${run.modified.length} −${run.trashed.length}  ${formatBytes(run.totalBytes ?? 0)}`;
}

const RESULT_BADGE = {
  success: { text: '✔', color: color.ok },
  partial: { text: '◑', color: color.warn },
  pending: { text: '…', color: color.dim },
};

// История запусков: список → детали → откат.
export function HistoryScreen({ projectIndex }) {
  const { cfg, nav } = useAppCtx();
  const project = cfg.projects[projectIndex];
  const { rows } = useTerminalSize();

  const [runs, setRuns] = useState(null);
  const [cursor, setCursor] = useState(0);
  const [detail, setDetail] = useState(null); // выбранный run

  const reload = async () => {
    try {
      setRuns(await listRuns(project.destination));
    } catch {
      setRuns([]);
    }
  };
  useEffect(() => {
    reload();
  }, []);

  useInput(
    (input, key) => {
      if (key.escape) {
        nav.pop();
        return;
      }
      if (!runs || runs.length === 0) return;
      if (key.upArrow) setCursor((c) => Math.max(0, c - 1));
      if (key.downArrow) setCursor((c) => Math.min(runs.length - 1, c + 1));
      if (key.return) setDetail(runs[cursor]);
    },
    { isActive: detail === null }
  );

  if (detail) {
    return (
      <RunDetail
        project={project}
        run={detail}
        onBack={() => {
          setDetail(null);
          reload();
        }}
      />
    );
  }

  return (
    <Frame
      title={`${project.name} · история бэкапа (внешний диск)`}
      footer={hints('↑↓ выбор', 'Enter детали', 'Esc назад')}
    >
      {runs === null ? (
        <Busy>Читаю историю…</Busy>
      ) : runs.length === 0 ? (
        <Text color={color.dim}>Запусков ещё не было (или бэкап недоступен).</Text>
      ) : (
        <ScrollList
          items={runs}
          cursor={cursor}
          height={rows - 7}
          renderItem={(run, i, isSel) => {
            const badge = RESULT_BADGE[run.result] ?? RESULT_BADGE.pending;
            return (
              <Box key={run.runId}>
                <Text color={color.accent}>{isSel ? '❯ ' : '  '}</Text>
                <Text color={badge.color}>{badge.text} </Text>
                <Text bold={isSel}>{formatRelativeDate(run.startedAt).padEnd(16)}</Text>
                <Text color={run.kind === 'rollback' ? color.warn : undefined}>
                  {(run.kind === 'rollback' ? 'откат  ' : 'синхр. ').padEnd(8)}
                </Text>
                <Text color={color.dim}>{runSummary(run)}</Text>
                {run.hasSnapshot ? <Text color={color.accent}>  ⎌</Text> : null}
              </Box>
            );
          }}
        />
      )}
      {runs?.length > 0 && (
        <Text color={color.dim}>
          ⎌ — есть снэпшот, можно откатить. Откат меняет только внешний диск; вернуть файлы
          на компьютер — плитка «Вернуть на компьютер».
        </Text>
      )}
    </Frame>
  );
}

// ── Детали запуска + откат ─────────────────────────────────────────────────
function RunDetail({ project, run, onBack }) {
  const { rows } = useTerminalSize();
  const [cursor, setCursor] = useState(0);
  const [mode, setMode] = useState('view'); // view | confirm | rolling | result
  const [rollProgress, setRollProgress] = useState(null);
  const [rollResult, setRollResult] = useState(null);

  const lines = [
    ...(run.restored ?? []).map((f) => ({ mark: 'restored', ...f })),
    ...run.added.map((f) => ({ mark: 'added', ...f })),
    ...run.modified.map((f) => ({ mark: 'modified', ...f })),
    ...run.trashed.map((f) => ({ mark: 'trashed', ...f })),
    ...run.skipped.map((f) => ({ mark: 'skipped', ...f })),
  ];
  const markColor = {
    added: color.ok,
    modified: color.warn,
    trashed: color.bad,
    restored: color.accent,
    skipped: color.dim,
  };

  // ↑↓ — прокрутка списка файлов; Enter/Esc/←→ обрабатывают кнопки внизу.
  useInput(
    (input, key) => {
      if (mode === 'view') {
        if (key.upArrow) setCursor((c) => Math.max(0, c - 1));
        if (key.downArrow) setCursor((c) => Math.min(lines.length - 1, c + 1));
        if ((input === 'r' || input === 'к') && run.hasSnapshot) setMode('confirm');
      } else if (mode === 'result') {
        if (key.return || key.escape) onBack();
      }
    },
    { isActive: mode === 'view' || mode === 'result' }
  );

  const doRollback = async () => {
    setMode('rolling');
    const res = await rollbackRun({
      destination: project.destination,
      runId: run.runId,
      onProgress: (p) => setRollProgress(p),
    });
    setRollResult(res);
    setMode('result');
  };

  const title = `${project.name} · ${run.kind === 'rollback' ? 'откат' : 'запуск'} ${formatRelativeDate(run.startedAt)}`;

  if (mode === 'confirm') {
    return (
      <Frame title={title} footer={hints('←→ выбор', 'Enter подтвердить', 'Esc отмена')}>
        <Box flexDirection="column" gap={1}>
          <Text bold>Откатить эту синхронизацию на внешнем диске?</Text>
          <Text color={color.dim}>
            Бэкап на внешнем диске вернётся к состоянию «до»: перезаписанные и удалённые
            файлы будут восстановлены, добавленные убраны. Текущие версии уедут в новый
            снэпшот, так что откат тоже можно откатить.
          </Text>
          <Text color={color.warn}>
            Файлы на компьютере при этом НЕ меняются, и следующая синхронизация снова
            приведёт внешний диск к состоянию компьютера. Если нужно вернуть файлы на
            компьютер — плитка «Вернуть на компьютер» на главном экране.
          </Text>
          <Buttons
            buttons={[
              { label: 'Откатить', value: 'yes', danger: true },
              { label: 'Отмена', value: 'no' },
            ]}
            initialIndex={1}
            onCancel={() => setMode('view')}
            onPress={(v) => (v === 'yes' ? doRollback() : setMode('view'))}
          />
        </Box>
      </Frame>
    );
  }

  if (mode === 'rolling') {
    return (
      <Frame title={title} footer="">
        <Busy>
          Откатываю… {rollProgress ? `${rollProgress.done} / ${rollProgress.total}  ${truncatePath(rollProgress.relPath ?? '', 50)}` : ''}
        </Busy>
      </Frame>
    );
  }

  if (mode === 'result') {
    return (
      <Frame title={title} footer={hints('Enter / Esc назад')}>
        <Box flexDirection="column" gap={1}>
          {rollResult.error ? (
            <Text color={color.bad}>{rollResult.error}</Text>
          ) : (
            <>
              <Text color={color.ok} bold>
                ✔ Откат выполнен
              </Text>
              <Text>
                Восстановлено файлов: {rollResult.restored}, убрано добавленных: {rollResult.removedAdded}
              </Text>
              {rollResult.errors.length > 0 && (
                <Text color={color.warn}>Не получилось: {rollResult.errors.length} (см. лог)</Text>
              )}
            </>
          )}
        </Box>
      </Frame>
    );
  }

  return (
    <Frame
      title={title}
      footer={hints('↑↓ список', '←→ кнопки', 'Enter выбрать', 'Esc назад')}
    >
      <Box flexDirection="column">
        <Text color={color.dim}>
          {new Date(run.startedAt).toLocaleString('ru-RU')} · {formatDuration(run.durationMs)} ·{' '}
          {formatBytes(run.totalBytes ?? 0)}
          {run.kind === 'rollback' && run.rolledBackRunId ? ` · откат запуска ${run.rolledBackRunId}` : ''}
          {run.result === 'partial' ? ' · были пропуски' : ''}
        </Text>
        <Box marginTop={1} flexDirection="column">
          <ScrollList
            items={lines}
            cursor={cursor}
            height={rows - 12}
            renderItem={(f, i, isSel) => (
              <Box key={f.mark + (f.relPath ?? i)}>
                <Text color={color.accent}>{isSel ? '❯ ' : '  '}</Text>
                <Text color={markColor[f.mark]}>{marks[f.mark] ?? '·'} </Text>
                <Text bold={isSel} wrap="truncate">
                  {truncatePath(f.relPath ?? '', 58).padEnd(60)}
                </Text>
                <Text color={color.dim}>
                  {f.size != null ? formatBytes(f.size).padStart(10) : (f.reason ?? '')}
                </Text>
              </Box>
            )}
          />
        </Box>
        <Box marginTop={1}>
          <Buttons
            buttons={[
              ...(run.hasSnapshot
                ? [{ label: '⎌ Откатить на внешнем диске', value: 'rollback', danger: true }]
                : []),
              { label: '← Назад', value: 'back' },
            ]}
            onPress={(v) => (v === 'rollback' ? setMode('confirm') : onBack())}
            onCancel={onBack}
            isActive={mode === 'view'}
          />
        </Box>
        {!run.hasSnapshot && (
          <Text color={color.dim}>
            Снэпшот этого запуска не сохранился (удалён по лимиту места) — откат недоступен.
          </Text>
        )}
      </Box>
    </Frame>
  );
}

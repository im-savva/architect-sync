import React, { useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import { useAppCtx } from '../App.jsx';
import { Frame, TileGrid, hints } from '../components.jsx';
import { color, icons } from '../theme.js';
import { listRuns } from '../../restore.js';
import { listSnapshots } from '../../snapshots.js';
import { getDiskStats, formatBytes, formatRelativeDate, truncatePath } from '../../utils.js';

// Главный экран проекта: плитки режимов.
export function DashboardScreen({ projectIndex }) {
  const { cfg, nav, dev } = useAppCtx();
  const project = cfg.projects[projectIndex];
  const [info, setInfo] = useState({});

  useEffect(() => {
    if (!project) return;
    let alive = true;
    (async () => {
      const result = {};
      try {
        const runs = await listRuns(project.destination);
        const last = runs.find((r) => r.kind === 'sync');
        result.runsCount = runs.length;
        result.lastSync = last
          ? `${formatRelativeDate(last.startedAt)}  +${last.added.length} ~${last.modified.length} −${last.trashed.length}`
          : 'ещё не было';
        const snapshots = await listSnapshots(project.destination);
        result.snapshotCount = snapshots.length;
      } catch {
        result.lastSync = 'бэкап недоступен';
      }
      result.disk = await getDiskStats(project.destination);
      if (alive) setInfo(result);
    })();
    return () => {
      alive = false;
    };
  }, [project]);

  // Проект могли удалить в настройках
  useEffect(() => {
    if (!project) nav.pop();
  }, [project]);
  if (!project) return null;

  const tiles = [
    {
      key: 'sync',
      icon: icons.sync,
      accent: 'cyan',
      title: 'Синхронизировать',
      subtitle: info.lastSync ?? '…',
    },
    {
      key: 'restore',
      icon: icons.restore,
      accent: 'green',
      title: 'Вернуть на компьютер',
      subtitle: 'файлы с внешнего диска',
    },
    {
      key: 'history',
      icon: icons.history,
      accent: 'yellow',
      title: 'История и откаты',
      subtitle:
        info.runsCount != null
          ? `записей: ${info.runsCount} · откат бэкапа`
          : 'журнал · откат бэкапа',
    },
    {
      key: 'duplicates',
      icon: icons.duplicates,
      accent: 'magenta',
      title: 'Дубликаты',
      subtitle: 'найти и почистить',
    },
    {
      key: 'settings',
      icon: icons.settings,
      accent: 'blue',
      title: 'Настройки',
      subtitle: 'проекты и параметры',
    },
    ...(dev
      ? [{ key: 'dev', icon: icons.dev, accent: 'magenta', title: 'Тесты', subtitle: 'песочница' }]
      : []),
  ];

  const diskLine = info.disk
    ? `диск: свободно ${formatBytes(info.disk.free)} из ${formatBytes(info.disk.total)}`
    : undefined;

  return (
    <Frame
      title={project.name}
      right={dev ? 'DEV' : diskLine}
      footer={hints('←→↑↓ выбор', 'Enter открыть', 'Esc к проектам', 'Ctrl+C выход')}
    >
      <Box flexDirection="column" marginBottom={1}>
        <Text color={color.dim}>
          компьютер:    {truncatePath(project.source, 60)}
        </Text>
        <Text color={color.dim}>
          внешний диск: {truncatePath(project.destination, 60)}
        </Text>
        {dev && diskLine ? <Text color={color.dim}>{diskLine}</Text> : null}
      </Box>
      <TileGrid
        tiles={tiles}
        onBack={() => nav.pop()}
        onSelect={(key) => {
          if (key === 'settings') nav.push('settings', {});
          else if (key === 'dev') nav.push('dev', {});
          else nav.push(key, { projectIndex });
        }}
      />
    </Frame>
  );
}

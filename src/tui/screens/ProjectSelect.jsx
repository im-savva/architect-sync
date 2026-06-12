import React, { useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import { useAppCtx } from '../App.jsx';
import { Frame, Menu, hints } from '../components.jsx';
import { color } from '../theme.js';
import { listRuns } from '../../restore.js';
import { formatRelativeDate, truncatePath } from '../../utils.js';

// Корневой экран: выбор проекта. Esc здесь некуда — выход через пункт меню.
export function ProjectSelectScreen() {
  const { cfg, nav, exit, dev } = useAppCtx();
  const [lastSync, setLastSync] = useState({}); // name → строка о последней синхронизации

  useEffect(() => {
    let alive = true;
    (async () => {
      const result = {};
      for (const p of cfg.projects) {
        try {
          const runs = await listRuns(p.destination);
          const last = runs.find((r) => r.kind === 'sync');
          result[p.name] = last
            ? `синх. ${formatRelativeDate(last.startedAt)}`
            : 'ещё не синхронизировался';
        } catch {
          result[p.name] = '';
        }
      }
      if (alive) setLastSync(result);
    })();
    return () => {
      alive = false;
    };
  }, [cfg.projects]);

  const items = [
    ...cfg.projects.map((p, i) => ({
      icon: '▸',
      iconColor: color.accent,
      label: p.name,
      hint: `${truncatePath(p.source, 30)} → ${truncatePath(p.destination, 30)}${
        lastSync[p.name] ? '  ·  ' + lastSync[p.name] : ''
      }`,
      value: { type: 'project', index: i },
    })),
    { icon: '+', iconColor: color.ok, label: 'Добавить проект', value: { type: 'add' } },
    ...(dev
      ? [{ icon: '⚗', iconColor: color.special, label: 'Тесты (песочница)', value: { type: 'dev' } }]
      : []),
    { icon: '×', iconColor: color.bad, label: 'Выход', value: { type: 'exit' } },
  ];

  return (
    <Frame
      title="выбор проекта"
      right={dev ? 'DEV' : undefined}
      footer={hints('↑↓ выбор', 'Enter открыть', 'Ctrl+C выход')}
    >
      {cfg.projects.length === 0 && (
        <Box marginBottom={1}>
          <Text color={color.dim}>Проектов пока нет — добавьте первый.</Text>
        </Box>
      )}
      <Menu
        items={items}
        onSelect={(value) => {
          if (value.type === 'exit') exit();
          else if (value.type === 'add') nav.push('wizard', {});
          else if (value.type === 'dev') nav.push('dev', {});
          else nav.push('dashboard', { projectIndex: value.index });
        }}
      />
    </Frame>
  );
}

import React, { useState } from 'react';
import { Box, Text } from 'ink';
import { useAppCtx } from '../App.jsx';
import { Frame, Menu, Busy, hints } from '../components.jsx';
import { color } from '../theme.js';
import { init, mutate, SOURCE, DEST, PROJECT_NAME } from '../../sandbox.js';

// Скрытый dev-режим (--dev): управление песочницей.
// Работает на отдельном конфиге (config.dev.json), боевой не трогает.
export function DevScreen() {
  const { cfg, updateConfig, nav } = useAppCtx();
  const [busy, setBusy] = useState(null);
  const [messages, setMessages] = useState([]);

  const hasSandboxProject = cfg.projects.some((p) => p.source === SOURCE);

  const run = async (label, fn) => {
    setBusy(label);
    try {
      const lines = await fn();
      setMessages(lines);
    } catch (err) {
      setMessages(['Ошибка: ' + (err.message || err)]);
    }
    setBusy(null);
  };

  const items = [
    {
      label: 'Пересоздать песочницу',
      hint: 'снести и создать заново 17 файлов (~21 МБ)',
      value: 'init',
    },
    {
      label: 'Внести изменения («рабочий день»)',
      hint: '2 файла изменены, 1 новый, 1 удалён',
      value: 'mutate',
    },
    ...(!hasSandboxProject
      ? [
          {
            label: `Добавить проект «${PROJECT_NAME}» в конфиг`,
            hint: 'появится в списке проектов',
            value: 'add-project',
          },
        ]
      : []),
    { label: '← Назад', value: 'back' },
  ];

  return (
    <Frame title="тесты · песочница" right="DEV" footer={hints('↑↓ выбор', 'Enter выполнить', 'Esc назад')}>
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          <Text color={color.dim}>Источник:   {SOURCE}</Text>
          <Text color={color.dim}>Назначение: {DEST}</Text>
        </Box>
        {busy ? (
          <Busy>{busy}</Busy>
        ) : (
          <Menu
            items={items}
            onBack={() => nav.pop()}
            onSelect={async (v) => {
              if (v === 'back') {
                nav.pop();
              } else if (v === 'init') {
                await run('Пересоздаю песочницу…', async () => {
                  const info = await init();
                  return [`Создано файлов: ${info.fileCount}`, 'Бэкап пуст — можно синхронизировать.'];
                });
              } else if (v === 'mutate') {
                await run('Вношу изменения…', async () => {
                  const changed = await mutate();
                  return changed.length ? changed : ['Песочница не создана — сначала init'];
                });
              } else if (v === 'add-project') {
                await updateConfig((c) => {
                  c.projects.push({ name: PROJECT_NAME, source: SOURCE, destination: DEST });
                });
                setMessages([`Проект «${PROJECT_NAME}» добавлен`]);
              }
            }}
          />
        )}
        {messages.length > 0 && (
          <Box flexDirection="column">
            {messages.map((m, i) => (
              <Text key={i} color={color.ok}>
                {m}
              </Text>
            ))}
          </Box>
        )}
      </Box>
    </Frame>
  );
}

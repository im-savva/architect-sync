import React, { useState } from 'react';
import { Box, Text } from 'ink';
import { useAppCtx } from '../App.jsx';
import { Frame, Menu, Buttons, hints } from '../components.jsx';
import { color } from '../theme.js';
import { truncatePath } from '../../utils.js';

// Настройки: проекты + параметры приложения.
export function SettingsScreen() {
  const { cfg, updateConfig, nav } = useAppCtx();
  const [mode, setMode] = useState({ name: 'menu' }); // menu | pick-edit | pick-remove | confirm-remove

  if (mode.name === 'pick-edit' || mode.name === 'pick-remove') {
    const forRemove = mode.name === 'pick-remove';
    return (
      <Frame
        title={forRemove ? 'настройки · удаление проекта' : 'настройки · изменение проекта'}
        footer={hints('↑↓ выбор', 'Enter выбрать', 'Esc назад')}
      >
        <Menu
          items={cfg.projects.map((p, i) => ({
            label: p.name,
            hint: `${truncatePath(p.source, 30)} → ${truncatePath(p.destination, 30)}`,
            value: i,
            danger: forRemove,
          }))}
          onBack={() => setMode({ name: 'menu' })}
          onSelect={(i) => {
            if (forRemove) setMode({ name: 'confirm-remove', index: i });
            else {
              setMode({ name: 'menu' });
              nav.push('wizard', { editIndex: i });
            }
          }}
        />
      </Frame>
    );
  }

  if (mode.name === 'confirm-remove') {
    const p = cfg.projects[mode.index];
    return (
      <Frame title="настройки · удаление проекта" footer={hints('←→ выбор', 'Enter подтвердить', 'Esc отмена')}>
        <Box flexDirection="column" gap={1}>
          <Text>
            Удалить проект <Text bold>«{p.name}»</Text> из списка?
          </Text>
          <Text color={color.dim}>Файлы на дисках не трогаются — удаляется только запись в настройках.</Text>
          <Buttons
            buttons={[
              { label: 'Удалить', value: 'yes', danger: true },
              { label: 'Отмена', value: 'no' },
            ]}
            initialIndex={1}
            onCancel={() => setMode({ name: 'menu' })}
            onPress={async (v) => {
              if (v === 'yes') {
                await updateConfig((c) => {
                  c.projects.splice(mode.index, 1);
                });
              }
              setMode({ name: 'menu' });
            }}
          />
        </Box>
      </Frame>
    );
  }

  const items = [
    { icon: '+', iconColor: color.ok, label: 'Добавить проект', value: 'add' },
    { icon: '~', iconColor: color.warn, label: 'Изменить проект', value: 'edit', disabled: cfg.projects.length === 0 },
    { icon: '−', iconColor: color.bad, label: 'Удалить проект', value: 'remove', disabled: cfg.projects.length === 0, danger: true },
    {
      icon: cfg.verifyAfterCopy ? '◉' : '◯',
      iconColor: cfg.verifyAfterCopy ? color.ok : color.dim,
      label: `Проверка после копирования: ${cfg.verifyAfterCopy ? 'включена' : 'выключена'}`,
      hint: 'перечитывать файл и сверять хэш — медленнее, но надёжнее',
      value: 'verify',
    },
    { icon: '←', iconColor: color.dim, label: 'Назад', value: 'back' },
  ];

  return (
    <Frame title="настройки" footer={hints('↑↓ выбор', 'Enter открыть', 'Esc назад')}>
      <Box flexDirection="column">
        {cfg.projects.length > 0 && (
          <Box flexDirection="column" marginBottom={1}>
            <Text color={color.dim}>Проекты:</Text>
            {cfg.projects.map((p) => (
              <Text key={p.name} color={color.dim}>
                {'  '}
                {p.name} — {truncatePath(p.source, 32)} → {truncatePath(p.destination, 32)}
              </Text>
            ))}
          </Box>
        )}
        <Menu
          items={items}
          onBack={() => nav.pop()}
          onSelect={async (v) => {
            if (v === 'back') nav.pop();
            else if (v === 'add') nav.push('wizard', {});
            else if (v === 'edit') setMode({ name: 'pick-edit' });
            else if (v === 'remove') setMode({ name: 'pick-remove' });
            else if (v === 'verify') {
              await updateConfig((c) => {
                c.verifyAfterCopy = !c.verifyAfterCopy;
              });
            }
          }}
        />
      </Box>
    </Frame>
  );
}

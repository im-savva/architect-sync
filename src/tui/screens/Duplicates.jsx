import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { useAppCtx } from '../App.jsx';
import { Frame, Menu, ScrollList, Buttons, Busy, hints } from '../components.jsx';
import { color } from '../theme.js';
import { useTerminalSize, useThrottledValue } from '../hooks.js';
import {
  scanForDuplicates,
  groupSimilarByName,
  groupIdenticalByHash,
  moveDuplicatesToTrash,
} from '../../duplicates.js';
import { extractVersion, formatBytes, formatRelativeDate, truncatePath } from '../../utils.js';

// Поиск дубликатов: режим → сканирование → группы с чекбоксами → подтверждение.
export function DuplicatesScreen({ projectIndex }) {
  const { cfg, nav } = useAppCtx();
  const project = cfg.projects[projectIndex];

  const [mode, setMode] = useState({ name: 'pick' });
  // pick | scanning | empty | groups | confirm | deleting | result
  const [hashProgress, setHashProgress] = useThrottledValue(120);

  const title = `${project.name} · дубликаты`;

  const startScan = async (kind) => {
    setMode({ name: 'scanning', kind, stage: 'scan' });
    const { files, totalScanned } = await scanForDuplicates(project.source, cfg.ignore);
    let groups;
    if (kind === 'similar') {
      groups = groupSimilarByName(files, project.source);
    } else {
      setMode({ name: 'scanning', kind, stage: 'hash' });
      groups = await groupIdenticalByHash(files, project.source, {
        onProgress: (p) => setHashProgress(p),
      });
    }
    if (groups.length === 0) {
      setMode({ name: 'empty', totalScanned, filtered: files.length });
    } else {
      // отмечаем все кроме новейшего (первый в каждой группе)
      const checked = groups.map((g) => g.files.map((_, i) => i !== 0));
      // cursor: 1 — первая строка-файл (нулевая — заголовок группы)
      setMode({ name: 'groups', kind, groups, checked, cursor: 1 });
    }
  };

  if (mode.name === 'pick') {
    return (
      <Frame title={title} footer={hints('↑↓ выбор', 'Enter запустить', 'Esc назад')}>
        <Box flexDirection="column" gap={1}>
          <Text color={color.dim}>
            Поиск идёт по рабочей папке. Текстуры и растровые картинки не учитываются.
          </Text>
          <Menu
            items={[
              {
                label: 'Похожие по имени',
                hint: 'детская_1, детская_v2, детская_final…',
                value: 'similar',
              },
              {
                label: 'Точно одинаковые по содержимому',
                hint: 'дольше: сверяет файлы по хэшу',
                value: 'identical',
              },
              { label: '← Назад', value: 'back' },
            ]}
            onBack={() => nav.pop()}
            onSelect={(v) => (v === 'back' ? nav.pop() : startScan(v))}
          />
        </Box>
      </Frame>
    );
  }

  if (mode.name === 'scanning') {
    return (
      <Frame title={title} footer="">
        <Busy>
          {mode.stage === 'scan'
            ? 'Сканирую рабочую папку…'
            : `Сверяю содержимое… ${hashProgress ? `${hashProgress.done} / ${hashProgress.total}` : ''}`}
        </Busy>
      </Frame>
    );
  }

  if (mode.name === 'empty') {
    return (
      <Frame title={title} footer={hints('Enter / Esc назад')}>
        <Text color={color.ok}>✔ Дубликатов не найдено</Text>
        <Text color={color.dim}>
          Проверено файлов: {mode.filtered} (из {mode.totalScanned}, без текстур и картинок)
        </Text>
        <BackKeys onBack={() => setMode({ name: 'pick' })} />
      </Frame>
    );
  }

  if (mode.name === 'groups') {
    return <GroupsView title={title} mode={mode} setMode={setMode} />;
  }

  if (mode.name === 'confirm') {
    const totalSize = mode.toDelete.reduce((s, f) => s + f.size, 0);
    return (
      <Frame title={title} footer={hints('←→ выбор', 'Enter подтвердить', 'Esc отмена')}>
        <Box flexDirection="column" gap={1}>
          <Text bold>
            Удалить {mode.toDelete.length} файл(ов) ({formatBytes(totalSize)})?
          </Text>
          <Text color={color.dim}>
            Файлы не пропадут безвозвратно — переедут в корзину .synca/trash внутри рабочей папки.
          </Text>
          <Buttons
            buttons={[
              { label: 'Удалить', value: 'yes', danger: true },
              { label: 'Отмена', value: 'no' },
            ]}
            initialIndex={1}
            onCancel={() => setMode({ name: 'pick' })}
            onPress={async (v) => {
              if (v !== 'yes') {
                setMode({ name: 'pick' });
                return;
              }
              setMode({ name: 'deleting' });
              const result = await moveDuplicatesToTrash(project.source, mode.toDelete);
              setMode({ name: 'result', result });
            }}
          />
        </Box>
      </Frame>
    );
  }

  if (mode.name === 'deleting') {
    return (
      <Frame title={title} footer="">
        <Busy>Перемещаю в корзину…</Busy>
      </Frame>
    );
  }

  // result
  return (
    <Frame title={title} footer={hints('Enter / Esc назад')}>
      <Box flexDirection="column" gap={1}>
        <Text color={color.ok} bold>
          ✔ Перемещено в корзину: {mode.result.removed}
        </Text>
        {mode.result.batch && <Text color={color.dim}>Корзина: {mode.result.batch}</Text>}
        {mode.result.errors.length > 0 && (
          <Text color={color.warn}>Не получилось: {mode.result.errors.length}</Text>
        )}
      </Box>
      <BackKeys onBack={() => nav.pop()} />
    </Frame>
  );
}

// ── Все группы одним списком с чекбоксами ──────────────────────────────────
// Строки-заголовки групп перемежаются строками-файлами. Курсор ходит только
// по файлам, Space отмечает, Enter — к подтверждению сразу по всем группам.
function GroupsView({ title, mode, setMode }) {
  const { rows } = useTerminalSize();
  const { groups, checked, cursor } = mode;

  // Плоский список: header / file
  const flat = [];
  groups.forEach((g, gi) => {
    const parents = [...new Set(g.files.map((f) => f.parent))];
    flat.push({
      type: 'header',
      gi,
      label: `Группа ${gi + 1} из ${groups.length} · ${g.files[0].baseName}`,
      where: parents.length === 1 ? parents[0] || '/' : `в ${parents.length} разных папках`,
    });
    g.files.forEach((f, fi) => flat.push({ type: 'file', gi, fi, file: f }));
  });
  const fileIndexes = flat.map((it, i) => (it.type === 'file' ? i : -1)).filter((i) => i >= 0);

  const collectToDelete = () => {
    const toDelete = [];
    groups.forEach((g, gi) => {
      g.files.forEach((f, fi) => {
        if (checked[gi][fi]) toDelete.push(f);
      });
    });
    return toDelete;
  };

  // группы, где отмечено всё (так нельзя — хоть один файл должен остаться)
  const fullyChecked = groups
    .map((g, gi) => (checked[gi].every(Boolean) ? gi + 1 : null))
    .filter(Boolean);
  const selected = collectToDelete();
  const selectedBytes = selected.reduce((s, f) => s + f.size, 0);

  const moveCursor = (dir) => {
    const pos = fileIndexes.indexOf(cursor);
    const next = fileIndexes[pos + dir];
    if (next != null) setMode({ ...mode, cursor: next });
  };

  useInput((input, key) => {
    if (key.escape) {
      setMode({ name: 'pick' });
      return;
    }
    if (key.return) {
      if (fullyChecked.length > 0) return;
      if (selected.length === 0) {
        setMode({ name: 'pick' });
        return;
      }
      setMode({ name: 'confirm', toDelete: selected });
      return;
    }
    if (input === ' ') {
      const it = flat[cursor];
      if (it?.type !== 'file') return;
      const updated = checked.map((arr, gi) =>
        gi === it.gi ? arr.map((c, fi) => (fi === it.fi ? !c : c)) : arr
      );
      setMode({ ...mode, checked: updated });
      return;
    }
    if (key.upArrow) moveCursor(-1);
    if (key.downArrow) moveCursor(1);
  });

  return (
    <Frame
      title={title}
      footer={hints('Space отметить', '↑↓ выбор', 'Enter удалить отмеченное', 'Esc отмена')}
    >
      <Box flexDirection="column">
        <Text>
          <Text bold>Групп: {groups.length}</Text>
          <Text color={color.dim}>
            {'  ·  отмечено к удалению: '}
            {selected.length} ({formatBytes(selectedBytes)})
            {'  ·  '}
            <Text color={color.ok}>◯ оставить</Text> / <Text color={color.bad}>◉ удалить</Text>
          </Text>
        </Text>
        <Box marginTop={1} flexDirection="column">
          <ScrollList
            items={flat}
            cursor={cursor}
            height={rows - 10}
            renderItem={(it, i, isSel) => {
              if (it.type === 'header') {
                return (
                  <Box key={'h' + it.gi} marginTop={it.gi === 0 ? 0 : 1}>
                    <Text bold color={color.special}>
                      ── {it.label}
                    </Text>
                    <Text color={color.dim}>  {it.where}</Text>
                  </Box>
                );
              }
              const f = it.file;
              const isChecked = checked[it.gi][it.fi];
              const version = extractVersion(f.baseName);
              return (
                <Box key={f.relPath + it.gi}>
                  <Text color={color.accent}>{isSel ? '❯ ' : '  '}</Text>
                  <Text color={isChecked ? color.bad : color.ok}>{isChecked ? '◉' : '◯'} </Text>
                  <Text bold={isSel} color={isChecked ? color.bad : undefined} wrap="truncate">
                    {truncatePath(f.relPath, 54).padEnd(56)}
                  </Text>
                  <Text color={color.dim}>
                    {formatRelativeDate(f.mtime).padEnd(14)} {formatBytes(f.size).padStart(9)}
                    {version != null ? `  v=${version}` : ''}
                  </Text>
                  {it.fi === 0 ? <Text color={color.ok}>  [новейший]</Text> : null}
                </Box>
              );
            }}
          />
        </Box>
        {fullyChecked.length > 0 && (
          <Text color={color.warn}>
            В группе {fullyChecked.join(', ')} отмечены ВСЕ файлы — хотя бы один должен остаться.
          </Text>
        )}
      </Box>
    </Frame>
  );
}

function BackKeys({ onBack }) {
  useInput((input, key) => {
    if (key.return || key.escape) onBack();
  });
  return null;
}

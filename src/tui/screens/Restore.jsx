import React, { useState, useEffect, useMemo } from 'react';
import { Box, Text, useInput } from 'ink';
import { useAppCtx } from '../App.jsx';
import { Frame, Menu, ScrollList, Buttons, Busy, ProgressBar, hints } from '../components.jsx';
import { color } from '../theme.js';
import { useTerminalSize, useThrottledValue } from '../hooks.js';
import { scanDirectory } from '../../scanner.js';
import { buildSnapshotIndex, listVersions, previewRestore, restoreToSource } from '../../restore.js';
import { formatBytes, formatRelativeDate, truncatePath } from '../../utils.js';

// Строит дерево: Map<dirRelPath, [{name, type, relPath, size, mtime, deleted}]>
function buildTree(currentFiles, snapshotIndex) {
  const dirs = new Map(); // dir → Map<name, entry>
  const ensureDir = (dir) => {
    if (!dirs.has(dir)) dirs.set(dir, new Map());
    return dirs.get(dir);
  };
  ensureDir('');

  const addFile = (relPath, info) => {
    const parts = relPath.split('/');
    let dir = '';
    for (let i = 0; i < parts.length - 1; i++) {
      const child = dir ? dir + '/' + parts[i] : parts[i];
      const m = ensureDir(dir);
      if (!m.has(parts[i])) m.set(parts[i], { name: parts[i], type: 'dir', relPath: child });
      ensureDir(child);
      dir = child;
    }
    const name = parts[parts.length - 1];
    const m = ensureDir(dir);
    const existing = m.get(name);
    // файл, который есть в бэкапе, важнее «удалённой» записи из снэпшота
    if (!existing || existing.deleted) m.set(name, { name, type: 'file', relPath, ...info });
  };

  for (const f of currentFiles) {
    addFile(f.relPath, { size: f.size, mtime: f.mtime, deleted: false });
  }
  for (const [relPath, versions] of snapshotIndex) {
    if (dirs.has(relPath)) continue;
    const known = [...dirs.values()].some((m) => {
      const name = relPath.split('/').pop();
      const e = m.get(name);
      return e && e.relPath === relPath;
    });
    if (!known) {
      const v = versions[0];
      addFile(relPath, { size: v.size, mtime: v.mtime, deleted: true });
    }
  }

  // в отсортированные массивы: папки сверху
  const sorted = new Map();
  for (const [dir, m] of dirs) {
    const arr = [...m.values()].sort((a, b) => {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
      return a.name.localeCompare(b.name, 'ru');
    });
    sorted.set(dir, arr);
  }
  return sorted;
}

// Восстановление из бэкапа в рабочую папку.
export function RestoreScreen({ projectIndex }) {
  const { cfg, nav } = useAppCtx();
  const project = cfg.projects[projectIndex];
  const { rows } = useTerminalSize();

  const [data, setData] = useState(null); // { tree, snapshotIndex, currentFiles }
  const [loadError, setLoadError] = useState(null);
  const [dir, setDir] = useState('');
  const [cursors, setCursors] = useState({}); // dir → cursor
  const [mode, setMode] = useState({ name: 'browse' });
  // browse | versions | confirm | restoring | result
  const [progress, setProgress] = useThrottledValue(90);

  useEffect(() => {
    (async () => {
      try {
        const currentFiles = await scanDirectory(project.destination, cfg.ignore);
        const snapshotIndex = await buildSnapshotIndex(project.destination);
        setData({ tree: buildTree(currentFiles, snapshotIndex), snapshotIndex, currentFiles });
      } catch (err) {
        setLoadError('Бэкап недоступен: ' + (err.code || err.message));
      }
    })();
  }, []);

  const entries = data?.tree.get(dir) ?? [];
  const items = useMemo(() => {
    const restoreAll = {
      type: 'action',
      name: dir
        ? `[ Вернуть папку «${dir.split('/').pop()}» целиком на компьютер ]`
        : '[ Вернуть ВСЁ с внешнего диска на компьютер ]',
    };
    return entries.length > 0 ? [restoreAll, ...entries] : entries;
  }, [entries, dir]);
  const cursor = Math.min(cursors[dir] ?? 0, Math.max(0, items.length - 1));
  const setCursor = (c) => setCursors((m) => ({ ...m, [dir]: c }));

  useInput(
    (input, key) => {
      if (key.escape) {
        if (dir === '') nav.pop();
        else setDir(dir.split('/').slice(0, -1).join('/'));
        return;
      }
      if (items.length === 0) return;
      if (key.upArrow) setCursor(Math.max(0, cursor - 1));
      if (key.downArrow) setCursor(Math.min(items.length - 1, cursor + 1));
      if (key.return) {
        const item = items[cursor];
        if (item.type === 'dir') setDir(item.relPath);
        else if (item.type === 'file') openVersions(item);
        else if (item.type === 'action') prepareDirRestore();
      }
    },
    { isActive: mode.name === 'browse' && data != null }
  );

  const openVersions = async (file) => {
    const versions = await listVersions(project.destination, file.relPath, data.snapshotIndex);
    if (versions.length === 0) return;
    setMode({ name: 'versions', file, versions });
  };

  const prepareConfirm = async (items) => {
    setMode({ name: 'confirm-loading' });
    const preview = await previewRestore({
      sourceRoot: project.source,
      destination: project.destination,
      items,
    });
    setMode({ name: 'confirm', preview });
  };

  const prepareDirRestore = () => {
    const prefix = dir === '' ? '' : dir + '/';
    const files = data.currentFiles
      .filter((f) => f.relPath.startsWith(prefix))
      .map((f) => ({ relPath: f.relPath, from: 'current' }));
    if (files.length === 0) return;
    prepareConfirm(files);
  };

  const doRestore = async (files) => {
    setMode({ name: 'restoring', total: files.length });
    const result = await restoreToSource({
      sourceRoot: project.source,
      files,
      onProgress: (p) => setProgress(p),
    });
    setMode({ name: 'result', result });
  };

  const title = `${project.name} · вернуть на компьютер`;

  if (loadError) {
    return (
      <Frame title={title} footer={hints('Esc назад')}>
        <Text color={color.bad}>{loadError}</Text>
        <BackKeys onBack={() => nav.pop()} />
      </Frame>
    );
  }

  if (!data) {
    return (
      <Frame title={title} footer="">
        <Busy>Читаю бэкап и снэпшоты…</Busy>
      </Frame>
    );
  }

  if (mode.name === 'versions') {
    const { file, versions } = mode;
    return (
      <Frame title={title} footer={hints('↑↓ выбор', 'Enter восстановить эту версию', 'Esc назад')}>
        <Box flexDirection="column" gap={1}>
          <Text>
            <Text bold>{file.relPath}</Text>
            {file.deleted ? <Text color={color.bad}>  (в бэкапе уже нет — только в снэпшотах)</Text> : null}
          </Text>
          <Menu
            items={versions.map((v, i) => ({
              label: `${v.label}`,
              hint: `${formatRelativeDate(v.mtime)} · ${formatBytes(v.size)}${
                v.from !== 'current' ? ' · снэпшот ' + v.from : ''
              }`,
              value: i,
            }))}
            onBack={() => setMode({ name: 'browse' })}
            onSelect={(i) => prepareConfirm([{ relPath: file.relPath, from: versions[i].from }])}
          />
        </Box>
      </Frame>
    );
  }

  if (mode.name === 'confirm-loading') {
    return (
      <Frame title={title} footer="">
        <Busy>Проверяю конфликты…</Busy>
      </Frame>
    );
  }

  if (mode.name === 'confirm') {
    const { preview } = mode;
    const conflicts = preview.conflicts.filter((c) => c.reason === 'source-newer');
    return (
      <Frame title={title} footer={hints('←→ выбор', 'Enter подтвердить', 'Esc отмена')}>
        <Box flexDirection="column" gap={1}>
          <Text bold>
            Вернуть на компьютер: {preview.files.length} файл(ов), {formatBytes(preview.totalBytes)}
          </Text>
          <Text color={color.dim}>Куда (рабочая папка на компьютере): {truncatePath(project.source, 50)}</Text>
          {conflicts.length > 0 && (
            <Box flexDirection="column">
              <Text color={color.warn}>
                ⚠ {conflicts.length} файл(ов) на компьютере НОВЕЕ возвращаемой версии — будут перезаписаны:
              </Text>
              {conflicts.slice(0, 5).map((c) => (
                <Text key={c.relPath} color={color.dim}>
                  {'  '}
                  {truncatePath(c.relPath, 60)}
                </Text>
              ))}
              {conflicts.length > 5 && <Text color={color.dim}>  … и ещё {conflicts.length - 5}</Text>}
            </Box>
          )}
          <Buttons
            buttons={[
              { label: 'Вернуть на компьютер', value: 'yes', danger: conflicts.length > 0 },
              { label: 'Отмена', value: 'no' },
            ]}
            initialIndex={conflicts.length > 0 ? 1 : 0}
            onCancel={() => setMode({ name: 'browse' })}
            onPress={(v) => (v === 'yes' ? doRestore(preview.files) : setMode({ name: 'browse' }))}
          />
        </Box>
      </Frame>
    );
  }

  if (mode.name === 'restoring') {
    const p = progress ?? {};
    const ratio = p.totalBytes > 0 ? p.bytesDone / p.totalBytes : 0;
    return (
      <Frame title={title} footer="">
        <Box flexDirection="column" gap={1}>
          <Text>Восстанавливаю {p.done ?? 0} / {p.total ?? mode.total}…</Text>
          <ProgressBar ratio={ratio} width={50} />
          <Text color={color.dim}>{truncatePath(p.relPath ?? '', 60)}</Text>
        </Box>
      </Frame>
    );
  }

  if (mode.name === 'result') {
    const { result } = mode;
    return (
      <Frame title={title} footer={hints('Enter / Esc назад')}>
        <Box flexDirection="column" gap={1}>
          <Text color={color.ok} bold>
            ✔ Возвращено на компьютер: {result.restored.length} файл(ов)
          </Text>
          {result.errors.length > 0 && (
            <Box flexDirection="column">
              <Text color={color.bad}>Ошибки ({result.errors.length}):</Text>
              {result.errors.slice(0, 8).map((e) => (
                <Text key={e.relPath} color={color.dim}>
                  {'  '}
                  {truncatePath(e.relPath, 50)} — {e.reason}
                </Text>
              ))}
            </Box>
          )}
          <Text color={color.dim}>
            Возвращённые файлы попадут в бэкап заново при следующей синхронизации.
          </Text>
        </Box>
        <BackKeys onBack={() => setMode({ name: 'browse' })} />
      </Frame>
    );
  }

  // browse
  const crumbs = dir === '' ? 'внешний диск' : 'внешний диск / ' + dir.split('/').join(' / ');
  return (
    <Frame
      title={title}
      footer={hints('↑↓ выбор', 'Enter открыть / выбрать', 'Esc вверх / назад')}
    >
      <Box flexDirection="column">
        <Text color={color.dim} wrap="truncate">
          {crumbs}
        </Text>
        <Box marginTop={1} flexDirection="column">
          {items.length === 0 ? (
            <Text color={color.dim}>Пусто — в бэкапе ещё нет файлов.</Text>
          ) : (
            <ScrollList
              items={items}
              cursor={cursor}
              height={rows - 9}
              renderItem={(e, i, isSel) => {
                if (e.type === 'action') {
                  return (
                    <Text key="action" color={isSel ? color.accent : color.dim} bold={isSel}>
                      {isSel ? '❯ ' : '  '}
                      {e.name}
                    </Text>
                  );
                }
                const deletedMark = e.deleted ? ' (удалён, есть в снэпшоте)' : '';
                return (
                  <Box key={e.relPath}>
                    <Text color={color.accent}>{isSel ? '❯ ' : '  '}</Text>
                    <Text color={e.type === 'dir' ? color.accent : e.deleted ? color.dim : undefined} bold={isSel}>
                      {e.type === 'dir' ? '▸ ' + e.name + '/' : '  ' + e.name}
                    </Text>
                    <Text color={e.deleted ? color.bad : color.dim}>
                      {e.type === 'file'
                        ? `  ${formatBytes(e.size)} · ${formatRelativeDate(e.mtime)}${deletedMark}`
                        : ''}
                    </Text>
                  </Box>
                );
              }}
            />
          )}
        </Box>
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

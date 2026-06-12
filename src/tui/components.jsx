import React, { useState, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import { useTerminalSize, useSpinner } from './hooks.js';
import { color, BRAND } from './theme.js';

// ── Каркас экрана: шапка / контент / футер с подсказками клавиш ────────────
export function Frame({ title, right, footer, children }) {
  const { columns, rows } = useTerminalSize();
  const rule = '─'.repeat(Math.max(0, columns - 2));
  return (
    <Box flexDirection="column" width={columns} height={rows} paddingX={1}>
      <Box justifyContent="space-between">
        <Text>
          <Text bold color={color.accent}>{BRAND}</Text>
          <Text color={color.dim}> · {title}</Text>
        </Text>
        {right ? <Text color={color.dim}>{right}</Text> : null}
      </Box>
      <Text color={color.dim}>{rule}</Text>
      <Box flexDirection="column" flexGrow={1} overflow="hidden" paddingTop={1}>
        {children}
      </Box>
      <Text color={color.dim}>{rule}</Text>
      <Text color={color.dim}>{footer ?? ''}</Text>
    </Box>
  );
}

// ── Вертикальное меню со стрелками и Enter ─────────────────────────────────
// items: { label, hint?, value, danger?, disabled?, icon?, iconColor? }
// icon — символ слева от лейбла (＋ × ~ −…), iconColor — его цвет.
export function Menu({ items, onSelect, onBack, isActive = true, initialIndex = 0, maxVisible = 12 }) {
  const selectable = (i) => !items[i]?.disabled;
  const firstSelectable = items.findIndex((_, i) => selectable(i));
  const [cursor, setCursor] = useState(
    initialIndex < items.length && selectable(initialIndex) ? initialIndex : Math.max(0, firstSelectable)
  );

  useInput(
    (input, key) => {
      if (key.escape) {
        if (onBack) onBack();
        return;
      }
      if (key.return) {
        const item = items[cursor];
        if (item && !item.disabled) onSelect(item.value, item);
        return;
      }
      if (key.upArrow || key.downArrow) {
        const delta = key.upArrow ? -1 : 1;
        let next = cursor;
        for (let i = 0; i < items.length; i++) {
          next = (next + delta + items.length) % items.length;
          if (selectable(next)) {
            setCursor(next);
            return;
          }
        }
      }
    },
    { isActive }
  );

  // окно прокрутки
  const half = Math.floor(maxVisible / 2);
  let start = Math.max(0, Math.min(cursor - half, items.length - maxVisible));
  const visible = items.slice(start, start + maxVisible);

  return (
    <Box flexDirection="column">
      {start > 0 && <Text color={color.dim}>  … ещё {start} выше</Text>}
      {visible.map((item, i) => {
        const idx = start + i;
        const isSel = idx === cursor;
        const labelColor = item.danger ? color.bad : item.disabled ? color.dim : undefined;
        return (
          <Box key={idx}>
            <Text color={color.accent}>{isSel ? '❯ ' : '  '}</Text>
            {item.icon ? (
              <Text color={item.iconColor} dimColor={item.disabled} bold={isSel}>
                {item.icon}{' '}
              </Text>
            ) : null}
            <Text bold={isSel} color={labelColor} inverse={false}>
              {item.label}
            </Text>
            {item.hint ? <Text color={color.dim}>  {item.hint}</Text> : null}
          </Box>
        );
      })}
      {start + maxVisible < items.length && (
        <Text color={color.dim}>  … ещё {items.length - start - maxVisible} ниже</Text>
      )}
    </Box>
  );
}

// ── Плитка с пиктограммой ──────────────────────────────────────────────────
// accent — собственный цвет плитки (иконка всегда цветная, выбор — яркость+рамка)
export function Tile({ icon, title, subtitle, selected, accent = color.accent, width = 24 }) {
  return (
    <Box
      flexDirection="column"
      alignItems="center"
      width={width}
      borderStyle="round"
      borderColor={selected ? accent : color.dim}
      paddingX={1}
    >
      <Box flexDirection="column" alignItems="flex-start">
        {icon.map((line, i) => (
          <Text key={i} color={accent} dimColor={!selected} bold={selected}>
            {line}
          </Text>
        ))}
      </Box>
      <Text bold={selected} color={selected ? accent : undefined}>
        {title}
      </Text>
      <Text color={color.dim} wrap="truncate">
        {subtitle ?? ' '}
      </Text>
    </Box>
  );
}

// ── Сетка плиток с навигацией стрелками ────────────────────────────────────
// tiles: { key, icon, title, subtitle, disabled? }
export function TileGrid({ tiles, onSelect, onBack, isActive = true }) {
  const { columns } = useTerminalSize();
  const tileWidth = 24;
  const cols = Math.max(1, Math.min(3, Math.floor((columns - 2) / (tileWidth + 2))));
  const [cursor, setCursor] = useState(0);

  useInput(
    (input, key) => {
      if (key.escape) {
        if (onBack) onBack();
        return;
      }
      if (key.return) {
        const tile = tiles[cursor];
        if (tile && !tile.disabled) onSelect(tile.key, tile);
        return;
      }
      let next = cursor;
      if (key.leftArrow) next = cursor - 1;
      else if (key.rightArrow) next = cursor + 1;
      else if (key.upArrow) next = cursor - cols;
      else if (key.downArrow) next = cursor + cols;
      else return;
      if (next >= 0 && next < tiles.length) setCursor(next);
    },
    { isActive }
  );

  const rows = [];
  for (let i = 0; i < tiles.length; i += cols) {
    rows.push(tiles.slice(i, i + cols));
  }

  return (
    <Box flexDirection="column">
      {rows.map((row, ri) => (
        <Box key={ri} gap={2}>
          {row.map((tile, ci) => (
            <Tile
              key={tile.key}
              icon={tile.icon}
              title={tile.title}
              subtitle={tile.subtitle}
              accent={tile.accent}
              selected={ri * cols + ci === cursor}
              width={tileWidth}
            />
          ))}
        </Box>
      ))}
    </Box>
  );
}

// ── Прокручиваемый список (курсор держится в окне) ─────────────────────────
// renderItem(item, index, isSelected) → элемент
export function ScrollList({ items, cursor, height, renderItem }) {
  const visibleCount = Math.max(1, height - 2);
  const half = Math.floor(visibleCount / 2);
  let start = Math.max(0, Math.min(cursor - half, items.length - visibleCount));
  const visible = items.slice(start, start + visibleCount);
  return (
    <Box flexDirection="column">
      <Text color={color.dim}>{start > 0 ? `  … ещё ${start} выше` : ' '}</Text>
      {visible.map((item, i) => renderItem(item, start + i, start + i === cursor))}
      <Text color={color.dim}>
        {start + visibleCount < items.length ? `  … ещё ${items.length - start - visibleCount} ниже` : ' '}
      </Text>
    </Box>
  );
}

// ── Прогресс-бар ───────────────────────────────────────────────────────────
export function ProgressBar({ ratio, width = 40 }) {
  const clamped = Math.max(0, Math.min(1, ratio || 0));
  const filled = Math.round(clamped * width);
  return (
    <Text>
      <Text color={color.accent}>{'█'.repeat(filled)}</Text>
      <Text color={color.dim}>{'░'.repeat(width - filled)}</Text>
    </Text>
  );
}

// ── Ряд кнопок: ←→/Tab переключают, Enter нажимает, Esc отменяет ───────────
// buttons: { label, value, danger? }
export function Buttons({ buttons, onPress, onCancel, isActive = true, initialIndex = 0 }) {
  const [focused, setFocused] = useState(initialIndex);
  useInput(
    (input, key) => {
      if (key.escape) {
        if (onCancel) onCancel();
        return;
      }
      if (key.return) {
        onPress(buttons[focused].value);
        return;
      }
      if (key.leftArrow || (key.tab && key.shift)) {
        setFocused((f) => (f - 1 + buttons.length) % buttons.length);
      } else if (key.rightArrow || key.tab) {
        setFocused((f) => (f + 1) % buttons.length);
      }
    },
    { isActive }
  );
  return (
    <Box gap={2}>
      {buttons.map((b, i) => {
        const isFocused = i === focused;
        const c = b.danger ? color.bad : color.accent;
        return (
          <Text key={b.value} inverse={isFocused} color={isFocused ? c : color.dim} bold={isFocused}>
            {`  ${b.label}  `}
          </Text>
        );
      })}
    </Box>
  );
}

// ── Текстовое поле с валидацией (Esc — отмена) ─────────────────────────────
export function TextField({ label, hint, initial, validate, onSubmit, onCancel, isActive = true }) {
  const [value, setValue] = useState(initial ?? '');
  const [error, setError] = useState(null);
  const [checking, setChecking] = useState(false);

  useInput(
    (input, key) => {
      if (key.escape && onCancel) onCancel();
    },
    { isActive }
  );

  const submit = async (v) => {
    if (checking) return;
    if (validate) {
      setChecking(true);
      const res = await validate(v);
      setChecking(false);
      if (res !== true) {
        setError(res || 'Некорректное значение');
        return;
      }
    }
    onSubmit(v);
  };

  return (
    <Box flexDirection="column">
      <Text bold>{label}</Text>
      {hint ? <Text color={color.dim}>{hint}</Text> : null}
      <Box>
        <Text color={color.accent}>❯ </Text>
        <TextInput
          value={value}
          onChange={(v) => {
            setValue(v);
            if (error) setError(null);
          }}
          onSubmit={submit}
          focus={isActive}
        />
      </Box>
      {error ? <Text color={color.bad}>{error}</Text> : null}
    </Box>
  );
}

// ── Строка «работаю…» со спиннером ─────────────────────────────────────────
export function Busy({ children }) {
  const frame = useSpinner(true);
  return (
    <Text>
      <Text color={color.accent}>{frame} </Text>
      {children}
    </Text>
  );
}

// ── Список стадий с галочками (для подготовки синхронизации) ───────────────
export function StageList({ stages, current }) {
  const frame = useSpinner(true);
  return (
    <Box flexDirection="column">
      {stages.map((s) => {
        const state = s.key === current ? 'active' : s.done ? 'done' : 'pending';
        return (
          <Text key={s.key} color={state === 'pending' ? color.dim : undefined}>
            {state === 'done' ? (
              <Text color={color.ok}>✔ </Text>
            ) : state === 'active' ? (
              <Text color={color.accent}>{frame} </Text>
            ) : (
              '  '
            )}
            {s.label}
          </Text>
        );
      })}
    </Box>
  );
}

// Подсказки для футера
export function hints(...parts) {
  return parts.filter(Boolean).join('  ·  ');
}

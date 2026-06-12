import React from 'react';
import { render } from 'ink';
import { setDevMode } from '../config.js';
import App from './App.jsx';

export async function main({ dev = false } = {}) {
  setDevMode(dev);

  // Alternate screen buffer: приложение занимает весь экран,
  // после выхода терминал возвращается в исходное состояние.
  const isTTY = process.stdout.isTTY;
  if (isTTY) process.stdout.write('\x1b[?1049h\x1b[H');

  const instance = render(<App />, { exitOnCtrlC: true });
  try {
    await instance.waitUntilExit();
  } finally {
    if (isTTY) process.stdout.write('\x1b[?1049l');
  }
  // Ctrl+C во время копирования: Ink размонтировался, но движок мог не довести
  // текущий файл. Выходим явно — недописанный .synca-tmp подчистится при
  // следующем запуске, state сохраняется по ходу работы.
  process.exit(0);
}

// Цвета и символьные пиктограммы для плиток.
// Иконки рисуем простыми unicode-символами (без эмодзи — стабильная ширина
// в Windows Terminal и старых консолях важнее красоты).

export const BRAND = 'Архивариус';

export const color = {
  accent: 'cyan',
  dim: 'gray',
  ok: 'green',
  warn: 'yellow',
  bad: 'red',
  special: 'magenta',
};

// Пиктограммы плиток: 3 строки, ширина ≤ 14 колонок.
export const icons = {
  sync: [
    '┌─┐    ┌─┐',
    '│░│ ─▶ │█│',
    '└─┘    └─┘',
  ],
  restore: [
    '   ╭──▶ ▢ ',
    '   │      ',
    '▣ ─╯      ',
  ],
  history: [
    '◷  ────── ',
    '◷  ────   ',
    '◷  ─────  ',
  ],
  duplicates: [
    '┌──┐ ┌──┐ ',
    '│▒▒│=│▒▒│ ',
    '└──┘ └──┘ ',
  ],
  settings: [
    '──○────   ',
    '────○──   ',
    '──○────   ',
  ],
  dev: [
    ' ╭─╮      ',
    ' │▲│ тест ',
    ' ╰─╯      ',
  ],
  exit: [
    '┌──       ',
    '│ ◀──     ',
    '└──       ',
  ],
};

// Префиксы строк изменений
export const marks = {
  added: '+',
  modified: '~',
  trashed: '−',
  restored: '↩',
};

import pc from 'picocolors';
import {
  createPrompt,
  useState,
  useKeypress,
  usePagination,
  usePrefix,
  isUpKey,
  isDownKey,
  isEnterKey,
  isSpaceKey,
  Separator,
  makeTheme,
} from '@inquirer/core';
import { input as inquirerInput, confirm, checkbox as inquirerCheckbox } from '@inquirer/prompts';

// Sentinel значение для «вернуться назад» из меню.
// Возвращается selectWithBack() когда пользователь нажал Esc.
// Также используется в input-обёртке.
export const BACK = Symbol('BACK');

// Класс-маркер: бросаем такое исключение из обёрток когда пользователь хочет назад.
// Вызывающий код ловит его и возвращается на предыдущий шаг.
export class BackError extends Error {
  constructor() {
    super('User pressed Esc / Ctrl+C to go back');
    this.name = 'BackError';
    this.isBack = true;
  }
}

function isEscapeKey(key) {
  return key.name === 'escape';
}

// Ctrl+C поступает в raw mode как keypress с ctrl+c. Используем его как
// эквивалент «назад» в наших меню (а не как «убить процесс»).
function isCtrlCKey(key) {
  return key.ctrl === true && key.name === 'c';
}

// Кастомный select с поддержкой Esc как «назад».
// API похож на @inquirer/prompts.select, плюс опция backable (по умолчанию true).
// При Esc промпт резолвится sentinel'ом BACK (см. выше).
const selectWithBack = createPrompt((config, done) => {
  const items = config.choices;
  const pageSize = config.pageSize ?? 10;
  const backable = config.backable !== false;
  const theme = makeTheme();
  const prefix = usePrefix({ theme });

  const firstSelectable = items.findIndex((c) => !(c instanceof Separator) && !c.disabled);
  const [active, setActive] = useState(firstSelectable === -1 ? 0 : firstSelectable);
  const [status, setStatus] = useState('idle');

  useKeypress((key) => {
    if (status !== 'idle') return;

    if (isEnterKey(key)) {
      const selected = items[active];
      if (!selected || selected instanceof Separator || selected.disabled) return;
      setStatus('done');
      done(selected.value);
      return;
    }

    if (backable && (isEscapeKey(key) || isCtrlCKey(key))) {
      setStatus('done');
      done(BACK);
      return;
    }

    // На корневом меню (backable=false) Ctrl+C = выход из программы.
    // Иначе пользователь окажется в ловушке: ни Esc, ни Ctrl+C не работают.
    if (!backable && isCtrlCKey(key)) {
      setStatus('done');
      process.stdout.write('\n');
      process.exit(0);
    }

    if (isUpKey(key) || isDownKey(key)) {
      const delta = isUpKey(key) ? -1 : 1;
      let next = active;
      for (let i = 0; i < items.length; i++) {
        next = (next + delta + items.length) % items.length;
        const candidate = items[next];
        if (!(candidate instanceof Separator) && !candidate?.disabled) {
          setActive(next);
          return;
        }
      }
    }
  });

  const message = theme.style.message(config.message, status);

  if (status === 'done') {
    const selected = items[active];
    const displayed = selected instanceof Separator ? '' : selected?.name ?? '';
    return `${prefix} ${message} ${pc.cyan(displayed)}`;
  }

  const page = usePagination({
    items,
    active,
    renderItem: ({ item, isActive }) => {
      if (item instanceof Separator) return item.separator;
      const line = item.name;
      if (item.disabled) return pc.dim('  ' + line);
      return isActive ? pc.cyan('❯ ') + line : '  ' + line;
    },
    pageSize,
    loop: true,
  });

  const helpText =
    config.helpText ??
    (backable
      ? '↑↓ выбор · Enter подтвердить · Esc / Ctrl+C назад'
      : '↑↓ выбор · Enter подтвердить');

  const RULE = '─'.repeat(50);
  const help =
    '\n' +
    pc.dim('  ' + RULE) +
    '\n' +
    pc.dim('  ' + helpText);

  return `${prefix} ${message}\n${page}\n${help}`;
});

// Восстанавливает stdin после прерывания inquirer prompt через SIGINT.
// На Windows raw mode и/или listeners не всегда корректно очищаются — следующий
// prompt может «зависнуть» на ожидании клавиатуры. Делаем это вручную.
function recoverStdin() {
  try {
    if (process.stdin.isTTY && process.stdin.isRaw) {
      process.stdin.setRawMode(false);
    }
  } catch {}
  try {
    process.stdin.removeAllListeners('keypress');
    process.stdin.removeAllListeners('data');
  } catch {}
  try {
    process.stdin.resume();
  } catch {}
}

// Обёртка вокруг inquirer checkbox с поддержкой Ctrl+C как «отмена».
// Ловим SIGINT глобально, abort'им наш AbortController, inquirer корректно завершает
// промпт через signal (а не через свой sigint-хук), мы чистим stdin и бросаем BackError.
//
// Это важнее для checkbox чем для select потому что в checkbox нет «выйти стрелочкой»;
// единственный способ пропустить группу — это сочетание клавиш.
export async function checkboxWithCancel(opts) {
  const ac = new AbortController();
  const sigintHandler = () => {
    ac.abort();
  };
  process.once('SIGINT', sigintHandler);
  try {
    return await inquirerCheckbox({ ...opts, signal: ac.signal });
  } catch (err) {
    if (
      err?.name === 'AbortPromptError' ||
      err?.name === 'ExitPromptError' ||
      err?.code === 'ABORT_ERR'
    ) {
      recoverStdin();
      throw new BackError();
    }
    throw err;
  } finally {
    process.removeListener('SIGINT', sigintHandler);
    recoverStdin();
  }
}

// Аналогично — confirm с Ctrl+C как «нет/отмена».
export async function confirmWithCancel(opts) {
  const ac = new AbortController();
  const sigintHandler = () => {
    ac.abort();
  };
  process.once('SIGINT', sigintHandler);
  try {
    return await confirm({ ...opts, signal: ac.signal });
  } catch (err) {
    if (
      err?.name === 'AbortPromptError' ||
      err?.name === 'ExitPromptError' ||
      err?.code === 'ABORT_ERR'
    ) {
      recoverStdin();
      throw new BackError();
    }
    throw err;
  } finally {
    process.removeListener('SIGINT', sigintHandler);
    recoverStdin();
  }
}

// Обёртка вокруг inquirer input с поддержкой Ctrl+C как «назад» (BackError).
// Реализовано через AbortController: при SIGINT в pendingом промпте даём signal,
// prompt бросает исключение, мы конвертируем его в BackError.
//
// ВНИМАНИЕ: эта функция временно перехватывает SIGINT на время своего вызова.
export async function inputWithBack(opts) {
  const ac = new AbortController();
  const sigintHandler = () => {
    ac.abort();
  };
  process.once('SIGINT', sigintHandler);
  try {
    return await inquirerInput({ ...opts, signal: ac.signal });
  } catch (err) {
    // Inquirer бросает специальное AbortPromptError или ExitPromptError при abort/Ctrl+C
    if (
      err?.name === 'AbortPromptError' ||
      err?.name === 'ExitPromptError' ||
      err?.code === 'ABORT_ERR'
    ) {
      throw new BackError();
    }
    throw err;
  } finally {
    process.removeListener('SIGINT', sigintHandler);
  }
}

// Утилита: вызвать selectWithBack и сконвертировать BACK в исключение BackError.
// Удобно когда вызывающему проще ловить throw чем проверять sentinel.
async function selectOrThrow(config) {
  const result = await selectWithBack(config);
  if (result === BACK) throw new BackError();
  return result;
}

// Фиксированная колонка-якорь слева от текста пункта меню.
function item(icon, color, text) {
  return `${color(icon)}  ${text}`;
}

const ACTION = (t) => item('→', pc.cyan, t);
const ADD = (t) => item('+', pc.green, t);
const BACK_ICON = (t) => item('←', pc.dim, t);
const EXIT = (t) => item('×', pc.dim, t);
const EDIT = (t) => item('~', pc.yellow, t);
const REMOVE = (t) => item('−', pc.red, t);

// Главное меню после выбора проекта.
// Esc возвращает в выбор проекта (BackError).
export async function mainMenu() {
  return selectOrThrow({
    message: 'Что делаем?',
    choices: [
      { name: ACTION('Синхронизировать'), value: 'sync' },
      { name: ACTION('Найти дубликаты'), value: 'duplicates' },
      { name: ACTION('Настройки'), value: 'settings' },
      { name: BACK_ICON('К выбору проекта'), value: '__back__' },
      { name: EXIT('Выход'), value: 'exit' },
    ],
  });
}

// Меню режима поиска дубликатов
export async function duplicatesMenu() {
  return selectOrThrow({
    message: 'Какие дубликаты искать?',
    choices: [
      { name: ACTION('Похожие по имени (детская_1, детская_2, детская_v3…)'), value: 'similar' },
      { name: ACTION('Точно одинаковые по содержимому'), value: 'identical' },
      { name: BACK_ICON('Назад'), value: 'back' },
    ],
  });
}

// Меню настроек
export async function settingsMenu() {
  return selectOrThrow({
    message: 'Настройки:',
    choices: [
      { name: ADD('Добавить проект'), value: 'add' },
      { name: EDIT('Изменить проект'), value: 'edit' },
      { name: REMOVE('Удалить проект'), value: 'remove' },
      { name: BACK_ICON('Назад'), value: 'back' },
    ],
  });
}

// Выбор проекта (если их несколько). Включает пункт «Добавить проект».
// Это корневое меню — Esc игнорируется (некуда назад), Ctrl+C = выход.
export async function chooseProject(projects) {
  return selectWithBack({
    message: 'Выберите проект:',
    backable: false,
    helpText: '↑↓ выбор · Enter подтвердить · Ctrl+C выход',
    choices: [
      ...projects.map((p, i) => ({
        name: ACTION(`${p.name}  ${pc.dim('(' + p.source + ' → ' + p.destination + ')')}`),
        value: i,
      })),
      { name: ADD('Добавить новый проект'), value: 'add' },
      { name: EXIT('Выход'), value: 'exit' },
    ],
    pageSize: 12,
  });
}

// Превью изменений
export async function confirmApply() {
  return selectOrThrow({
    message: 'Применить изменения?',
    choices: [
      { name: ACTION('Применить'), value: 'apply' },
      { name: ACTION('Посмотреть список'), value: 'list' },
      { name: BACK_ICON('Отмена'), value: 'cancel' },
    ],
  });
}

// Прокручиваемый список изменений.
// Все строки — активные пункты (просто для прокрутки), любой Enter / Esc / Ctrl+C возвращает.
export async function viewChangeList(lines) {
  await selectWithBack({
    message: 'Список изменений:',
    choices: lines.map((line, i) => ({ name: line, value: i })),
    pageSize: 20,
    helpText: '↑↓ прокрутка · Enter / Esc / Ctrl+C — вернуться',
  });
}

// Меню выбора проекта для edit/remove (в settingsMenu).
export async function pickProject(projects, message) {
  const result = await selectWithBack({
    message,
    choices: [
      ...projects.map((p, i) => ({ name: ACTION(p.name), value: i })),
      { name: BACK_ICON('Отмена'), value: -1 },
    ],
  });
  if (result === BACK) return -1;
  return result;
}

export { selectWithBack as select, confirm, inquirerCheckbox as checkbox };

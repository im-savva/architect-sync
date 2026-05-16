import pc from 'picocolors';
import Table from 'cli-table3';
import { formatBytes, formatDuration, truncatePath } from './utils.js';

const RULE = '─'.repeat(50);

// Очищает экран (включая историю прокрутки) и рисует шапку раздела.
// Используется на границах логических фаз: главное меню, wizard, sync, дубликаты, настройки.
// Внутри фазы НЕ вызывается — там вопросы и ответы должны накапливаться.
export function screen(sectionTitle) {
  // \x1b[2J — очистить экран, \x1b[3J — очистить scrollback, \x1b[H — курсор в (0,0)
  process.stdout.write('\x1b[2J\x1b[3J\x1b[H');
  console.log();
  console.log(pc.bold(pc.cyan('  synca')) + pc.dim('  ·  синхронизация проектов'));
  if (sectionTitle) {
    console.log();
    console.log(pc.bold('  ' + sectionTitle));
  }
  console.log(pc.dim('  ' + RULE));
  console.log();
  console.log();
}

export function showHeader() {
  screen();
}

// Горизонтальная черта-разделитель внутри раздела (например перед «Нажмите Enter»).
// С пустой строкой до и после.
export function divider() {
  console.log();
  console.log(pc.dim('  ' + RULE));
  console.log();
}

export function info(text) {
  console.log(pc.dim('  ' + text));
}

export function success(text) {
  console.log(pc.green('  ' + text));
}

export function warn(text) {
  console.log(pc.yellow('  ' + text));
}

export function error(text) {
  console.log(pc.red('  ' + text));
}

// Сводка изменений
export function renderSummary({ added, modified, trashed }) {
  const addedBytes = added.reduce((s, f) => s + f.size, 0);
  const modifiedBytes = modified.reduce((s, f) => s + f.size, 0);
  const trashedBytes = trashed.reduce((s, f) => s + f.size, 0);

  console.log();
  console.log(`  ${pc.green('+')} ${pc.bold(added.length.toString().padStart(3))}  новых     ${pc.dim('(' + formatBytes(addedBytes) + ')')}`);
  console.log(`  ${pc.yellow('~')} ${pc.bold(modified.length.toString().padStart(3))}  изменено  ${pc.dim('(' + formatBytes(modifiedBytes) + ')')}`);
  console.log(`  ${pc.red('−')} ${pc.bold(trashed.length.toString().padStart(3))}  удалено   ${pc.dim('(' + formatBytes(trashedBytes) + ')')}`);
  console.log();
}

// Все изменения одним прокручиваемым списком (через @inquirer/prompts.select).
// Возвращает массив строк для choices.
export function buildChangeList({ added, modified, trashed }) {
  const lines = [];
  const maxPathLen = 50;

  for (const f of added) {
    const p = truncatePath(f.relPath, maxPathLen).padEnd(maxPathLen);
    lines.push(`${pc.green('+')} ${p}  ${pc.dim(formatBytes(f.size).padStart(10))}`);
  }
  for (const f of modified) {
    const p = truncatePath(f.relPath, maxPathLen).padEnd(maxPathLen);
    lines.push(`${pc.yellow('~')} ${p}  ${pc.dim(formatBytes(f.size).padStart(10))}`);
  }
  for (const f of trashed) {
    const p = truncatePath(f.relPath, maxPathLen).padEnd(maxPathLen);
    lines.push(`${pc.red('−')} ${p}  ${pc.dim(formatBytes(f.size).padStart(10))}`);
  }
  return lines;
}

// Финальный экран после успешной синхронизации
export function renderFinal({ log, logPath }) {
  console.log();
  console.log(pc.green(pc.bold('  [OK] Готово')));
  console.log();
  if (log.added.length) {
    console.log(`  ${pc.green('+' + log.added.length)} файлов добавлено  ${pc.dim('(' + formatBytes(log.added.reduce((s, f) => s + f.size, 0)) + ')')}`);
  }
  if (log.modified.length) {
    console.log(`  ${pc.yellow('~' + log.modified.length)} файлов обновлено  ${pc.dim('(' + formatBytes(log.modified.reduce((s, f) => s + f.size, 0)) + ')')}`);
  }
  if (log.trashed.length) {
    console.log(`  ${pc.red('−' + log.trashed.length)} файлов в корзину  ${pc.dim('(' + formatBytes(log.trashed.reduce((s, f) => s + f.size, 0)) + ')')}`);
  }
  console.log();
  console.log(pc.dim('  Время: ' + formatDuration(log.durationMs)));
  console.log(pc.dim('  Лог:   ' + logPath));
  console.log();

  if (log.skipped.length) {
    console.log(pc.yellow('  Внимание: пропущено файлов: ' + log.skipped.length));
    console.log(pc.dim('  (подробности — в логе)'));
    console.log();
  }
  if (log.verifyFailures.length) {
    console.log(pc.red('  Ошибки проверки: ' + log.verifyFailures.length));
    console.log(pc.dim('  (подробности — в логе)'));
    console.log();
  }
}

// Таблица проектов
export function renderProjectsTable(projects) {
  const table = new Table({
    head: ['#', 'Название', 'Источник', 'Назначение'].map((h) => pc.bold(h)),
    style: { head: [], border: [] },
  });
  projects.forEach((p, i) => {
    table.push([
      (i + 1).toString(),
      p.name,
      truncatePath(p.source, 40),
      truncatePath(p.destination, 40),
    ]);
  });
  console.log(table.toString());
}

// Информация о диске
export function renderDiskInfo(label, stats) {
  if (!stats) return;
  const usedPct = ((stats.total - stats.free) / stats.total * 100).toFixed(1);
  console.log(pc.dim(`  ${label}: свободно ${formatBytes(stats.free)} из ${formatBytes(stats.total)} (занято ${usedPct}%)`));
}

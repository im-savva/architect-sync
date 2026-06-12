#!/usr/bin/env node
// Headless-прогон движка на песочнице: sync → mutate → sync → rollback → restore.
// Запуск: node scripts/engine-test.mjs
// Падает с ненулевым кодом при первой же ошибке проверки.

import fs from 'node:fs/promises';
import path from 'node:path';
import { init, mutate, SOURCE, DEST } from './sandbox.mjs';
import { planSync, applySync } from '../src/plan.js';
import { listRuns, rollbackRun, buildSnapshotIndex, listVersions, previewRestore, restoreToSource } from '../src/restore.js';
import { defaultConfig } from '../src/config.js';
import { hashFile, pathExists } from '../src/utils.js';

const cfg = defaultConfig();
const project = { name: 'sandbox', source: SOURCE, destination: DEST };

let failures = 0;
function check(cond, label) {
  console.log(`  ${cond ? 'OK  ' : 'FAIL'} ${label}`);
  if (!cond) failures++;
}

async function sync(label) {
  const { plan, error } = await planSync(project, cfg);
  if (error) throw new Error('planSync: ' + error);
  if (plan.isEmpty) {
    console.log(`\n${label}: изменений нет`);
    return { plan, result: null };
  }
  const result = await applySync(project, cfg, plan, {});
  console.log(
    `\n${label}: +${result.log.added.length} ~${result.log.modified.length} −${result.log.trashed.length} → ${result.log.result} (runId ${result.runId})`
  );
  return { plan, result };
}

console.log('1. Пересоздаю песочницу');
await init();

console.log('\n2. Первая синхронизация (всё новое)');
const first = await sync('Синхронизация №1');
check(first.result.log.added.length === 17, 'скопировано 17 файлов');
check(first.result.log.result === 'success', 'результат success');
check(
  (await hashFile(path.join(SOURCE, 'Чертежи/план-1-этаж.dwg'))) ===
    (await hashFile(path.join(DEST, 'Чертежи/план-1-этаж.dwg'))),
  'хэш файла в бэкапе совпадает с источником'
);

console.log('\n3. Повторная синхронизация — должно быть пусто');
const second = await planSync(project, cfg);
check(second.plan.isEmpty, 'повторный план пуст');

console.log('\n4. Мутация источника (рабочий день)');
const hashBeforeMutate = await hashFile(path.join(DEST, 'Чертежи/план-1-этаж.dwg'));
await mutate();

console.log('\n5. Синхронизация изменений');
const third = await sync('Синхронизация №2');
check(third.result.log.modified.length === 2, 'обновлено 2 файла');
check(third.result.log.added.length === 1, 'добавлен 1 файл');
check(third.result.log.trashed.length === 1, 'удалён 1 файл');
const runId = third.result.runId;

console.log('\n6. Проверяю снэпшот');
const index = await buildSnapshotIndex(DEST);
check(index.has('Чертежи/план-1-этаж.dwg'), 'старая версия перезаписанного файла в снэпшоте');
check(index.has('Рендеры/гостиная_v1.jpg'), 'удалённый файл в снэпшоте');
const versions = await listVersions(DEST, 'Чертежи/план-1-этаж.dwg', index);
check(versions.length === 2, 'у файла 2 версии (текущая + снэпшот)');

console.log('\n7. История запусков');
const runs = await listRuns(DEST);
check(runs.length === 2, 'в истории 2 запуска');
check(runs[0].hasSnapshot, 'у последнего запуска есть снэпшот');

console.log('\n8. Откат последнего запуска');
const rb = await rollbackRun({ destination: DEST, runId });
check(!rb.error, 'откат прошёл без ошибки');
check(rb.restored === 3, 'возвращено 3 файла (2 перезаписанных + 1 удалённый)');
check(rb.removedAdded === 1, 'убран 1 добавленный файл');
check(
  (await hashFile(path.join(DEST, 'Чертежи/план-1-этаж.dwg'))) === hashBeforeMutate,
  'перезаписанный файл вернулся к старой версии'
);
check(await pathExists(path.join(DEST, 'Рендеры/гостиная_v1.jpg')), 'удалённый файл вернулся');

console.log('\n9. Откат отката (снэпшот отката)');
const runsAfter = await listRuns(DEST);
check(runsAfter[0].kind === 'rollback', 'откат записан в историю');
check(runsAfter[0].hasSnapshot, 'у отката есть свой снэпшот');
const rb2 = await rollbackRun({ destination: DEST, runId: runsAfter[0].runId });
check(!rb2.error && rb2.restored === 3, 'откат отката вернул новые версии');
check(
  (await hashFile(path.join(DEST, 'Чертежи/план-1-этаж.dwg'))) ===
    (await hashFile(path.join(SOURCE, 'Чертежи/план-1-этаж.dwg'))),
  'бэкап снова соответствует источнику'
);
check(!(await pathExists(path.join(DEST, 'Рендеры/гостиная_v1.jpg'))), 'удалённый файл снова убран');

console.log('\n10. Синхронизация после откатов — план должен быть пуст');
const after = await planSync(project, cfg);
check(
  after.plan.isEmpty,
  'план пуст (state корректен после откатов)' +
    (after.plan.isEmpty
      ? ''
      : ` — added:${after.plan.added.length} mod:${after.plan.modified.length} del:${after.plan.trashed.length}`)
);

console.log('\n11. Восстановление удалённого файла в рабочую папку');
// гостиная_v1.jpg удалена из источника мутацией; в бэкапе её нет (синхронизировано),
// но она лежит в снэпшоте отката
const index2 = await buildSnapshotIndex(DEST);
const v1versions = await listVersions(DEST, 'Рендеры/гостиная_v1.jpg', index2);
check(v1versions.length >= 1, 'есть снэпшотные версии удалённого файла');
const preview = await previewRestore({
  sourceRoot: SOURCE,
  destination: DEST,
  items: [{ relPath: 'Рендеры/гостиная_v1.jpg', from: v1versions[0].from }],
});
check(preview.files.length === 1 && preview.conflicts.length === 0, 'превью восстановления без конфликтов');
const restoreResult = await restoreToSource({ sourceRoot: SOURCE, files: preview.files });
check(restoreResult.restored.length === 1, 'файл восстановлен в рабочую папку');
check(await pathExists(path.join(SOURCE, 'Рендеры/гостиная_v1.jpg')), 'файл существует в источнике');

console.log('\n12. Синхронизация подхватывает восстановленный файл');
const final = await sync('Синхронизация №3');
check(final.result && final.result.log.added.length === 1, 'восстановленный файл уехал в бэкап');

console.log(failures === 0 ? '\nВсе проверки пройдены.' : `\nПровалено проверок: ${failures}`);
process.exit(failures === 0 ? 0 : 1);

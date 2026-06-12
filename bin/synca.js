#!/usr/bin/env node
import pc from 'picocolors';

process.on('uncaughtException', (err) => {
  console.error(pc.red('\nНепредвиденная ошибка:'), err.message);
  if (process.env.SYNCA_DEBUG) console.error(err.stack);
  process.exit(1);
});

process.on('unhandledRejection', (err) => {
  console.error(pc.red('\nНепредвиденная ошибка:'), err);
  process.exit(1);
});

const dev = process.argv.includes('--dev');

let main;
try {
  ({ main } = await import('../dist/synca.js'));
} catch (err) {
  if (err.code === 'ERR_MODULE_NOT_FOUND') {
    console.error(pc.red('Приложение не собрано. Выполните в папке synca:'));
    console.error('  npm install');
    process.exit(1);
  }
  throw err;
}

main({ dev }).catch((err) => {
  console.error(pc.red('\nОшибка:'), err.message || err);
  if (process.env.SYNCA_DEBUG) console.error(err.stack);
  process.exit(1);
});

#!/usr/bin/env node
import { main } from '../src/index.js';
import pc from 'picocolors';

process.on('uncaughtException', (err) => {
  console.error(pc.red('\nНепредвиденная ошибка:'), err.message);
  process.exit(1);
});

process.on('unhandledRejection', (err) => {
  console.error(pc.red('\nНепредвиденная ошибка:'), err);
  process.exit(1);
});

main().catch((err) => {
  console.error(pc.red('\nОшибка:'), err.message || err);
  if (process.env.SYNCA_DEBUG) console.error(err.stack);
  process.exit(1);
});

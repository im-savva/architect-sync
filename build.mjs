// Сборка TUI (JSX → dist/synca.js). Запускается автоматически при npm install (prepare).
import { build } from 'esbuild';

await build({
  entryPoints: ['src/tui/main.jsx'],
  outfile: 'dist/synca.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  packages: 'external', // node_modules не бандлим (в т.ч. нативный xxhash-addon)
  jsx: 'automatic',
  target: 'node20',
  sourcemap: true,
});

console.log('Сборка готова: dist/synca.js');

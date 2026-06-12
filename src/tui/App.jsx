import React, { useState, useEffect, useMemo, createContext, useContext } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import { loadConfig, saveConfig, defaultConfig, isDevMode } from '../config.js';
import { Frame, Busy } from './components.jsx';
import { ProjectSelectScreen } from './screens/ProjectSelect.jsx';
import { DashboardScreen } from './screens/Dashboard.jsx';
import { WizardScreen } from './screens/Wizard.jsx';
import { SyncScreen } from './screens/Sync.jsx';
import { HistoryScreen } from './screens/History.jsx';
import { RestoreScreen } from './screens/Restore.jsx';
import { DuplicatesScreen } from './screens/Duplicates.jsx';
import { SettingsScreen } from './screens/Settings.jsx';
import { DevScreen } from './screens/Dev.jsx';

const AppCtx = createContext(null);
export function useAppCtx() {
  return useContext(AppCtx);
}

const SCREENS = {
  projects: ProjectSelectScreen,
  dashboard: DashboardScreen,
  wizard: WizardScreen,
  sync: SyncScreen,
  history: HistoryScreen,
  restore: RestoreScreen,
  duplicates: DuplicatesScreen,
  settings: SettingsScreen,
  dev: DevScreen,
};

export default function App() {
  const { exit } = useApp();
  const [cfg, setCfg] = useState(null);
  const [loaded, setLoaded] = useState(false);
  const [stack, setStack] = useState([{ name: 'projects', props: {} }]);

  // Всегда-активный обработчик ввода. Без него, когда на экране временно нет
  // ни одного активного useInput (загрузка, busy-состояния), Ink выключает
  // raw mode у stdin, а повторное включение на Windows ломает стрелки —
  // клавиши перестают приходить.
  // Заодно — диагностика: SYNCA_DEBUG_KEYS=1 показывает каждое нажатие внизу.
  const [debugKeys, setDebugKeys] = useState('');
  useInput((input, key) => {
    if (process.env.SYNCA_DEBUG_KEYS) {
      const flags = Object.entries(key)
        .filter(([, v]) => v)
        .map(([k]) => k)
        .join(',');
      setDebugKeys(`нажатие: input=${JSON.stringify(input)} key=${flags || '—'}`);
    }
  });

  useEffect(() => {
    (async () => {
      const loadedCfg = (await loadConfig()) ?? defaultConfig();
      setCfg(loadedCfg);
      setLoaded(true);
    })();
  }, []);

  const ctx = useMemo(() => {
    const nav = {
      push: (name, props = {}) => setStack((s) => [...s, { name, props }]),
      pop: () => setStack((s) => (s.length > 1 ? s.slice(0, -1) : s)),
      replace: (name, props = {}) => setStack((s) => [...s.slice(0, -1), { name, props }]),
      reset: (name, props = {}) => setStack([{ name, props }]),
    };
    // Изменение конфига: mutator получает черновик, результат сохраняется на диск.
    const updateConfig = async (mutator) => {
      const draft = structuredClone(cfg);
      mutator(draft);
      await saveConfig(draft);
      setCfg(draft);
      return draft;
    };
    return { cfg, updateConfig, nav, exit, dev: isDevMode() };
  }, [cfg, exit]);

  if (!loaded) {
    return (
      <Frame title="загрузка" footer="">
        <Busy>Загружаю конфигурацию…</Busy>
      </Frame>
    );
  }

  const top = stack[stack.length - 1];
  const Screen = SCREENS[top.name];
  return (
    <AppCtx.Provider value={ctx}>
      <Box flexDirection="column">
        {Screen ? <Screen {...top.props} /> : <Text>Неизвестный экран: {top.name}</Text>}
        {process.env.SYNCA_DEBUG_KEYS ? <Text color="magenta">{debugKeys || 'DEBUG KEYS: жду нажатий…'}</Text> : null}
      </Box>
    </AppCtx.Provider>
  );
}

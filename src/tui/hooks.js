import { useState, useEffect, useRef } from 'react';
import { useStdout } from 'ink';

// Размер терминала с реакцией на ресайз (защита от 0×0 у «безголовых» pty).
function readSize(stdout) {
  return {
    columns: Math.max(stdout?.columns || 80, 40),
    rows: Math.max(stdout?.rows || 24, 12),
  };
}
export function useTerminalSize() {
  const { stdout } = useStdout();
  const [size, setSize] = useState(() => readSize(stdout));
  useEffect(() => {
    if (!stdout) return;
    const onResize = () => setSize(readSize(stdout));
    stdout.on('resize', onResize);
    return () => stdout.off('resize', onResize);
  }, [stdout]);
  return size;
}

// Спиннер-кадры.
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
export function useSpinner(active = true) {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setFrame((f) => (f + 1) % SPINNER_FRAMES.length), 80);
    return () => clearInterval(t);
  }, [active]);
  return SPINNER_FRAMES[frame];
}

// Горячие данные (прогресс копирования сыплется на каждые 64 КБ) держим в ref,
// а в state переносим по таймеру — иначе Ink захлёбывается перерисовкой.
export function useThrottledValue(intervalMs = 100) {
  const ref = useRef(null);
  const [value, setValue] = useState(null);
  useEffect(() => {
    const t = setInterval(() => {
      setValue((prev) => (prev === ref.current ? prev : ref.current));
    }, intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return [value, (v) => { ref.current = v; }];
}

// Скорость и ETA по байтам: скользящее окно последних ~5 секунд.
export function useSpeedometer() {
  const samples = useRef([]);
  return {
    feed(bytesDone) {
      const now = Date.now();
      samples.current.push({ t: now, b: bytesDone });
      while (samples.current.length > 2 && now - samples.current[0].t > 5000) {
        samples.current.shift();
      }
    },
    speed() {
      const s = samples.current;
      if (s.length < 2) return 0;
      const dt = (s[s.length - 1].t - s[0].t) / 1000;
      if (dt <= 0) return 0;
      return (s[s.length - 1].b - s[0].b) / dt;
    },
    eta(bytesDone, totalBytes) {
      const v = this.speed();
      if (v <= 0) return null;
      return (totalBytes - bytesDone) / v;
    },
    reset() {
      samples.current = [];
    },
  };
}

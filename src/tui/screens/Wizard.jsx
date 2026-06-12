import React, { useState } from 'react';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Box, Text } from 'ink';
import { useAppCtx } from '../App.jsx';
import { Frame, TextField, hints } from '../components.jsx';
import { color } from '../theme.js';
import { validateProject } from '../../config.js';
import { pathExists } from '../../utils.js';

// Мастер добавления/изменения проекта: имя → источник → назначение.
// editIndex — если задан, редактируем существующий проект.
export function WizardScreen({ editIndex }) {
  const { cfg, updateConfig, nav } = useAppCtx();
  const editing = editIndex != null ? cfg.projects[editIndex] : null;
  const [step, setStep] = useState(0);
  const [draft, setDraft] = useState({
    name: editing?.name ?? '',
    source: editing?.source ?? '',
    destination: editing?.destination ?? '',
  });

  const existingNames = cfg.projects
    .filter((_, i) => i !== editIndex)
    .map((p) => p.name);

  const back = () => {
    if (step === 0) nav.pop();
    else setStep(step - 1);
  };

  const finish = async (destination) => {
    const project = {
      name: draft.name.trim(),
      source: path.resolve(draft.source.trim()),
      destination: path.resolve(destination.trim()),
    };
    await updateConfig((c) => {
      if (editIndex != null) c.projects[editIndex] = project;
      else c.projects.push(project);
    });
    nav.pop();
  };

  const steps = [
    <TextField
      key="name"
      label="Название проекта"
      hint="Как проект будет называться в меню"
      initial={draft.name}
      validate={(v) => {
        if (!v.trim()) return 'Название не может быть пустым';
        if (existingNames.includes(v.trim())) return 'Проект с таким названием уже есть';
        return true;
      }}
      onSubmit={(v) => {
        setDraft((d) => ({ ...d, name: v }));
        setStep(1);
      }}
      onCancel={back}
    />,
    <TextField
      key="source"
      label="Рабочая папка на компьютере (откуда копировать)"
      hint="Папка с проектами. Путь можно вставить из проводника."
      initial={draft.source}
      validate={async (v) => {
        const trimmed = v.trim();
        if (!trimmed) return 'Путь не может быть пустым';
        if (!(await pathExists(trimmed))) return 'Папка не существует';
        try {
          const st = await fs.stat(trimmed);
          if (!st.isDirectory()) return 'Это не папка';
        } catch {
          return 'Не удаётся прочитать';
        }
        return true;
      }}
      onSubmit={(v) => {
        setDraft((d) => ({ ...d, source: v }));
        setStep(2);
      }}
      onCancel={back}
    />,
    <TextField
      key="destination"
      label="Папка бэкапа на внешнем диске (куда копировать)"
      hint="Папка на флешке/SSD. Если не существует — будет создана."
      initial={draft.destination}
      validate={async (v) => {
        const trimmed = v.trim();
        if (!trimmed) return 'Путь не может быть пустым';
        const err = await validateProject({ source: draft.source.trim(), destination: trimmed });
        if (err) return err;
        return true;
      }}
      onSubmit={finish}
      onCancel={back}
    />,
  ];

  return (
    <Frame
      title={editing ? `изменение проекта «${editing.name}»` : 'новый проект'}
      footer={hints('Enter далее', 'Esc назад')}
    >
      <Box flexDirection="column" gap={1}>
        <Text color={color.dim}>Шаг {step + 1} из 3</Text>
        {steps[step]}
      </Box>
    </Frame>
  );
}

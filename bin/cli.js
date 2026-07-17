// cli.js — Фаза 1: конвейер задача→код→проверка БЕЗ советника (DEV_GUIDE §3).
// Задача задаётся руками: свободным текстом, флагами или JSON-файлом.
// Советник/router/architect подключаются в Фазе 3 (talk.js/ask.js).
import fs from 'node:fs';
import { addTask, getTask, releaseStuck } from '../core/journal.js';
import { runCoordinatorLoop } from '../core/coordinator.js';
import { resolveSingleActiveProject, getProject } from '../core/projects.js';

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) { args[key] = next; i++; } else args[key] = true;
    } else {
      args._.push(a);
    }
  }
  return args;
}

function usage() {
  return [
    'Использование:',
    '  npm run cli -- "текст задачи"',
    '  npm run cli -- --file task.json',
    '  npm run cli -- --title T --spec S --criteria \'{"cmd":"node -e \\"...\\""}\'',
    '  npm run cli -- --type tool --tool-name X --title T --spec S --criteria \'{"cmd":"..."}\'   (§26 Кузница — ручная сборка/переиспользование инструмента)',
    '  npm run cli -- --type tool_run --tool-name X --title T --spec \'{"tool":"X","args":["a","b"]}\' --criteria \'{"cmd":"..."}\'',
    '  npm run cli -- --type regression_detected --title T --spec S --criteria \'{"cmd":"..."}\'   (§18 maintenance-минимум — заводится будущим мониторингом прода; сегодня журнал принимает его, координатор ведёт как обычный tweak, никакой особой ветки)',
  ].join('\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  // §29.1: cli.js — ad-hoc задача, ей всё равно нужен проект. --project явно
  // ИЛИ (ровно один активный проект) — иначе честная ошибка вместо угадывания.
  const project = args.project ? getProject(args.project) : resolveSingleActiveProject().project;
  if (!project) {
    console.error(args.project
      ? `[cli] проект не найден: ${args.project}`
      : '[cli] не удалось определить проект однозначно — передайте --project <id> (см. npm run talk -> /projects).');
    process.exit(1);
    return;
  }
  releaseStuck({ projectId: project.id });

  let taskDef;
  if (args.file) {
    taskDef = JSON.parse(fs.readFileSync(args.file, 'utf8'));
  } else if (args.title || args.spec || args.criteria) {
    taskDef = {
      title: args.title || args._.join(' ') || 'ad-hoc',
      spec: args.spec || args._.join(' ') || '',
      criteria: args.criteria,
      role: args.role || 'coder',
      type: args.type || 'project',
      // §26 Кузница: --tool-name обязателен харнессом для type=tool/tool_run
      // (coordinator.js читает task.tool_name, не парсит его из title/spec).
      tool_name: args['tool-name'] || undefined,
      budget_usd: args.budget ? Number(args.budget) : undefined,
    };
  } else if (args._.length) {
    const text = args._.join(' ');
    taskDef = { title: text, spec: text, role: 'coder', type: 'project' };
  } else {
    console.error(usage());
    process.exit(1);
    return;
  }

  const id = addTask({ project_id: project.id, ...taskDef });
  console.log(`[cli] задача создана: ${id} (проект ${project.id})`);

  await runCoordinatorLoop({
    role: taskDef.role || 'coder', workspaceDir: project.workspace_dir, projectId: taskDef.project_id || project.id,
  });

  const finalTask = getTask(id);
  console.log(`[cli] финальный статус задачи ${id}: ${finalTask.status} (попыток: ${finalTask.attempts})`);
  if (finalTask.feedback) console.log(`[cli] feedback:\n${finalTask.feedback}`);
  if (finalTask.question) console.log(`[cli] вопрос человеку:\n${finalTask.question}`);
  process.exit(finalTask.status === 'done' ? 0 : 1);
}

main().catch((e) => { console.error('[cli] FAIL', e); process.exit(1); });

// talk.js — сеанс (§25 ТЗ v4): пять типов входа за одним REPL. /status
// /resume /exit, unhandledRejection-броня (шрам 25), .history-бэкап перед
// изменениями (шрам 26, только tweak/project — question ничего не меняет),
// санитизация ввода (шрам 32).
import fs from 'node:fs';
import path from 'node:path';
import { question, closeInput, sanitizeLine } from './io.js';
import {
  isGarbageInput, startIntake, continueIntake, reviseDecisions, buildBrief, runAnalyst,
  buildConsultantReport,
} from './agents/advisor.js';
import { routeRequest } from './agents/router.js';
import { runArchitect } from './agents/architect.js';
import { listWorkspaceFileNames } from './agents/coder.js';
import { runLivein } from './agents/livein.js';
import { runCoordinatorLoop } from './coordinator.js';
import {
  addTask, getTask, listTasks, releaseStuck, newRunId, setRootSpec, getRootSpec,
} from './journal.js';
import { WORKSPACE, HISTORY_DIR } from './config.js';

const PROJECT_PROTOCOLS = new Set(['wish', 'problem', 'spec']);

function backupWorkspaceHistory(label) {
  if (!fs.existsSync(WORKSPACE)) return;
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dest = path.join(HISTORY_DIR, `${stamp}-${label}`);
    fs.mkdirSync(HISTORY_DIR, { recursive: true });
    fs.cpSync(WORKSPACE, dest, { recursive: true });
  } catch (e) {
    console.error(`[talk] .history-бэкап не удался (продолжаю без него): ${e.message}`);
  }
}

function boardSummaryText(taskIds) {
  return taskIds.map((id) => {
    const t = getTask(id);
    if (!t) return `- ${id}: (не найдена)`;
    return `- [${t.type}] "${t.title}" — ${t.status} (попыток: ${t.attempts})${t.feedback ? ` — ${t.feedback.slice(0, 200)}` : ''}`;
  }).join('\n');
}

function printStatus() {
  const tasks = listTasks({});
  const byStatus = {};
  for (const t of tasks) byStatus[t.status] = (byStatus[t.status] || 0) + 1;
  console.log('\n--- /status ---');
  console.log(JSON.stringify(byStatus));
  for (const t of tasks) {
    if (t.status === 'blocked_needs_human') {
      console.log(`  ⚠ ${t.id} "${t.title}" — ${t.question ? `вопрос: ${t.question}` : t.feedback}`);
    }
  }
}

async function runProjectFlow(protocol, initialText, runId) {
  let { history, step } = await startIntake({ protocol, initialText, runId });
  let turnCount = 1;
  while (step.type === 'ask') {
    const reply = sanitizeLine(await question(`\n${step.question}\n> `));
    turnCount++;
    // eslint-disable-next-line no-await-in-loop
    ({ history, step } = await continueIntake({ protocol, history, clientReply: reply, runId, turnCount }));
  }

  console.log('\nПринял инженерные решения:');
  for (const d of step.engineeringDefaults) console.log(`  - ${d}`);
  const confirmation = sanitizeLine(await question('\n(Enter — согласие, или впишите правку)\n> '));
  if (confirmation) {
    ({ history, step } = await reviseDecisions({ protocol, history, correctionText: confirmation, runId }));
    console.log('\nОбновлённые решения:');
    for (const d of step.engineeringDefaults) console.log(`  - ${d}`);
  }

  const brief = buildBrief({ protocol, initialText, step });
  setRootSpec('default', brief.summary, brief.engineering_defaults, protocol);
  backupWorkspaceHistory(protocol);

  const workspaceListing = listWorkspaceFileNames(WORKSPACE);
  const architectResult = await runArchitect({
    brief, workspaceDir: WORKSPACE, workspaceListing, runId, projectId: 'default',
  });
  if (!architectResult.ok) {
    console.log(`\nАрхитектор не смог построить план: ${architectResult.error}`);
    return;
  }
  console.log(`\nСоздано задач: ${architectResult.taskIds.length} + регрессия. Пакеты: ${architectResult.packages.join(', ') || '(нет)'}`);
  architectResult.precheckLog.forEach((l) => console.log(`  ${l}`));

  await runCoordinatorLoop({ role: 'coder', workspaceDir: WORKSPACE });
  printStatus();

  const treeIds = [...architectResult.taskIds, architectResult.regressionId];
  const allDone = treeIds.every((id) => getTask(id)?.status === 'done');
  if (!allDone) {
    console.log('\nДерево не полностью зелёное — обживание и отчёт консультанта пропущены (см. /status, /resume).');
    return;
  }

  // Обживание (§9, Фаза 5.5) — ОДИН цикл на сдачу, только после зелёной доски.
  console.log('\n[live_in] обживаю продукт как первый пользователь...');
  const liveinResult = await runLivein({
    rootSpec: brief.summary, workspaceDir: WORKSPACE, runId, projectId: 'default',
  });

  let liveinSummary;
  if (!liveinResult.ok) {
    liveinSummary = `не удалось провести обживание: ${liveinResult.error}`;
    console.log(`\n[live_in] ${liveinSummary}`);
  } else if (liveinResult.roughSpotsFound === 0) {
    liveinSummary = 'шероховатостей не найдено — обживание прошло без замечаний.';
    console.log(`\n[live_in] ${liveinSummary}`);
  } else {
    console.log(`\n[live_in] найдено шероховатостей: ${liveinResult.roughSpotsFound}, создано polish-задач: ${liveinResult.taskIds.length}`);
    await runCoordinatorLoop({ role: 'coder', workspaceDir: WORKSPACE });
    liveinSummary = `найдено и обработано шероховатостей: ${liveinResult.roughSpotsFound}\n${boardSummaryText(liveinResult.taskIds)}`;
    printStatus();
  }

  const allTreeIds = [...treeIds, ...(liveinResult.taskIds || [])];
  console.log('\n--- Отчёт консультанта ---');
  const report = await buildConsultantReport({
    protocol, rootSpec: brief.summary, engineeringDefaults: brief.engineering_defaults,
    problem: brief.problem, boardSummary: boardSummaryText(allTreeIds), liveinSummary, runId,
  });
  console.log(report);
}

async function runTweakFlow(text, criteria, runId) {
  backupWorkspaceHistory('tweak');
  const id = addTask({
    title: text.slice(0, 80), spec: text, criteria: JSON.stringify(criteria), role: 'coder', type: 'tweak',
  });
  await runCoordinatorLoop({ role: 'coder', workspaceDir: WORKSPACE });
  const finalTask = getTask(id);

  if (finalTask.status === 'blocked_needs_human') {
    // Эскалация встроена (§1): tweak, оказавшийся сложнее, автоматически
    // перезапускается маршрутом project (полный цикл с советником/архитектором).
    console.log('\nTweak оказался сложнее ожидаемого — эскалирую на полный цикл (project).');
    await runProjectFlow('wish', text, runId);
    return;
  }
  console.log(`\nTweak завершён: ${finalTask.status}`);
  if (finalTask.feedback) console.log(finalTask.feedback);
}

async function handleLine(rawLine) {
  const line = sanitizeLine(rawLine);
  if (!line) return;

  if (line === '/exit') { closeInput(); process.exit(0); }
  if (line === '/status') { printStatus(); return; }
  if (line === '/resume') {
    const n = releaseStuck();
    console.log(`\n[resume] возвращено в pending: ${n}`);
    await runCoordinatorLoop({ role: 'coder', workspaceDir: WORKSPACE });
    printStatus();
    return;
  }

  // Шрам 16: мусорный вход не превращается в бриф.
  if (isGarbageInput(line)) {
    console.log('\nНе понял запрос — слишком коротко или похоже на случайный ввод. Если что-то не завершилось, попробуйте /resume.');
    return;
  }

  const runId = newRunId();
  const workspaceListing = listWorkspaceFileNames(WORKSPACE);
  const routed = await routeRequest({ text: line, workspaceFiles: workspaceListing, runId });
  console.log(`\n[router] route=${routed.route} (${routed.reason})`);

  if (routed.route === 'question') {
    const rootSpec = getRootSpec('default');
    const answer = await runAnalyst({
      question: line, rootSpec: rootSpec?.spec, workspaceDir: WORKSPACE, runId,
    });
    console.log(`\n${answer}`);
    return;
  }

  if (routed.route === 'tweak') {
    await runTweakFlow(line, routed.criteria, runId);
    return;
  }

  const protocol = PROJECT_PROTOCOLS.has(routed.route) ? routed.route : 'wish';
  await runProjectFlow(protocol, line, runId);
}

async function main() {
  releaseStuck();
  console.log('LOOM talk — сессия. Команды: /status /resume /exit. Опишите задачу:');

  // unhandledRejection-броня (шрам 25): ошибка в фоне не должна убивать сеанс.
  process.on('unhandledRejection', (e) => {
    console.error('\n[talk] необработанная ошибка (сессия продолжает работу):', e?.message || e);
  });
  process.on('uncaughtException', (e) => {
    console.error('\n[talk] необработанное исключение (сессия продолжает работу):', e?.message || e);
  });

  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const line = await question('\n> ');
    try {
      // eslint-disable-next-line no-await-in-loop
      await handleLine(line);
    } catch (e) {
      console.error('\n[talk] ошибка обработки запроса (сессия продолжает работу):', e.message);
    }
  }
}

main();

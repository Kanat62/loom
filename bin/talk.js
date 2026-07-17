// talk.js — сеанс (§25 ТЗ v4): пять типов входа за одним REPL. /status
// /resume /exit /projects /project, unhandledRejection-броня (шрам 25),
// .history-бэкап перед изменениями (шрам 26, только tweak/project — question
// ничего не меняет), санитизация ввода (шрам 32).
//
// §29 (шрам 35): проект — первоклассная сущность, активный проект живёт в
// переменной сеанса (activeProject), не в тихом project_id='default'.
// Правило рождения нового проекта — детерминированный код здесь, НЕ отдано
// модели (§29.1: «маршрутизатор дал wish/problem/spec И (активного проекта
// нет ИЛИ человек явно сказал «новый продукт»)»).
import fs from 'node:fs';
import path from 'node:path';
import { question, closeInput, sanitizeLine } from '../core/io.js';
import {
  isGarbageInput, startIntake, continueIntake, reviseDecisions, buildBrief, runAnalyst,
  buildConsultantReport,
} from '../agents/advisor.js';
import { routeRequest } from '../agents/router.js';
import { runArchitect } from '../agents/architect.js';
import { runDesigner } from '../agents/designer.js';
import { listWorkspaceFileNames } from '../agents/coder.js';
import { runLivein } from '../agents/livein.js';
import { planResearch, evaluateResearch } from '../agents/researcher.js';
import { runIngest } from '../agents/ingest.js';
import { runCoordinatorLoop } from '../core/coordinator.js';
import {
  addTask, getTask, listTasks, releaseStuck, newRunId, setRootSpec, getRootSpec,
  listEvents, listEventsSince, mergeRootSpec,
} from '../core/journal.js';
import {
  createProject, listProjects, touchProject,
} from '../core/projects.js';
import { resolveDomain } from '../core/domain.js';
import { HISTORY_DIR, MOCK, GITHUB_PUSH } from '../core/config.js';
import { ensureProductRepo, slugify } from '../core/github.js';

const PROJECT_PROTOCOLS = new Set(['wish', 'problem', 'spec']);
// Момент старта сеанса — итог "за сеанс" (/status, /exit) считается по всем
// events с created_at позже этой отметки, не завязан на конкретный run_id
// (за сеанс их обычно несколько: у каждого запроса свой).
const SESSION_STARTED_AT = Date.now();

// §29.1: активный проект сеанса — состояние процесса, не аргумент каждой
// функции по отдельности (та же роль, что раньше играл 'default', но теперь
// это реальная запись в таблице projects, не строковый литерал).
let activeProject = null;

function backupWorkspaceHistory(label) {
  if (!activeProject || !fs.existsSync(activeProject.workspace_dir)) return;
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dest = path.join(HISTORY_DIR, `${activeProject.id}-${stamp}-${label}`);
    fs.mkdirSync(HISTORY_DIR, { recursive: true });
    fs.cpSync(activeProject.workspace_dir, dest, { recursive: true });
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

/**
 * Итог по токенам (§14: usage уже пишется в events на каждый вызов шлюза —
 * это просто SQL-агрегация уже существующих данных, не новый учёт стоимости;
 * $ берётся из events.cost_usd, который gateway.js уже посчитал по условным
 * ценам тиров из config.js, когда claude-cli не вернул total_cost_usd сам).
 * Общий итог за сеанс сознательно НЕ фильтруется по активному проекту —
 * человек может переключаться между проектами в одном сеансе, а токены
 * тратятся сеансом целиком (в отличие от задач, которые принадлежат ровно
 * одному проекту).
 */
function formatTokenSummary(events, title) {
  const usage = events.filter((e) => e.type === 'usage');
  if (!usage.length) return `\n--- ${title} ---\n(вызовов модели не было)`;

  const byAgent = new Map();
  for (const e of usage) {
    const agent = e.agent || '(неизвестно)';
    let cacheRead = 0;
    try { cacheRead = JSON.parse(e.payload || '{}').cache_read || 0; } catch { /* мок-события без payload.cache_read */ }
    const row = byAgent.get(agent) || {
      calls: 0, tokensIn: 0, tokensOut: 0, cacheRead: 0, cost: 0,
    };
    row.calls += 1;
    row.tokensIn += e.tokens_in || 0;
    row.tokensOut += e.tokens_out || 0;
    row.cacheRead += cacheRead;
    row.cost += e.cost_usd || 0;
    byAgent.set(agent, row);
  }

  const total = {
    calls: 0, tokensIn: 0, tokensOut: 0, cacheRead: 0, cost: 0,
  };
  const col = (v, w) => String(v).padStart(w);
  const lines = [
    `\n--- ${title} ---`,
    `${'агент'.padEnd(13)} | ${'вызовов'.padStart(7)} | ${'tokens_in'.padStart(9)} | ${'tokens_out'.padStart(10)} | ${'cache_read'.padStart(10)} | ${'$'.padStart(8)}`,
  ];
  for (const [agent, row] of byAgent) {
    total.calls += row.calls;
    total.tokensIn += row.tokensIn;
    total.tokensOut += row.tokensOut;
    total.cacheRead += row.cacheRead;
    total.cost += row.cost;
    lines.push(`${agent.padEnd(13)} | ${col(row.calls, 7)} | ${col(row.tokensIn, 9)} | ${col(row.tokensOut, 10)} | ${col(row.cacheRead, 10)} | ${col(row.cost.toFixed(4), 8)}`);
  }
  lines.push(`${'ИТОГО'.padEnd(13)} | ${col(total.calls, 7)} | ${col(total.tokensIn, 9)} | ${col(total.tokensOut, 10)} | ${col(total.cacheRead, 10)} | ${col(total.cost.toFixed(4), 8)}`);
  return lines.join('\n');
}

function printRunTokenSummary(runId) {
  console.log(formatTokenSummary(listEvents({ run_id: runId }), `Токены за запрос (run_id=${runId})`));
}

function printSessionTokenSummary() {
  console.log(formatTokenSummary(listEventsSince(SESSION_STARTED_AT), 'Токены за сеанс (итого)'));
}

/**
 * printStatus() — §29.2 п.3: только активный проект + честная строка "в
 * других проектах", НИКОГДА не смешанная сводка по всей базе (это и был
 * реальный инцидент — /status показывал счётчики чужих деревьев вперемешку).
 */
function printStatus() {
  if (!activeProject) {
    console.log('\n--- /status ---');
    console.log('Нет активного проекта — см. /projects.');
    printSessionTokenSummary();
    return;
  }
  const tasks = listTasks({ project_id: activeProject.id });
  const byStatus = {};
  for (const t of tasks) byStatus[t.status] = (byStatus[t.status] || 0) + 1;
  console.log(`\n--- /status (проект: ${activeProject.title}, ${activeProject.id}) ---`);
  console.log(JSON.stringify(byStatus));
  for (const t of tasks) {
    if (t.status === 'blocked_needs_human') {
      console.log(`  ⚠ ${t.id} "${t.title}" — ${t.question ? `вопрос: ${t.question}` : t.feedback}`);
    }
  }
  const otherTasks = listTasks({}).filter((t) => t.project_id !== activeProject.id);
  if (otherTasks.length) {
    const otherByStatus = {};
    for (const t of otherTasks) otherByStatus[t.status] = (otherByStatus[t.status] || 0) + 1;
    console.log(`  в других проектах: ${JSON.stringify(otherByStatus)} (/projects — список)`);
  }
  printSessionTokenSummary();
}

/** /projects — все проекты со счётчиками задач по статусам (§29.1). */
function printProjects() {
  const all = listProjects({});
  if (!all.length) {
    console.log('\nПроектов ещё нет — опишите задачу, чтобы создать первый.');
    return;
  }
  console.log('\n--- /projects ---');
  all.forEach((p, i) => {
    const tasks = listTasks({ project_id: p.id });
    const byStatus = {};
    for (const t of tasks) byStatus[t.status] = (byStatus[t.status] || 0) + 1;
    const marker = activeProject && activeProject.id === p.id ? '→' : ' ';
    console.log(`${marker} ${i + 1}. [${p.status}] ${p.title} (${p.id}) ${JSON.stringify(byStatus)}`);
  });
}

/** /project <номер|id> — переключить активный проект (§29.1). */
function switchActiveProject(arg) {
  const all = listProjects({});
  const byIndex = all[Number(arg) - 1];
  const byId = all.find((p) => p.id === arg);
  const target = byIndex || byId;
  if (!target) {
    console.log(`\nПроект не найден: "${arg}". См. /projects.`);
    return;
  }
  activeProject = target;
  touchProject(target.id);
  console.log(`\nАктивный проект: ${target.title} (${target.id})`);
}

/**
 * Выбор активного проекта на старте сеанса (§29.1): единственный active →
 * он; несколько → печатается список, человек выбирает; ноль → остаётся null
 * («нет активных проектов, опишите задачу» — первый wish/problem/spec его
 * создаст). Чистое чтение + одна интерактивная развилка, вся логика решения
 * "что делать при multiple/none" — здесь, а не в core/projects.js (та
 * функция там намеренно неинтерактивна, resolveSingleActiveProject).
 */
async function pickActiveProjectAtStartup() {
  const active = listProjects({ status: 'active' });
  if (active.length === 1) {
    activeProject = active[0];
    console.log(`\nАктивный проект: ${activeProject.title} (${activeProject.id})`);
    return;
  }
  if (active.length === 0) {
    console.log('\nНет активных проектов — опишите задачу, чтобы создать первый (см. также /projects).');
    return;
  }
  console.log('\nНесколько активных проектов:');
  active.forEach((p, i) => console.log(`  ${i + 1}. ${p.title} (${p.id})`));
  const choice = sanitizeLine(await question('Выберите номер (Enter — самый недавний): '));
  if (!choice) {
    activeProject = active[0]; // listProjects сортирует по last_active_at DESC
  } else {
    const byIndex = active[Number(choice) - 1];
    const byId = active.find((p) => p.id === choice);
    activeProject = byIndex || byId || active[0];
  }
  touchProject(activeProject.id);
  console.log(`Активный проект: ${activeProject.title} (${activeProject.id})`);
}

/**
 * Детерминированное правило рождения нового проекта (§29.1, НЕ отдано
 * модели): вызывается только для route wish/problem/spec. Активного проекта
 * нет → новый молча (нечего уточнять). Активный есть → один короткий вопрос
 * харнесса (не модели): Enter — это про текущий проект, любой другой
 * непустой ответ — трактуется как «новый продукт».
 */
async function ensureProjectForNewWork(initialText) {
  if (!activeProject) {
    activeProject = createProject({ title: initialText.slice(0, 60) });
    console.log(`\n[project] новый проект: ${activeProject.title} (${activeProject.id})`);
    return;
  }
  const reply = sanitizeLine(await question(
    `\nЭто про текущий проект "${activeProject.title}" или новый продукт? (Enter — текущий, любой текст — новый продукт)\n> `,
  ));
  if (reply) {
    activeProject = createProject({ title: initialText.slice(0, 60) });
    console.log(`[project] новый проект: ${activeProject.title} (${activeProject.id})`);
  } else {
    touchProject(activeProject.id);
  }
}

async function runProjectFlow(protocol, initialText, runId) {
  await ensureProjectForNewWork(initialText);
  const projectId = activeProject.id;
  const workspaceDir = activeProject.workspace_dir;

  const existingRootSpec = getRootSpec(projectId);
  const existingDefaults = existingRootSpec?.engineering_defaults
    ? JSON.parse(existingRootSpec.engineering_defaults) : [];

  let { history, step } = await startIntake({
    protocol, initialText, runId, rootSpec: existingRootSpec?.spec, engineeringDefaults: existingDefaults,
  });
  let turnCount = 1;
  while (step.type === 'ask') {
    const reply = sanitizeLine(await question(`\n${step.question}\n> `));
    turnCount++;
    // eslint-disable-next-line no-await-in-loop
    ({ history, step } = await continueIntake({
      protocol, history, clientReply: reply, runId, turnCount,
      rootSpec: existingRootSpec?.spec, engineeringDefaults: existingDefaults,
    }));
  }

  console.log('\nПринял инженерные решения:');
  for (const d of step.engineeringDefaults) console.log(`  - ${d}`);
  const confirmation = sanitizeLine(await question('\n(Enter — согласие, или впишите правку)\n> '));
  if (confirmation) {
    ({ history, step } = await reviseDecisions({
      protocol, history, correctionText: confirmation, runId,
      rootSpec: existingRootSpec?.spec, engineeringDefaults: existingDefaults,
    }));
    console.log('\nОбновлённые решения:');
    for (const d of step.engineeringDefaults) console.log(`  - ${d}`);
  }

  const brief = buildBrief({ protocol, initialText, step });
  const merged = mergeRootSpec(existingRootSpec, brief.summary, brief.engineering_defaults);
  // §27.1: домен решается ОДИН раз на проект и дальше наследуется — если
  // root_spec уже знает домен (проект не новый), новое решение/эвристика
  // игнорируется, а не перебивает уже принятое (setRootSpec тоже страхует
  // это через COALESCE, здесь — явно, чтобы не звать эвристику впустую).
  const domain = existingRootSpec?.domain
    || resolveDomain(brief.domain, `${merged.spec}\n${merged.engineeringDefaults.join('\n')}`);
  setRootSpec(projectId, merged.spec, merged.engineeringDefaults, protocol, domain);
  backupWorkspaceHistory(protocol);

  // Архитектор получает ПОЛНУЮ (объединённую) картину продукта, не только
  // новый инкремент — иначе он тоже забудет более ранние решения.
  const fullBrief = { ...brief, summary: merged.spec, engineering_defaults: merged.engineeringDefaults };

  // Исследователь (§10, П§6.1) — только для problem-входа: советник уже
  // диагностировал проблему, теперь честно проверяем, доступны ли данные,
  // ДО того, как архитектор спроектирует решение вокруг данных, которых
  // может не существовать. Жесточайший стоп-фактор: data_unavailable →
  // проект blocked_needs_human, архитектор НЕ вызывается — ветки
  // «продолжить без данных» здесь структурно нет.
  let dataSummaryForReport = null;
  if (protocol === 'problem') {
    console.log('\n[researcher] оцениваю доступность данных...');
    const planResult = await planResearch({
      brief: fullBrief, rootSpec: merged.spec, workspaceDir, runId, projectId,
    });
    if (!planResult.ok) {
      console.log(`\nИсследователь не смог построить план добычи данных: ${planResult.error}`);
      printRunTokenSummary(runId);
      return;
    }
    if (!planResult.empty) {
      console.log(`[researcher] заказано: инструментов ${planResult.toolTaskIds.length}, запусков добычи ${planResult.toolRunTaskIds.length}`);
      (planResult.precheckLog || []).forEach((l) => console.log(`  ${l}`));
      await runCoordinatorLoop({
        role: 'coder', workspaceDir, runId, projectId,
      });

      const evalResult = await evaluateResearch({
        toolRunTaskIds: planResult.toolRunTaskIds, workspaceDir, runId,
      });
      if (!evalResult.ok) {
        console.log(`\nИсследователь не смог оценить добытые данные: ${evalResult.error}`);
        printRunTokenSummary(runId);
        return;
      }
      if (evalResult.verdict === 'data_unavailable') {
        console.log(`\n[researcher] ${evalResult.clientNote}`);
        console.log('\nПроект остановлен — данные недоступны (см. выше). Архитектор не вызывается, это честный итог, не сбой.');
        printRunTokenSummary(runId);
        return;
      }
      dataSummaryForReport = evalResult.dataSummary;
      fullBrief.summary = `${fullBrief.summary}\n\n[Данные, добытые исследователем]\n${evalResult.forArchitect}`;
    }
  }

  await runBuildFlow({
    protocol, brief, merged, fullBrief, runId, dataSummaryForReport, domain, projectId, workspaceDir,
  });
}

/**
 * Общий хвост project/spec-потока — architect → coordinator → live_in →
 * отчёт консультанта → публикация (§9/§17/Фаза 5). Выделен из runProjectFlow
 * (П§6.2), потому что /ingest (§11) строит fullBrief по-своему (требования
 * ТЗ-пакета вместо интервью советника), но дальше идёт ТОТ ЖЕ конвейер —
 * дублировать его копипастой означало бы неизбежное расхождение при правках.
 */
async function runBuildFlow({
  protocol, brief, merged, fullBrief, runId, dataSummaryForReport, domain, projectId, workspaceDir,
}) {
  // Дизайн-контур (§27.1/27.2): только domain='ui', ДО архитектора — план
  // архитектора (§27.3, следующая стадия) должен видеть готовую систему.
  // Провал здесь — честный останов, симметрично провалу npm install у
  // архитектора ("нужен пакет → статус «нужен пакет»"): задачи ещё не
  // созданы, продолжать строить UI без системы значило бы обесценить весь
  // смысл этой роли.
  if (domain === 'ui') {
    console.log('\n[designer] издаю дизайн-систему проекта...');
    const designerResult = await runDesigner({ brief: fullBrief, workspaceDir, runId });
    if (!designerResult.ok) {
      console.log(`\n[designer] не удалось издать дизайн-систему: ${designerResult.error}`);
      printRunTokenSummary(runId);
      return;
    }
    if (designerResult.skipped) {
      console.log('[designer] система уже издана ранее в этом проекте — не переиздаю.');
    } else {
      console.log(`[designer] издана: ${designerResult.direction}`);
    }
  }

  const workspaceListing = listWorkspaceFileNames(workspaceDir);
  const architectResult = await runArchitect({
    brief: fullBrief, workspaceDir, workspaceListing, runId, projectId,
  });
  if (!architectResult.ok) {
    console.log(`\nАрхитектор не смог построить план: ${architectResult.error}`);
    printRunTokenSummary(runId);
    return;
  }
  console.log(`\nСоздано задач: ${architectResult.taskIds.length} + регрессия. Пакеты: ${architectResult.packages.join(', ') || '(нет)'}`);
  architectResult.precheckLog.forEach((l) => console.log(`  ${l}`));
  if (architectResult.uncoveredRequirements?.length) {
    console.log('\n⚠ Требования ТЗ-пакета без покрывающей задачи (дыра в плане архитектора):');
    for (const r of architectResult.uncoveredRequirements) console.log(`  - [${r.id}] ${r.text}`);
  }

  await runCoordinatorLoop({
    role: 'coder', workspaceDir, runId, projectId,
  });
  printStatus();

  const treeIds = [...architectResult.taskIds, architectResult.regressionId];
  const allDone = treeIds.every((id) => getTask(id)?.status === 'done');
  if (!allDone) {
    console.log('\nДерево не полностью зелёное — обживание и отчёт консультанта пропущены (см. /status, /resume).');
    printRunTokenSummary(runId);
    return;
  }

  // Обживание (§9, Фаза 5.5) — ОДИН цикл на сдачу, только после зелёной доски.
  console.log('\n[live_in] обживаю продукт как первый пользователь...');
  const liveinResult = await runLivein({
    rootSpec: merged.spec, workspaceDir, runId, projectId,
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
    await runCoordinatorLoop({
      role: 'coder', workspaceDir, runId, projectId,
    });
    liveinSummary = `найдено и обработано шероховатостей: ${liveinResult.roughSpotsFound}\n${boardSummaryText(liveinResult.taskIds)}`;
    printStatus();
  }

  const allTreeIds = [...treeIds, ...(liveinResult.taskIds || [])];
  console.log('\n--- Отчёт консультанта ---');
  const report = await buildConsultantReport({
    protocol, rootSpec: merged.spec, engineeringDefaults: merged.engineeringDefaults,
    problem: brief.problem, boardSummary: boardSummaryText(allTreeIds), liveinSummary,
    dataSources: dataSummaryForReport, runId,
  });
  console.log(report);
  publishToGithub(merged.spec, workspaceDir);
  printRunTokenSummary(runId);
}

/**
 * Фаза 5 (П§3 DEV_GUIDE part2): публикация после отчёта консультанта —
 * только тогда есть что публиковать (дерево зелёное, обживание прошло).
 * MOCK — всегда dry-run, GITHUB_PUSH в MOCK игнорируется (§24); в реальном
 * режиме — только по явному GITHUB_PUSH=1. Недоступный gh/сеть → одна
 * честная строка в сдаче, НЕ падение прогона (история задач уже сохранена
 * autoCommit'ом независимо от публикации).
 */
function publishToGithub(rootSpecSummary, workspaceDir) {
  if (!MOCK && !GITHUB_PUSH) return;
  const name = slugify(rootSpecSummary);
  const result = ensureProductRepo(workspaceDir, name, { dryRun: MOCK });
  if (result.dryRun) {
    console.log(`\n[github] MOCK dry-run (сеть не трогается): ${result.dryRunCmd}`);
  } else if (result.ok) {
    console.log(`\n[github] опубликовано: ${result.url || '(gh не вернул URL в выводе)'}`);
  } else {
    console.log(`\n[github] репозиторий не создан: ${result.error}`);
  }
}

async function runTweakFlow(text, criteria, runId, verification = false) {
  if (!activeProject) {
    console.log('\nСначала выберите проект: /projects (или опишите задачу как новый продукт).');
    return;
  }
  touchProject(activeProject.id);
  const { id: projectId, workspace_dir: workspaceDir } = activeProject;
  backupWorkspaceHistory('tweak');
  // Verification-вход (шрам: «проверь фильтр» отроутилось в problem, советник
  // спросил у клиента то, что сам обязан был установить прогоном критериев):
  // criteria здесь — {regression_of:[...]} на УЖЕ существующие задачи, type
  // 'regression' — coordinator.js пропускает кодера для таких задач (§8.9),
  // сразу идёт в tester. Никакой новой генерации кода/проверки, ноль вопросов
  // клиенту до отчёта.
  const id = addTask({
    project_id: projectId, title: text.slice(0, 80), spec: text, criteria: JSON.stringify(criteria), role: 'coder',
    type: verification ? 'regression' : 'tweak',
  });
  await runCoordinatorLoop({
    role: 'coder', workspaceDir, runId, projectId,
  });
  const finalTask = getTask(id);

  if (finalTask.status === 'blocked_needs_human' && finalTask.type !== 'regression') {
    // Эскалация встроена (§1): tweak, оказавшийся сложнее, автоматически
    // перезапускается маршрутом project (полный цикл с советником/архитектором).
    // Verification-регрессия сюда не попадает: провал существующих критериев
    // — это результат проверки, который нужно ДОЛОЖИТЬ, а не повод затевать
    // новый цикл советника. runId тот же — эскалированный project допечатает
    // токены за ВЕСЬ запрос (tweak-попытка + полный цикл) сам, повторно
    // печатать здесь не нужно.
    console.log('\nTweak оказался сложнее ожидаемого — эскалирую на полный цикл (project).');
    await runProjectFlow('wish', text, runId);
    return;
  }
  console.log(`\nTweak завершён: ${finalTask.status}`);
  if (finalTask.feedback) console.log(finalTask.feedback);
  printRunTokenSummary(runId);
}

/**
 * /ingest <папка> (§11, П§6.2): приём ТЗ-пакета. Разбор документов → свод
 * требований → поиск дыр/противоречий → вопросы клиенту ТОЛЬКО по дырам
 * (тот же принцип, что у интервью советника) → root_spec пополняется
 * (ТЗ-текст + ответы клиента) → общий хвост runBuildFlow (архитектор
 * получает требования с id и обязан трассировать covers).
 *
 * §29.1: /ingest пакета документов — всегда НОВЫЙ продукт (тот же принцип,
 * что wish/problem/spec без активного проекта) — ТЗ-пакет описывает целый
 * продукт с нуля, не инкремент существующего; человека не переспрашиваем.
 */
async function runIngestFlow(folderPath) {
  if (!folderPath || !fs.existsSync(folderPath) || !fs.statSync(folderPath).isDirectory()) {
    console.log(`\n/ingest: папка не найдена: ${folderPath || '(путь не указан)'}`);
    return;
  }
  activeProject = createProject({ title: `ingest: ${path.basename(folderPath)}` });
  console.log(`\n[project] новый проект: ${activeProject.title} (${activeProject.id})`);
  const projectId = activeProject.id;
  const workspaceDir = activeProject.workspace_dir;

  const runId = newRunId();
  console.log(`\n[ingest] читаю пакет документов: ${folderPath}`);
  const result = await runIngest({ folderPath, runId });
  if (!result.ok) {
    console.log(`\n[ingest] сбой: ${result.error}`);
    printRunTokenSummary(runId);
    return;
  }
  (result.parseErrors || []).forEach((e) => console.log(`  ${e}`));
  console.log(`[ingest] документов: ${result.docs.length}, требований: ${result.requirements.length}`);

  if (result.holes.length || result.contradictions.length) {
    console.log('\n--- Дыры и противоречия в ТЗ ---');
    for (const h of result.holes) console.log(`  ⚠ дыра [${h.req_id}]: ${h.description}`);
    for (const c of result.contradictions) console.log(`  ⚠ противоречие [${(c.req_ids || []).join(', ')}]: ${c.description}`);
  } else {
    console.log('\n[ingest] дыр и противоречий не найдено.');
  }

  const answers = [];
  for (const q of result.questions) {
    // eslint-disable-next-line no-await-in-loop
    const reply = sanitizeLine(await question(`\n[дыра ${q.req_id}] ${q.question}\n> `));
    if (reply) answers.push(`[${q.req_id}] ${q.question} → ${reply}`);
  }

  const existingRootSpec = getRootSpec(projectId);
  const existingDefaults = existingRootSpec?.engineering_defaults
    ? JSON.parse(existingRootSpec.engineering_defaults) : [];
  const summary = [
    'ТЗ-пакет (ingest):',
    result.combinedText || '(документы не содержали проверяемых требований)',
    answers.length ? `\nОтветы клиента на дыры/противоречия:\n${answers.join('\n')}` : '',
  ].join('\n');
  const merged = mergeRootSpec(existingRootSpec, summary, existingDefaults);
  // §27.1: /ingest не проходит через интервью советника (нет ready-JSON с
  // полем domain) — домен решается ЦЕЛИКОМ эвристикой по тексту ТЗ-пакета,
  // если проект ещё не решил его раньше.
  const domain = existingRootSpec?.domain || resolveDomain(null, summary);
  setRootSpec(projectId, merged.spec, merged.engineeringDefaults, 'spec', domain);
  backupWorkspaceHistory('spec');

  const brief = {
    protocol: 'spec', request: `/ingest ${folderPath}`, summary: merged.spec, engineering_defaults: merged.engineeringDefaults, problem: null,
  };
  const fullBrief = { ...brief, requirements: result.requirements };

  await runBuildFlow({
    protocol: 'spec', brief, merged, fullBrief, runId, dataSummaryForReport: null, domain, projectId, workspaceDir,
  });
}

async function handleLine(rawLine) {
  const line = sanitizeLine(rawLine);
  if (!line) return;

  if (line === '/exit') { printSessionTokenSummary(); closeInput(); process.exit(0); }
  if (line === '/status') { printStatus(); return; }
  if (line === '/projects') { printProjects(); return; }
  if (line.startsWith('/project ')) { switchActiveProject(line.slice('/project '.length).trim()); return; }
  if (line === '/resume') {
    if (!activeProject) {
      console.log('\nНет активного проекта — см. /projects.');
      return;
    }
    const n = releaseStuck({ projectId: activeProject.id });
    console.log(`\n[resume] возвращено в pending: ${n}`);
    await runCoordinatorLoop({ role: 'coder', workspaceDir: activeProject.workspace_dir, projectId: activeProject.id });
    printStatus();
    return;
  }
  if (line.startsWith('/ingest ')) {
    await runIngestFlow(line.slice('/ingest '.length).trim());
    return;
  }

  // Шрам 16: мусорный вход не превращается в бриф.
  if (isGarbageInput(line)) {
    console.log('\nНе понял запрос — слишком коротко или похоже на случайный ввод. Если что-то не завершилось, попробуйте /resume.');
    return;
  }

  const runId = newRunId();
  const workspaceListing = activeProject ? listWorkspaceFileNames(activeProject.workspace_dir) : [];
  // [router]-строка прогресса печатается внутри routeRequest() самой (agents/
  // router.js) — одинаково видна и здесь, и в npm run mock, который зовёт её напрямую.
  const routed = await routeRequest({ text: line, workspaceFiles: workspaceListing, runId });

  if (routed.route === 'question') {
    if (!activeProject) {
      console.log('\nСначала выберите проект: /projects (или опишите задачу как новый продукт).');
      return;
    }
    const rootSpec = getRootSpec(activeProject.id);
    const answer = await runAnalyst({
      question: line, rootSpec: rootSpec?.spec, workspaceDir: activeProject.workspace_dir, runId,
    });
    console.log(`\n${answer}`);
    return;
  }

  if (routed.route === 'tweak') {
    await runTweakFlow(line, routed.criteria, runId, routed.verification === true);
    return;
  }

  const protocol = PROJECT_PROTOCOLS.has(routed.route) ? routed.route : 'wish';
  await runProjectFlow(protocol, line, runId);
}

async function main() {
  releaseStuck(); // глобальный sweep (§29.2 п.2: без projectId — до выбора активного проекта ничего другого не знаем)
  console.log('LOOM talk — сессия. Команды: /status /resume /exit /projects /project. Опишите задачу:');
  await pickActiveProjectAtStartup();

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

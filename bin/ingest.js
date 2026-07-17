// bin/ingest.js — приём ТЗ-пакета отдельным прогоном (§11, П§6.2 DEV_GUIDE
// part2): `node bin/ingest.js <папка>`. То же самое доступно как `/ingest
// <папка>` внутри talk.js (bin/talk.js:runIngestFlow) — этот файл не
// импортирует talk.js (там `main()` вызывается безусловно на верхнем уровне,
// как и в остальных bin/*), это самостоятельная точка входа в духе cli.js.
import fs from 'node:fs';
import { question, closeInput, sanitizeLine } from '../core/io.js';
import { runIngest } from '../agents/ingest.js';
import { runArchitect } from '../agents/architect.js';
import { runLivein } from '../agents/livein.js';
import { buildConsultantReport } from '../agents/advisor.js';
import { listWorkspaceFileNames } from '../agents/coder.js';
import { runCoordinatorLoop } from '../core/coordinator.js';
import {
  getTask, newRunId, setRootSpec, getRootSpec, releaseStuck, listEvents, mergeRootSpec,
} from '../core/journal.js';
import { createProject } from '../core/projects.js';
import { MOCK, GITHUB_PUSH } from '../core/config.js';
import { ensureProductRepo, slugify } from '../core/github.js';

function boardSummaryText(taskIds) {
  return taskIds.map((id) => {
    const t = getTask(id);
    if (!t) return `- ${id}: (не найдена)`;
    return `- [${t.type}] "${t.title}" — ${t.status} (попыток: ${t.attempts})${t.feedback ? ` — ${t.feedback.slice(0, 200)}` : ''}`;
  }).join('\n');
}

function printTokenSummary(runId) {
  const usage = listEvents({ run_id: runId }).filter((e) => e.type === 'usage');
  const cost = usage.reduce((s, e) => s + (e.cost_usd || 0), 0);
  console.log(`\n--- Токены за прогон (run_id=${runId}) ---`);
  console.log(`вызовов: ${usage.length}, $: ${cost.toFixed(4)}`);
}

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

async function main() {
  const folderPath = process.argv[2];
  if (!folderPath || !fs.existsSync(folderPath) || !fs.statSync(folderPath).isDirectory()) {
    console.error(`Использование: node bin/ingest.js <папка>\nПапка не найдена: ${folderPath || '(не указана)'}`);
    process.exit(1);
  }

  // §29.1: /ingest — всегда НОВЫЙ проект (ТЗ-пакет описывает продукт с нуля,
  // тот же принцип, что bin/talk.js:runIngestFlow).
  const project = createProject({ title: `ingest: ${folderPath}` });
  const workspaceDir = project.workspace_dir;
  console.log(`[ingest] новый проект: ${project.title} (${project.id})`);

  releaseStuck({ projectId: project.id });
  const runId = newRunId();
  console.log(`[ingest] читаю пакет документов: ${folderPath}`);
  const result = await runIngest({ folderPath, runId });
  if (!result.ok) {
    console.error(`[ingest] сбой: ${result.error}`);
    process.exit(1);
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
  closeInput();

  const existingRootSpec = getRootSpec(project.id);
  const existingDefaults = existingRootSpec?.engineering_defaults
    ? JSON.parse(existingRootSpec.engineering_defaults) : [];
  const summary = [
    'ТЗ-пакет (ingest):',
    result.combinedText || '(документы не содержали проверяемых требований)',
    answers.length ? `\nОтветы клиента на дыры/противоречия:\n${answers.join('\n')}` : '',
  ].join('\n');
  const merged = mergeRootSpec(existingRootSpec, summary, existingDefaults);
  setRootSpec(project.id, merged.spec, merged.engineeringDefaults, 'spec');

  const brief = {
    protocol: 'spec', request: `/ingest ${folderPath}`, summary: merged.spec, engineering_defaults: merged.engineeringDefaults, problem: null,
  };
  const fullBrief = { ...brief, requirements: result.requirements };

  const workspaceListing = listWorkspaceFileNames(workspaceDir);
  const architectResult = await runArchitect({
    brief: fullBrief, workspaceDir, workspaceListing, runId, projectId: project.id,
  });
  if (!architectResult.ok) {
    console.error(`\nАрхитектор не смог построить план: ${architectResult.error}`);
    printTokenSummary(runId);
    process.exit(1);
  }
  console.log(`\nСоздано задач: ${architectResult.taskIds.length} + регрессия. Пакеты: ${architectResult.packages.join(', ') || '(нет)'}`);
  architectResult.precheckLog.forEach((l) => console.log(`  ${l}`));
  if (architectResult.uncoveredRequirements?.length) {
    console.log('\n⚠ Требования ТЗ-пакета без покрывающей задачи (дыра в плане архитектора):');
    for (const r of architectResult.uncoveredRequirements) console.log(`  - [${r.id}] ${r.text}`);
  }

  await runCoordinatorLoop({
    role: 'coder', workspaceDir, runId, projectId: project.id,
  });

  const treeIds = [...architectResult.taskIds, architectResult.regressionId];
  const allDone = treeIds.every((id) => getTask(id)?.status === 'done');
  if (!allDone) {
    console.log('\nДерево не полностью зелёное — обживание и отчёт консультанта пропущены (см. npm run talk -> /status, /resume).');
    printTokenSummary(runId);
    return;
  }

  console.log('\n[live_in] обживаю продукт как первый пользователь...');
  const liveinResult = await runLivein({
    rootSpec: merged.spec, workspaceDir, runId, projectId: project.id,
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
      role: 'coder', workspaceDir, runId, projectId: project.id,
    });
    liveinSummary = `найдено и обработано шероховатостей: ${liveinResult.roughSpotsFound}\n${boardSummaryText(liveinResult.taskIds)}`;
  }

  const allTreeIds = [...treeIds, ...(liveinResult.taskIds || [])];
  console.log('\n--- Отчёт консультанта ---');
  const report = await buildConsultantReport({
    protocol: 'spec', rootSpec: merged.spec, engineeringDefaults: merged.engineeringDefaults,
    problem: null, boardSummary: boardSummaryText(allTreeIds), liveinSummary, runId,
  });
  console.log(report);
  publishToGithub(merged.spec, workspaceDir);
  printTokenSummary(runId);
}

main().catch((e) => { console.error('[ingest] ошибка:', e.message); process.exit(1); });

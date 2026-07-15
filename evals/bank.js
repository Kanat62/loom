// evals/bank.js — банк эталонных желаний (§14.2, П§6.3 DEV_GUIDE part2):
// четыре сценария из Г§10 (кофейня, танки — браузерная игра, аналитика
// откликов — класс на Chart.js, диллер-лайт — problem). Формат файлов —
// evals/bank/*.json: {input, route_expected, protocol_expected, min_tasks,
// forbidden_in_interview}.
//
// В MOCK — быстрый смоук: структура интервью (без запрещённых/технических
// слов в вопросах), router здесь НЕ вызывается для problem-кейсов — мок-
// роутер (core/mock.js) умеет отличать problem от wish только по спец-
// маркеру ТЕСТ_ИССЛЕДОВАТЕЛЬ (честная деградация, не реальная диагностика),
// поэтому под MOCK протокол берётся из фикстуры напрямую, а route_expected
// сверяется отдельно и только когда MOCK=false (см. ниже) — тот же принцип,
// которым уже пользуется evals/interview.js.
//
// С живыми моделями (MOCK=false) — полный релизный критерий (Г§10): router
// реально диагностирует (route===route_expected обязателен), architect
// строит дерево ≥ min_tasks задач, judge.js оценивает DAG (метрика, не
// ворота, §14: уровень 3).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { routeRequest } from '../agents/router.js';
import {
  startIntake, buildBrief, containsTechnicalQuestion,
} from '../agents/advisor.js';
import { runArchitect } from '../agents/architect.js';
import { listWorkspaceFileNames } from '../agents/coder.js';
import {
  newRunId, releaseStuck, setRootSpec,
} from '../core/journal.js';
import { WORKSPACE, MOCK } from '../core/config.js';
import { judgeArchitectPlan } from './judge.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BANK_DIR = path.join(__dirname, 'bank');

function loadBank() {
  return fs.readdirSync(BANK_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => ({ file: f, ...JSON.parse(fs.readFileSync(path.join(BANK_DIR, f), 'utf8')) }));
}

async function checkInterviewStructure(item, protocol, runId) {
  const { step } = await startIntake({ protocol, initialText: item.input, runId });
  if (step.type === 'ask') {
    const q = step.question.toLowerCase();
    const forbidden = (item.forbidden_in_interview || []).find((w) => q.includes(w.toLowerCase()));
    if (forbidden) throw new Error(`интервью содержит запрещённое слово "${forbidden}" в вопросе: "${step.question}"`);
    if (containsTechnicalQuestion(step.question) && !step.forcedFallback) {
      throw new Error(`интервью содержит техническую деталь (code-guard должен был это перехватить): "${step.question}"`);
    }
  }
  return step;
}

async function runOne(item) {
  const runId = newRunId();

  if (!MOCK) {
    // Полный релизный критерий — только с живыми моделями (router здесь
    // реально диагностирует wish/problem/spec, не регэксп-заглушка).
    const routed = await routeRequest({ text: item.input, workspaceFiles: listWorkspaceFileNames(WORKSPACE), runId });
    if (routed.route !== item.route_expected) {
      throw new Error(`route: ожидали ${item.route_expected}, получили ${routed.route}`);
    }
    if (routed.route === 'tweak' || routed.route === 'question') {
      console.log(`[bank] ${item.file}: route=${routed.route} — структура интервью не применима, OK.`);
      return;
    }

    const step = await checkInterviewStructure(item, item.protocol_expected, runId);
    if (step.type !== 'ready') throw new Error('интервью не завершилось (banks должны быть однозначными для судьи, не для человека) — см. RUNBOOK: банк рассчитан на модель, отвечающую сразу');

    const brief = buildBrief({ protocol: item.protocol_expected, initialText: item.input, step });
    setRootSpec(`bank-${item.file}`, brief.summary, brief.engineering_defaults, item.protocol_expected);
    const architectResult = await runArchitect({
      brief, workspaceDir: WORKSPACE, workspaceListing: listWorkspaceFileNames(WORKSPACE), runId, projectId: `bank-${item.file}`,
    });
    if (!architectResult.ok) throw new Error(`architect: ${architectResult.error}`);
    if (architectResult.taskIds.length < item.min_tasks) {
      throw new Error(`architect: ожидали ≥${item.min_tasks} задач, получили ${architectResult.taskIds.length}`);
    }
    const judged = await judgeArchitectPlan({ taskIds: architectResult.taskIds, runId });
    console.log(`[bank] ${item.file}: полный прогон OK — задач ${architectResult.taskIds.length}, judge score=${judged.result?.score ?? '(сбой судьи, не блокирует)'}.`);
    return;
  }

  // MOCK — быстрый смоук: только структура интервью, без architect/judge
  // (мок-архитектор — фиксированный сценарий калькулятора, не отражает
  // реальный вход банка — прогонять его здесь бессмысленно).
  await checkInterviewStructure(item, item.protocol_expected, runId);
  console.log(`[bank] ${item.file}: protocol=${item.protocol_expected} — структура интервью OK (MOCK-смоук, route не проверяется — см. комментарий вверху файла).`);
}

async function main() {
  releaseStuck();
  const bank = loadBank();
  if (!bank.length) throw new Error('evals/bank/: пусто — банк эталонных желаний обязателен (§14.2)');

  let failed = false;
  for (const item of bank) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await runOne(item);
    } catch (e) {
      failed = true;
      console.error(`[bank] FAIL "${item.file}": ${e.message}`);
    }
  }

  if (failed) {
    console.error('\n[bank] ИТОГ: провал (см. выше).');
    process.exit(1);
  }
  console.log(`\n[bank] ИТОГ: все ${bank.length} сценария(ев) банка зелёные.`);
}

main().catch((e) => { console.error('[bank] FAIL', e); process.exit(1); });

// evals/budget.js — DoD Фазы 2: «бюджет-стоп срабатывает на игрушечном
// лимите 0.01» (DEV_GUIDE §4). Требует MOCK=1 (см. package.json: запускается
// с --env-file=.env.mock, как npm run mock), чтобы не тратить реальные
// вызовы моделей — стоимость мок-вызова синтетическая (config.MOCK_CALL_COST_USD).
import fs from 'node:fs';
import { JOURNAL_DB_PATH, WORKSPACE, MOCK, MOCK_CALL_COST_USD } from '../core/config.js';
import { addTask, getTask, releaseStuck } from '../core/journal.js';
import { runCoordinatorLoop } from '../core/coordinator.js';

async function main() {
  if (!MOCK) {
    console.error('[budget] MOCK !== true — запусти: node --env-file=.env --env-file=.env.mock --no-warnings evals/budget.js');
    process.exit(1);
  }

  for (const suffix of ['', '-wal', '-shm']) {
    const p = JOURNAL_DB_PATH + suffix;
    if (fs.existsSync(p)) fs.rmSync(p);
  }
  if (fs.existsSync(WORKSPACE)) fs.rmSync(WORKSPACE, { recursive: true, force: true });
  releaseStuck();

  // budget_usd == ровно одному мок-вызову: после первой попытки spent_usd
  // достигает лимита, вторая попытка должна быть остановлена ДО начала (§13:
  // «проверка ДО следующего вызова»).
  const id = addTask({
    title: 'budget-stop probe',
    spec: 'Специально невыполнимая задача — важен не результат, а факт остановки по бюджету.',
    criteria: JSON.stringify({ cmd: 'node -e "process.exit(1)"' }), // всегда FAIL, чтобы не завершиться раньше по done
    role: 'coder',
    type: 'project',
    budget_usd: MOCK_CALL_COST_USD, // 0.01 — «игрушечный лимит» из DoD
  });

  await runCoordinatorLoop({ role: 'coder', workspaceDir: WORKSPACE });

  const task = getTask(id);
  console.log(`[budget] статус=${task.status} attempts=${task.attempts} spent_usd=${task.spent_usd} budget_usd=${task.budget_usd}`);
  console.log(`[budget] feedback: ${task.feedback}`);

  const ok = task.status === 'blocked_needs_human'
    && task.attempts === 1
    && /budget_usd/.test(task.feedback || '');

  if (!ok) {
    console.error('[budget] FAIL — ожидали blocked_needs_human после ровно 1 попытки с feedback про budget_usd.');
    process.exit(1);
  }
  console.log('[budget] OK — бюджет-стоп сработал ДО второй попытки, дальнейшие вызовы не потрачены.');
}

main().catch((e) => { console.error('[budget] FAIL', e); process.exit(1); });

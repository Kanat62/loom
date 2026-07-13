// coordinator.js — детерминированный код БЕЗ LLM (§2, §7 ТЗ v4): захват →
// исполнение → вердикт. Лестница попыток задачи (§7): 1) claimNext → coder →
// tester; провал → назад в pending (следующая попытка теми же ролями);
// MAX_ATTEMPTS исчерпан → blocked_needs_human. Фаза 1: без эскалации тиров
// внутри лестницы (эскалация тиров живёт в цепочках gateway/ROLES) — просто
// attempts (DEV_GUIDE §3).
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import {
  claimNext, setStatus, addSpent, isOverBudget, releaseStuck, newRunId,
  logEvent, listEvents, getTask,
} from './journal.js';
import { runCoder } from './agents/coder.js';
import { runTester } from './agents/tester.js';
import { WORKSPACE, MAX_ATTEMPTS } from './config.js';

function git(args, cwd) {
  try {
    execFileSync('git', args, { cwd, stdio: 'pipe' });
    return true;
  } catch {
    return false; // "nothing to commit" и подобные — не аварийная ситуация
  }
}

/**
 * workspace/ лежит внутри репозитория LOOM, у которого package.json объявляет
 * "type":"module" — Node ищет ближайший package.json вверх по дереву и БЕЗ
 * своего package.json трактовал бы код продукта клиента как ESM, что ломает
 * `module.exports` в обычном CommonJS-коде (найдено при первом реальном
 * прогоне сценария калькулятора). Нейтральный package.json без поля "type"
 * возвращает Node к дефолту CommonJS для продукта — LOOM не диктует продукту
 * модульную систему.
 */
function ensureWorkspacePackageJson(workspaceDir) {
  const p = path.join(workspaceDir, 'package.json');
  if (!fs.existsSync(p)) {
    fs.writeFileSync(p, JSON.stringify({ name: 'loom-product', private: true }, null, 2) + '\n', 'utf8');
  }
}

function ensureWorkspaceGit(workspaceDir) {
  fs.mkdirSync(workspaceDir, { recursive: true });
  ensureWorkspacePackageJson(workspaceDir);
  if (!fs.existsSync(path.join(workspaceDir, '.git'))) {
    git(['init', '-q'], workspaceDir);
    git(['config', 'user.email', 'loom@local'], workspaceDir);
    git(['config', 'user.name', 'LOOM coder'], workspaceDir);
  }
}

/**
 * Auto-commit safety net (шрам 4, §7): в варианте А кодер вообще не вызывает
 * git сам (нет инструментов) — харнесс коммитит принудительно и безусловно
 * после каждого хода, так что «забыть закоммитить» структурно невозможно.
 */
function autoCommit(workspaceDir, message) {
  git(['add', '-A'], workspaceDir);
  git(['commit', '-q', '-m', message], workspaceDir);
}

function sumRunCost(runId, taskId) {
  return listEvents({ run_id: runId, task_id: taskId, type: 'usage' })
    .reduce((sum, e) => sum + (e.cost_usd || 0), 0);
}

function handleAttemptFailure(task, runId, report) {
  const fresh = getTask(task.id);
  if (fresh.attempts >= MAX_ATTEMPTS) {
    setStatus(task.id, 'blocked_needs_human', { feedback: report });
    logEvent({
      run_id: runId, task_id: task.id, type: 'status', agent: 'coordinator',
      payload: { event: 'max_attempts_reached', attempts: fresh.attempts },
    });
    return { task: getTask(task.id), verdict: 'blocked_needs_human', reason: 'max_attempts' };
  }
  setStatus(task.id, 'pending', { feedback: report });
  return { task: getTask(task.id), verdict: 'retry' };
}

/** Захват и исполнение ОДНОЙ задачи роли role. Возвращает вердикт либо null, если задач нет. */
export async function processOneTask(role = 'coder', workspaceDir = WORKSPACE) {
  const task = claimNext(role, `coordinator-${process.pid}`);
  if (!task) return null;

  const runId = newRunId();
  ensureWorkspaceGit(workspaceDir);

  logEvent({
    run_id: runId, task_id: task.id, type: 'status', agent: 'coordinator',
    payload: { event: 'claimed', attempt: task.attempts, role },
  });

  if (isOverBudget(task.id)) {
    setStatus(task.id, 'blocked_needs_human', { feedback: 'FAIL: budget_usd задачи исчерпан до начала попытки' });
    return { task: getTask(task.id), verdict: 'blocked_needs_human', reason: 'budget' };
  }

  const coderResult = await runCoder({ task, workspaceDir, runId });
  addSpent(task.id, sumRunCost(runId, task.id));

  if (coderResult.type === 'question') {
    setStatus(task.id, 'blocked_needs_human', { question: coderResult.question });
    return { task: getTask(task.id), verdict: 'blocked_needs_human', reason: 'question' };
  }
  if (coderResult.type === 'error') {
    return handleAttemptFailure(task, runId, `FAIL(coder): ${coderResult.error}`);
  }

  autoCommit(workspaceDir, `loom: coder attempt ${task.attempts} on ${task.id} (${coderResult.written.length} файлов)`);

  const testResult = await runTester({ task, workspaceDir });
  logEvent({
    run_id: runId, task_id: task.id, type: 'test_result', agent: 'tester',
    payload: { pass: testResult.pass, report: testResult.report },
  });

  if (testResult.pass) {
    setStatus(task.id, 'done', { feedback: testResult.report });
    autoCommit(workspaceDir, `loom: done ${task.id}`);
    return { task: getTask(task.id), verdict: 'done' };
  }

  return handleAttemptFailure(task, runId, testResult.report);
}

/**
 * Цикл координатора: releaseStuck() на КАЖДОМ входе (шрам 25 — задачи
 * навечно в claimed после смерти процесса), затем обработка задач роли role
 * до опустошения очереди или maxIterations.
 */
export async function runCoordinatorLoop({ role = 'coder', workspaceDir = WORKSPACE, maxIterations = Infinity } = {}) {
  releaseStuck();
  const results = [];
  let iterations = 0;
  for (;;) {
    if (iterations >= maxIterations) break;
    const result = await processOneTask(role, workspaceDir);
    if (!result) break;
    results.push(result);
    iterations++;
  }
  return results;
}

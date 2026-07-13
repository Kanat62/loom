// coordinator.js — детерминированный код БЕЗ LLM (§2, §7 ТЗ v4): захват →
// исполнение → вердикт. Лестница попыток задачи (§7): 1) claimNext → coder →
// tester; провал → назад в pending (следующая попытка теми же ролями);
// MAX_ATTEMPTS исчерпан → blocked_needs_human. Без ручной эскалации тиров
// внутри лестницы (эскалация тиров живёт в цепочках gateway/ROLES) — просто
// attempts (DEV_GUIDE §3). Бюджет (§13) проверяется ДО каждой попытки —
// attempts инкрементится ПОСЛЕ этой проверки, не при захвате (Фаза 2).
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import {
  claimNext, setStatus, addSpent, isOverBudget, releaseStuck, newRunId,
  logEvent, listEvents, getTask, incrementAttempts,
} from './journal.js';
import { runCoder, clearEyesState } from './agents/coder.js';
import { runTester } from './agents/tester.js';
import { runSkillWriter } from './agents/skill.js';
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
    clearEyesState(task.id);
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
    payload: { event: 'claimed', attemptsSoFar: task.attempts, role },
  });

  // Бюджет проверяется ДО следующего вызова (§13) — захват сам по себе ещё
  // не тратит деньги, поэтому attempts инкрементится только ПОСЛЕ этой
  // проверки (incrementAttempts), а не в claimNext.
  if (isOverBudget(task.id)) {
    setStatus(task.id, 'blocked_needs_human', { feedback: 'FAIL: budget_usd задачи исчерпан до начала попытки' });
    clearEyesState(task.id);
    return { task: getTask(task.id), verdict: 'blocked_needs_human', reason: 'budget' };
  }

  incrementAttempts(task.id);
  const task2 = getTask(task.id);

  // Регрессия (§8.9, шрам 31): ТОЛЬКО повтор существующих критериев —
  // кодер не вызывается, писать нечего, весь смысл в tester-проходе.
  if (task2.type !== 'regression') {
    const coderResult = await runCoder({ task: task2, workspaceDir, runId });
    addSpent(task.id, sumRunCost(runId, task.id));

    if (coderResult.type === 'question') {
      setStatus(task.id, 'blocked_needs_human', { question: coderResult.question });
      clearEyesState(task.id);
      return { task: getTask(task.id), verdict: 'blocked_needs_human', reason: 'question' };
    }
    if (coderResult.type === 'error') {
      return handleAttemptFailure(task, runId, `FAIL(coder): ${coderResult.error}`);
    }
    autoCommit(workspaceDir, `loom: coder attempt ${task2.attempts} on ${task.id} (${coderResult.written.length} файлов)`);
  }

  const testResult = await runTester({ task: task2, workspaceDir });
  logEvent({
    run_id: runId, task_id: task.id, type: 'test_result', agent: 'tester',
    payload: { pass: testResult.pass, report: testResult.report },
  });

  if (testResult.pass) {
    setStatus(task.id, 'done', { feedback: testResult.report });
    autoCommit(workspaceDir, `loom: done ${task.id}`);
    clearEyesState(task.id);
    await writeSkillSafely(task.id, runId);
    return { task: getTask(task.id), verdict: 'done' };
  }

  return handleAttemptFailure(task, runId, testResult.report);
}

/** skill_writer — механически после done (§4); сбой этой роли не должен ронять координатор. */
async function writeSkillSafely(taskId, runId) {
  try {
    await runSkillWriter({ task: getTask(taskId), runId });
  } catch (e) {
    logEvent({
      run_id: runId, task_id: taskId, type: 'status', agent: 'coordinator',
      payload: { event: 'skill_writer_failed', error: e.message },
    });
  }
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

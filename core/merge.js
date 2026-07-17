// core/merge.js — Фаза 6 (§16 ТЗ v4, П§5 DEV_GUIDE part2): sequential merge
// queue + LLM-reconciler для конфликтов. Один вызов chat('cheap', …,
// {json:true}) на конфликт — не кодер, генерация нового кода запрещена
// (§16), только выбор ours/theirs по каждому конфликтному файлу.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { callAgent } from './engine.js';
import { buildSpawnArgs } from './spawnUtil.js';
import {
  mergeWorktree, readFileAtRef, resolveConflictFile, commitMerge, abortMerge,
  rebaseWorktreeOntoMain, currentBranch,
} from './worktrees.js';
import {
  setStatus, listTasks, listEvents, logEvent,
} from './journal.js';
import { progress } from './io.js';
import { MAX_ATTEMPTS, AUTO_MERGES_PER_DAY } from './config.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Maintenance-минимум (§18, П§7 п.3): сколько мёржей уже случилось за последние 24ч. */
function mergesInLast24h() {
  const since = Date.now() - DAY_MS;
  return listEvents({ type: 'merged' }).filter((e) => e.created_at >= since).length;
}

/**
 * Ищет ЛОКАЛЬНО установленный tsc — НИКОГДА через `npx` без предустановленного
 * пакета (npx молча тянет пакет из сети при отсутствии — недопустимо, тот же
 * принцип, что optionalDependencies better-sqlite3/playwright: опциональная
 * возможность, не обязательная сетевая зависимость на каждый merge).
 */
function resolveTscBin(worktreePath) {
  const binName = process.platform === 'win32' ? 'tsc.cmd' : 'tsc';
  const candidates = [
    path.join(worktreePath, 'node_modules', '.bin', binName),
    path.join(worktreePath, '..', '..', 'node_modules', '.bin', binName), // корень LOOM, если tsc там
  ];
  return candidates.find((c) => fs.existsSync(c)) || null;
}

/**
 * tsc level-0 (§15 ТЗ v4 declares_interface, П§5 п.5): если в worktree есть
 * tsconfig/jsconfig — `tsc --noEmit` ВОРОТА перед merge, красный не сливается.
 * typescript недоступен локально (DECISIONS: optionalDependency, как
 * better-sqlite3/playwright) → ворота технически неприменимы, НЕ блокируем
 * merge недоступностью инструмента (graceful degradation, тот же паттерн,
 * что Docker для checkRunner и Playwright для live_in).
 */
export function tscGate(worktreePath) {
  const hasConfig = fs.existsSync(path.join(worktreePath, 'tsconfig.json'))
    || fs.existsSync(path.join(worktreePath, 'jsconfig.json'));
  if (!hasConfig) return { ok: true };
  const tscBin = resolveTscBin(worktreePath);
  if (!tscBin) return { ok: true, skipped: true };
  const isWin = process.platform === 'win32';
  try {
    execFileSync(tscBin, buildSpawnArgs(['--noEmit']), {
      cwd: worktreePath, stdio: 'pipe', shell: isWin, windowsHide: isWin, timeout: 60_000,
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, report: (e.stdout ? e.stdout.toString() : e.message).slice(0, 1000) };
  }
}

/**
 * reconcile({conflictFiles, workspaceDir, branch, oursTask, theirsTask, runId})
 * → {ok:true, choices:{path:'ours'|'theirs'}} | {ok:false, error}.
 * ours = HEAD (main, ДО коммита слияния — git merge --no-commit его не двигает),
 * theirs = ветка воркера.
 */
export async function reconcile({
  conflictFiles, workspaceDir, branch, oursTask, theirsTask, runId,
}) {
  const parts = [
    `## Конфликт слияния — ${conflictFiles.length} файл(ов)`,
    `### Ветка A (ours, main) — задача\n"${oursTask?.title || '(неизвестна)'}"\n${oursTask?.spec || ''}`,
    `### Ветка B (theirs, ${branch}) — задача\n"${theirsTask?.title || '(неизвестна)'}"\n${theirsTask?.spec || ''}`,
  ];
  for (const f of conflictFiles) {
    const ours = readFileAtRef(workspaceDir, 'HEAD', f);
    const theirs = readFileAtRef(workspaceDir, branch, f);
    parts.push([
      `### Файл: ${f}`,
      `--- ours (main) ---\n${ours === null ? '(файла нет на main)' : ours}`,
      `--- theirs (${branch}) ---\n${theirs === null ? '(файла нет на ветке)' : theirs}`,
    ].join('\n\n'));
  }

  let result;
  try {
    result = await callAgent({
      role: 'cheap', promptFile: 'reconciler.md', userText: parts.join('\n\n'), json: true, runId, agent: 'reconciler',
    });
  } catch (e) {
    return { ok: false, error: `reconciler: сбой шлюза (${e.message})` };
  }

  if (!result || !result.files || typeof result.files !== 'object') {
    return { ok: false, error: 'reconciler: ответ без поля files' };
  }
  const choices = {};
  for (const f of conflictFiles) {
    const c = result.files[f];
    if (c === 'ours' || c === 'theirs') choices[f] = c;
  }
  if (Object.keys(choices).length !== conflictFiles.length) {
    return { ok: false, error: `reconciler: неполный ответ — покрыто ${Object.keys(choices).length} из ${conflictFiles.length} файлов` };
  }
  return { ok: true, choices };
}

/**
 * mergeOneTask(task, workspaceDir, {runId, worktreesDir}) → 'merged' |
 * 'blocked_needs_human' | 'retry'. Зелёный worktree воркера → merge_pending
 * → эта функция сливает В main (§16 mergeQueue: последовательно, в главном
 * цикле — вызывающий гарантирует, что это не выполняется параллельно с
 * другим вызовом).
 */
async function mergeOneTask(task, workspaceDir, { runId, worktreesDir } = {}) {
  const workerId = (task.claimed_by || '').replace(/^w/, '') || '?';
  const worktreePath = path.join(worktreesDir, `w${workerId}`);

  const gate = tscGate(worktreePath);
  if (!gate.ok) {
    const report = `FAIL(tsc --noEmit — declares_interface, §15): ${gate.report}`.slice(0, 1000);
    if (task.attempts >= MAX_ATTEMPTS) {
      setStatus(task.id, 'blocked_needs_human', { feedback: report });
      progress(`[merge] "${task.title}" → blocked_needs_human (tsc-ворота красные, лимит попыток)`);
      return 'blocked_needs_human';
    }
    setStatus(task.id, 'pending', { feedback: report });
    progress(`[merge] "${task.title}" → retry (tsc-ворота красные, merge отложен)`);
    return 'retry';
  }

  const message = `loom: merged ${task.id} (${task.title.slice(0, 60)})`;
  const result = mergeWorktree(workspaceDir, workerId, message);

  if (result.ok) {
    setStatus(task.id, 'merged', { feedback: task.feedback });
    logEvent({
      run_id: runId, task_id: task.id, type: 'merged', agent: 'coordinator',
      payload: { worker: task.claimed_by, conflict: false },
    });
    progress(`[merge] "${task.title}" → merged (без конфликтов)`);
    return 'merged';
  }

  if (!result.conflictFiles || !result.conflictFiles.length) {
    // Не конфликт, а техническая ошибка мёржа — не выдумываем reconcile,
    // честно блокируем на человека с текстом git.
    setStatus(task.id, 'blocked_needs_human', { feedback: `FAIL(merge): ${result.error || 'неизвестная ошибка слияния'}` });
    progress(`[merge] "${task.title}" → blocked_needs_human (ошибка слияния, не конфликт)`);
    return 'blocked_needs_human';
  }

  progress(`[merge] "${task.title}" → конфликт в ${result.conflictFiles.length} файл(ах), зову reconciler...`);
  // Задача-конкурент (theirs) — обычно последняя done/merge_pending, которая
  // трогала те же файлы; для контекста reconciler'у достаточно ЭТОЙ задачи
  // (oursTask неизвестна конкретно — main мог накопить несколько мёржей;
  // берём саму задачу, чья ветка сливается, как "theirs", а "ours" описываем
  // текстом main без привязки к одной конкретной прошлой задаче).
  const rec = await reconcile({
    conflictFiles: result.conflictFiles,
    workspaceDir,
    branch: result.branch,
    oursTask: { title: 'main (накопленное состояние продукта)', spec: '' },
    theirsTask: task,
    runId,
  });

  if (!rec.ok) {
    abortMerge(workspaceDir);
    setStatus(task.id, 'blocked_needs_human', { feedback: `FAIL(merge): конфликт не разрешён — ${rec.error}` });
    logEvent({
      run_id: runId, task_id: task.id, type: 'merged', agent: 'coordinator',
      payload: { worker: task.claimed_by, conflict: true, resolved: false, error: rec.error },
    });
    progress(`[merge] "${task.title}" → blocked_needs_human (reconciler не справился: ${rec.error})`);
    return 'blocked_needs_human';
  }

  for (const [file, choice] of Object.entries(rec.choices)) {
    resolveConflictFile(workspaceDir, file, choice);
  }
  commitMerge(workspaceDir, message);
  setStatus(task.id, 'merged', { feedback: task.feedback });
  logEvent({
    run_id: runId, task_id: task.id, type: 'merged', agent: 'coordinator',
    payload: { worker: task.claimed_by, conflict: true, resolved: true, choices: rec.choices },
  });
  progress(`[merge] "${task.title}" → merged (конфликт разрешён reconciler'ом: ${JSON.stringify(rec.choices)})`);
  return 'merged';
}

/**
 * drainMergeQueue({role, workspaceDir, worktreesDir, workerIds, runId, projectId}) →
 * число обработанных задач. Последовательно, ОДНА за раз (§16 п.4) — не
 * Promise.all, не параллельно самому себе: два одновременных git-мёржа в
 * ОДИН workspace физически несовместимы (один .git индекс). projectId
 * (§29.2 п.5) — очередь мёржей сжата до своего проекта, симметрично claimNext.
 */
export async function drainMergeQueue({
  role = 'coder', workspaceDir, worktreesDir, workerIds = [], runId, maxPerDay = AUTO_MERGES_PER_DAY, projectId,
} = {}) {
  let processed = 0;
  for (;;) {
    const pending = listTasks({ status: 'merge_pending', role, project_id: projectId }).sort((a, b) => a.created_at - b.created_at);
    const task = pending[0];
    if (!task) break;

    // Maintenance-минимум (§18): лимит достигнут → оставшиеся merge_pending
    // ЖДУТ (не failed, не blocked_needs_human) — следующий вызов
    // drainMergeQueue (следующий цикл координатора, обычно уже завтра)
    // подберёт их сам, как только окно откроется снова.
    if (maxPerDay > 0 && mergesInLast24h() >= maxPerDay) {
      progress(`[merge] rate-limit: ${maxPerDay} автомёржей/сутки исчерпаны — ${pending.length} задач(и) в merge_pending ждут следующего окна (§18 maintenance-минимум).`);
      break;
    }

    // eslint-disable-next-line no-await-in-loop
    const verdict = await mergeOneTask(task, workspaceDir, { runId, worktreesDir });
    processed++;

    if (verdict === 'merged') {
      const mainBranch = currentBranch(workspaceDir);
      for (const workerId of workerIds) {
        const wtPath = `${worktreesDir}/w${workerId}`;
        // eslint-disable-next-line no-await-in-loop
        rebaseWorktreeOntoMain(wtPath, mainBranch);
      }
    }
  }
  return processed;
}

/** Fan-in политика (§16 п.7): failed, блокирующий недостигнутые done-ветки через task_deps → весь проект стоит. */
export function hasBlockingFailure(role = 'coder', projectId) {
  const failedIds = new Set(
    listTasks({ status: 'blocked_needs_human', role, project_id: projectId }).map((t) => t.id),
  );
  if (!failedIds.size) return false;
  const pending = listTasks({ status: 'pending', role, project_id: projectId });
  for (const t of pending) {
    if (t.blocked_by_task_id && failedIds.has(t.blocked_by_task_id)) return true;
  }
  return false;
}

export { mergeOneTask };

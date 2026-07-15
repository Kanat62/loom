// core/worktrees.js — Фаза 6 (§16 ТЗ v4, П§5 DEV_GUIDE part2): git worktrees
// продукта, по одному на воркера. Кодер и тестер воркера работают в своём
// worktree — существующие функции (runCoder/runTester) уже принимают
// workspaceDir параметром, сигнатуры менять не пришлось.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

function git(args, cwd) {
  return execFileSync('git', args, { cwd, stdio: 'pipe' }).toString();
}

function gitQuiet(args, cwd) {
  try {
    execFileSync('git', args, { cwd, stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

export function branchName(workerId) {
  return `loom/w${workerId}`;
}

/**
 * ensureWorktree(workspaceDir, worktreesDir, workerId) → путь worktree.
 * `git worktree add <path> -b loom/w<i>` от текущего main; если ветка уже
 * существует (возобновлённая сессия — воркер убит между заходами) —
 * повторно используем её без -b, вместо падения.
 */
export function ensureWorktree(workspaceDir, worktreesDir, workerId) {
  const branch = branchName(workerId);
  const wtPath = path.join(worktreesDir, `w${workerId}`);
  if (fs.existsSync(wtPath)) return wtPath;

  fs.mkdirSync(worktreesDir, { recursive: true });
  if (gitQuiet(['worktree', 'add', wtPath, '-b', branch], workspaceDir)) return wtPath;
  // Ветка уже существует (шрам-класс «возобновлённая сессия») — переиспользуем.
  if (gitQuiet(['worktree', 'add', wtPath, branch], workspaceDir)) return wtPath;
  throw new Error(`worktrees: не удалось создать worktree для ветки ${branch}`);
}

/** Список конфликтных файлов текущего незакоммиченного merge (diff --diff-filter=U). */
function listConflictFiles(workspaceDir) {
  try {
    const out = git(['diff', '--name-only', '--diff-filter=U'], workspaceDir);
    return out.split('\n').map((s) => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * mergeWorktree(workspaceDir, workerId, message) → {ok:true} |
 * {ok:false, conflictFiles, branch} | {ok:false, error}.
 * `--no-ff --no-commit` ВСЕГДА (даже чистое слияние не коммитится сразу) —
 * так оба пути (чисто/конфликт) проходят через один и тот же явный commit-шаг,
 * не два разных.
 */
export function mergeWorktree(workspaceDir, workerId, message) {
  const branch = branchName(workerId);
  try {
    execFileSync('git', ['merge', '--no-ff', '--no-commit', branch], { cwd: workspaceDir, stdio: 'pipe' });
    execFileSync('git', ['commit', '-q', '-m', message], { cwd: workspaceDir, stdio: 'pipe' });
    return { ok: true };
  } catch (e) {
    const conflictFiles = listConflictFiles(workspaceDir);
    if (!conflictFiles.length) {
      // Провал НЕ из-за конфликта (например, нечего сливать) — откатываем
      // на всякий случай и честно возвращаем ошибку, не притворяемся конфликтом.
      gitQuiet(['merge', '--abort'], workspaceDir);
      return { ok: false, error: (e.stderr ? e.stderr.toString() : e.message).slice(0, 500) };
    }
    return { ok: false, conflictFiles, branch };
  }
}

/** Содержимое файла на конкретной ссылке (ветке/HEAD) — для reconciler'а: ours=HEAD, theirs=branch. */
export function readFileAtRef(workspaceDir, ref, relPath) {
  try {
    return git(['show', `${ref}:${relPath}`], workspaceDir);
  } catch {
    return null; // файла нет на этой ссылке (асимметричное добавление/удаление)
  }
}

/** Разрешает ОДИН конфликтный файл выбором ours/theirs (§16: не новый код — выбор существующего). */
export function resolveConflictFile(workspaceDir, relPath, choice) {
  execFileSync('git', ['checkout', `--${choice}`, '--', relPath], { cwd: workspaceDir, stdio: 'pipe' });
  execFileSync('git', ['add', relPath], { cwd: workspaceDir, stdio: 'pipe' });
}

export function commitMerge(workspaceDir, message) {
  execFileSync('git', ['commit', '-q', '-m', message], { cwd: workspaceDir, stdio: 'pipe' });
}

/** Не решилось / ответ кривой (§26.5-класс стоп-фактора) — worktree сохраняется человеку, main остаётся чистым. */
export function abortMerge(workspaceDir) {
  gitQuiet(['merge', '--abort'], workspaceDir);
}

/**
 * rebaseWorktreeOntoMain(worktreePath) — после мёржа другого воркера в main,
 * подтягивает свежий main в ещё живые worktree, чтобы следующий ход кодера
 * видел актуальное дерево. Конфликт при ребейзе (реже, чем при мёрже —
 * weave уже не даёт пересекающихся touches_files в ОДНОМ раунде, но main мог
 * уйти вперёд за это время) — честно абортим и оставляем воркера на старой
 * базе до следующей попытки, не пытаемся разрешать автоматически (это не
 * тот же контракт, что merge-reconciler, — сорванный ребейз не блокирует
 * задачу воркера прямо сейчас, просто откладывает синхронизацию).
 */
export function rebaseWorktreeOntoMain(worktreePath, mainBranch = 'main') {
  if (gitQuiet(['rebase', mainBranch], worktreePath)) return { ok: true };
  gitQuiet(['rebase', '--abort'], worktreePath);
  return { ok: false };
}

/** Явная главная ветка репозитория (main|master) — для rebase-цели. */
export function currentBranch(workspaceDir) {
  try {
    return git(['rev-parse', '--abbrev-ref', 'HEAD'], workspaceDir).trim();
  } catch {
    return 'main';
  }
}

/** Удаляет worktree (не используется в обычном цикле — для ручной уборки после сессии параллельности). */
export function removeWorktree(workspaceDir, worktreesDir, workerId) {
  const wtPath = path.join(worktreesDir, `w${workerId}`);
  gitQuiet(['worktree', 'remove', '--force', wtPath], workspaceDir);
  gitQuiet(['branch', '-D', branchName(workerId)], workspaceDir);
}

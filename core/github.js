// core/github.js — Фаза 5 (§22 ТЗ v4, П§3 DEV_GUIDE part2): публикация
// продукта в приватный GitHub-репозиторий. Только `gh` CLI (§23: без
// GitHub App). Включение явное — GITHUB_PUSH=1 в .env, по умолчанию
// выключено (сдача не должна требовать сети). Секреты: `gh` держит токен
// в своей собственной связке (`gh auth login`) — в .env добавлять нечего,
// в документах токенов не бывает (шрам 33). История по задачам уже
// обеспечена autoCommit (`loom: done <task.id>`, coordinator.js) — эта
// фаза её только публикует, сообщения не переписывает.
import { execFileSync } from 'node:child_process';

function run(args, cwd) {
  return execFileSync('gh', args, { cwd, stdio: 'pipe' }).toString();
}

let _available = null;

/** Бинарь gh установлен И залогинен (`gh auth status`). Кэшируется на процесс. */
export function ghAvailable() {
  if (_available !== null) return _available;
  try {
    execFileSync('gh', ['--version'], { stdio: 'ignore' });
    execFileSync('gh', ['auth', 'status'], { stdio: 'ignore' });
    _available = true;
  } catch {
    _available = false;
  }
  return _available;
}

/**
 * Слаг из произвольного текста (root_spec.summary) для имени репозитория —
 * та же дисциплина санитизации, что у ввода сеанса (шрам 32: терминальный
 * мусор/произвольный текст не должен ломать внешние команды).
 */
export function slugify(text, fallback = 'loom-product') {
  const s = (text || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return s || fallback;
}

/** git remote get-url — локальная операция, без сети, безопасна в dry-run. */
function hasRemote(workspaceDir, remote = 'origin') {
  try {
    execFileSync('git', ['remote', 'get-url', remote], { cwd: workspaceDir, stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/**
 * ensureProductRepo(workspaceDir, name, {dryRun}) → {ok, url?, error?} |
 * {ok:true, dryRun:true, dryRunCmd}. Нет remote → `gh repo create <name>
 * --private --source <workspaceDir> --push` (создаёт И пушит одной
 * командой; owner не указываем — gh резолвит текущий аутентифицированный
 * аккаунт сам, без отдельного сетевого запроса на выяснение owner).
 * Remote есть → обычный `git push`. dryRun (MOCK, §24) — команда строится
 * и возвращается строкой, НИ gh, НИ сеть не трогаются вообще (ghAvailable()
 * тоже не вызывается — сам `gh auth status` уже сетевой запрос).
 */
export function ensureProductRepo(workspaceDir, name, { dryRun = false } = {}) {
  const remoteExists = hasRemote(workspaceDir);

  if (dryRun) {
    const dryRunCmd = remoteExists
      ? 'git push origin HEAD'
      : `gh repo create ${name} --private --source ${workspaceDir} --push`;
    return { ok: true, dryRun: true, dryRunCmd };
  }

  if (!ghAvailable()) {
    return { ok: false, error: 'gh CLI недоступен или не залогинен (gh auth status)' };
  }

  try {
    if (remoteExists) {
      execFileSync('git', ['push', 'origin', 'HEAD'], { cwd: workspaceDir, stdio: 'pipe' });
      const url = run(['repo', 'view', '--json', 'url', '-q', '.url'], workspaceDir).trim();
      return { ok: true, url };
    }
    const out = run(['repo', 'create', name, '--private', '--source', workspaceDir, '--push'], workspaceDir);
    const urlMatch = out.match(/https:\/\/\S+/);
    return { ok: true, url: urlMatch ? urlMatch[0] : undefined };
  } catch (e) {
    return { ok: false, error: (e.stderr ? e.stderr.toString() : e.message).slice(0, 500) };
  }
}

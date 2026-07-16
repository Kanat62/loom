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
  logEvent, listEvents, listTasks, getTask, incrementAttempts, repairCriteria,
} from './journal.js';
import { runCoder, clearEyesState } from '../agents/coder.js';
import { runTester } from '../agents/tester.js';
import { runSkillWriter } from '../agents/skill.js';
import { reviewCriterion } from '../agents/architect.js';
import { isDockerAvailable, buildWorkspaceImage } from './docker.js';
import { WORKSPACE, TOOLS_DIR, WORKTREES_DIR, MAX_ATTEMPTS, ROOT } from './config.js';
import { progress } from './io.js';
import { registerTool, runTool, listTools } from './tools.js';
import { ensureWorktree } from './worktrees.js';
import { drainMergeQueue } from './merge.js';

function git(args, cwd) {
  try {
    execFileSync('git', args, { cwd, stdio: 'pipe' });
    return true;
  } catch {
    return false; // "nothing to commit" и подобные — не аварийная ситуация
  }
}

// gitGuard (шрам 5, §12.4): физическая защита репозитория самого LOOM от
// stray-веток агентов. Все git-операции агентского пути и так строго
// scoped к workspaceDir (см. git()/autoCommit() выше — cwd передаётся явно
// на каждый вызов, никогда не наследуется от process.cwd()); это —
// дополнительный pre-flight, который громко останавливает координатор, если
// репозиторий LOOM САМ неожиданно оказался не на основной ветке.
const LOOM_MAIN_BRANCHES = new Set(['main', 'master']);

export function gitGuard() {
  try {
    const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: ROOT, stdio: 'pipe' })
      .toString().trim();
    if (!LOOM_MAIN_BRANCHES.has(branch)) {
      return { ok: false, branch, message: `gitGuard: репозиторий LOOM на неожиданной ветке "${branch}" (ожидали main/master) — возможна stray-ветка агента (шрам 5)` };
    }
    return { ok: true, branch };
  } catch {
    // Не git-репозиторий или git недоступен (например, тесты во временном
    // каталоге) — не блокируем, просто нечего защищать.
    return { ok: true, branch: null, skipped: true };
  }
}

let dockerSandboxState = { ready: false, checkedForDir: null };

/**
 * Собирает (или переиспользует кэш) образ комнаты кодера, если Docker-демон
 * доступен (§12 ТЗ, Фаза 4). Пересборка — раз на вход в runCoordinatorLoop
 * для данного workspace (упрощение: architect может добавить пакеты
 * ПОСРЕДИ дерева — тогда статус «нужен пакет» потребует ручного /resume,
 * полноценный авто-триггер на изменение package.json — за рамками Фазы 4).
 */
function ensureDockerSandbox(workspaceDir) {
  if (dockerSandboxState.checkedForDir === workspaceDir) return dockerSandboxState.ready;
  if (!isDockerAvailable()) {
    dockerSandboxState = { ready: false, checkedForDir: workspaceDir };
    return false;
  }
  const result = buildWorkspaceImage(workspaceDir);
  dockerSandboxState = { ready: result.ok, checkedForDir: workspaceDir };
  if (!result.ok) {
    console.error(`[coordinator] Docker доступен, но сборка образа не удалась — исполнение локально: ${result.error}`);
  } else {
    console.log('[coordinator] Docker-песочница активна для этого workspace (--network none, лимиты).');
  }
  return dockerSandboxState.ready;
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
 * Реальный баг, найден MOCK-сценарием параллельности: `git merge --no-ff`
 * в ветку БЕЗ единого коммита («empty head») технически падает — не
 * конфликт, а git отказывается делать non-fast-forward merge в пустую
 * историю. Однопоточный путь этого никогда не задевал (там нет merge --no-ff
 * вообще, только autoCommit), но параллельная фаза создаёт worktrees и
 * мёржит В main ДО того, как кодер вообще успел что-то закоммитить — нужен
 * явный пустой стартовый коммит, чтобы у main было ОТ ЧЕГО ветвиться и КУДА
 * мёржить.
 */
function ensureInitialCommit(workspaceDir) {
  try {
    execFileSync('git', ['rev-parse', 'HEAD'], { cwd: workspaceDir, stdio: 'pipe' });
  } catch {
    // Реальный баг, тоже найден MOCK-сценарием: --allow-empty БЕЗ git add
    // оставлял package.json (уже написанный ensureWorkspacePackageJson НА
    // ДИСК main до этого коммита) неотслеженным — worktrees ветвились БЕЗ
    // него, потом каждый воркер создавал СВОЙ package.json заново, и при
    // мёрже git отказывался перезаписать untracked-файл main'а версией из
    // ветки («would be overwritten by merge»). git add -A перед коммитом —
    // всё, что уже лежит на диске (package.json), становится частью
    // стартовой истории, worktrees наследуют его сразу.
    git(['add', '-A'], workspaceDir);
    git(['commit', '--allow-empty', '-q', '-m', 'loom: initial commit (parallel phase root)'], workspaceDir);
  }
}

/**
 * Кузница (§26.4): tools/ — СОБСТВЕННЫЙ git-репозиторий, отдельный от
 * репозитория LOOM И от workspace продукта. tools/ уже в .gitignore
 * LOOM'а (шрам 5, gitGuard спокоен — агентский код физически не попадает
 * в репозиторий машины), история версионируется здесь. Тот же
 * package.json-фикс, что у workspace (ensureWorkspacePackageJson) — без
 * поля "type", иначе Node трактовал бы run.js-скрипты как ESM из-за
 * корневого package.json LOOM (тот же баг, что нашли в Фазе 1).
 */
function ensureToolsGit() {
  fs.mkdirSync(TOOLS_DIR, { recursive: true });
  const pkgPath = path.join(TOOLS_DIR, 'package.json');
  if (!fs.existsSync(pkgPath)) {
    fs.writeFileSync(pkgPath, JSON.stringify({ name: 'loom-tools', private: true }, null, 2) + '\n', 'utf8');
  }
  if (!fs.existsSync(path.join(TOOLS_DIR, '.git'))) {
    git(['init', '-q'], TOOLS_DIR);
    git(['config', 'user.email', 'loom@local'], TOOLS_DIR);
    git(['config', 'user.name', 'LOOM coder'], TOOLS_DIR);
  }
}

/** tool.json — обязателен по контракту §26.1; отсутствие/битый JSON = брак, не регистрируем. */
function readToolManifest(toolRoot) {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(toolRoot, 'tool.json'), 'utf8'));
    if (typeof manifest.name === 'string' && manifest.name.trim() && typeof manifest.description === 'string') {
      return manifest;
    }
    return null;
  } catch {
    return null;
  }
}

/** Реестр в контекст кодера (не только архитектора) — reuse-first виден на каждой попытке сборки. */
function toolRegistryContext() {
  const tools = listTools();
  if (!tools.length) return '(пока нет ни одного инструмента)';
  return tools.map((t) => `- ${t.name} (v${t.version}): ${t.description}`).join('\n');
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

/** Сколько задач роли role ещё ждут — печатается вместе с вердиктом попытки. */
function remainingCount(role) {
  return listTasks({ status: 'pending', role }).length;
}

// Числа в отчёте тестера (координаты, счёт, тайминги) легитимно скачут
// между попытками даже при ОДНОЙ И ТОЙ ЖЕ причине провала — нормализация
// нужна, чтобы сравнивать ФОРМУ провала, а не точные значения (scar 34).
function normalizeReport(report) {
  return String(report || '').replace(/\d+/g, '#');
}

/**
 * Tree-хэши коммитов автокоммита кодера ("loom: coder attempt N on
 * <taskId> ...", autoCommit() выше) по попыткам, в хронологическом порядке.
 * Различие tree-хэшей между попытками — единственный дешёвый и честный
 * способ убедиться, что кодер РЕАЛЬНО писал разный код, а не буквально
 * прислал то же самое: без этого «критерий провалился одинаково N раз»
 * нельзя отличить от «кодер сдался и повторил старый ответ» (scar 34).
 */
function attemptTreeHashes(codeRoot, taskId) {
  try {
    const log = execFileSync('git', ['log', '--format=%H %s'], { cwd: codeRoot, stdio: 'pipe' }).toString();
    const marker = ` on ${taskId} `;
    const hashes = [];
    for (const line of log.split('\n')) {
      const sp = line.indexOf(' ');
      if (sp === -1) continue;
      if (line.slice(sp).includes(marker)) hashes.push(line.slice(0, sp));
    }
    hashes.reverse(); // git log — новые сверху, нужен хронологический порядок попыток
    return hashes.map((h) => execFileSync('git', ['rev-parse', `${h}^{tree}`], { cwd: codeRoot, stdio: 'pipe' }).toString().trim());
  } catch {
    return [];
  }
}

/**
 * Подозрение «брак критерия, не кодера» (scar 34, П§11): критерий проваливается
 * с ОДИНАКОВОЙ (после нормализации чисел) причиной на КАЖДОЙ попытке, при
 * этом код реально менялся между попытками (git tree-хэш). Рабочий, но
 * честно проваливающийся код обычно даёт РАЗНЫЕ провалы между попытками
 * (другие числа, другое условие) — если форма провала не меняется вообще,
 * а код меняется, вероятнее сломан сам тест, не решение.
 * НЕ применяется к regression (повтор ЧУЖИХ критериев, не своего) и
 * tool_run (кодер вообще не вызывается — не с чем сравнивать «код менялся»).
 * Один review на задачу максимум — если событие уже есть, не повторяем.
 */
function detectCriteriaDefect(task, codeRoot) {
  if (task.type === 'regression' || task.type === 'tool_run') return null;
  if (listEvents({ task_id: task.id, type: 'criteria_defect_suspected' }).length) return null;

  const testEvents = listEvents({ task_id: task.id, type: 'test_result' });
  if (testEvents.length < 2) return null;

  const reports = testEvents.map((e) => {
    try { return JSON.parse(e.payload)?.report || ''; } catch { return ''; }
  });
  if (new Set(reports.map(normalizeReport)).size !== 1) return null;

  const hashes = new Set(attemptTreeHashes(codeRoot, task.id));
  if (hashes.size < 2) return null;

  return { reports };
}

async function handleAttemptFailure(task, runId, report, role, codeRoot) {
  const fresh = getTask(task.id);
  if (fresh.attempts >= MAX_ATTEMPTS) {
    const defect = detectCriteriaDefect(fresh, codeRoot);
    if (defect) {
      setStatus(task.id, 'suspected_criteria_defect', { feedback: report });
      logEvent({
        run_id: runId, task_id: task.id, type: 'status', agent: 'coordinator',
        payload: { event: 'criteria_defect_suspected', attempts: fresh.attempts },
      });
      progress(`[coordinator] "${fresh.title}" — ${fresh.attempts} провала подряд с одинаковой причиной при разном коде: подозрение на брак критерия, зову архитектора на ревью`);

      let criteria;
      try { criteria = JSON.parse(fresh.criteria || '{}'); } catch { criteria = {}; }
      // eslint-disable-next-line no-await-in-loop
      const review = await reviewCriterion({
        title: fresh.title, spec: fresh.spec, cmd: criteria.cmd, expect: criteria.expect, attemptReports: defect.reports, runId,
      });

      if (review.verdict === 'criterion_defect') {
        repairCriteria(task.id, { cmd: review.cmd, expect: criteria.expect });
        logEvent({
          run_id: runId, task_id: task.id, type: 'status', agent: 'coordinator',
          payload: { event: 'criteria_repaired', reason: review.reason },
        });
        progress(`[coordinator] критерий "${fresh.title}" пересобран архитектором (${review.reason}) — задача снова pending`);
        return { task: getTask(task.id), verdict: 'retry', reason: 'criteria_repaired' };
      }

      logEvent({
        run_id: runId, task_id: task.id, type: 'status', agent: 'coordinator',
        payload: { event: 'criteria_defect_confirmed', reason: review.reason },
      });
      progress(`[coordinator] архитектор подтвердил критерий верным (${review.reason}) — блок остаётся`);
    }

    setStatus(task.id, 'blocked_needs_human', { feedback: report });
    logEvent({
      run_id: runId, task_id: task.id, type: 'status', agent: 'coordinator',
      payload: { event: 'max_attempts_reached', attempts: fresh.attempts },
    });
    clearEyesState(task.id);
    progress(`[coordinator] задача failed (blocked_needs_human), осталось ${remainingCount(role)}`);
    return { task: getTask(task.id), verdict: 'blocked_needs_human', reason: 'max_attempts' };
  }
  setStatus(task.id, 'pending', { feedback: report });
  progress(`[coordinator] задача failed (retry), осталось ${remainingCount(role)}`);
  return { task: getTask(task.id), verdict: 'retry' };
}

/**
 * Захват и исполнение ОДНОЙ задачи роли role. Возвращает вердикт либо null,
 * если задач нет. sharedRunId (опционально) — если вызывающий (talk.js)
 * ведёт один клиентский запрос через несколько задач дерева, все их events
 * пишутся под одним run_id (§14: run_id прошивает все events сквозного
 * запроса) — нужен для точного итога по токенам за запрос. Без него, как и
 * раньше, каждая попытка получает свой независимый run_id (/resume, cli.js,
 * evals — где нет единого «запроса», от которого можно унаследовать id).
 *
 * opts (Фаза 6, П§5 параллельность):
 * - claimedBy — идентификатор захвата ('w1'/'w2'/… для воркеров вместо
 *   дефолтного 'coordinator-<pid>').
 * - activeTouches/excludeTypes — прокидываются в claimNext (weave по файлам,
 *   исключение regression/tool_run из параллельного захвата).
 * - preClaimed — задача уже захвачена вызывающим (параллельная фаза сама
 *   зовёт claimNext раньше, чтобы решить, параллелится ли тип задачи, ДО
 *   выбора worktree) — тогда claimNext здесь не вызывается повторно.
 * - onSuccessStatus — статус на зелёном критерии вместо 'done' (параллельная
 *   фаза использует 'merge_pending' — воркер завершил свою часть, слияние в
 *   main происходит отдельно, последовательно, core/merge.js). НЕ применяется
 *   к type='tool'/'tool_run'/'regression' — им merge-очередь не нужна,
 *   для них 'done' всегда означает готово по-настоящему.
 */
export async function processOneTask(role = 'coder', workspaceDir = WORKSPACE, sharedRunId = null, opts = {}) {
  const task = opts.preClaimed || claimNext(role, opts.claimedBy || `coordinator-${process.pid}`, {
    activeTouches: opts.activeTouches, excludeTypes: opts.excludeTypes,
  });
  if (!task) return null;

  const runId = sharedRunId || newRunId();
  // Кузница (§26.2, П§4): type='tool' пишет в tools/<tool_name>/, НЕ в
  // workspace продукта — замок пути (isPathInsideWorkspace) действует
  // относительно ЭТОГО корня, тот же механизм, другой base (runCoder
  // принимает workspaceDir как параметр — сигнатуру менять не пришлось).
  const isTool = task.type === 'tool';
  const isToolRun = task.type === 'tool_run';
  const effectiveRoot = isTool ? path.join(TOOLS_DIR, task.tool_name || '') : workspaceDir;

  if (isTool) ensureToolsGit();
  else ensureWorkspaceGit(workspaceDir);

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
    progress(`[coordinator] задача failed (бюджет исчерпан), осталось ${remainingCount(role)}`);
    return { task: getTask(task.id), verdict: 'blocked_needs_human', reason: 'budget' };
  }

  incrementAttempts(task.id);
  const task2 = getTask(task.id);

  // Регрессия (§8.9, шрам 31) И tool_run (§26.2 «Использование») — та же
  // ветка «пропустить кодера»: писать нечего, весь смысл в исполнении
  // (tester для регрессии, runTool+tester для tool_run).
  const skipCoder = task2.type === 'regression' || isToolRun;
  progress(`[coordinator] "${task2.title}" — попытка ${task2.attempts}/${MAX_ATTEMPTS}: ${skipCoder ? `${task2.type}, пропускаю кодера` : 'кодер работает...'}`);

  let toolRunPrefix = '';

  if (isToolRun) {
    // task.spec = JSON {"tool":"name","args":[...]} (§26.2). Провал парсинга
    // — брак архитектора/researcher-харнесса, честный retry, не exception.
    let toolCall;
    try { toolCall = JSON.parse(task2.spec || '{}'); } catch { toolCall = {}; }
    if (typeof toolCall.tool !== 'string' || !toolCall.tool.trim()) {
      return handleAttemptFailure(task, runId, 'FAIL: tool_run.spec обязан быть JSON {"tool":"name","args":[...]}, поле tool отсутствует', role, effectiveRoot);
    }
    // eslint-disable-next-line no-await-in-loop
    const runResult = await runTool(toolCall.tool, Array.isArray(toolCall.args) ? toolCall.args : [], {
      cwd: workspaceDir, runId, taskId: task2.id,
    });
    progress(`[coordinator] tool_run "${toolCall.tool}" → exit=${runResult.code} (${runResult.duration_ms}мс)`);
    toolRunPrefix = `[tool_run] ${toolCall.tool} exit=${runResult.code} (${runResult.duration_ms}мс)\nSTDOUT: ${runResult.stdout}\nSTDERR: ${runResult.stderr}\n---\n`;
  } else if (!skipCoder) {
    // Кузница: реестр в контексте кодера (не только архитектора, §26.2 п.1
    // reuse-first) — виден на КАЖДОЙ попытке сборки, свежий список.
    const codeTask = isTool
      ? { ...task2, spec: `${task2.spec}\n\n## Существующие инструменты (reuse-first — переиспользуй, не дублируй)\n${toolRegistryContext()}` }
      : task2;
    const coderResult = await runCoder({ task: codeTask, workspaceDir: effectiveRoot, runId });
    addSpent(task.id, sumRunCost(runId, task.id));

    if (coderResult.type === 'question') {
      setStatus(task.id, 'blocked_needs_human', { question: coderResult.question });
      clearEyesState(task.id);
      progress(`[coordinator] задача failed (вопрос человеку), осталось ${remainingCount(role)}`);
      return { task: getTask(task.id), verdict: 'blocked_needs_human', reason: 'question' };
    }
    if (coderResult.type === 'error') {
      // Замок пути (§12.1) — попытка записи вне workspace/tools-корня:
      // отдельное событие для аудита SQL-запросом (§14), не только текст в feedback.
      if (/замком пути/.test(coderResult.error)) {
        logEvent({
          run_id: runId, task_id: task.id, type: 'status', agent: 'coordinator',
          payload: { event: 'path_lock_blocked', error: coderResult.error },
        });
      }
      return handleAttemptFailure(task, runId, `FAIL(coder): ${coderResult.error}`, role, effectiveRoot);
    }
    // Печать рядом с уже существующим usage-событием кодера (logEvent внутри
    // chat(), вызванного runCoder чуть выше).
    progress(`[coder] задача "${task2.title}" попытка ${task2.attempts} → файлы: ${coderResult.written.join(', ') || '(нет)'}`);
    if (isTool) {
      autoCommit(TOOLS_DIR, `loom-tool: coder attempt ${task2.attempts} on ${task.id} (${task2.tool_name})`);
    } else {
      autoCommit(workspaceDir, `loom: coder attempt ${task2.attempts} on ${task.id} (${coderResult.written.length} файлов)`);
    }
  }

  // Критерий tool-сборки обязан РЕАЛЬНО исполнить инструмент (§8.5, §26.2) —
  // cwd = корень инструмента, тот же контракт, что боевой прогон; tool_run и
  // всё остальное — cwd = workspace продукта, как раньше.
  const testCwd = isTool ? effectiveRoot : workspaceDir;
  const sandbox = ensureDockerSandbox(testCwd) ? 'docker' : 'local';
  const testResult = await runTester({ task: task2, workspaceDir: testCwd, sandbox });
  const report = (toolRunPrefix + testResult.report).slice(0, 1000);
  // Печать рядом с уже существующим test_result-событием ниже — тестер сам
  // LLM не вызывает (§9), это единственная точка, где известен вердикт.
  progress(`[tester] критерий "${task2.title}" → ${testResult.pass ? 'PASS' : 'FAIL'} (${report.slice(0, 120).replace(/\n/g, ' ')})`);
  logEvent({
    run_id: runId, task_id: task.id, type: 'test_result', agent: 'tester',
    payload: { pass: testResult.pass, report },
  });

  if (testResult.pass) {
    if (isTool) {
      // tool.json обязателен по контракту (§26.1) — отсутствие/битый JSON
      // не регистрируем даже при зелёном критерии (брак архитектора/кодера,
      // доверие построено на недоверии, не на слове тестера).
      const manifest = readToolManifest(effectiveRoot);
      if (!manifest) {
        return handleAttemptFailure(task, runId, `${report}\nFAIL: критерий прошёл, но tool.json отсутствует или битый (обязателен §26.1) — инструмент НЕ зарегистрирован`.slice(0, 1000), role, effectiveRoot);
      }
      const registered = registerTool({
        name: manifest.name,
        description: manifest.description,
        entry: manifest.entry || 'run.js',
        network: manifest.network || 'none',
        timeout_ms: manifest.timeout_ms || 60000,
        created_by_task: task.id,
        runId,
      });
      autoCommit(TOOLS_DIR, `loom-tool: ${registered.name} v${registered.version} (${task.id})`);
      progress(`[coordinator] инструмент "${registered.name}" зарегистрирован (v${registered.version})`);
    } else {
      autoCommit(workspaceDir, `loom: done ${task.id}`);
    }
    // Параллельная фаза (Фаза 6, П§5): 'merge_pending' вместо 'done' — воркер
    // закончил СВОЮ часть в СВОЁМ worktree, интеграция в main происходит
    // отдельно, последовательно (core/merge.js). Не применяется к
    // tool/tool_run/regression — им очередь мёржей не нужна, 'done' для них
    // означает готово по-настоящему уже сейчас (isTool/isToolRun/regression
    // писали не в workspaceDir-worktree, а в свои собственные корни).
    const finalStatus = (!isTool && !isToolRun && task2.type !== 'regression' && opts.onSuccessStatus) || 'done';
    setStatus(task.id, finalStatus, { feedback: report });
    clearEyesState(task.id);
    await writeSkillSafely(task.id, runId);
    progress(`[coordinator] задача ${finalStatus === 'merge_pending' ? 'готова к мёржу (merge_pending)' : 'done'}, осталось ${remainingCount(role)}`);
    return { task: getTask(task.id), verdict: finalStatus };
  }

  return handleAttemptFailure(task, runId, report, role, effectiveRoot);
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
 * Объединение touches_files всех задач сейчас в claimed/merge_pending
 * (Фаза 6, П§5 weave) — передаётся в claimNext воркера ПЕРЕД каждым
 * захватом. Синхронная функция, без await: внутри одного JS-раунда
 * (Promise.all по воркерам) каждый воркер синхронно захватывает ДО первого
 * await своего хода, поэтому следующий воркер в том же .map()-раунде уже
 * видит захват предыдущего — однопоточность JS даёт это бесплатно, без
 * явной координации между воркерами.
 */
function computeActiveTouches(role) {
  const active = [...listTasks({ status: 'claimed', role }), ...listTasks({ status: 'merge_pending', role })];
  const set = new Set();
  for (const t of active) {
    let touches;
    try { touches = JSON.parse(t.touches_files || '[]'); } catch { touches = []; }
    for (const f of touches) set.add(f);
  }
  return [...set];
}

/** Есть ли хоть одна pending-задача, которая ИМЕЕТ смысл параллелить (не regression/tool_run — им нужен main). */
function hasParallelizableWork(role) {
  return listTasks({ status: 'pending', role }).some((t) => t.type !== 'regression' && t.type !== 'tool_run');
}

async function claimAndRunInWorktree({
  workerId, role, workspaceDir, worktreesDir, runId,
}) {
  const activeTouches = computeActiveTouches(role);
  const claimedBy = `w${workerId}`;
  // regression/tool_run исключены из параллельного захвата на уровне
  // claimNext (excludeTypes) — им нужен workspaceDir=main, не worktree
  // воркера (§16 п.8); последовательная фаза после параллельной их заберёт.
  const task = claimNext(role, claimedBy, { activeTouches, excludeTypes: ['regression', 'tool_run'] });
  if (!task) return null;

  const worktreePath = ensureWorktree(workspaceDir, worktreesDir, workerId);
  return processOneTask(role, worktreePath, runId, {
    claimedBy, activeTouches, onSuccessStatus: 'merge_pending', preClaimed: task,
  });
}

/**
 * Параллельная фаза (Фаза 6, П§5): N воркеров в ОДНОМ процессе, каждый в
 * своём git worktree продукта; зелёный критерий → merge_pending (не done);
 * после каждого раунда — последовательное дренирование очереди мёржей
 * (core/merge.js: git merge, tsc-ворота, LLM-reconciler на конфликт).
 * Регрессия/live_in — НЕ здесь (§16 п.8: строго после пустой очереди
 * мёржей) — вызывающий (runCoordinatorLoop) доводит их последовательной
 * фазой ПОСЛЕ этой функции, тем же кодом, что и однопоточный путь.
 */
async function runParallelPhase({
  role, workspaceDir, runId, workers, maxIterations,
}) {
  ensureWorkspaceGit(workspaceDir);
  ensureInitialCommit(workspaceDir);
  const worktreesDir = WORKTREES_DIR;
  const workerIds = Array.from({ length: workers }, (_, i) => i + 1);
  for (const id of workerIds) ensureWorktree(workspaceDir, worktreesDir, id);

  const results = [];
  let iterations = 0;
  for (;;) {
    if (iterations >= maxIterations) break;
    if (!hasParallelizableWork(role)) break;

    const roundPromises = workerIds.map((id) => claimAndRunInWorktree({
      workerId: id, role, workspaceDir, worktreesDir, runId,
    }));
    // eslint-disable-next-line no-await-in-loop
    const roundResults = await Promise.all(roundPromises);
    const claimedAny = roundResults.some((r) => r !== null);
    for (const r of roundResults) if (r) results.push(r);

    // eslint-disable-next-line no-await-in-loop
    const mergedCount = await drainMergeQueue({
      role, workspaceDir, worktreesDir, workerIds, runId,
    });

    iterations++;
    if (!claimedAny && !mergedCount) break; // раунд ничего не взял и нечего мёржить — параллелить больше нечего
  }
  return results;
}

/**
 * Цикл координатора: gitGuard pre-flight (шрам 5) → releaseStuck() на
 * КАЖДОМ входе (шрам 25 — задачи навечно в claimed после смерти процесса),
 * затем обработка задач роли role до опустошения очереди или maxIterations.
 * runId (опционально) — сквозной run_id одного клиентского запроса (talk.js);
 * без него, как и раньше, каждая захваченная задача получает свой (см.
 * processOneTask).
 *
 * workers>1 (Фаза 6, П§5): сначала параллельная фаза (worktrees + merge
 * queue) для параллелящихся типов, ЗАТЕМ обычная последовательная фаза
 * (без изменений, тот же код, что при workers=1) добирает то, что
 * параллельная фаза сознательно не взяла (regression/tool_run — им нужен
 * main, §16 п.8) и всё, что осталось после неё (retry-задачи, tool-задачи).
 */
export async function runCoordinatorLoop({
  role = 'coder', workspaceDir = WORKSPACE, maxIterations = Infinity, runId = null, workers = 1,
} = {}) {
  const guard = gitGuard();
  if (!guard.ok) {
    throw new Error(guard.message);
  }
  releaseStuck();
  const results = [];

  if (workers > 1) {
    const parallelResults = await runParallelPhase({
      role, workspaceDir, runId, workers, maxIterations,
    });
    results.push(...parallelResults);
  }

  let iterations = 0;
  for (;;) {
    if (iterations >= maxIterations) break;
    const result = await processOneTask(role, workspaceDir, runId);
    if (!result) break;
    results.push(result);
    iterations++;
  }
  return results;
}

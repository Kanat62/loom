// agents/architect.js — architect (§3, §8 ТЗ v4): не пишет код, только план.
// packages→npm install ДО кодера (шрам 22); предпроверка критериев с тихим
// логом (шрам 19); контракт регрессии §8.9 (склейка id, не новая проверка,
// шрам 31).
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { callAgent } from '../core/engine.js';
import { precheck } from '../core/checkRunner.js';
import { addTask } from '../core/journal.js';
import { progress } from '../core/io.js';
import { TOOLS_DIR } from '../core/config.js';
import { listTools } from '../core/tools.js';
import { buildSpawnArgs } from '../core/spawnUtil.js';

function buildArchitectPrompt(brief, workspaceListing) {
  const parts = [
    `## Бриф от советника\nПротокол: ${brief.protocol}\nЗапрос клиента: ${brief.request}\nСводка: ${brief.summary || ''}`,
    `## Принятые инженерные решения (используй дословно)\n${(brief.engineering_defaults || []).map((d) => `- ${d}`).join('\n') || '(нет)'}`,
  ];
  if (brief.problem) {
    parts.push([
      '## Диагностика проблемы',
      `Проблема: ${brief.problem.formulation || ''}`,
      `Критерий успеха клиента: ${brief.problem.success_criterion || ''}`,
      `Принятое решение: ${brief.problem.decision || ''}`,
      `Почему: ${brief.problem.why || ''}`,
    ].join('\n'));
  }
  // §26.2 п.1 reuse-first: реестр в контексте на КАЖДОМ вызове, не только
  // когда явно похоже, что нужен инструмент — архитектор сам решает.
  const tools = listTools();
  parts.push(`## Реестр существующих инструментов (reuse-first — переиспользуй, не дублируй)\n${tools.length ? tools.map((t) => `- ${t.name} (v${t.version}): ${t.description}`).join('\n') : '(пока нет ни одного инструмента)'}`);
  // §11, П§6.2: ingest ТЗ-пакета передаёт требования с id — каждая задача
  // ОБЯЗАНА трассировать, какие требования она покрывает (covers), иначе
  // harness не сможет отличить дыру («требование без задачи») от того, что
  // архитектор просто забыл про него.
  if (Array.isArray(brief.requirements) && brief.requirements.length) {
    parts.push([
      '## Требования ТЗ-пакета (§11, обязательна трассировка)',
      brief.requirements.map((r) => `- ${r.id}: ${r.text}`).join('\n'),
      'КАЖДАЯ задача ОБЯЗАНА включать поле "covers" — список id требований, которые',
      'она закрывает (может быть несколько задач на одно требование, и наоборот).',
      'Требование без единой покрывающей его задачи — дыра, о которой нужно честно',
      'сообщить (harness сам это посчитает по covers, ты просто заполняй поле честно).',
    ].join('\n'));
  }
  parts.push(`## Текущие файлы workspace (только имена)\n${workspaceListing.length ? workspaceListing.join('\n') : '(пусто)'}`);
  return parts.join('\n\n');
}

const TASK_TYPES = new Set(['tool', 'tool_run']); // 'project' — дефолт, в план не пишется явно

function validatePlan(plan) {
  if (!plan || !Array.isArray(plan.tasks) || !plan.tasks.length) return null;
  const tasks = plan.tasks
    .filter((t) => t
      && typeof t.title === 'string' && t.title.trim()
      && typeof t.spec === 'string'
      && t.criteria && typeof t.criteria === 'object' && typeof t.criteria.cmd === 'string')
    .map((t) => ({ ...t, type: TASK_TYPES.has(t.type) ? t.type : 'project' }))
    // §26.2: tool/tool_run без tool_name — брак, отбрасываем задачу целиком
    // (архитектор ошибся в схеме), не превращаем в мусорную обычную задачу.
    .filter((t) => t.type === 'project' || (typeof t.tool_name === 'string' && t.tool_name.trim()));
  if (!tasks.length) return null;
  const packages = Array.isArray(plan.packages) ? plan.packages.filter((p) => typeof p === 'string' && p.trim()) : [];
  return { packages, tasks };
}

const NPM_INSTALL_TIMEOUT_MS = 10 * 60_000; // пакеты вроде playwright тянут браузерный бинарник — даём запас

// npm на Windows ставится как npm.cmd — прямой execFileSync без shell даёт
// ENOENT (тот же инвариант §20.6, что и claude.cmd в gateway.js: явные
// Windows-ветки для .cmd-бинарников). shell:true на Windows режет аргументы
// с пробелами — buildSpawnArgs (core/spawnUtil.js, тот же хелпер, что
// gateway.js) оборачивает их в JSON.stringify, валидное cmd.exe-экранирование
// для путей/имён пакетов.
function npmInstall(workspaceDir, packages) {
  if (!packages.length) return { ok: true, output: '(пакетов не требуется)' };
  const isWin = process.platform === 'win32';
  const args = ['install', '--no-audit', '--no-fund', ...packages];
  try {
    const out = execFileSync('npm', buildSpawnArgs(args), {
      cwd: workspaceDir,
      stdio: 'pipe',
      timeout: NPM_INSTALL_TIMEOUT_MS,
      maxBuffer: 10 * 1024 * 1024,
      shell: isWin,
      windowsHide: isWin,
    });
    return { ok: true, output: out.toString().slice(0, 500) };
  } catch (e) {
    return { ok: false, output: (e.stdout ? e.stdout.toString() : e.message).slice(0, 1000) };
  }
}

async function regenerateCriteria({ title, spec, oldCriteria, runId }) {
  const userText = [
    `Критерий задачи "${title}" оказался ФИКТИВНЫМ — он уже проходит на текущем workspace ДО работы кодера.`,
    `Задача: ${spec}`,
    `Старый (фиктивный) критерий: ${JSON.stringify(oldCriteria)}`,
    'Придумай ДРУГОЙ критерий для той же задачи, который СЕЙЧАС падает и станет проходить только после реальной реализации.',
    'Ответь СТРОГО JSON: {"criteria": {"cmd": "node -e \\"...\\"", "expect": "..."}}',
  ].join('\n\n');
  try {
    const result = await callAgent({
      role: 'architect', promptFile: 'architect.md', userText, json: true, runId, agent: 'architect',
    });
    if (result && result.criteria && typeof result.criteria.cmd === 'string') return result.criteria;
  } catch { /* оставляем старый критерий — лучше фиктивный, чем сорванный прогон */ }
  return null;
}

/**
 * reviewCriterion({title, spec, cmd, expect, attemptReports, runId}) →
 * {verdict:'criterion_defect', cmd, reason} | {verdict:'confirmed_block', reason}
 *
 * scar 34 (П§11): вызывается coordinator.js, когда критерий проваливается
 * с ОДИНАКОВОЙ (после нормализации чисел) причиной на КАЖДОЙ из MAX_ATTEMPTS
 * попыток, при этом кодер каждый раз реально писал разный код (подтверждено
 * git-историей, не догадкой) — сильный сигнал, что дело не в коде. Критерии
 * пишет архитектор (§8: «нарушение любого правила = брак архитектора»),
 * поэтому только он имеет право их чинить — не coordinator сам по себе, и не
 * кодер (журнал, куда его инструментам хода нет, §8 преамбула).
 *
 * Симметрична regenerateCriteria() выше (тот же приём: отдельный userText
 * поверх ОБЩЕГО architect.md, роль/тир не меняются), но для
 * ПРОТИВОПОЛОЖНОГО брака: там критерий ВСЕГДА проходит (фиктивен, §8.8),
 * здесь — критерий НИКОГДА не может пройти (сломан сам, не то, что проверяет).
 *
 * Дисбаланс осторожности сознательный: при любой неопределённости или сбое
 * шлюза — 'confirmed_block' (задача остаётся blocked_needs_human человеку).
 * Ложное «исправление» рабочего критерия хуже, чем оставить блок — доверие
 * построено на недоверии (§26.0), это применимо и к самому этому механизму.
 */
export async function reviewCriterion({
  title, spec, cmd, expect, attemptReports, runId,
}) {
  const userText = [
    `Критерий задачи "${title}" провалился ${attemptReports.length} раз(а) подряд С ПОЧТИ ОДИНАКОВЫМ выводом теста, хотя кодер каждый раз писал РАЗНЫЙ код (подтверждено git-историей коммитов, не догадкой). Это сигнал, что дело может быть не в коде, а в самом критерии — но может быть и настоящий тяжёлый баг, который просто ловится одним и тем же условием каждый раз.`,
    `Задача (spec): ${spec}`,
    `Проверяемый критерий (cmd), ИМЕННО ЕГО текст нужно проверить на ошибку: ${cmd}`,
    expect ? `Ожидаемая подстрока (expect): ${expect}` : '',
    `Отчёты тестера по попыткам (для контекста, не редактируй их):\n${attemptReports.map((r, i) => `Попытка ${i + 1}: ${String(r).slice(0, 300)}`).join('\n')}`,
    'Внимательно прочитай ТЕКСТ критерия на предмет реальной ошибки логики/экранирования/опечатки в САМОЙ ПРОВЕРКЕ — типичные примеры: задвоенное экранирование regex (в исходнике `/\\\\d/` вместо `/\\d/` — совпадает с буквальным `\\d`, а не с цифрой), обращение к несуществующему полю/селектору, перепутанный оператор сравнения, условие, которое математически не может стать true.',
    'Если находишь конкретную, объяснимую ошибку В САМОМ ТЕКСТЕ критерия (не гадая по отчётам) — ответь JSON {"verdict":"criterion_defect","cmd":"исправленный критерий ЦЕЛИКОМ, той же структуры и с той же целью проверки, минимальная точечная правка","reason":"что именно было не так, коротко"}.',
    'Если критерий выглядит логически верным (значит проблема настоящая, в коде/сложности задачи) — ответь JSON {"verdict":"confirmed_block","reason":"почему критерий верный"}.',
    'Если сомневаешься — выбирай confirmed_block: ложное "исправление" рабочего критерия хуже, чем оставить задачу человеку.',
    'Отвечай СТРОГО JSON, без markdown-фенсов.',
  ].filter(Boolean).join('\n\n');

  try {
    const result = await callAgent({
      role: 'architect', promptFile: 'architect.md', userText, json: true, runId, agent: 'architect_criteria_review',
    });
    if (
      result && result.verdict === 'criterion_defect'
      && typeof result.cmd === 'string' && result.cmd.trim() && result.cmd.trim() !== String(cmd).trim()
    ) {
      return { verdict: 'criterion_defect', cmd: result.cmd.trim(), reason: String(result.reason || '(без обоснования)').slice(0, 500) };
    }
    return { verdict: 'confirmed_block', reason: String(result?.reason || '(нет обоснования от архитектора)').slice(0, 500) };
  } catch (e) {
    return { verdict: 'confirmed_block', reason: `review call failed: ${e.message}` };
  }
}

/**
 * runArchitect({brief, workspaceDir, workspaceListing, runId, projectId}) →
 * {ok, taskIds, regressionId, packages, installOk, precheckLog} | {ok:false, error}
 */
export async function runArchitect({
  brief, workspaceDir, workspaceListing = [], runId, projectId = 'default', sandbox = 'local',
}) {
  const userText = buildArchitectPrompt(brief, workspaceListing);
  let raw;
  try {
    raw = await callAgent({
      role: 'architect', promptFile: 'architect.md', userText, json: true, runId, agent: 'architect',
    });
  } catch (e) {
    return { ok: false, error: `architect: сбой шлюза (${e.message})` };
  }

  const plan = validatePlan(raw);
  if (!plan) {
    return { ok: false, error: 'architect: пустой или некорректный план (нет валидных задач с criteria.cmd)' };
  }

  const install = npmInstall(workspaceDir, plan.packages);
  // Реальный баг с первого живого прогона: раньше install-ошибка тихо
  // игнорировалась — задачи создавались с критериями на пакет, которого
  // физически нет, и всё дерево гарантированно упиралось в
  // "Cannot find module" на КАЖДОЙ из 4 попыток. Теперь — честный останов
  // ДО создания задач (§12.2: "нужен пакет → статус «нужен пакет»").
  if (!install.ok) {
    return {
      ok: false,
      error: `architect: npm install пакетов [${plan.packages.join(', ')}] не удался — задачи не созданы: ${install.output}`,
    };
  }

  // Печать рядом с уже существующим usage-событием architect'а (logEvent
  // внутри chat(), см. callAgent выше) — план уже валиден и пакеты стоят,
  // список задач финальный.
  progress(`[architect] задач: ${plan.tasks.length} (${plan.tasks.map((t) => t.title).join(', ')})`);

  const createdIds = [];
  const titleToId = new Map();
  const precheckLog = [];

  for (const t of plan.tasks) {
    let criteria = t.criteria;
    // Предпроверка (шрам 19): тихо (pipe, 5с) прогоняем критерий ДО кодера.
    // §26: для type=tool — cwd ТОТ ЖЕ контракт, что боевой прогон (тот же
    // корень, что увидит кодер и тестер — tools/<tool_name>/, обычно ещё не
    // существует на старте, precheck честно падает на несуществующем cwd,
    // что и требуется — критерий ещё не должен проходить).
    const precheckCwd = t.type === 'tool' ? path.join(TOOLS_DIR, t.tool_name) : workspaceDir;
    const pre = await precheck(criteria, precheckCwd, { sandbox });
    if (pre.pass) {
      const regenerated = await regenerateCriteria({ title: t.title, spec: t.spec, oldCriteria: criteria, runId });
      if (regenerated) criteria = regenerated;
      precheckLog.push(`[precheck] "${t.title}": ФИКТИВЕН на старте — ${regenerated ? 'регенерирован' : 'регенерация не удалась, оставлен как есть'}`);
    } else {
      precheckLog.push(`[precheck] "${t.title}": OK (сейчас падает, как и должно)`);
    }

    const dependTitle = typeof t.depends_on_title === 'string' ? t.depends_on_title : null;
    const blockedById = dependTitle ? (titleToId.get(dependTitle) || null) : null;

    // Фаза 6 (П§5): настоящий fan-in для ЛЮБОЙ задачи, не только автоматической
    // регрессии — задача может ждать НЕСКОЛЬКО предшественников (например,
    // задача-потребитель ждёт и tool_run, и отдельную задачу с данными).
    // task_deps (П§2), не заменяет depends_on_title — оба могут быть заданы
    // одновременно, claimNext требует удовлетворения обоих.
    const dependTitles = Array.isArray(t.depends_on_titles) ? t.depends_on_titles.filter((x) => typeof x === 'string') : [];
    const depIds = dependTitles.map((title) => titleToId.get(title)).filter(Boolean);

    // tool_run: harness строит канонический JSON-вызов сам из tool_name/
    // tool_args, не доверяя модели точный формат spec (§26.2 «Использование»).
    const spec = t.type === 'tool_run'
      ? JSON.stringify({ tool: t.tool_name, args: Array.isArray(t.tool_args) ? t.tool_args.map(String) : [] })
      : t.spec;

    const covers = Array.isArray(t.covers) ? t.covers.filter((x) => typeof x === 'string') : [];
    const id = addTask({
      project_id: projectId,
      title: t.title,
      spec,
      criteria: JSON.stringify(criteria),
      role: 'coder',
      type: t.type,
      tool_name: (t.type === 'tool' || t.type === 'tool_run') ? t.tool_name : undefined,
      touches_files: Array.isArray(t.touches_files) ? t.touches_files : [],
      blocked_by_task_id: blockedById,
      deps: depIds.length ? depIds : undefined,
      covers,
    });
    createdIds.push(id);
    titleToId.set(t.title, id);
  }

  // §11, П§6.2: требование без единой покрывающей его задачи — дыра,
  // о которой сообщается человеку (не блокирует прогон — architect уже
  // сделал свой выбор, это отчётность, не ворота).
  let uncoveredRequirements = [];
  if (Array.isArray(brief.requirements) && brief.requirements.length) {
    const coveredIds = new Set(plan.tasks.flatMap((t) => (Array.isArray(t.covers) ? t.covers : [])));
    uncoveredRequirements = brief.requirements.filter((r) => !coveredIds.has(r.id));
  }

  // Контракт регрессии (§8.9): последняя задача дерева — ТОЛЬКО повтор уже
  // существующих критериев (склейка id), новый код проверки не пишем (шрам 31).
  // Настоящий fan-in (П§2 DEV_GUIDE part2, закрывает упрощение из DECISIONS
  // Фазы 3): регрессия зависит от ВСЕХ задач дерева через task_deps, не
  // только от последней созданной — раньше это работало только благодаря
  // побочному эффекту строго последовательной однопоточной обработки очереди
  // (claimNext всегда берёт самую старую pending-задачу), что перестанет
  // быть истиной с параллельными воркерами (Фаза 6).
  //
  // Кузница (§26, П§4): type=tool ИСКЛЮЧЁН из regression_of, хотя и остаётся
  // в deps (порядок — регрессия всё равно ждёт, что инструмент собран).
  // Регрессия всегда исполняется с ОДНИМ cwd=workspace продукта (checkRunner
  // не умеет разные cwd для разных под-критериев внутри одного regression_of)
  // — критерий сборки инструмента написан для cwd=tools/<name>/ и упадёт
  // технически (Cannot find module run.js), не содержательно, при повторе
  // относительно workspace. Сборка уже верифицирована один раз при
  // регистрации (§26.2) — для регрессии продукта важно, что PRODUCT
  // по-прежнему корректно ИСПОЛЬЗУЕТ инструмент (tool_run + потребитель
  // результата), не что сам инструмент всё ещё собирается с нуля.
  const regressionOfIds = plan.tasks
    .map((t, i) => ({ type: t.type, id: createdIds[i] }))
    .filter(({ type }) => type !== 'tool')
    .map(({ id }) => id);

  const regressionId = addTask({
    project_id: projectId,
    title: 'Регрессия: повтор критериев дерева',
    spec: 'Автоматическая регрессия — повторный прогон критериев всех задач этого дерева (кроме сборки инструментов — см. §26), без новой генерации кода.',
    criteria: JSON.stringify({ regression_of: regressionOfIds }),
    role: 'coder',
    type: 'regression',
    deps: createdIds,
  });

  return {
    ok: true,
    taskIds: createdIds,
    regressionId,
    packages: plan.packages,
    installOk: install.ok,
    installOutput: install.output,
    precheckLog,
    uncoveredRequirements,
  };
}

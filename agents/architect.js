// agents/architect.js — architect (§3, §8 ТЗ v4): не пишет код, только план.
// packages→npm install ДО кодера (шрам 22); предпроверка критериев с тихим
// логом (шрам 19); контракт регрессии §8.9 (склейка id, не новая проверка,
// шрам 31).
import { execFileSync } from 'node:child_process';
import { callAgent } from '../engine.js';
import { precheck } from '../checkRunner.js';
import { addTask } from '../journal.js';

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
  parts.push(`## Текущие файлы workspace (только имена)\n${workspaceListing.length ? workspaceListing.join('\n') : '(пусто)'}`);
  return parts.join('\n\n');
}

function validatePlan(plan) {
  if (!plan || !Array.isArray(plan.tasks) || !plan.tasks.length) return null;
  const tasks = plan.tasks.filter((t) => t
    && typeof t.title === 'string' && t.title.trim()
    && typeof t.spec === 'string'
    && t.criteria && typeof t.criteria === 'object' && typeof t.criteria.cmd === 'string');
  if (!tasks.length) return null;
  const packages = Array.isArray(plan.packages) ? plan.packages.filter((p) => typeof p === 'string' && p.trim()) : [];
  return { packages, tasks };
}

function npmInstall(workspaceDir, packages) {
  if (!packages.length) return { ok: true, output: '(пакетов не требуется)' };
  try {
    const out = execFileSync('npm', ['install', '--no-audit', '--no-fund', ...packages], {
      cwd: workspaceDir, stdio: 'pipe',
    });
    return { ok: true, output: out.toString().slice(0, 500) };
  } catch (e) {
    return { ok: false, output: (e.stdout ? e.stdout.toString() : e.message).slice(0, 500) };
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

  const createdIds = [];
  const titleToId = new Map();
  const precheckLog = [];

  for (const t of plan.tasks) {
    let criteria = t.criteria;
    // Предпроверка (шрам 19): тихо (pipe, 5с) прогоняем критерий ДО кодера.
    const pre = await precheck(criteria, workspaceDir, { sandbox });
    if (pre.pass) {
      const regenerated = await regenerateCriteria({ title: t.title, spec: t.spec, oldCriteria: criteria, runId });
      if (regenerated) criteria = regenerated;
      precheckLog.push(`[precheck] "${t.title}": ФИКТИВЕН на старте — ${regenerated ? 'регенерирован' : 'регенерация не удалась, оставлен как есть'}`);
    } else {
      precheckLog.push(`[precheck] "${t.title}": OK (сейчас падает, как и должно)`);
    }

    const dependTitle = typeof t.depends_on_title === 'string' ? t.depends_on_title : null;
    const blockedById = dependTitle ? (titleToId.get(dependTitle) || null) : null;

    const id = addTask({
      project_id: projectId,
      title: t.title,
      spec: t.spec,
      criteria: JSON.stringify(criteria),
      role: 'coder',
      type: 'project',
      touches_files: Array.isArray(t.touches_files) ? t.touches_files : [],
      blocked_by_task_id: blockedById,
    });
    createdIds.push(id);
    titleToId.set(t.title, id);
  }

  // Контракт регрессии (§8.9): последняя задача дерева — ТОЛЬКО повтор уже
  // существующих критериев (склейка id), новый код проверки не пишем (шрам 31).
  // Зависит от последней созданной обычной задачи; при строго
  // последовательной обработке очереди (claimNext всегда берёт самую старую
  // pending-задачу) это гарантирует, что регрессия стартует только после
  // того, как ВСЕ задачи дерева уже в терминальном статусе.
  const regressionId = addTask({
    project_id: projectId,
    title: 'Регрессия: повтор критериев дерева',
    spec: 'Автоматическая регрессия — повторный прогон критериев всех задач этого дерева, без новой генерации кода.',
    criteria: JSON.stringify({ regression_of: createdIds }),
    role: 'coder',
    type: 'regression',
    blocked_by_task_id: createdIds[createdIds.length - 1] || null,
  });

  return {
    ok: true,
    taskIds: createdIds,
    regressionId,
    packages: plan.packages,
    installOk: install.ok,
    installOutput: install.output,
    precheckLog,
  };
}

// agents/researcher.js — исследователь (§10 ТЗ v4, П§6.1 DEV_GUIDE part2):
// двузвонковый цикл, весь стейт — на доске (task/events), не в памяти
// процесса. Заказывает инструменты добычи конвейеру (Кузница §26), сам
// ничего не пишет и не исполняет. Жесточайший стоп-фактор: verdict
// data_unavailable — единственный легальный исход при недоступности данных,
// ветки «продолжить без данных» здесь СТРУКТУРНО нет.
import { callAgent } from '../core/engine.js';
import { precheck } from '../core/checkRunner.js';
import { addTask, getTask } from '../core/journal.js';
import { listTools } from '../core/tools.js';
import { progress } from '../core/io.js';

function buildPlanPrompt(brief, rootSpec) {
  const tools = listTools();
  return [
    '## Режим: план',
    `## Бриф советника (problem-протокол)\n${brief?.problem ? JSON.stringify(brief.problem, null, 2) : (brief?.summary || '')}`,
    `## root_spec проекта\n${rootSpec || '(нет)'}`,
    `## Реестр существующих инструментов (reuse-first)\n${tools.length ? tools.map((t) => `- ${t.name} (v${t.version}): ${t.description}`).join('\n') : '(пока нет ни одного инструмента)'}`,
  ].join('\n\n');
}

const FICTIONAL_TOOL_CRITERIA = (name) => ({
  cmd: `node -e "console.error('FAIL: researcher не прислал критерий для ${name} — задача заведомо не может считаться выполненной'); process.exit(1)"`,
});
const FICTIONAL_DATA_CRITERIA = (tool) => ({
  cmd: `node -e "console.error('FAIL: researcher не прислал критерий данных для ${tool}'); process.exit(1)"`,
});

/**
 * planResearch({brief, rootSpec, workspaceDir, runId, projectId, sandbox}) →
 * {ok, toolTaskIds, toolRunTaskIds, sources, empty?} | {ok:false, error}
 * Звонок 1: харнесс превращает need_tools → type='tool', tool_runs →
 * type='tool_run' (spec = канонический JSON {tool,args}, тот же контракт,
 * что architect.js строит для tool_run — код, не модель, отвечает за формат).
 */
export async function planResearch({
  brief, rootSpec, workspaceDir, runId, projectId = 'default', sandbox = 'local',
}) {
  let plan;
  try {
    plan = await callAgent({
      role: 'researcher', promptFile: 'researcher.md', userText: buildPlanPrompt(brief, rootSpec), json: true, runId, agent: 'researcher',
    });
  } catch (e) {
    return { ok: false, error: `researcher: сбой шлюза на плане (${e.message})` };
  }
  if (!plan || typeof plan !== 'object') {
    return { ok: false, error: 'researcher: план — не объект (нарушен JSON-контракт)' };
  }

  const needTools = Array.isArray(plan.need_tools)
    ? plan.need_tools.filter((t) => t && typeof t.tool_name === 'string' && t.tool_name.trim())
    : [];
  const toolRuns = Array.isArray(plan.tool_runs)
    ? plan.tool_runs.filter((t) => t && typeof t.tool === 'string' && t.tool.trim())
    : [];
  const sources = Array.isArray(plan.sources) ? plan.sources : [];

  progress(`[researcher] план: источников ${sources.length}, инструментов заказано ${needTools.length}, запусков ${toolRuns.length}`);

  if (!needTools.length && !toolRuns.length) {
    return {
      ok: true, sources, toolTaskIds: [], toolRunTaskIds: [], empty: true,
    };
  }

  const toolIdByName = new Map();
  const toolTaskIds = [];
  const precheckLog = [];
  for (const nt of needTools) {
    const criteria = (nt.criteria && typeof nt.criteria === 'object' && typeof nt.criteria.cmd === 'string')
      ? nt.criteria
      : FICTIONAL_TOOL_CRITERIA(nt.tool_name);
    // Предпроверка (шрам 19, §8.8) — та же дисциплина, что у архитектора:
    // критерий обязан ещё падать на несуществующем инструменте.
    if (workspaceDir) {
      const { TOOLS_DIR } = await import('../core/config.js');
      const path = await import('node:path');
      const pre = await precheck(criteria, path.join(TOOLS_DIR, nt.tool_name), { sandbox });
      precheckLog.push(pre.pass
        ? `[precheck] инструмент "${nt.tool_name}": ФИКТИВЕН на старте (researcher прислал проходящий заранее критерий)`
        : `[precheck] инструмент "${nt.tool_name}": OK (сейчас падает, как и должно)`);
    }
    const id = addTask({
      project_id: projectId,
      title: `Инструмент ${nt.tool_name}: ${(nt.purpose || '').slice(0, 100)}`,
      spec: `${nt.purpose || ''}\nВход/выход: ${nt.io || ''}`,
      criteria: JSON.stringify(criteria),
      role: 'coder',
      type: 'tool',
      tool_name: nt.tool_name,
    });
    toolIdByName.set(nt.tool_name, id);
    toolTaskIds.push(id);
  }

  const toolRunTaskIds = [];
  for (const tr of toolRuns) {
    const depId = toolIdByName.get(tr.tool) || null; // существующий (reuse) инструмент — depId=null, зависимости не нужно
    const dataCriteria = (Array.isArray(tr.data_criteria) && tr.data_criteria.length)
      ? tr.data_criteria.filter((c) => c && typeof c.cmd === 'string')
      : [FICTIONAL_DATA_CRITERIA(tr.tool)];
    const id = addTask({
      project_id: projectId,
      title: `Добыча данных: ${tr.tool} ${JSON.stringify(tr.args || [])}`.slice(0, 200),
      spec: JSON.stringify({ tool: tr.tool, args: Array.isArray(tr.args) ? tr.args.map(String) : [] }),
      criteria: JSON.stringify(dataCriteria),
      role: 'coder',
      type: 'tool_run',
      tool_name: tr.tool,
      blocked_by_task_id: depId,
    });
    toolRunTaskIds.push(id);
  }

  return {
    ok: true, sources, toolTaskIds, toolRunTaskIds, precheckLog,
  };
}

/**
 * evaluateResearch({toolRunTaskIds, workspaceDir, runId}) →
 * {ok:true, verdict:'proceed', dataSummary, forArchitect} |
 * {ok:true, verdict:'data_unavailable', clientNote} | {ok:false, error}
 * Звонок 2: отчёты tool_run (task.feedback) + read-only глаза продукта
 * (тот же фильтр мусора, что у кодера/аналитика).
 */
export async function evaluateResearch({ toolRunTaskIds = [], workspaceDir, runId }) {
  const { buildEyes } = await import('./coder.js');
  const reports = toolRunTaskIds.map((id) => {
    const t = getTask(id);
    if (!t) return `## tool_run (задача не найдена: ${id})`;
    return `## Отчёт tool_run "${t.title}"\nСтатус: ${t.status}\n${t.feedback || '(нет отчёта)'}`;
  }).join('\n\n');
  const eyes = workspaceDir ? buildEyes(workspaceDir) : '(workspace не передан)';
  const userText = [
    '## Режим: оценка',
    reports || '(tool_run задач не было — оценивай по факту их отсутствия)',
    `## Файлы продукта (read-only, первые строки/фильтр мусора)\n${eyes}`,
  ].join('\n\n');

  let result;
  try {
    result = await callAgent({
      role: 'researcher', promptFile: 'researcher.md', userText, json: true, runId, agent: 'researcher',
    });
  } catch (e) {
    return { ok: false, error: `researcher: сбой шлюза на оценке (${e.message})` };
  }

  if (result && result.verdict === 'data_unavailable') {
    const clientNote = typeof result.client_note === 'string' && result.client_note.trim()
      ? result.client_note
      : 'Данные для этой задачи недоступны в открытом виде.';
    progress(`[researcher] оценка: data_unavailable — ${clientNote.slice(0, 120)}`);
    return { ok: true, verdict: 'data_unavailable', clientNote };
  }
  if (result && result.verdict === 'proceed') {
    progress(`[researcher] оценка: proceed — ${(result.data_summary || '').slice(0, 120)}`);
    return {
      ok: true, verdict: 'proceed', dataSummary: result.data_summary || '', forArchitect: result.for_architect || '',
    };
  }
  return { ok: false, error: 'researcher: ответ на оценку не распознан (ни proceed, ни data_unavailable) — нарушен JSON-контракт' };
}

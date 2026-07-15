// evals/judge.js — LLM-as-judge на DAG архитектора (§14.3, П§6.3
// DEV_GUIDE part2). Один вызов chat('cheap', DAG+рубрика, {json:true}).
// НИКОГДА не блокирует прогон — только метрика (§14: уровень 3, наблюдение,
// не ворота): событие eval_score логируется всегда, даже если шлюз упал
// (result:null, error — тоже полезный сигнал для последующего анализа).
import { chat } from '../core/gateway.js';
import { getTask, logEvent } from '../core/journal.js';

const RUBRIC = [
  'Ты judge. Оцени план задач архитектора (DAG) по трём осям, каждая от 0 до 1:',
  '- atomicity: каждая задача — одна атомарная измеримая цель, не солянка из нескольких.',
  '- dupes: 1 = дублирующихся/пересекающихся по смыслу задач нет, 0 = много дублей.',
  '- touches_realism: touches_files выглядят реалистично для описанной задачи.',
  'Ответь строго JSON без фенсов: {"atomicity":0..1,"dupes":0..1,"touches_realism":0..1,"score":0..1,"notes":"кратко почему"}',
  '"score" — твоя интегральная оценка (не обязана быть средним трёх выше).',
].join('\n');

/**
 * judgeArchitectPlan({taskIds, runId}) -> {ok, result, error}
 * Метрика, не ворота: вызывающий код НИКОГДА не должен ветвиться на .ok.
 */
export async function judgeArchitectPlan({ taskIds, runId }) {
  const tasks = taskIds.map(getTask).filter(Boolean);
  const dag = tasks.map((t) => ({
    title: t.title,
    type: t.type,
    touches_files: (() => { try { return JSON.parse(t.touches_files || '[]'); } catch { return []; } })(),
    spec: (t.spec || '').slice(0, 300),
  }));
  const userText = `## DAG архитектора (${dag.length} задач)\n${JSON.stringify(dag, null, 2)}`;

  let result = null;
  let error = null;
  try {
    result = await chat('cheap', [
      { role: 'system', content: RUBRIC },
      { role: 'user', content: userText },
    ], { json: true, run_id: runId, agent: 'judge' });
  } catch (e) {
    error = e.message;
  }

  logEvent({
    run_id: runId, type: 'eval_score', agent: 'judge', payload: { result, error },
  });

  return { ok: !error, result, error };
}

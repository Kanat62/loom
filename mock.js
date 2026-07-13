// Детерминированные ответы всех ролей (§24 ТЗ v4). Наполняется по мере
// появления ролей (Фаза 0 — только каркас, ветки заполняются по фазам).
// Сценарий-эталон: калькулятор, 2 задачи, первая с нарочной ошибкой в первой
// попытке (демонстрация цикла поймал → отчёт → починил). MOCK=1 — полный
// прогон без единого вызова модели.
//
// gateway.chat(role, messages, opts) вызывает mockChat() вместо claude-cli,
// когда config.MOCK === true (см. gateway.js, Фаза 1).
import { pathToFileURL } from 'node:url';

/** Возвращает [tier, callIndexForTier] — сколько раз tier этой роли уже звали. */
const callCounters = new Map();

function nextCallIndex(key) {
  const n = (callCounters.get(key) || 0) + 1;
  callCounters.set(key, n);
  return n;
}

export function resetMockState() {
  callCounters.clear();
}

/**
 * mockChat(role, messages, opts) -> { text, usage } синхронно (без сети).
 * Наполняется постепенно (агенты появляются в Фазах 1, 3, 5.5).
 */
export function mockChat(role, messages, opts = {}) {
  const idx = nextCallIndex(role);
  const userMsg = messages.find((m) => m.role === 'user')?.content || '';

  const handler = MOCK_HANDLERS[role];
  if (!handler) {
    throw new Error(`mock.js: нет MOCK-ветки для роли "${role}" (добавь в MOCK_HANDLERS)`);
  }
  return handler({ idx, userMsg, messages, opts });
}

// Роли добавляются по мере реализации (Фаза 1: coder/tester не-LLM;
// Фаза 3: advisor/router/architect/skill; Фаза 5.5: live_in).
export const MOCK_HANDLERS = {};

export function registerMockHandler(role, fn) {
  MOCK_HANDLERS[role] = fn;
}

// Точка входа `npm run mock`: полный смоук-прогон машины в MOCK-режиме.
// Наполняется по мере готовности coordinator/gateway (с Фазы 1).
async function main() {
  console.log('[mock] Фаза 0: каркас mock.js готов, ролевые ветки появятся с Фазы 1.');
  console.log('[mock] Проверка журнала...');
  const { addTask, getTask, releaseStuck } = await import('./journal.js');
  const id = addTask({ title: 'mock smoke', spec: 'noop', criteria: '{}' });
  const t = getTask(id);
  if (!t || t.id !== id) throw new Error('journal smoke failed');
  releaseStuck();
  console.log(`[mock] OK — задача ${id} создана и читается из журнала.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error('[mock] FAIL', e); process.exit(1); });
}

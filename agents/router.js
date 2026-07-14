// agents/router.js — один вызов лёгкой модели: {route, reason, criteria?}
// (§3, §1 ТЗ v4). Парсинг безопасный: ошибка → route='project' (ошибка в
// сторону завышения безопасна — полный цикл вместо мусорной точечной правки).
import { callAgent } from '../core/engine.js';

const KNOWN_ROUTES = new Set(['question', 'tweak', 'wish', 'problem', 'spec']);

function buildRouterPrompt(text, workspaceFiles) {
  const parts = [`## Запрос клиента\n${text}`];
  if (workspaceFiles.length) {
    parts.push(`## Файлы текущего продукта (только имена)\n${workspaceFiles.join('\n')}`);
  } else {
    parts.push('## Файлы текущего продукта\n(workspace пуст — продукта ещё нет)');
  }
  return parts.join('\n\n');
}

function fallbackResult(reason) {
  return { route: 'project', reason, criteria: null, complexity_score: null };
}

function normalize(result) {
  if (!result || typeof result !== 'object' || typeof result.route !== 'string') {
    return fallbackResult('router: ответ без корректного поля route');
  }
  if (!KNOWN_ROUTES.has(result.route)) {
    return fallbackResult(`router: неизвестный route "${result.route}"`);
  }
  if (result.route === 'tweak' && (!result.criteria || typeof result.criteria !== 'object' || !result.criteria.cmd)) {
    // Контракт §1: criteria ОБЯЗАТЕЛЕН для tweak. Без него — не доверяем
    // классификации, эскалируем на безопасный полный цикл.
    return fallbackResult('router: route=tweak без criteria — эскалация на project');
  }
  return {
    route: result.route,
    reason: typeof result.reason === 'string' ? result.reason : '',
    criteria: result.route === 'tweak' ? result.criteria : null,
    complexity_score: result.route === 'tweak' ? (result.complexity_score || null) : null,
  };
}

/**
 * routeRequest({text, workspaceFiles, runId}) → {route, reason, criteria, complexity_score}
 * Никогда не бросает — сбой шлюза сам по себе тоже эскалирует на 'project'.
 */
export async function routeRequest({ text, workspaceFiles = [], runId }) {
  const userText = buildRouterPrompt(text, workspaceFiles);
  try {
    const result = await callAgent({
      role: 'router', promptFile: 'router.md', userText, json: true, runId, agent: 'router',
    });
    return normalize(result);
  } catch (e) {
    return fallbackResult(`router: сбой шлюза (${e.message}) — ошибка в сторону завышения безопасна`);
  }
}

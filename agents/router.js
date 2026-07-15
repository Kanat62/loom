// agents/router.js — один вызов лёгкой модели: {route, reason, criteria?}
// (§3, §1 ТЗ v4). Парсинг безопасный: ошибка → route='project' (ошибка в
// сторону завышения безопасна — полный цикл вместо мусорной точечной правки).
//
// Verification-вход (шрам: «проверь фильтр работает как надо» отроутилось в
// problem, советник спросил у клиента то, что обязан был установить сам).
// Модель распознаёт verification и называет artifact — реальные task id для
// regression_of подставляет КОД (findVerificationTasks), не модель: LLM не
// видит журнал и не должен выдумывать id (факты раньше вопросов — тот же
// принцип применён к самому роутеру).
import { callAgent } from '../core/engine.js';
import { listTasks } from '../core/journal.js';
import { progress } from '../core/io.js';

const KNOWN_ROUTES = new Set(['question', 'tweak', 'wish', 'problem', 'spec']);

/**
 * Ищет существующие (не-regression) задачи, чей title упоминает artifact —
 * склейка их критериев станет regression_of (контракт §8.9: повтор
 * существующих критериев, НЕ генерация новой проверки, шрам 31).
 */
function findVerificationTasks(artifact) {
  const needle = artifact.trim().toLowerCase();
  if (!needle) return [];
  return listTasks({})
    .filter((t) => t.type !== 'regression' && t.title && t.title.toLowerCase().includes(needle))
    .map((t) => t.id);
}

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

  if (result.route === 'tweak' && result.verification === true) {
    const artifact = typeof result.artifact === 'string' ? result.artifact.trim() : '';
    if (!artifact) {
      return fallbackResult('router: verification-запрос без artifact — эскалация на project');
    }
    const ids = findVerificationTasks(artifact);
    if (!ids.length) {
      // Артефакт не найден среди существующих задач — регрессию собрать не
      // из чего. Не выдумываем criteria — уходим в read-only разбор кода
      // (аналитик реально прочитает файлы и честно ответит), а не в
      // мусорный tweak без проверки.
      return {
        route: 'question',
        reason: `verification: артефакт "${artifact}" не найден среди существующих задач — читаю код напрямую`,
        criteria: null,
        complexity_score: null,
      };
    }
    return {
      route: 'tweak',
      reason: typeof result.reason === 'string' ? result.reason : '',
      verification: true,
      artifact,
      criteria: { regression_of: ids },
      complexity_score: null,
    };
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
  let routed;
  try {
    const result = await callAgent({
      role: 'router', promptFile: 'router.md', userText, json: true, runId, agent: 'router',
    });
    routed = normalize(result);
  } catch (e) {
    routed = fallbackResult(`router: сбой шлюза (${e.message}) — ошибка в сторону завышения безопасна`);
  }
  // Печать рядом с уже существующим usage-событием (logEvent внутри chat(),
  // см. gateway.js) — здесь, а не у каждого вызывающего, чтобы прогресс был
  // виден одинаково и в live-сеансе, и в npm run mock (оба зовут routeRequest напрямую).
  progress(`[router] route=${routed.route} (${routed.reason})`);
  return routed;
}

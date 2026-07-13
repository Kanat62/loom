// agents/advisor.js — advisor_intake (§3 ТЗ v4): протоколы wish/problem/spec.
// Общие законы (§1, §3): клиент описывает результат, технические решения
// советник принимает сам («Принял инженерные решения»); технические вопросы
// клиенту ЗАПРЕЩЕНЫ на двух уровнях — промптом И regex-фильтром КОДОМ (шрам
// 15); мусорный вход не превращается в бриф (шрам 16).
import { callAgent } from '../engine.js';
import { MAX_INTERVIEW_TURNS } from '../config.js';

const PROTOCOL_FILES = {
  wish: 'advisor.wish.md',
  problem: 'advisor.problem.md',
  spec: 'advisor.spec.md',
};

// Шрам 15: «советник спрашивал клиента скорость в px». Регэксп ловит единицы
// измерения и явную техническую лексику — код-уровневый guard ПОВЕРХ промпта.
// ВАЖНО: `\b` в JS не распознаёт кириллицу как \w (найдено при живой
// проверке этого файла) — граница "буква→пробел" вокруг "мс"/"протокол" не
// матчится обычным \b. Используем lookaround с \p{L} (Unicode-буква, флаг u)
// вместо \b везде, где термин может стоять рядом с кириллицей.
const TECH_QUESTION_RE = new RegExp(
  [
    '(?<![\\p{L}\\d])(px|ms|мс|мсек|fps|mb|мб|gb|гб|kb|кб)(?![\\p{L}\\d])',
    '\\d+\\s*(пиксел\\w*|миллисекунд\\w*|секунд\\w*|кадр\\w*)',
    'протокол\\w*', 'алгоритм\\w*', 'фреймворк\\w*', 'framework',
    '(?<![\\p{L}\\d])API(?![\\p{L}\\d])', '(?<![\\p{L}\\d])REST(?![\\p{L}\\d])', '(?<![\\p{L}\\d])SQL(?![\\p{L}\\d])',
    'endpoint', 'таймаут\\w*', 'timeout', 'порт[ауов]?(?![\\p{L}\\d])', 'формат данных', 'схем[ауы] (?:БД|базы)',
    'версия \\S*(?:node|react|vue|python)', 'бэкенд\\w*', 'фронтенд\\w*', 'библиотек\\w*',
  ].join('|'),
  'iu',
);

export function containsTechnicalQuestion(text) {
  return TECH_QUESTION_RE.test(text || '');
}

// Шрам 16: мусорный вход («continue», <15 символов) не превращается в бриф.
export function isGarbageInput(text) {
  const t = (text || '').trim();
  if (t.length < 15) return true;
  if (/^continue$/i.test(t)) return true;
  return false;
}

const SAFE_FALLBACK_QUESTION = 'Опишите, пожалуйста, подробнее и своими словами, что именно должно получиться в результате?';

function renderHistory(history) {
  return history.map((turn) => {
    if (turn.role === 'client') return `Клиент: ${turn.text}`;
    if (turn.role === 'client_correction') return `Клиент (правка решений): ${turn.text}`;
    if (turn.role === 'advisor_ask') return `Советник (вопрос): ${turn.text}`;
    return `[СИСТЕМА] ${turn.text}`;
  }).join('\n');
}

function buildUserText(protocol, history) {
  return [
    `## Протокол\n${protocol}`,
    `## История диалога\n${renderHistory(history)}`,
    '## Задача на этот ход\nЕсли информации достаточно — верни {"ready":true,...}. Иначе верни ровно один уточняющий вопрос {"ask":"..."} строго по правилам протокола.',
  ].join('\n\n');
}

async function runAdvisorStep({ protocol, history, runId, retried = false }) {
  const userText = buildUserText(protocol, history);
  let result;
  try {
    result = await callAgent({
      role: 'advisor', promptFile: PROTOCOL_FILES[protocol], userText, json: true, runId, agent: 'advisor',
    });
  } catch (e) {
    return { type: 'ask', question: SAFE_FALLBACK_QUESTION, forcedFallback: true, error: e.message };
  }

  if (result && typeof result.ask === 'string' && result.ask.trim()) {
    if (containsTechnicalQuestion(result.ask)) {
      if (!retried) {
        const nudged = [...history, {
          role: 'system_note',
          text: 'Предыдущий вопрос содержал техническую деталь — клиенту такое спрашивать нельзя. Реши сам, либо задай вопрос только о желаемом результате.',
        }];
        return runAdvisorStep({ protocol, history: nudged, runId, retried: true });
      }
      // Код-уровневый guard побеждает модель безусловно (§1: "на двух уровнях").
      return { type: 'ask', question: SAFE_FALLBACK_QUESTION, forcedFallback: true };
    }
    return { type: 'ask', question: result.ask };
  }

  if (result && result.ready) {
    return {
      type: 'ready',
      summary: typeof result.summary === 'string' ? result.summary : '',
      engineeringDefaults: Array.isArray(result.engineering_defaults) ? result.engineering_defaults : [],
      problem: protocol === 'problem' && result.problem && typeof result.problem === 'object' ? result.problem : null,
    };
  }

  return { type: 'ask', question: SAFE_FALLBACK_QUESTION, forcedFallback: true };
}

async function forceFinalize(protocol, history) {
  return {
    type: 'ready',
    summary: renderHistory(history),
    engineeringDefaults: ['Интервью прервано предохранителем длины (MAX_INTERVIEW_TURNS) — решения приняты по имеющейся информации.'],
    problem: null,
    forced: true,
  };
}

export async function startIntake({ protocol, initialText, runId }) {
  const history = [{ role: 'client', text: initialText }];
  const step = await runAdvisorStep({ protocol, history, runId });
  if (step.type === 'ask') history.push({ role: 'advisor_ask', text: step.question });
  return { history, step };
}

export async function continueIntake({ protocol, history, clientReply, runId, turnCount = 1 }) {
  if (turnCount >= MAX_INTERVIEW_TURNS) {
    return { history, step: await forceFinalize(protocol, history) };
  }
  const newHistory = [...history, { role: 'client', text: clientReply }];
  const step = await runAdvisorStep({ protocol, history: newHistory, runId });
  if (step.type === 'ask') newHistory.push({ role: 'advisor_ask', text: step.question });
  return { history: newHistory, step };
}

export async function reviseDecisions({ protocol, history, correctionText, runId }) {
  const newHistory = [...history, { role: 'client_correction', text: correctionText }];
  const step = await runAdvisorStep({ protocol, history: newHistory, runId });
  return { history: newHistory, step };
}

export function buildBrief({ protocol, initialText, step }) {
  return {
    protocol,
    request: initialText,
    summary: step.summary,
    engineering_defaults: step.engineeringDefaults,
    problem: step.problem,
  };
}

/**
 * advisor_analyst (протокол question, §3): read-only, без интервью, без
 * задач. Один вызов, обычный текстовый ответ (не JSON).
 */
export async function runAnalyst({ question, rootSpec, workspaceListing = [], runId }) {
  const parts = [`## Вопрос клиента\n${question}`];
  parts.push(`## root_spec проекта\n${rootSpec || '(проект ещё не заведён — root_spec отсутствует)'}`);
  parts.push(`## Файлы продукта\n${workspaceListing.length ? workspaceListing.join('\n') : '(workspace пуст)'}`);
  try {
    return await callAgent({
      role: 'advisor', promptFile: 'advisor.analyst.md', userText: parts.join('\n\n'),
      json: false, runId, agent: 'advisor_analyst',
    });
  } catch (e) {
    return `Не удалось получить ответ аналитика: ${e.message}`;
  }
}

/**
 * Отчёт консультанта (§17): advisor_analyst из root_spec + доска +
 * engineering_defaults + источники данных. Печатается при закрытии
 * project-дерева (talk.js, после live_in). protocol='wish' опускает блок
 * «проблема» (см. prompts/advisor.report.md).
 */
export async function buildConsultantReport({
  protocol, rootSpec, engineeringDefaults = [], problem, boardSummary, liveinSummary, runId,
}) {
  const parts = [
    `## Протокол\n${protocol}`,
    `## root_spec (сводка)\n${rootSpec || '(нет)'}`,
    `## Принятые инженерные решения\n${engineeringDefaults.map((d) => `- ${d}`).join('\n') || '(нет)'}`,
  ];
  if (problem) {
    parts.push(`## Диагностика (только для protocol=problem)\n${JSON.stringify(problem, null, 2)}`);
  }
  parts.push(`## Доска (задачи дерева)\n${boardSummary || '(нет данных)'}`);
  parts.push(`## Обживание (контур 2)\n${liveinSummary || '(не проводилось)'}`);

  try {
    return await callAgent({
      role: 'advisor', promptFile: 'advisor.report.md', userText: parts.join('\n\n'),
      json: false, runId, agent: 'consultant_report',
    });
  } catch (e) {
    return `Не удалось сформировать отчёт консультанта: ${e.message}`;
  }
}

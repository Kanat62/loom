// agents/specwriter.js — spec_writer (§28.2 ТЗ §28): пишет полное ТЗ
// документом ПОСЛЕ брифа советника и ДО архитектора — не решает технологии
// (те уже в engineering_defaults), не пишет код продукта, только фиксирует
// ЧТО должно получиться и почему. Тот же приёмный конвейер, что и внешний
// ingest-путь (§11) — этот модуль лишь производит вход для него, не
// дублирует разбор дыр/противоречий (см. agents/ingest.js:findSpecHoles,
// переиспользуется в §28 Stage C).
import fs from 'node:fs';
import path from 'node:path';
import { callAgent } from '../core/engine.js';

export const TZ_REL_PATH = path.join('docs', 'TZ.md');

// Порядок и формулировки — ДОСЛОВНО те, что задаются моделью в
// prompts/specwriter.md (§28.2 п.1-8): harness сверяет по заголовкам, не по
// содержимому — модель обязана воспроизводить эти фразы в markdown-заголовках.
const REQUIRED_SECTIONS = [
  'Цель и пользователи',
  'Функциональные требования',
  'Нефункциональные требования',
  'Экраны и сценарии',
  'Данные',
  'Приёмка',
  'За рамками',
  'Открытые вопросы',
];

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function headingRegex(phrase) {
  // Заголовок markdown ("#".."####") ГДЕ-ТО на строке содержит фразу —
  // не привязываемся к точному номеру/уровню, только к самой формулировке.
  return new RegExp(`^#{1,4}[^\\n]*${escapeRegExp(phrase)}`, 'im');
}

/** Тело секции — от заголовка до следующего заголовка любого уровня, либо до конца документа. */
function sectionBody(tzMd, phrase) {
  const re = headingRegex(phrase);
  const m = re.exec(tzMd);
  if (!m) return null;
  const rest = tzMd.slice(m.index + m[0].length);
  const nextHeading = /^#{1,4}\s/m.exec(rest);
  return (nextHeading ? rest.slice(0, nextHeading.index) : rest).trim();
}

/**
 * validateTzMd(tzMd, requirements) -> {ok:true} | {ok:false, reason}
 * Детерминированная проверка (§28.2): все обязательные секции по
 * заголовкам присутствуют, "За рамками" не пуста (ТЗ без границ — не ТЗ),
 * и КАЖДОЕ requirements[i] дословно (id и текст) встречается в самом
 * markdown — требования не украшение текста, а его источник; расхождение
 * машинного массива с документом = брак, не мелочь.
 */
export function validateTzMd(tzMd, requirements) {
  if (typeof tzMd !== 'string' || !tzMd.trim()) {
    return { ok: false, reason: 'tz_md пуст или не строка' };
  }
  for (const phrase of REQUIRED_SECTIONS) {
    if (!headingRegex(phrase).test(tzMd)) {
      return { ok: false, reason: `нет секции "${phrase}"` };
    }
  }
  const scopeBody = sectionBody(tzMd, 'За рамками');
  if (!scopeBody) {
    return { ok: false, reason: 'секция "За рамками" пуста — ТЗ без границ не ТЗ' };
  }
  for (const r of requirements) {
    if (!tzMd.includes(r.id)) {
      return { ok: false, reason: `требование ${r.id} не упомянуто в tz_md` };
    }
    if (!tzMd.includes(r.text)) {
      return { ok: false, reason: `требование ${r.id}: текст в tz_md расходится с requirements (не найден дословно)` };
    }
  }
  return { ok: true };
}

/** sanitizeRequirements(raw) -> [{id,text,priority}] — только валидные записи, приоритет по умолчанию 'must'. */
function sanitizeRequirements(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((r) => r && typeof r.id === 'string' && r.id.trim() && typeof r.text === 'string' && r.text.trim())
    .map((r) => ({
      id: r.id.trim(),
      text: r.text.trim(),
      priority: r.priority === 'should' ? 'should' : 'must',
    }));
}

function renderTranscript(transcript) {
  if (!Array.isArray(transcript) || !transcript.length) return '(интервью не проводилось — только исходный запрос клиента)';
  return transcript.map((turn) => {
    if (turn.role === 'client') return `Клиент: ${turn.text}`;
    if (turn.role === 'client_correction') return `Клиент (правка решений): ${turn.text}`;
    if (turn.role === 'advisor_ask') return `Советник (вопрос): ${turn.text}`;
    return `[СИСТЕМА] ${turn.text}`;
  }).join('\n');
}

function buildSpecWriterPrompt({
  brief, transcript, researcherNote, topLessons,
}) {
  const parts = [
    `## Бриф советника\nПротокол: ${brief.protocol}\nЗапрос клиента: ${brief.request}\nСводка: ${brief.summary || ''}`,
    `## Принятые инженерные решения (используй дословно, не передумывай)\n${(brief.engineering_defaults || []).map((d) => `- ${d}`).join('\n') || '(нет)'}`,
    `## Полная стенограмма интервью советника\n${renderTranscript(transcript)}`,
  ];
  if (researcherNote) {
    parts.push(`## Данные, добытые исследователем (§10, только для problem-маршрута)\n${researcherNote}`);
  }
  if (Array.isArray(topLessons) && topLessons.length) {
    parts.push(`## Уроки прошлых проектов (skills.db)\n${topLessons.map((l) => `- ${l}`).join('\n')}`);
  }
  return parts.join('\n\n');
}

async function callSpecWriterModel({
  brief, transcript, researcherNote, topLessons, runId, retryReason,
}) {
  const parts = [buildSpecWriterPrompt({
    brief, transcript, researcherNote, topLessons,
  })];
  if (retryReason) {
    parts.push(`## Предыдущий ответ отклонён харнессом\n${retryReason}\nИсправь и ответь заново строго по контракту из системного промпта.`);
  }
  return callAgent({
    role: 'spec_writer', promptFile: 'specwriter.md', userText: parts.join('\n\n'), json: true, runId, agent: 'spec_writer',
  });
}

function validateResponse(raw) {
  const requirements = sanitizeRequirements(raw?.requirements);
  if (!requirements.length) {
    return { requirements, validation: { ok: false, reason: 'requirements пуст или невалиден' } };
  }
  return { requirements, validation: validateTzMd(raw?.tz_md, requirements) };
}

/**
 * runSpecWriter({brief, transcript, researcherNote, topLessons, workspaceDir, runId}) →
 *   {ok:true, tzMd, requirements, openQuestions, tzPath} — ТЗ прошло проверку,
 *     записано в workspaceDir/docs/TZ.md (если workspaceDir передан);
 *   {ok:false, error} — сбой шлюза, либо ТЗ невалидно после ОДНОЙ повторной
 *     попытки (§28.2: "лестница как у всех").
 */
export async function runSpecWriter({
  brief, transcript = [], researcherNote = null, topLessons = [], workspaceDir, runId,
}) {
  let raw;
  try {
    raw = await callSpecWriterModel({
      brief, transcript, researcherNote, topLessons, runId,
    });
  } catch (e) {
    return { ok: false, error: `spec_writer: сбой шлюза (${e.message})` };
  }

  let { requirements, validation } = validateResponse(raw);
  if (!validation.ok) {
    let retry;
    try {
      retry = await callSpecWriterModel({
        brief, transcript, researcherNote, topLessons, runId, retryReason: `ТЗ отклонено харнессом: ${validation.reason}`,
      });
    } catch (e) {
      return { ok: false, error: `spec_writer: сбой шлюза на повторной попытке (${e.message})` };
    }
    const retried = validateResponse(retry);
    if (!retried.validation.ok) {
      return { ok: false, error: `spec_writer: ТЗ невалидно после повторной попытки (${retried.validation.reason})` };
    }
    raw = retry;
    requirements = retried.requirements;
  }

  const openQuestions = Array.isArray(raw.open_questions)
    ? raw.open_questions.filter((q) => typeof q === 'string' && q.trim())
    : [];

  let tzPath = null;
  if (workspaceDir) {
    const docsDir = path.join(workspaceDir, 'docs');
    fs.mkdirSync(docsDir, { recursive: true });
    tzPath = path.join(workspaceDir, TZ_REL_PATH);
    fs.writeFileSync(tzPath, raw.tz_md, 'utf8');
  }

  return {
    ok: true, tzMd: raw.tz_md, requirements, openQuestions, tzPath,
  };
}

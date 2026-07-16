// agents/designer.js — designer (§27.2 ТЗ §27): законодатель дизайна, не
// исполнитель. Издаёт дизайн-систему (tokens.css + DESIGN.md) ОДИН раз на
// проект, ДО архитектора — файлы продукта не трогает (§3 сохраняется).
// Харнесс (не модель) пишет файлы на диск; коммит — обычным autoCommit
// координатора на первом же ходе кодера (git add -A подхватит уже
// лежащие на диске файлы, отдельный коммит здесь не нужен — см. DECISIONS
// §27 Stage A).
import fs from 'node:fs';
import path from 'node:path';
import { callAgent } from '../core/engine.js';

export const DESIGN_DIR_NAME = 'design';
export const TOKENS_REL_PATH = path.join(DESIGN_DIR_NAME, 'tokens.css');
export const DESIGN_MD_REL_PATH = 'DESIGN.md';

// Группы токенов, обязательные в tokens_css (§27.2), и минимум деклараций
// в каждой ("минимум 5" для цвета — фон/поверхность/текст/primary/danger).
const REQUIRED_TOKEN_GROUPS = {
  '--color-': 5,
  '--space-': 4,
  '--radius-': 1,
  '--font-': 1,
  '--shadow-': 1,
};

function buildDesignerPrompt(brief, existingTokensCss) {
  const parts = [
    `## Бриф\nПротокол: ${brief.protocol}\nЗапрос клиента: ${brief.request}\nСводка: ${brief.summary || ''}`,
    `## Принятые инженерные решения\n${(brief.engineering_defaults || []).map((d) => `- ${d}`).join('\n') || '(нет)'}`,
  ];
  if (existingTokensCss) {
    parts.push([
      '## Существующая дизайн-система (расширение продукта)',
      'Система уже издана раньше в этом же проекте — уточни/расширь её при',
      'необходимости, но НЕ переизобретай с нуля (разнобой — то, с чем боремся):',
      existingTokensCss,
    ].join('\n'));
  }
  return parts.join('\n\n');
}

/**
 * validateTokensCss(css) -> {ok:true} | {ok:false, reason}
 * Простой CSS-парс без зависимостей (§27.2: "скобочный баланс + регэксп
 * деклараций достаточно"): только :root{}/[data-theme=...]{} блоки, никаких
 * селекторов продукта, обязательные группы токенов с минимумом деклараций.
 */
export function validateTokensCss(cssRaw) {
  if (typeof cssRaw !== 'string' || !cssRaw.trim()) {
    return { ok: false, reason: 'tokens_css пуст или не строка' };
  }
  const css = cssRaw.replace(/\/\*[\s\S]*?\*\//g, '').trim();
  if (!css) return { ok: false, reason: 'tokens_css содержит только комментарии' };

  const opens = (css.match(/\{/g) || []).length;
  const closes = (css.match(/\}/g) || []).length;
  if (opens === 0 || opens !== closes) {
    return { ok: false, reason: `несбалансированные фигурные скобки ({: ${opens}, }: ${closes})` };
  }

  const blockRe = /(:root|\[data-theme=[^\]]*\])\s*\{([^{}]*)\}/g;
  let rest = css;
  let sawRootBlock = false;
  let match;
  // eslint-disable-next-line no-cond-assign
  while ((match = blockRe.exec(css))) {
    sawRootBlock = true;
    rest = rest.replace(match[0], '');
  }
  if (!sawRootBlock) {
    return { ok: false, reason: 'нет ни одного :root {} блока — нужны токены, не готовые стили' };
  }
  if (rest.trim()) {
    return { ok: false, reason: `посторонний селектор вместо токенов: "${rest.trim().slice(0, 80)}"` };
  }

  const declNames = css.match(/--[a-zA-Z0-9-]+(?=\s*:)/g) || [];
  const counts = {};
  for (const name of declNames) {
    for (const prefix of Object.keys(REQUIRED_TOKEN_GROUPS)) {
      if (name.startsWith(prefix)) counts[prefix] = (counts[prefix] || 0) + 1;
    }
  }
  for (const [prefix, min] of Object.entries(REQUIRED_TOKEN_GROUPS)) {
    if ((counts[prefix] || 0) < min) {
      return { ok: false, reason: `группа токенов ${prefix}* — нужно минимум ${min}, найдено ${counts[prefix] || 0}` };
    }
  }
  return { ok: true };
}

async function callDesignerModel({
  brief, existingTokensCss, runId, retryReason,
}) {
  const parts = [buildDesignerPrompt(brief, existingTokensCss)];
  if (retryReason) {
    parts.push(`## Предыдущий ответ отклонён харнессом\n${retryReason}\nИсправь и ответь заново строго по контракту из системного промпта.`);
  }
  return callAgent({
    role: 'designer', promptFile: 'designer.md', userText: parts.join('\n\n'), json: true, runId, agent: 'designer',
  });
}

/**
 * runDesigner({brief, workspaceDir, runId}) →
 *   {ok:true, skipped:true, tokensPath, designMdPath} — система уже издана
 *     раньше (tweak/повторный project по тому же проекту), модель не звалась;
 *   {ok:true, skipped:false, tokensPath, designMdPath, direction} — издана
 *     и записана харнессом;
 *   {ok:false, error} — сбой шлюза, либо токены невалидны после ОДНОЙ
 *     повторной попытки (§27.2: "дизайнер тоже живёт по лестнице").
 */
export async function runDesigner({ brief, workspaceDir, runId }) {
  const designDir = path.join(workspaceDir, DESIGN_DIR_NAME);
  const tokensPath = path.join(workspaceDir, TOKENS_REL_PATH);
  const designMdPath = path.join(workspaceDir, DESIGN_MD_REL_PATH);

  // Один раз на проект (§27.2): если система уже издана, дизайнер НЕ
  // вызывается вовсе — повторное издание значило бы разнобой, ровно то, с
  // чем эта роль борется.
  if (fs.existsSync(tokensPath)) {
    return {
      ok: true, skipped: true, tokensPath, designMdPath,
    };
  }

  let raw;
  try {
    raw = await callDesignerModel({ brief, runId });
  } catch (e) {
    return { ok: false, error: `designer: сбой шлюза (${e.message})` };
  }

  let validation = validateTokensCss(raw?.tokens_css);
  if (!validation.ok) {
    let retry;
    try {
      retry = await callDesignerModel({
        brief, runId, retryReason: `Токены не прошли проверку харнесса: ${validation.reason}`,
      });
    } catch (e) {
      return { ok: false, error: `designer: сбой шлюза на повторной попытке (${e.message})` };
    }
    const retryValidation = validateTokensCss(retry?.tokens_css);
    if (!retryValidation.ok) {
      return { ok: false, error: `designer: токены невалидны после повторной попытки (${retryValidation.reason})` };
    }
    raw = retry;
    validation = retryValidation;
  }

  if (typeof raw.design_md !== 'string' || !raw.design_md.trim()) {
    return { ok: false, error: 'designer: design_md отсутствует или пуст' };
  }

  fs.mkdirSync(designDir, { recursive: true });
  fs.writeFileSync(tokensPath, raw.tokens_css, 'utf8');
  fs.writeFileSync(designMdPath, raw.design_md, 'utf8');

  return {
    ok: true,
    skipped: false,
    tokensPath,
    designMdPath,
    direction: typeof raw.direction === 'string' ? raw.direction : '',
  };
}

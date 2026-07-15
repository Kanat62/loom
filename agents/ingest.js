// agents/ingest.js — приём ТЗ-пакета (§11, П§6.2 DEV_GUIDE part2). Читает
// папку с документами, по документу за вызов разбирает требования
// (advisor.spec-протокол, режим «разбор документа»), затем ОДНИМ вызовом
// ищет дыры/противоречия в своде всех требований (режим «поиск дыр»).
// Парсинг pdf/бинарных макетов — за рамками v1.0-final (см. DECISIONS):
// такие файлы учитываются честной строкой-заглушкой, не читаются.
import fs from 'node:fs';
import path from 'node:path';
import { callAgent } from '../core/engine.js';
import { progress } from '../core/io.js';

const TEXT_EXTENSIONS = new Set(['.md', '.txt', '.json']);

function readDocuments(folderPath) {
  const names = fs.readdirSync(folderPath)
    .filter((f) => fs.statSync(path.join(folderPath, f)).isFile())
    .sort();
  return names.map((name) => {
    const full = path.join(folderPath, name);
    const ext = path.extname(name).toLowerCase();
    if (!TEXT_EXTENSIONS.has(ext)) {
      const sizeKb = Math.ceil(fs.statSync(full).size / 1024);
      return { name, text: `[${name}, ${sizeKb}КБ — не читается, учтён как артефакт]`, artifact: true };
    }
    return { name, text: fs.readFileSync(full, 'utf8'), artifact: false };
  });
}

/** parseSpecDocument({name, text, runId}) -> [{id,text,source}, ...] | {error} */
export async function parseSpecDocument({ name, text, runId }) {
  if (!text || !text.trim()) return [];
  const userText = ['## Режим: разбор документа', `## Файл: ${name}`, text].join('\n\n');
  let result;
  try {
    result = await callAgent({
      role: 'advisor', promptFile: 'advisor.spec.md', userText, json: true, runId, agent: 'advisor',
    });
  } catch (e) {
    return { error: `ingest: сбой разбора документа "${name}" (${e.message})` };
  }
  const reqs = Array.isArray(result?.requirements) ? result.requirements : [];
  return reqs
    .filter((r) => r && typeof r.id === 'string' && r.id.trim() && typeof r.text === 'string' && r.text.trim())
    // id делаем глобально уникальным приклейкой имени файла (§11 п.2) — сама
    // модель отвечает только за уникальность ВНУТРИ документа.
    .map((r) => ({ id: `${name}:${r.id}`, text: r.text, source: name }));
}

/** findSpecHoles({requirements, runId}) -> {holes,contradictions,questions} | {error} */
export async function findSpecHoles({ requirements, runId }) {
  if (!requirements.length) return { holes: [], contradictions: [], questions: [] };
  const listing = requirements.map((r) => `- ${r.id} (${r.source}): ${r.text}`).join('\n');
  const userText = ['## Режим: поиск дыр', `## Все требования пакета\n${listing}`].join('\n\n');
  let result;
  try {
    result = await callAgent({
      role: 'advisor', promptFile: 'advisor.spec.md', userText, json: true, runId, agent: 'advisor',
    });
  } catch (e) {
    return { error: `ingest: сбой поиска дыр (${e.message})` };
  }
  return {
    holes: Array.isArray(result?.holes) ? result.holes : [],
    contradictions: Array.isArray(result?.contradictions) ? result.contradictions : [],
    questions: Array.isArray(result?.questions) ? result.questions : [],
  };
}

/**
 * runIngest({folderPath, runId}) ->
 * {ok, docs, requirements, combinedText, parseErrors, holes, contradictions, questions} | {ok:false, error}
 */
export async function runIngest({ folderPath, runId }) {
  const docs = readDocuments(folderPath);
  const requirements = [];
  const parseErrors = [];
  for (const doc of docs) {
    // eslint-disable-next-line no-await-in-loop
    const res = await parseSpecDocument({ name: doc.name, text: doc.text, runId });
    if (res && !Array.isArray(res) && res.error) { parseErrors.push(res.error); continue; }
    requirements.push(...res);
    progress(`[ingest] ${doc.name}: требований найдено ${res.length}`);
  }

  const holesResult = await findSpecHoles({ requirements, runId });
  if (holesResult.error) return { ok: false, error: holesResult.error };

  const combinedText = requirements.map((r) => `[${r.id}] ${r.text}`).join('\n');
  return {
    ok: true,
    docs,
    requirements,
    combinedText,
    parseErrors,
    holes: holesResult.holes,
    contradictions: holesResult.contradictions,
    questions: holesResult.questions,
  };
}

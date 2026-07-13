// agents/coder.js — вариант А (JSON-контракт, §7 ТЗ v4): вход =
// system(prompts/coder.md) + user(задача + feedback + глаза); выход строго
// {"files":{...}} | {"question":"..."}; запись — харнессом, только под
// workspace (замок пути — обязательный минимум с первого дня, §12.1).
import fs from 'node:fs';
import path from 'node:path';
import { chat } from '../gateway.js';
import { PROMPTS_DIR, EYES_MAX_FILE_BYTES, EYES_IGNORE_PATTERNS, EYES_BINARY_EXT } from '../config.js';

const CODER_SYSTEM_PROMPT = fs.readFileSync(path.join(PROMPTS_DIR, 'coder.md'), 'utf8');

function listFilesRecursive(dir, base = dir, acc = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    if (entry.name.startsWith('.loom-check-')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) listFilesRecursive(full, base, acc);
    else acc.push(path.relative(base, full));
  }
  return acc;
}

/**
 * Глаза кодера — Фаза 1: ПОЛНЫЙ снимок workspace (дельта — Фаза 2, §6.1).
 * Фильтр мусора СРАЗУ (шрам 30): .min/бинарники/>50КБ → строка-заглушка,
 * никогда не льём содержимое таких файлов в контекст.
 */
export function buildEyes(workspaceDir) {
  if (!fs.existsSync(workspaceDir)) return '(workspace пуст — файлов ещё нет)';
  const files = listFilesRecursive(workspaceDir).sort();
  if (!files.length) return '(workspace пуст — файлов ещё нет)';

  const blocks = files.map((relPath) => {
    const abs = path.join(workspaceDir, relPath);
    const relPosix = relPath.split(path.sep).join('/');
    const ext = path.extname(relPath).toLowerCase();
    let stat;
    try { stat = fs.statSync(abs); } catch { return `=== ${relPosix} ===\n[недоступен]`; }

    const ignoredByName = EYES_IGNORE_PATTERNS.some((re) => re.test(relPath));
    if (ignoredByName || EYES_BINARY_EXT.has(ext) || stat.size > EYES_MAX_FILE_BYTES) {
      return `=== ${relPosix} ===\n[библиотека/бинарник, ${stat.size}Б — не читается; сторонние библиотеки подключай через CDN <script src>, не переписывай файлом]`;
    }
    const content = fs.readFileSync(abs, 'utf8');
    return `=== ${relPosix} ===\n${content}`;
  });

  return blocks.join('\n\n');
}

function buildUserPrompt(task, eyes) {
  const parts = [
    `## Задача\n${task.title}\n\n${task.spec || ''}`,
    `## Критерий приёмки (справочно, правке не подлежит)\n${task.criteria || ''}`,
  ];
  if (task.feedback) {
    parts.push(`## Отчёт тестера (последняя попытка, почини именно это)\n${task.feedback}`);
  }
  parts.push(`## Текущие файлы workspace\n${eyes}`);
  return parts.join('\n\n');
}

/** Замок пути (§12.1): запись только внутри workspace, никаких '..'/абсолютных путей/дисков. */
export function isPathInsideWorkspace(workspaceDir, relPath) {
  if (typeof relPath !== 'string' || !relPath.trim()) return false;
  if (path.isAbsolute(relPath)) return false;
  if (/^[a-zA-Z]:/.test(relPath)) return false; // диск Windows без ведущего слеша, напр. "C:evil.js"
  const resolved = path.resolve(workspaceDir, relPath);
  const rel = path.relative(workspaceDir, resolved);
  if (rel === '') return false;
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * runCoder({task, workspaceDir, runId}) — один ход кодера.
 * Возвращает {type:'files', written} | {type:'question', question} | {type:'error', error}.
 */
export async function runCoder({ task, workspaceDir, runId }) {
  const eyes = buildEyes(workspaceDir);
  const userText = buildUserPrompt(task, eyes);
  const messages = [
    { role: 'system', content: CODER_SYSTEM_PROMPT },
    { role: 'user', content: userText },
  ];

  const result = await chat('coder', messages, {
    json: true, run_id: runId, task_id: task.id, agent: 'coder',
  });

  if (result && typeof result.question === 'string') {
    return { type: 'question', question: result.question };
  }
  if (!result || typeof result.files !== 'object' || result.files === null) {
    return { type: 'error', error: 'coder: ответ без files и без question (нарушен JSON-контракт)' };
  }

  fs.mkdirSync(workspaceDir, { recursive: true });
  const written = [];
  const rejected = [];
  for (const [relPath, content] of Object.entries(result.files)) {
    if (!isPathInsideWorkspace(workspaceDir, relPath)) {
      rejected.push(relPath);
      continue;
    }
    const abs = path.resolve(workspaceDir, relPath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, typeof content === 'string' ? content : JSON.stringify(content, null, 2), 'utf8');
    written.push(relPath);
  }

  if (rejected.length) {
    return {
      type: 'error',
      error: `coder: запись вне workspace заблокирована замком пути: ${rejected.join(', ')}`,
      written,
    };
  }

  return { type: 'files', written };
}

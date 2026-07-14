// agents/coder.js — вариант А (JSON-контракт, §7 ТЗ v4): вход =
// system(prompts/coder.md) + user(задача + feedback + глаза); выход строго
// {"files":{...}} | {"question":"..."}; запись — харнессом, только под
// workspace (замок пути — обязательный минимум с первого дня, §12.1).
import fs from 'node:fs';
import path from 'node:path';
import { chat } from '../core/gateway.js';
import { PROMPTS_DIR, EYES_MAX_FILE_BYTES, EYES_IGNORE_PATTERNS, EYES_BINARY_EXT } from '../core/config.js';

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

/** Только имена файлов (без содержимого) — для router/talk, которым полные глаза не нужны. */
export function listWorkspaceFileNames(workspaceDir) {
  if (!fs.existsSync(workspaceDir)) return [];
  return listFilesRecursive(workspaceDir).sort().map((p) => p.split(path.sep).join('/'));
}

function fileBlock(workspaceDir, relPath) {
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
}

/**
 * Полный снимок workspace: имя+содержимое (с фильтром мусора, шрам 30)
 * каждого файла.
 */
export function buildEyes(workspaceDir) {
  if (!fs.existsSync(workspaceDir)) return '(workspace пуст — файлов ещё нет)';
  const files = listFilesRecursive(workspaceDir).sort();
  if (!files.length) return '(workspace пуст — файлов ещё нет)';
  return files.map((relPath) => fileBlock(workspaceDir, relPath)).join('\n\n');
}

function snapshotMeta(workspaceDir) {
  const map = new Map();
  for (const relPath of listFilesRecursive(workspaceDir)) {
    const abs = path.join(workspaceDir, relPath);
    try {
      const stat = fs.statSync(abs);
      map.set(relPath, { size: stat.size, mtimeMs: stat.mtimeMs });
    } catch { /* файл исчез между листингом и stat — пропускаем */ }
  }
  return map;
}

function diffSnapshots(prev, curr) {
  const added = [];
  const changed = [];
  const removed = [];
  for (const [relPath, meta] of curr) {
    const prevMeta = prev.get(relPath);
    if (!prevMeta) added.push(relPath);
    else if (prevMeta.size !== meta.size || prevMeta.mtimeMs !== meta.mtimeMs) changed.push(relPath);
  }
  for (const relPath of prev.keys()) {
    if (!curr.has(relPath)) removed.push(relPath);
  }
  return { added, changed, removed };
}

/**
 * Дельта, не снимок (§6.1, шрам 9: v2 слал весь workspace — 34К токенов на
 * ход). Ход 2 (второй вызов кодера на ЭТОЙ задаче) — ещё полный snapshot,
 * ходы 3+ — только added/changed/removed относительно того, что кодер видел
 * на прошлом ходу этой же задачи. Состояние снимка — в памяти процесса,
 * ключ task_id; при рестарте процесса просто откатываемся к полному снимку
 * (не баг — деградация в сторону больших, но корректных данных).
 */
const lastSeenSnapshot = new Map(); // task_id -> Map(relPath -> {size, mtimeMs})

export function clearEyesState(taskId) {
  lastSeenSnapshot.delete(taskId);
}

export function buildEyesForAttempt(workspaceDir, taskId, attempt) {
  const currSnap = fs.existsSync(workspaceDir) ? snapshotMeta(workspaceDir) : new Map();
  const prevSnap = lastSeenSnapshot.get(taskId);
  lastSeenSnapshot.set(taskId, currSnap);

  if (attempt <= 2 || !prevSnap) {
    return buildEyes(workspaceDir);
  }

  const { added, changed, removed } = diffSnapshots(prevSnap, currSnap);
  if (!added.length && !changed.length && !removed.length) {
    return '(изменений в файлах с прошлого хода нет)';
  }

  const parts = [];
  if (added.length) {
    parts.push(`### Добавлены\n${added.map((p) => fileBlock(workspaceDir, p)).join('\n\n')}`);
  }
  if (changed.length) {
    parts.push(`### Изменены\n${changed.map((p) => fileBlock(workspaceDir, p)).join('\n\n')}`);
  }
  if (removed.length) {
    parts.push(`### Удалены\n${removed.map((p) => `- ${p.split(path.sep).join('/')}`).join('\n')}`);
  }
  return `(дельта с прошлого хода — неизменённые файлы не показаны)\n\n${parts.join('\n\n')}`;
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
  const eyes = buildEyesForAttempt(workspaceDir, task.id, task.attempts);
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

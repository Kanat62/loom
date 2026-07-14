// skills.db — отдельная БД уроков (§4 ТЗ v4). BEGIN DEFERRED: перезапись урока
// допустима, строгость журнала задач тут не нужна. writeSkill() вызывается
// механически координатором после каждой завершённой задачи; фильтр
// галлюцинаций (шрам 24) обязателен на входе — чужой язык/несуществующий файл
// → отброс, нет урока → SKIP, ничего не пишется.
import { openDb } from './db.js';
import { SKILLS_DB_PATH } from './config.js';

let _db = null;

function db() {
  if (!_db) {
    _db = openDb(SKILLS_DB_PATH);
    _db.exec(`
      CREATE TABLE IF NOT EXISTS skills (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT,
        files TEXT,
        lesson TEXT,
        created_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_skills_task ON skills(task_id);
    `);
  }
  return _db;
}

// Проект — JS/TS. Упоминание файлов чужого языка — верный признак галлюцинации
// (шрам 24: уроки про Unity/Python в JS-проекте).
const FOREIGN_EXT_RE = /\.(py|cs|java|rb|go|php|swift|kt|cpp|cc|c|rs|m|mm)\b/i;
const FILE_TOKEN_RE = /\b[\w./-]+\.[a-zA-Z]{1,6}\b/g;

// Общие имена, которые допустимо упоминать без явного присутствия в touches_files.
const GENERIC_OK = new Set(['package.json', 'package-lock.json', 'node_modules', 'tsconfig.json', '.env', '.gitignore']);

/**
 * Фильтр галлюцинаций: урок обязан ссылаться только на реальные файлы задачи.
 * Возвращает {ok:true} либо {ok:false, reason}.
 */
export function hallucinationGuard(lesson, allowedFiles = []) {
  if (!lesson || typeof lesson !== 'string' || lesson.trim().length < 5) {
    return { ok: false, reason: 'empty' };
  }
  if (FOREIGN_EXT_RE.test(lesson)) {
    return { ok: false, reason: 'foreign-language-file-mentioned' };
  }
  const allowed = new Set((allowedFiles || []).map((f) => f.replace(/\\/g, '/').toLowerCase()));
  const tokens = lesson.match(FILE_TOKEN_RE) || [];
  for (const tok of tokens) {
    const norm = tok.replace(/\\/g, '/').toLowerCase();
    const base = norm.split('/').pop();
    if (GENERIC_OK.has(base)) continue;
    const isAllowed = [...allowed].some((f) => f === norm || f.endsWith('/' + base) || base === f.split('/').pop());
    if (!isAllowed) {
      return { ok: false, reason: `unknown-file-reference:${tok}` };
    }
  }
  return { ok: true };
}

/**
 * writeSkill({task_id, files, lesson}) — применяет hallucinationGuard, при
 * провале — SKIP (ничего не пишется, возвращает null).
 */
export function writeSkill({ task_id, files = [], lesson }) {
  const guard = hallucinationGuard(lesson, files);
  if (!guard.ok) {
    return { skipped: true, reason: guard.reason };
  }
  db().prepare(`
    INSERT INTO skills (task_id, files, lesson, created_at) VALUES (?, ?, ?, ?)
  `).run(task_id || null, JSON.stringify(files || []), lesson, Date.now());
  return { skipped: false };
}

export function listSkills() {
  return db().prepare(`SELECT * FROM skills ORDER BY id ASC`).all();
}

/**
 * Поиск уроков. grep+SQL LIKE хватает до 100+ записей (§4, анти-скоуп §23);
 * FTS5 — задел на будущее, не подключаем раньше времени.
 */
export function searchSkills(query) {
  const all = listSkills();
  // TODO(Фаза 8): переключить на FTS5 после 100+ записей (§4); до тех пор grep+SQL хватает.
  const q = query.toLowerCase();
  return all.filter((s) => s.lesson.toLowerCase().includes(q));
}

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

// Фаза 8 (§4, П§7 DEV_GUIDE part2): FTS5 включается ТОЛЬКО после порога
// 100+ записей — до тех пор LIKE честно быстрее заводить виртуальную
// таблицу впустую. Поддержка FTS5 сборкой sqlite проверяется ОДИН раз за
// процесс и кэшируется (try/catch — node:sqlite иногда собран без FTS5, тот
// же паттерн деградации, что better-sqlite3→node:sqlite в core/db.js);
// сам count пересчитывается на каждый search (таблица уроков небольшая,
// полный COUNT(*) дёшев) — так порог 100 честно ловится в СЕРЕДИНЕ живого
// процесса, а не только при следующем перезапуске.
let ftsSupported = null; // null = не проверено, true/false — итог первой попытки

function probeFtsSupport(d) {
  if (ftsSupported !== null) return ftsSupported;
  try {
    d.exec("CREATE VIRTUAL TABLE IF NOT EXISTS skills_fts USING fts5(lesson, content='skills', content_rowid='id')");
    ftsSupported = true;
  } catch {
    ftsSupported = false; // сборка sqlite без FTS5 — деградация в LIKE, не сбой
  }
  return ftsSupported;
}

function ensureFts() {
  const d = db();
  const { n } = d.prepare('SELECT COUNT(*) AS n FROM skills').get();
  if (n < 100) return false;
  if (!probeFtsSupport(d)) return false;
  // INSERT OR IGNORE, не "WHERE id NOT IN (SELECT rowid FROM skills_fts)":
  // тот вариант подставляет skills_fts И источником, И назначением в ОДНОМ
  // statement — для виртуальных таблиц (FTS5) это недокументированное
  // поведение SQLite, на практике молча портит инвертированный индекс
  // (COUNT(*) показывал верно 106, но MATCH ничего не находил — поймано
  // именно evals/fts.js на 106-й записи, не на глаз). OR IGNORE опирается на
  // обычный конфликт по rowid — тот же результат, без самоссылки в подзапросе.
  d.exec(`
    INSERT OR IGNORE INTO skills_fts(rowid, lesson) SELECT id, lesson FROM skills;
    CREATE TRIGGER IF NOT EXISTS skills_ai AFTER INSERT ON skills BEGIN
      INSERT INTO skills_fts(rowid, lesson) VALUES (new.id, new.lesson);
    END;
    CREATE TRIGGER IF NOT EXISTS skills_ad AFTER DELETE ON skills BEGIN
      INSERT INTO skills_fts(skills_fts, rowid, lesson) VALUES('delete', old.id, old.lesson);
    END;
    CREATE TRIGGER IF NOT EXISTS skills_au AFTER UPDATE ON skills BEGIN
      INSERT INTO skills_fts(skills_fts, rowid, lesson) VALUES('delete', old.id, old.lesson);
      INSERT INTO skills_fts(rowid, lesson) VALUES (new.id, new.lesson);
    END;
  `);
  return true;
}

/** Поиск уроков — FTS5 при наличии (100+ записей и сборка её поддерживает), иначе LIKE (§4, П§7). */
export function searchSkills(query) {
  const q = (query || '').trim();
  if (!q) return [];
  if (ensureFts()) {
    try {
      const phrase = `"${q.replace(/"/g, '""')}"`; // фраза целиком — не парсим MATCH-синтаксис пользовательского ввода
      return db().prepare(`
        SELECT skills.* FROM skills_fts JOIN skills ON skills.id = skills_fts.rowid
        WHERE skills_fts MATCH ? ORDER BY rank
      `).all(phrase);
    } catch {
      // конкретный запрос не разобрался FTS-движком — падаем на LIKE ниже, не роняем прогон
    }
  }
  const needle = q.toLowerCase();
  return listSkills().filter((s) => s.lesson.toLowerCase().includes(needle));
}

/** Диагностика для evals/fts.js — какой путь поиска сейчас активен (не для продуктового кода). */
export function _ftsDebugStatus() {
  return { active: ensureFts(), supported: ftsSupported };
}

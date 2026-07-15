// Журнал — единственный источник правды (§4 ТЗ v4). Атомарный захват задач
// (BEGIN IMMEDIATE), run_id-трейсинг событий, бюджеты. Не думает — защищает
// целостность.
import crypto from 'node:crypto';
import { openDb } from './db.js';
import { JOURNAL_DB_PATH } from './config.js';

let _db = null;

function db() {
  if (!_db) {
    _db = openDb(JOURNAL_DB_PATH);
    migrate(_db);
  }
  return _db;
}

// Идемпотентная добавка колонки: SQLite не даёт ADD COLUMN IF NOT EXISTS,
// PRAGMA table_info — стандартный кросс-драйверный способ проверить, что
// правка уже применена (П§2 DEV_GUIDE part2: без отдельного
// migration-фреймворка, старый journal.db открывается без потери данных).
function ensureColumn(d, table, column, ddl) {
  const cols = d.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) {
    d.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }
}

function migrate(d) {
  d.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      project_id TEXT DEFAULT 'default',
      title TEXT,
      spec TEXT,
      criteria TEXT,
      role TEXT DEFAULT 'coder',
      type TEXT DEFAULT 'project',
      status TEXT DEFAULT 'pending',
      touches_files TEXT,
      touches_functions TEXT,
      blocked_by_task_id TEXT REFERENCES tasks(id),
      budget_usd REAL DEFAULT 2.0,
      spent_usd REAL DEFAULT 0.0,
      claimed_by TEXT,
      attempts INTEGER DEFAULT 0,
      feedback TEXT,
      question TEXT,
      created_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT,
      task_id TEXT,
      type TEXT,
      agent TEXT,
      duration_ms INTEGER,
      tokens_in INTEGER,
      tokens_out INTEGER,
      cost_usd REAL,
      payload TEXT,
      created_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS root_spec (
      project_id TEXT PRIMARY KEY,
      spec TEXT,
      engineering_defaults TEXT,
      route TEXT,
      created_at INTEGER
    );

    -- П§2 DEV_GUIDE part2: фундамент Кузницы (§26) и настоящего fan-in (Фаза 6).
    CREATE TABLE IF NOT EXISTS tools (
      name TEXT PRIMARY KEY,
      version INTEGER DEFAULT 1,
      description TEXT,
      entry TEXT DEFAULT 'run.js',
      network TEXT DEFAULT 'none',
      timeout_ms INTEGER DEFAULT 60000,
      created_by_task TEXT,
      status TEXT DEFAULT 'active',
      usage_count INTEGER DEFAULT 0,
      last_used_at INTEGER,
      created_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS task_deps (
      task_id TEXT NOT NULL,
      blocked_by TEXT NOT NULL,
      PRIMARY KEY (task_id, blocked_by)
    );

    CREATE INDEX IF NOT EXISTS idx_tasks_status_role ON tasks(status, role);
    CREATE INDEX IF NOT EXISTS idx_events_run ON events(run_id);
    CREATE INDEX IF NOT EXISTS idx_events_task ON events(task_id);
    CREATE INDEX IF NOT EXISTS idx_task_deps_task ON task_deps(task_id);
  `);

  // tasks.tool_name — существующие БД до этой правки не имеют колонки
  // (26.2: связывает type='tool'/'tool_run' задачу с записью в tools).
  ensureColumn(d, 'tasks', 'tool_name', 'tool_name TEXT');
  // tasks.covers — П§6.2 (§11): трассировка требование→задача для ingest
  // ТЗ-пакета. JSON-массив req id ('файл.md:R1'), '[]' для задач вне ingest.
  ensureColumn(d, 'tasks', 'covers', "covers TEXT DEFAULT '[]'");
}

function jsonOrNull(v) {
  if (v === undefined || v === null) return null;
  return typeof v === 'string' ? v : JSON.stringify(v);
}

export function newId(prefix = 't') {
  return `${prefix}_${crypto.randomUUID()}`;
}

export function newRunId() {
  return crypto.randomUUID();
}

/**
 * addTask(t) -> id (§4, DEV_GUIDE §1). t.tool_name (26.2: связь с tools) и
 * t.deps (П§2: массив task id — настоящий fan-in через task_deps, вдобавок
 * к устаревающему одиночному blocked_by_task_id, который остаётся рабочим
 * для обратной совместимости).
 */
export function addTask(t) {
  const id = t.id || newId('task');
  db().prepare(`
    INSERT INTO tasks
      (id, project_id, title, spec, criteria, role, type, status,
       touches_files, touches_functions, blocked_by_task_id,
       budget_usd, spent_usd, claimed_by, attempts, feedback, question, created_at, tool_name, covers)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    t.project_id || 'default',
    t.title || '',
    t.spec || '',
    jsonOrNull(t.criteria),
    t.role || 'coder',
    t.type || 'project',
    t.status || 'pending',
    jsonOrNull(t.touches_files) || '[]',
    jsonOrNull(t.touches_functions) || '[]',
    t.blocked_by_task_id || null,
    t.budget_usd ?? 2.0,
    0.0,
    null,
    0,
    t.feedback || null,
    t.question || null,
    Date.now(),
    t.tool_name || null,
    jsonOrNull(t.covers) || '[]',
  );
  if (Array.isArray(t.deps) && t.deps.length) {
    const depStmt = db().prepare('INSERT OR IGNORE INTO task_deps (task_id, blocked_by) VALUES (?, ?)');
    for (const depId of t.deps) {
      if (depId) depStmt.run(id, depId);
    }
  }
  return id;
}

/**
 * claimNext(role, claimedBy, {activeTouches, excludeTypes}) -> task|null
 * BEGIN IMMEDIATE: pending, роль совпадает, И одиночная зависимость (если
 * есть) done/merged, И все зависимости из task_deps (если есть) done/merged
 * (П§2: настоящий fan-in — обе формы должны быть удовлетворены одновременно).
 *
 * activeTouches (Фаза 6, П§5 weave по файлам) — необязательный массив путей,
 * которые уже трогают ДРУГИЕ claimed/merge_pending задачи прямо сейчас;
 * candidate с пересекающимися touches_files пропускается в пользу
 * следующего по created_at. Пересечение массивов JSON — в JS, не в SQL
 * (JSON в SQLite парсить SQL-выражением хрупко, П§5 прямо это оговаривает):
 * выбираем всех кандидатов ОДНИМ запросом внутри той же BEGIN IMMEDIATE
 * транзакции, фильтруем в JS, захватываем первого непересекающегося.
 * Без activeTouches (однопоточный путь, как раньше) — поведение НЕ меняется:
 * первый кандидат по created_at, тот же результат, что был при LIMIT 1.
 *
 * excludeTypes — необязательный массив типов, которые эта попытка захвата
 * не должна брать (Фаза 6: параллельный воркер работает в СВОЁМ worktree,
 * а type='regression'/'tool_run' обязаны исполняться против main —
 * §16 п.8, «регрессия строго после пустой очереди мёржей» — воркер их не трогает,
 * дожидается последовательной фазы после параллельной).
 */
export function claimNext(role, claimedBy = 'worker', { activeTouches, excludeTypes } = {}) {
  const d = db();
  d.exec('BEGIN IMMEDIATE');
  try {
    let candidates = d.prepare(`
      SELECT t.* FROM tasks t
      WHERE t.status = 'pending' AND t.role = ?
        AND (
          t.blocked_by_task_id IS NULL
          OR EXISTS (
            SELECT 1 FROM tasks b WHERE b.id = t.blocked_by_task_id AND b.status IN ('done','merged')
          )
        )
        AND NOT EXISTS (
          SELECT 1 FROM task_deps td
          JOIN tasks bt ON bt.id = td.blocked_by
          WHERE td.task_id = t.id AND bt.status NOT IN ('done','merged')
        )
      ORDER BY t.created_at ASC
    `).all(role);

    if (excludeTypes && excludeTypes.length) {
      const ex = new Set(excludeTypes);
      candidates = candidates.filter((c) => !ex.has(c.type));
    }

    let row = null;
    if (!activeTouches || !activeTouches.length) {
      row = candidates[0] || null;
    } else {
      const activeSet = new Set(activeTouches);
      row = candidates.find((c) => {
        let touches;
        try { touches = JSON.parse(c.touches_files || '[]'); } catch { touches = []; }
        // Задача без объявленных touches_files не считается пересекающейся ни
        // с чем (архитектор ОБЯЗАН объявлять их в Фазе 6, но деградация для
        // задач без объявления — «разрешить», не «зависнуть навсегда»).
        return !touches.some((f) => activeSet.has(f));
      }) || null;
    }

    if (!row) {
      d.exec('COMMIT');
      return null;
    }

    // attempts НЕ трогаем здесь: захват — не то же самое, что фактическая
    // попытка (budget-стоп может отвести только что захваченную задачу в
    // blocked_needs_human ДО вызова кодера — см. incrementAttempts).
    const res = d.prepare(`
      UPDATE tasks SET status='claimed', claimed_by=?
      WHERE id=? AND status='pending'
    `).run(claimedBy, row.id);

    d.exec('COMMIT');
    if (res.changes === 0) return null; // проиграли гонку другому процессу
    return getTask(row.id);
  } catch (e) {
    try { d.exec('ROLLBACK'); } catch { /* noop */ }
    throw e;
  }
}

/**
 * setStatus(id, status, {feedback?, question?}) — feedback ПЕРЕЗАПИСЫВАЕТСЯ,
 * не накапливается (§4, шрам: рост контекста). claimed_by сбрасывается, когда
 * задача покидает claimed — КРОМЕ перехода в 'merge_pending' (Фаза 6, П§5):
 * задача там всё ещё «принадлежит» воркеру/worktree'у, чья ветка ждёт
 * слияния — core/merge.js:mergeOneTask читает claimed_by, чтобы найти,
 * КАКОЙ worktree/branch сливать (`loom/w<i>`); обнулять его раньше времени
 * значило бы потерять эту связь ровно тогда, когда она нужнее всего.
 */
export function setStatus(id, status, extra = {}) {
  const clearClaim = status !== 'claimed' && status !== 'merge_pending';
  const fields = ['status = ?'];
  const args = [status];
  if (clearClaim) { fields.push('claimed_by = ?'); args.push(null); }
  if ('feedback' in extra) { fields.push('feedback = ?'); args.push(extra.feedback ?? null); }
  if ('question' in extra) { fields.push('question = ?'); args.push(extra.question ?? null); }
  args.push(id);
  db().prepare(`UPDATE tasks SET ${fields.join(', ')} WHERE id = ?`).run(...args);
}

/** Отмечает начало РЕАЛЬНОЙ попытки (вызов кодера уже точно состоится). */
export function incrementAttempts(id) {
  db().prepare(`UPDATE tasks SET attempts = attempts + 1 WHERE id = ?`).run(id);
  return getTask(id)?.attempts;
}

/** Прибавляет фактическую стоимость вызова к spent_usd. Возвращает новый spent_usd. */
export function addSpent(id, amountUsd) {
  db().prepare(`UPDATE tasks SET spent_usd = spent_usd + ? WHERE id = ?`).run(amountUsd, id);
  return getTask(id)?.spent_usd;
}

export function isOverBudget(id) {
  const t = getTask(id);
  if (!t) return false;
  return t.spent_usd >= t.budget_usd;
}

/** releaseStuck() — убитый процесс оставляет claimed-задачи; возвращаем в pending (шрам 25). */
export function releaseStuck() {
  const res = db().prepare(`
    UPDATE tasks SET status='pending', claimed_by=NULL WHERE status='claimed'
  `).run();
  return res.changes;
}

export function getTask(id) {
  return db().prepare(`SELECT * FROM tasks WHERE id = ?`).get(id) || null;
}

export function listTasks(filter = {}) {
  const clauses = [];
  const args = [];
  for (const col of ['status', 'role', 'type', 'project_id']) {
    if (filter[col] !== undefined) { clauses.push(`${col} = ?`); args.push(filter[col]); }
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return db().prepare(`SELECT * FROM tasks ${where} ORDER BY created_at ASC`).all(...args);
}

/** logEvent({run_id, task_id, type, agent, duration_ms, tokens_in, tokens_out, cost_usd, payload}) */
export function logEvent(e) {
  db().prepare(`
    INSERT INTO events (run_id, task_id, type, agent, duration_ms, tokens_in, tokens_out, cost_usd, payload, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    e.run_id || null,
    e.task_id || null,
    e.type || 'status',
    e.agent || null,
    e.duration_ms ?? null,
    e.tokens_in ?? null,
    e.tokens_out ?? null,
    e.cost_usd ?? null,
    jsonOrNull(e.payload),
    Date.now(),
  );
}

export function listEvents(filter = {}) {
  const clauses = [];
  const args = [];
  for (const col of ['run_id', 'task_id', 'type', 'agent']) {
    if (filter[col] !== undefined) { clauses.push(`${col} = ?`); args.push(filter[col]); }
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return db().prepare(`SELECT * FROM events ${where} ORDER BY id ASC`).all(...args);
}

/** Все события с created_at >= ts — для сеансового (не per-run_id) итога по токенам. */
export function listEventsSince(ts) {
  return db().prepare(`SELECT * FROM events WHERE created_at >= ? ORDER BY id ASC`).all(ts);
}

export function setRootSpec(projectId, spec, engineeringDefaults, route) {
  db().prepare(`
    INSERT INTO root_spec (project_id, spec, engineering_defaults, route, created_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(project_id) DO UPDATE SET spec=excluded.spec, engineering_defaults=excluded.engineering_defaults, route=excluded.route
  `).run(projectId, spec, jsonOrNull(engineeringDefaults), route || null, Date.now());
}

export function getRootSpec(projectId = 'default') {
  return db().prepare(`SELECT * FROM root_spec WHERE project_id = ?`).get(projectId) || null;
}

/** Для evals/race.js и диагностики — прямой доступ к сырой БД не экспортируем специально. */
export function _debugDbPath() {
  return JOURNAL_DB_PATH;
}

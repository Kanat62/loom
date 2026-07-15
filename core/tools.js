// core/tools.js — Кузница инструментов (§26 ТЗ v4, П§1/П§4 DEV_GUIDE
// part2). Реестр — таблица `tools` в journal.db (не отдельная БД:
// регистрация транзакционно связана с задачами, §26.1); отдельное
// соединение (openDb на тот же файл — WAL уже настроен journal.js,
// несколько соединений к одному WAL-файлу штатны), модульная граница
// чище, чем расширение journal.js чужой предметной областью.
//
// Инвариант (26.3 п.1, нарушение = баг): инструмент исполняется ТОЛЬКО
// дочерним процессом (`node <TOOLS_DIR>/<name>/run.js …args`). Код
// инструмента НИКОГДА не require'ится/import'ится в процесс координатора —
// у инструмента не должно быть теоретической возможности дотянуться до
// journal.db/prompts (§12.6).
import { spawn } from 'node:child_process';
import path from 'node:path';
import { openDb } from './db.js';
import { JOURNAL_DB_PATH, TOOLS_DIR } from './config.js';
import { logEvent } from './journal.js';

let _db = null;
function db() {
  if (!_db) _db = openDb(JOURNAL_DB_PATH);
  return _db;
}

/**
 * registerTool(manifest) → запись/апгрейд в tools (26.2 «Сборка»): имя
 * занято и описание отличается → version+1, статус прежней записи не
 * трогается (история — в git tools-репозитория, не в этой таблице).
 * Имя занято, описание СОВПАДАЕТ → просто обновление метаданных (та же
 * версия, повторная регистрация того же инструмента идемпотентна).
 */
export function registerTool({
  name, description, entry = 'run.js', network = 'none', timeout_ms = 60000, created_by_task, runId,
}) {
  const existing = getTool(name);
  const version = existing && existing.description !== description ? existing.version + 1 : (existing ? existing.version : 1);
  db().prepare(`
    INSERT INTO tools (name, version, description, entry, network, timeout_ms, created_by_task, status, usage_count, last_used_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'active', COALESCE((SELECT usage_count FROM tools WHERE name = ?), 0), (SELECT last_used_at FROM tools WHERE name = ?), ?)
    ON CONFLICT(name) DO UPDATE SET
      version = excluded.version, description = excluded.description, entry = excluded.entry,
      network = excluded.network, timeout_ms = excluded.timeout_ms, created_by_task = excluded.created_by_task,
      status = 'active'
  `).run(name, version, description, entry, network, timeout_ms, created_by_task || null, name, name, Date.now());

  logEvent({
    run_id: runId || null, task_id: created_by_task || null, type: 'tool_registered', agent: 'coordinator',
    payload: { name, version, description },
  });
  return getTool(name);
}

export function getTool(name) {
  return db().prepare('SELECT * FROM tools WHERE name = ?').get(name) || null;
}

export function listTools() {
  return db().prepare('SELECT * FROM tools ORDER BY name ASC').all();
}

// Фаза 8 (§4, П§7): тот же порог/деградация, что core/skills.js — FTS5
// только после 100+ инструментов; поддержка FTS5 пробуется один раз за
// процесс и кэшируется, count пересчитывается на каждый search (дёшево,
// таблица маленькая) — порог честно ловится в середине живого процесса.
// `tools.name` — TEXT PRIMARY KEY, но неявный rowid всё равно есть (таблица
// не WITHOUT ROWID) — used as content_rowid, как и полагается
// external-content FTS5.
let ftsSupported = null;

function probeFtsSupport(d) {
  if (ftsSupported !== null) return ftsSupported;
  try {
    d.exec("CREATE VIRTUAL TABLE IF NOT EXISTS tools_fts USING fts5(name, description, content='tools', content_rowid='rowid')");
    ftsSupported = true;
  } catch {
    ftsSupported = false; // сборка sqlite без FTS5 — деградация в LIKE, не сбой
  }
  return ftsSupported;
}

function ensureFts() {
  const d = db();
  const { n } = d.prepare('SELECT COUNT(*) AS n FROM tools').get();
  if (n < 100) return false;
  if (!probeFtsSupport(d)) return false;
  // INSERT OR IGNORE — см. подробное объяснение в core/skills.js:ensureFts
  // (тот же баг: self-referential "WHERE rowid NOT IN (SELECT ... FROM
  // tools_fts)" молча портит FTS5-индекс, найдено evals/fts.js).
  d.exec(`
    INSERT OR IGNORE INTO tools_fts(rowid, name, description) SELECT rowid, name, description FROM tools;
    CREATE TRIGGER IF NOT EXISTS tools_ai AFTER INSERT ON tools BEGIN
      INSERT INTO tools_fts(rowid, name, description) VALUES (new.rowid, new.name, new.description);
    END;
    CREATE TRIGGER IF NOT EXISTS tools_ad AFTER DELETE ON tools BEGIN
      INSERT INTO tools_fts(tools_fts, rowid, name, description) VALUES('delete', old.rowid, old.name, old.description);
    END;
    CREATE TRIGGER IF NOT EXISTS tools_au AFTER UPDATE ON tools BEGIN
      INSERT INTO tools_fts(tools_fts, rowid, name, description) VALUES('delete', old.rowid, old.name, old.description);
      INSERT INTO tools_fts(rowid, name, description) VALUES (new.rowid, new.name, new.description);
    END;
  `);
  return true;
}

/** findTools(query) — FTS5 при наличии (100+ записей и сборка её поддерживает), иначе LIKE (§4, П§7). */
export function findTools(query) {
  const q = (query || '').trim();
  if (!q) return [];
  if (ensureFts()) {
    try {
      const phrase = `"${q.replace(/"/g, '""')}"`;
      return db().prepare(`
        SELECT tools.* FROM tools_fts JOIN tools ON tools.rowid = tools_fts.rowid
        WHERE tools_fts MATCH ? ORDER BY rank
      `).all(phrase);
    } catch {
      // конкретный запрос не разобрался FTS-движком — падаем на LIKE ниже
    }
  }
  const needle = `%${q}%`;
  return db().prepare('SELECT * FROM tools WHERE name LIKE ? OR description LIKE ? ORDER BY name ASC').all(needle, needle);
}

/** Диагностика для evals/fts.js — какой путь поиска сейчас активен (не для продуктового кода). */
export function _ftsDebugStatus() {
  return { active: ensureFts(), supported: ftsSupported };
}

function recordUsage(name) {
  db().prepare('UPDATE tools SET usage_count = usage_count + 1, last_used_at = ? WHERE name = ?').run(Date.now(), name);
}

/**
 * runTool(name, args, {cwd, runId, taskId}) → {ok, code, stdout, stderr, duration_ms}
 * Правила (26.3, нарушение = баг):
 * 1. Только дочерний процесс `node`; cwd = workspace текущего продукта —
 *    данные ложатся внутрь продукта, не внутрь tools/<name>/.
 * 2. Окружение минимальное (PATH и всё) — .env LOOM внутрь не передаётся,
 *    секреты оркестратора инструментам не принадлежат.
 * 3. Таймаут из манифеста, потолок 300с (как MODEL_TIMEOUT); stdout/stderr
 *    режутся до 4000 символов для контекста.
 * 4. Песочница — здесь только локальный путь; Docker-уровень (workspace rw,
 *    tools/<name> ro, --network none при network:"none") — до появления
 *    обязательного демона Docker в среде сборки (см. DECISIONS, Docker уже
 *    опционален для checkRunner по той же причине). Честно НЕ enforce'ит
 *    сетевую политику физически — только логирует событие tool_network.
 * 5. Каждый запуск — событие tool_run (name, args, code, duration) +
 *    usage_count/last_used_at в реестре — независимо от исхода (провал
 *    инструмента — тоже диагностируемый факт, не только успех).
 */
export function runTool(name, args, { cwd, runId, taskId } = {}) {
  const tool = getTool(name);
  if (!tool) {
    const names = listTools().map((t) => t.name).join(', ') || '(пусто)';
    return Promise.resolve({
      ok: false, code: null, duration_ms: 0, stdout: '',
      stderr: `runTool: инструмент "${name}" не зарегистрирован. Существующие: ${names}`,
    });
  }

  const scriptPath = path.join(TOOLS_DIR, name, tool.entry);
  const timeoutMs = Math.min(tool.timeout_ms || 60000, 300_000);
  const argv = (args || []).map(String);

  return new Promise((resolve) => {
    const t0 = Date.now();
    let settled = false;
    let stdout = '';
    let stderr = '';

    const child = spawn('node', [scriptPath, ...argv], {
      cwd,
      env: { PATH: process.env.PATH || '' }, // минимальное окружение (26.3 п.2) — .env LOOM НЕ передаётся
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      finish(null, true);
    }, timeoutMs);

    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stderr += `\nspawn-error: ${e.message}`;
      finish(null, false);
    });
    child.on('exit', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      finish(code, false);
    });

    function finish(code, timedOut) {
      const duration_ms = Date.now() - t0;
      recordUsage(name);
      if (tool.network === 'none') {
        // Честное ограничение (26.3 п.4): локальный путь сеть физически не
        // enforce'ит — только фиксирует политику как факт для аудита.
        logEvent({
          run_id: runId || null, task_id: taskId || null, type: 'tool_network', agent: 'coordinator',
          payload: { name, declared: 'none', enforced: false },
        });
      }
      logEvent({
        run_id: runId || null, task_id: taskId || null, type: 'tool_run', agent: 'coordinator',
        duration_ms,
        payload: {
          name, args: argv, code, timed_out: timedOut, network: tool.network,
        },
      });
      resolve({
        ok: !timedOut && code === 0,
        code,
        duration_ms,
        stdout: stdout.slice(0, 4000),
        stderr: (timedOut ? `${stderr}\nFAIL: таймаут инструмента (${timeoutMs}мс)` : stderr).slice(0, 4000),
      });
    }
  });
}

// core/projects.js — реестр проектов (§29.1 ТЗ v4, шрам 35): проект как
// первоклассная сущность со своим workspace, не только колонка в схеме —
// колонка без фильтра в каждой точке чтения/записи изоляцией не является
// (реальный инцидент — см. docs/DECISIONS.md «§29»). Таблица `projects`
// создаётся в core/journal.js:migrate() (тот же паттерн, что `tools` —
// схема живёт в journal.js, даже когда основной потребитель — другой
// модуль); здесь — отдельное соединение (openDb на тот же файл, WAL уже
// настроен journal.js), тот же приём, что core/tools.js/core/skills.js.
import path from 'node:path';
import crypto from 'node:crypto';
import { openDb } from './db.js';
import { JOURNAL_DB_PATH, WORKSPACE } from './config.js';
import { slugify } from './github.js';

let _db = null;
function db() {
  if (!_db) _db = openDb(JOURNAL_DB_PATH);
  return _db;
}

/** projectWorkspaceDir(projectId) — <WORKSPACE>/<project_id>/, единый корень продукта (§29.1). */
export function projectWorkspaceDir(projectId) {
  return path.join(WORKSPACE, projectId);
}

/**
 * createProject({title, workspaceDir}) → новая запись, id — слаг(title) +
 * короткий хеш (детерминированная санитизация — slugify из core/github.js,
 * переиспользована для той же дисциплины, что уже применяется к имени
 * GitHub-репозитория, §29.1, а не задублирована заново). Для живого
 * продукта клиента, рождённого из брифа wish/problem/spec — talk.js/
 * telegram.js. Для фиксированных id служебных/eval-проектов — ensureProject.
 */
export function createProject({ title, workspaceDir } = {}) {
  const base = slugify(title, 'project');
  const id = `${base}-${crypto.randomBytes(3).toString('hex')}`;
  const dir = workspaceDir || projectWorkspaceDir(id);
  const now = Date.now();
  db().prepare(`
    INSERT INTO projects (id, title, workspace_dir, status, created_at, last_active_at)
    VALUES (?, ?, ?, 'active', ?, ?)
  `).run(id, title || id, dir, now, now);
  return getProject(id);
}

/**
 * ensureProject(id, {title, workspaceDir, status}) — идемпотентный upsert с
 * ЯВНЫМ id (не автогенерируемым слагом): для eval/manual/ops-скриптов и
 * миграции legacy, которым нужен фиксированный предсказуемый project_id, не
 * для живых продуктов клиента (те — через createProject). Повторный вызов
 * с тем же id только обновляет last_active_at, не трогает title/status.
 */
export function ensureProject(id, { title, workspaceDir, status = 'active' } = {}) {
  const existing = getProject(id);
  const now = Date.now();
  if (existing) {
    db().prepare(`UPDATE projects SET last_active_at = ? WHERE id = ?`).run(now, id);
    return getProject(id);
  }
  const dir = workspaceDir || projectWorkspaceDir(id);
  db().prepare(`
    INSERT INTO projects (id, title, workspace_dir, status, created_at, last_active_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, title || id, dir, status, now, now);
  return getProject(id);
}

export function getProject(id) {
  return db().prepare(`SELECT * FROM projects WHERE id = ?`).get(id) || null;
}

export function listProjects(filter = {}) {
  const clauses = [];
  const args = [];
  if (filter.status !== undefined) { clauses.push('status = ?'); args.push(filter.status); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return db().prepare(`SELECT * FROM projects ${where} ORDER BY last_active_at DESC`).all(...args);
}

export function touchProject(id) {
  db().prepare(`UPDATE projects SET last_active_at = ? WHERE id = ?`).run(Date.now(), id);
}

export function setProjectStatus(id, status) {
  db().prepare(`UPDATE projects SET status = ? WHERE id = ?`).run(status, id);
}

/**
 * resolveSingleActiveProject() → {ok:true, project} если РОВНО один active;
 * {ok:false, reason:'none'} / {ok:false, reason:'multiple', projects} иначе.
 * Чистая функция БЕЗ интерактивности (§29.1) — решение "что делать при
 * multiple/none" остаётся за вызывающим (talk.js спрашивает человека
 * интерактивно, bin/ask.js честно падает и т.д.).
 */
export function resolveSingleActiveProject() {
  const active = listProjects({ status: 'active' });
  if (active.length === 1) return { ok: true, project: active[0] };
  if (active.length === 0) return { ok: false, reason: 'none' };
  return { ok: false, reason: 'multiple', projects: active };
}

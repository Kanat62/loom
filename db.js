// Тонкий адаптер БД: better-sqlite3 (предпочтительно) | node:sqlite (fallback).
// Нативная сборка better-sqlite3 иногда падает на Windows (инвариант §20.8) —
// в этом случае откатываемся на встроенный node:sqlite без остановки установки.
import path from 'node:path';
import fs from 'node:fs';

// require() недоступен напрямую в ESM — эмулируем через createRequire.
import { createRequire } from 'node:module';
const require_ = createRequire(import.meta.url);

function pickDriver() {
  try {
    const BetterSqlite3 = require_('better-sqlite3');
    return { name: 'better-sqlite3', Database: BetterSqlite3 };
  } catch (e) {
    return { name: 'node:sqlite', Database: null };
  }
}

/**
 * Открывает БД по пути, создаёт директорию при необходимости.
 * Возвращает унифицированный интерфейс: exec, prepare(sql)->{run,get,all}, close.
 */
export function openDb(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const chosen = pickDriver();

  if (chosen.name === 'better-sqlite3') {
    const db = new chosen.Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 5000');
    return {
      driverName: 'better-sqlite3',
      exec: (sql) => db.exec(sql),
      prepare: (sql) => {
        const stmt = db.prepare(sql);
        return {
          run: (...args) => stmt.run(...args),
          get: (...args) => stmt.get(...args),
          all: (...args) => stmt.all(...args),
        };
      },
      close: () => db.close(),
    };
  }

  // node:sqlite fallback
  const { DatabaseSync } = require_('node:sqlite');
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');
  return {
    driverName: 'node:sqlite',
    exec: (sql) => db.exec(sql),
    prepare: (sql) => {
      const stmt = db.prepare(sql);
      return {
        run: (...args) => stmt.run(...args),
        get: (...args) => stmt.get(...args),
        all: (...args) => stmt.all(...args),
      };
    },
    close: () => db.close(),
  };
}

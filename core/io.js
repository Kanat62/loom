// Один readline на процесс, очередь строк (шрам 27: readline терял
// опережающий ввод — пользователь печатал раньше, чем подписывались на 'line').
// Плюс санитизация ввода сеанса (шрам 32: терминальный мусор склеился в title).
import readline from 'node:readline';
import { QUIET } from './config.js';

let rl = null;
const queue = [];
const waiters = [];

function ensureRl() {
  if (rl) return rl;
  rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: !!process.stdin.isTTY });
  rl.on('line', (line) => {
    if (waiters.length) {
      const resolve = waiters.shift();
      resolve(line);
    } else {
      queue.push(line);
    }
  });
  return rl;
}

export function startInput() {
  return ensureRl();
}

export function nextLine() {
  ensureRl();
  if (queue.length) return Promise.resolve(queue.shift());
  return new Promise((resolve) => waiters.push(resolve));
}

export function question(promptText) {
  ensureRl();
  if (promptText) process.stdout.write(promptText);
  return nextLine();
}

export function closeInput() {
  if (rl) {
    rl.close();
    rl = null;
  }
  queue.length = 0;
}

/**
 * Живой прогресс агентов: одна строка на существующее событие (router/
 * advisor/architect/coder/tester/coordinator) — печать РЯДОМ с уже
 * существующими точками logEvent, не новая система логирования. В stderr,
 * не в stdout — не мешает readline-промпту, который живёт на stdout/stdin.
 * LOOM_QUIET=1 глушит (для evals — чтобы не замусоривать их вывод).
 */
export function progress(line) {
  if (QUIET) return;
  process.stderr.write(`${line}\n`);
}

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;
// eslint-disable-next-line no-control-regex
const ANSI_ESCAPE_RE = /\x1B\[[0-9;]*[a-zA-Z]/g;

/**
 * Санитизация одной строки ввода сеанса: убирает ANSI-эскейпы и управляющие
 * символы, схлопывает пробелы, режет длину. Без этого мусор терминального
 * буфера склеивался в title задачи (шрам 32).
 */
export function sanitizeLine(raw, maxLen = 500) {
  if (typeof raw !== 'string') return '';
  let s = raw.replace(ANSI_ESCAPE_RE, '').replace(CONTROL_CHARS_RE, '');
  s = s.replace(/\s+/g, ' ').trim();
  if (s.length > maxLen) s = s.slice(0, maxLen);
  return s;
}

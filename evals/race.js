// evals/race.js — DoD Фазы 0: claimNext в двух параллельных процессах не
// выдаёт одну задачу дважды (BEGIN IMMEDIATE в journal.js). Запускает N
// дочерних процессов-«воркеров», каждый пытается захватить задачи из общего
// пула, и проверяет отсутствие дублей по id.
//
// Запускается через "npm run race" с --env-file=.env.mock — не потому, что
// нужны мок-ответы моделей (этот эвал вообще не вызывает gateway), а чтобы
// resetDb() ниже удалял ИЗОЛИРОВАННЫЙ journal.mock.db, а не настоящий
// journal.db с реальными задачами пользователя (реальный баг с первого
// живого прогона: race.js без этой изоляции стирал боевую доску).
import { fork } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import {
  addTask, releaseStuck, claimNext, setStatus, listTasks,
} from '../core/journal.js';
import { JOURNAL_DB_PATH } from '../core/config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKER_COUNT = 4;
const TASK_COUNT = 40;

function resetDb() {
  for (const suffix of ['', '-wal', '-shm']) {
    const p = JOURNAL_DB_PATH + suffix;
    if (fs.existsSync(p)) fs.rmSync(p);
  }
}

async function runCrossProcessRace() {
  const ids = [];
  for (let i = 0; i < TASK_COUNT; i++) {
    ids.push(addTask({ title: `race-${i}`, spec: 'race', criteria: '{}', role: 'coder' }));
  }

  const workerPath = path.join(__dirname, 'race-worker.js');
  const results = await Promise.all(
    Array.from({ length: WORKER_COUNT }, (_, i) => runWorker(workerPath, i)),
  );

  const claimed = results.flat();
  const unique = new Set(claimed);

  console.log(`[race] задач: ${TASK_COUNT}, воркеров: ${WORKER_COUNT}, захватов всего: ${claimed.length}, уникальных: ${unique.size}`);

  if (claimed.length !== unique.size) {
    console.error('[race] FAIL: одна и та же задача захвачена дважды!');
    process.exit(1);
  }
  if (unique.size !== TASK_COUNT) {
    console.error(`[race] FAIL: захвачено ${unique.size} из ${TASK_COUNT} — часть задач потеряна.`);
    process.exit(1);
  }
  console.log('[race] OK — гонка захвата не воспроизвелась.');
}

function runWorker(workerPath, idx) {
  return new Promise((resolve, reject) => {
    const child = fork(workerPath, [String(idx)], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    let out = [];
    child.on('message', (msg) => { out = msg; });
    child.on('exit', (code) => {
      if (code !== 0) reject(new Error(`worker ${idx} exited with ${code}`));
      else resolve(out);
    });
    child.on('error', reject);
  });
}

/**
 * Внутрипроцессная гонка weave (Фаза 6, П§5 DoD: «два claimNext из
 * Promise.all»): claimNext сам синхронен (better-sqlite3), реальной
 * ОС-конкуренции внутри одного процесса нет и быть не может (Node
 * однопоточен) — эта проверка не про атомарность BEGIN IMMEDIATE (её уже
 * доказывает кросс-процессная гонка выше), а про то, что filter по
 * activeTouches (§16 weave) корректен именно в том паттерне вызова, каким
 * его реально использует core/coordinator.js:claimAndRunInWorktree —
 * несколько claimNext из одного Promise.all-раунда, каждый со свежим
 * activeTouches. Половина задач трогает shared-a.js, половина — shared-b.js:
 * ни одна пара захваченных В ОДНОМ раунде задач не должна пересекаться
 * по touches_files.
 */
async function runWeaveRace() {
  const WORKERS = 4;
  const FILES = ['shared-a.js', 'shared-b.js', 'shared-c.js', 'shared-d.js']; // == WORKERS — типичный раунд может занять всех
  const TOTAL = 20;

  for (let i = 0; i < TOTAL; i++) {
    addTask({
      title: `weave-${i}`, spec: 'weave', criteria: '{}', role: 'coder',
      touches_files: [FILES[i % FILES.length]],
    });
  }

  function activeTouchesNow() {
    const active = listTasks({ status: 'claimed', role: 'coder' });
    const set = new Set();
    for (const t of active) {
      let touches;
      try { touches = JSON.parse(t.touches_files || '[]'); } catch { touches = []; }
      for (const f of touches) set.add(f);
    }
    return [...set];
  }

  let totalClaimed = 0;
  // Файл-уровневый weave принципиально ограничивает параллелизм числом
  // РАЗЛИЧНЫХ файлов, не числом воркеров (это честное свойство file-level
  // weave, не баг теста) — цикл идёт до исчерпания очереди, не фиксированное
  // число раундов; предохранитель TOTAL*2 — на случай реальной поломки
  // (иначе тест зависнет вместо явного FAIL).
  for (let round = 0; round < TOTAL * 2 && totalClaimed < TOTAL; round++) {
    // eslint-disable-next-line no-await-in-loop
    const roundResults = await Promise.all(Array.from({ length: WORKERS }, async (_, w) => {
      const activeTouches = activeTouchesNow();
      return claimNext('coder', `weave-w${w}`, { activeTouches });
    }));

    for (let i = 0; i < roundResults.length; i++) {
      for (let j = i + 1; j < roundResults.length; j++) {
        const a = roundResults[i];
        const b = roundResults[j];
        if (!a || !b) continue;
        const ta = JSON.parse(a.touches_files || '[]');
        const tb = JSON.parse(b.touches_files || '[]');
        if (ta.some((f) => tb.includes(f))) {
          console.error(`[race] FAIL: weave — "${a.title}" и "${b.title}" захвачены ОДНОВРЕМЕННО с пересекающимися touches_files (${ta.join(',')} / ${tb.join(',')})`);
          process.exit(1);
        }
      }
    }

    for (const t of roundResults) {
      if (!t) continue;
      totalClaimed++;
      setStatus(t.id, 'done'); // освобождаем файл для следующего раунда
    }
  }

  if (totalClaimed !== TOTAL) {
    console.error(`[race] FAIL: weave — захвачено ${totalClaimed} из ${TOTAL} задач.`);
    process.exit(1);
  }
  console.log(`[race] weave OK — ${TOTAL} задач/${FILES.length} файла/${WORKERS} воркера, ни одного одновременного пересечения touches_files.`);
}

async function main() {
  resetDb();
  releaseStuck();
  await runCrossProcessRace();

  // Без повторного resetDb(): journal.js кэширует открытое соединение на
  // процесс (Windows не даёт unlink открытого файла, EBUSY) — не нужно, все
  // race-N задачи выше уже status=done, weave-N задачи их не видят
  // (claimNext фильтрует по status='pending').
  releaseStuck();
  await runWeaveRace();
}

main().catch((e) => { console.error('[race] FAIL', e); process.exit(1); });

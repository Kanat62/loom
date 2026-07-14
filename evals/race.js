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
import { addTask, releaseStuck } from '../core/journal.js';
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

async function main() {
  resetDb();
  releaseStuck();

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

main().catch((e) => { console.error('[race] FAIL', e); process.exit(1); });

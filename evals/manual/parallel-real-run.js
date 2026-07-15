// evals/manual/parallel-real-run.js — РУЧНАЯ проверка (RUNBOOK.md, Ф6):
// Фаза 6 (§16, П§5) на РЕАЛЬНЫХ моделях — 4 задачи / 2 воркера, две из них
// искусственно конфликтуют на shared.js (та же схема, что MOCK-сценарий
// «8 задач / 2 воркера» в core/mock.js, уменьшенная вдвое для дешёвого
// реального прогона). Кодер — реальный Sonnet, reconciler на конфликте —
// реальный Haiku (роль 'cheap'). Задачи создаются напрямую (addTask), не
// через архитектора — architect непредсказуемо мог бы спроектировать DAG
// без конфликта вовсе, а цель прогона — проверить именно merge queue +
// reconciler, не качество архитектора (оно уже проверяется реальным
// прогоном раздела 4 RUNBOOK.md части 1).
//
// Запуск: node --env-file=.env --no-warnings evals/manual/parallel-real-run.js
import { addTask, listTasks, newRunId } from '../../core/journal.js';
import { runCoordinatorLoop } from '../../core/coordinator.js';
import { WORKSPACE } from '../../core/config.js';

async function main() {
  const runId = newRunId();

  addTask({
    title: 'Параллельный реальный прогон 1: file1.js',
    spec: 'Создай file1.js в корне workspace — module.exports = { n: 1 };',
    criteria: JSON.stringify({ cmd: "node -e \"const c=require('./file1.js'); if(c.n===1){console.log('PASS n=1')}else{console.error('FAIL: n='+c.n);process.exit(1)}\"" }),
    role: 'coder',
    type: 'project',
    touches_files: ['file1.js'],
  });
  addTask({
    title: 'Параллельный реальный прогон 2: file2.js',
    spec: 'Создай file2.js в корне workspace — module.exports = { n: 2 };',
    criteria: JSON.stringify({ cmd: "node -e \"const c=require('./file2.js'); if(c.n===2){console.log('PASS n=2')}else{console.error('FAIL: n='+c.n);process.exit(1)}\"" }),
    role: 'coder',
    type: 'project',
    touches_files: ['file2.js'],
  });
  // 3/4 НЕ объявляют shared.js в touches_files (искусственный конфликт —
  // тот же приём, что MOCK-сценарий, реалистичный blind spot file-level weave).
  addTask({
    title: 'Параллельный реальный прогон 3: file3.js + shared.js (версия A)',
    spec: 'Создай file3.js — module.exports = { n: 3 }; И ОТДЕЛЬНО shared.js — module.exports = { version: "A" };',
    criteria: JSON.stringify({ cmd: "node -e \"const c=require('./file3.js'); if(c.n===3){console.log('PASS n=3')}else{console.error('FAIL: n='+c.n);process.exit(1)}\"" }),
    role: 'coder',
    type: 'project',
    touches_files: ['file3.js'],
  });
  addTask({
    title: 'Параллельный реальный прогон 4: file4.js + shared.js (версия B)',
    spec: 'Создай file4.js — module.exports = { n: 4 }; И ОТДЕЛЬНО shared.js — module.exports = { version: "B" };',
    criteria: JSON.stringify({ cmd: "node -e \"const c=require('./file4.js'); if(c.n===4){console.log('PASS n=4')}else{console.error('FAIL: n='+c.n);process.exit(1)}\"" }),
    role: 'coder',
    type: 'project',
    touches_files: ['file4.js'],
  });

  console.log('[parallel-real-run] 4 задачи созданы, запускаю 2 воркера...');
  await runCoordinatorLoop({
    role: 'coder', workspaceDir: WORKSPACE, workers: 2, runId,
  });

  const tasks = listTasks({ role: 'coder' }).filter((t) => t.title.startsWith('Параллельный реальный прогон'));
  for (const t of tasks) {
    console.log(`[parallel-real-run] ${t.title} → ${t.status} (попыток: ${t.attempts})`);
  }
  const allMerged = tasks.every((t) => t.status === 'merged');
  console.log(allMerged
    ? '[parallel-real-run] OK — все 4 задачи merged, конфликт shared.js должен быть разрешён reconciler’ом (проверьте лог [merge] выше).'
    : '[parallel-real-run] НЕ все задачи дошли до merged — смотрите feedback выше.');
  process.exit(allMerged ? 0 : 1);
}

main().catch((e) => { console.error('[parallel-real-run] FAIL', e); process.exit(1); });

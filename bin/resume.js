// resume.js — npm run resume (§25 ТЗ v4): убитый процесс оставляет claimed-
// задачи; releaseStuck() при любом входе (шрам 25), затем довести очередь
// pending до терминальных статусов.
import { releaseStuck, listTasks } from '../core/journal.js';
import { runCoordinatorLoop } from '../core/coordinator.js';
import { WORKSPACE } from '../core/config.js';

async function main() {
  const released = releaseStuck();
  console.log(`[resume] возвращено в pending из claimed: ${released}`);

  const roles = [...new Set(listTasks({ status: 'pending' }).map((t) => t.role))];
  if (!roles.length) {
    console.log('[resume] очередь pending пуста — продолжать нечего.');
  }
  for (const role of roles) {
    // eslint-disable-next-line no-await-in-loop
    const results = await runCoordinatorLoop({ role, workspaceDir: WORKSPACE });
    console.log(`[resume] роль "${role}": обработано задач — ${results.length}`);
  }

  const tasks = listTasks({});
  const byStatus = {};
  for (const t of tasks) byStatus[t.status] = (byStatus[t.status] || 0) + 1;
  console.log('[resume] статусы доски:', JSON.stringify(byStatus));
}

main().catch((e) => { console.error('[resume] FAIL', e); process.exit(1); });

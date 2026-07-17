// resume.js — npm run resume (§25 ТЗ v4): убитый процесс оставляет claimed-
// задачи; releaseStuck() при любом входе (шрам 25), затем довести очередь
// pending до терминальных статусов.
//
// §29 (шрам 35, реальный инцидент): /resume раньше молча гнал координатор
// по ВСЕЙ базе без фильтра проекта — исполнял чужие деревья. Теперь resume —
// ops-утилита, которая честно проходит КАЖДЫЙ active-проект ПО ОТДЕЛЬНОСТИ,
// своим claimNext/workspaceDir — ни один проект не остаётся молча заброшен
// (в отличие от talk.js, где активен один проект за раз), но и ни один
// координатор-проход не смешивает деревья разных проектов.
import { releaseStuck, listTasks } from '../core/journal.js';
import { runCoordinatorLoop } from '../core/coordinator.js';
import { listProjects } from '../core/projects.js';

async function main() {
  const released = releaseStuck(); // глобальный sweep — claimed-задачи любого проекта, убитый процесс не разбирает границ
  console.log(`[resume] возвращено в pending из claimed (все проекты): ${released}`);

  const projects = listProjects({ status: 'active' });
  if (!projects.length) {
    console.log('[resume] нет активных проектов — продолжать нечего.');
    return;
  }

  for (const project of projects) {
    const roles = [...new Set(listTasks({ status: 'pending', project_id: project.id }).map((t) => t.role))];
    if (!roles.length) continue;
    console.log(`[resume] проект "${project.title}" (${project.id}):`);
    for (const role of roles) {
      // eslint-disable-next-line no-await-in-loop
      const results = await runCoordinatorLoop({
        role, workspaceDir: project.workspace_dir, projectId: project.id,
      });
      console.log(`[resume]   роль "${role}": обработано задач — ${results.length}`);
    }
  }

  for (const project of projects) {
    const tasks = listTasks({ project_id: project.id });
    const byStatus = {};
    for (const t of tasks) byStatus[t.status] = (byStatus[t.status] || 0) + 1;
    console.log(`[resume] статусы доски (${project.id}):`, JSON.stringify(byStatus));
  }
}

main().catch((e) => { console.error('[resume] FAIL', e); process.exit(1); });

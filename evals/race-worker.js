// Дочерний процесс для evals/race.js: захватывает задачи, пока они не
// закончатся, и присылает список захваченных id родителю через IPC.
import { claimNext, setStatus } from '../core/journal.js';

const workerId = `worker-${process.argv[2]}`;
const projectId = process.argv[3];
const claimed = [];

for (;;) {
  const task = claimNext('coder', workerId, { projectId });
  if (!task) break;
  claimed.push(task.id);
  setStatus(task.id, 'done');
}

process.send(claimed);
process.exit(0);

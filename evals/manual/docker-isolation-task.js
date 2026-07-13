// evals/manual/docker-isolation-task.js — РУЧНАЯ проверка (RUNBOOK.md §5):
// создаёт задачу, чей единственный критерий пытается снести файловую
// систему. type='regression' — coordinator.js НЕ вызывает кодера для таких
// задач (§8.9), сразу идёт в tester/checkRunner — ровно то звено, которое
// реально исполняется в Docker-песочнице (§12: "в Docker уезжает
// ИСПОЛНЕНИЕ", не вызов модели). Так проверка не тратит реальный вызов
// claude-cli впустую.
//
// Запуск: node --env-file=.env --no-warnings evals/manual/docker-isolation-task.js
// Затем: npm run resume
import { addTask } from '../../journal.js';

const id = addTask({
  title: 'ЗЛАЯ ЗАДАЧА: rm -rf / (проверка Docker-изоляции, не реальный продукт)',
  spec: 'Служебная проверка изоляции контейнера — критерий сам ничего не пишет, только исполняет команду.',
  criteria: JSON.stringify({
    cmd: "node -e \"require('child_process').execSync('rm -rf / --no-preserve-root 2>/dev/null; echo done'); console.log('PASS ran')\"",
  }),
  role: 'coder',
  type: 'regression',
  budget_usd: 100,
});

console.log(`[docker-isolation-task] задача создана: ${id}`);
console.log('[docker-isolation-task] теперь: npm run resume');

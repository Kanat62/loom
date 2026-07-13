// Детерминированные ответы всех ролей (§24 ТЗ v4). MOCK=1 — полный прогон
// БЕЗ единого вызова модели: gateway.chat() делегирует сюда. Тестер при этом
// остаётся настоящим (у роли tester нет LLM, §3) — checkRunner реально
// выполняет критерии над файлами, которые записал мок-кодер, так что цикл
// «поймал → отчёт → починил» демонстрируется по-настоящему, не имитацией.
//
// Сценарий-эталон (DEV_GUIDE §11.2): калькулятор, 2 задачи, ПЕРВАЯ — с
// нарочной ошибкой в первой попытке кодера (subtract реализован как plus),
// тестер ловит это говорящим провалом, вторая попытка — уже верный код.
// Вторая задача (зависит от первой) решается с первой попытки.
import { pathToFileURL } from 'node:url';

const callCounters = new Map();

function nextCallIndex(key) {
  const n = (callCounters.get(key) || 0) + 1;
  callCounters.set(key, n);
  return n;
}

export function resetMockState() {
  callCounters.clear();
}

/**
 * mockChat(role, messages, opts) -> текст | объект (симметрично gateway.chat).
 */
export function mockChat(role, messages, opts = {}) {
  const idx = nextCallIndex(role);
  const userMsg = messages.find((m) => m.role === 'user')?.content || '';
  const handler = MOCK_HANDLERS[role];
  if (!handler) {
    throw new Error(`mock.js: нет MOCK-ветки для роли "${role}" (добавь в MOCK_HANDLERS)`);
  }
  return handler({ idx, userMsg, messages, opts });
}

export const MOCK_HANDLERS = {};

export function registerMockHandler(role, fn) {
  MOCK_HANDLERS[role] = fn;
}

// --- Фаза 1: coder --------------------------------------------------------
// Задачи различаются по содержимому userMsg (заголовок задачи виден в
// "## Задача"), не по глобальному счётчику вызовов — так сценарий не зависит
// от порядка обработки очереди координатором.
registerMockHandler('coder', ({ userMsg }) => {
  const hasFeedback = /## Отчёт тестера/.test(userMsg);
  const isCalc = /calc\.js/.test(userMsg) && !/index\.html/.test(userMsg);
  const isPage = /index\.html/.test(userMsg);

  if (isCalc) {
    if (!hasFeedback) {
      // Первая попытка — нарочная ошибка (шрам-демо: поймал → отчёт → починил).
      return {
        files: {
          'calc.js': [
            'module.exports = {',
            '  add: (a, b) => a + b,',
            '  subtract: (a, b) => a + b, // ошибка: должно быть a - b',
            '};',
            '',
          ].join('\n'),
        },
      };
    }
    return {
      files: {
        'calc.js': [
          'module.exports = {',
          '  add: (a, b) => a + b,',
          '  subtract: (a, b) => a - b,',
          '};',
          '',
        ].join('\n'),
      },
    };
  }

  if (isPage) {
    return {
      files: {
        'index.html': [
          '<!doctype html>',
          '<html><head><meta charset="utf-8"><title>Калькулятор</title></head>',
          '<body>',
          '<script src="calc.js"></script>',
          '<div id="result">2+3=5, 5-2=3</div>',
          '</body></html>',
          '',
        ].join('\n'),
      },
    };
  }

  throw new Error('mock.js: coder-хендлер не узнал задачу сценария калькулятора');
});

// --- Точка входа `npm run mock` -------------------------------------------
async function main() {
  const { MOCK } = await import('./config.js');
  if (!MOCK) {
    console.error('[mock] MOCK !== true — запусти через "npm run mock" (использует .env.mock).');
    process.exit(1);
  }

  resetMockState();

  const fs = await import('node:fs');
  const { JOURNAL_DB_PATH, WORKSPACE } = await import('./config.js');
  for (const suffix of ['', '-wal', '-shm']) {
    const p = JOURNAL_DB_PATH + suffix;
    if (fs.existsSync(p)) fs.rmSync(p);
  }
  if (fs.existsSync(WORKSPACE)) fs.rmSync(WORKSPACE, { recursive: true, force: true });

  const { addTask, getTask, releaseStuck } = await import('./journal.js');
  const { runCoordinatorLoop } = await import('./coordinator.js');

  releaseStuck();

  const calcId = addTask({
    title: 'calc.js: экспортирует add(a,b) и subtract(a,b)',
    spec: 'Создай calc.js в корне workspace. module.exports = { add, subtract }. add(a,b) = a+b, subtract(a,b) = a-b.',
    criteria: JSON.stringify({
      cmd: 'node -e "const c=require(\'./calc.js\'); const a=c.add(2,3), s=c.subtract(5,2); if(a===5 && s===3){console.log(\'PASS add=\'+a+\' subtract=\'+s)} else {console.error(\'FAIL: add(2,3)=\'+a+\' (ожидалось 5), subtract(5,2)=\'+s+\' (ожидалось 3)\'); process.exit(1)}"',
    }),
    role: 'coder',
    type: 'project',
  });

  const pageId = addTask({
    title: 'index.html: калькулятор подключает calc.js и показывает 2+3 и 5-2',
    spec: 'Создай index.html. Подключи calc.js через <script src="calc.js"></script>. В теле должны быть числа 5 и 3 как результаты 2+3 и 5-2.',
    criteria: JSON.stringify({
      cmd: 'node -e "const fs=require(\'fs\'); const h=fs.readFileSync(\'index.html\',\'utf8\'); const ok = h.includes(\'calc.js\') && h.includes(\'5\') && h.includes(\'3\'); if(ok){console.log(\'PASS html содержит calc.js и результаты\')} else {console.error(\'FAIL: index.html не содержит ссылку на calc.js или результаты, len=\'+h.length); process.exit(1)}"',
    }),
    role: 'coder',
    type: 'project',
    blocked_by_task_id: calcId,
  });

  console.log(`[mock] задачи созданы: calc=${calcId}, page=${pageId}`);
  await runCoordinatorLoop({ role: 'coder', workspaceDir: WORKSPACE });

  const calcTask = getTask(calcId);
  const pageTask = getTask(pageId);

  console.log(`[mock] calc: status=${calcTask.status} attempts=${calcTask.attempts}`);
  console.log(`[mock] page: status=${pageTask.status} attempts=${pageTask.attempts}`);

  const ok = calcTask.status === 'done' && calcTask.attempts === 2
    && pageTask.status === 'done' && pageTask.attempts === 1;

  if (!ok) {
    console.error('[mock] FAIL — сценарий калькулятора не сошёлся с эталоном (calc: 2 попытки, page: 1 попытка).');
    process.exit(1);
  }
  console.log('[mock] OK — цикл поймал → отчёт → починил воспроизведён, вторая задача решена с первой попытки.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error('[mock] FAIL', e); process.exit(1); });
}

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
import { containsTechnicalQuestion } from './agents/advisor.js';

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
  // ВАЖНО: матчим по title из "## Задача", а не по всему userMsg — секция
  // критерия часто содержит имена файлов (readFileSync('calc.js')), что даёт
  // ложные срабатывания, если смотреть на весь текст промпта.
  const titleMatch = userMsg.match(/## Задача\n([^\n]*)/);
  const title = titleMatch ? titleMatch[1] : userMsg;
  const hasFeedback = /## Отчёт тестера/.test(userMsg);
  const isCalc = /calc\.js/.test(title) && !/index\.html/.test(title);
  const isPage = /index\.html/.test(title);

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

  // tweak-сценарий (Фаза 3): роутер сам пишет критерий на "Итого" в calc.js —
  // мок-кодер должен уметь удовлетворить именно его, независимо от того,
  // существовал ли раньше calc.js в этом прогоне (сценарий самодостаточен).
  if (/Итого/.test(title)) {
    return {
      files: {
        'calc.js': [
          'module.exports = {',
          '  add: (a, b) => a + b,',
          '  subtract: (a, b) => a - b,',
          '};',
          "console.log('Итого:', module.exports.add(2, 3));",
          '',
        ].join('\n'),
      },
    };
  }

  // Фаза 4 DoD: попытка записи вне workspace блокируется замком пути и
  // логируется — мок-кодер намеренно ведёт себя как «злой»/сломанный агент.
  if (/ТЕСТ_ПУТЬ_НАРУШЕНИЕ/.test(title)) {
    return { files: { '../evil.js': "console.log('escaped workspace');\n" } };
  }

  // Задача вне сценария калькулятора (например, evals/budget.js) — детерминированная
  // заглушка-файл, чтобы другие MOCK-прогоны могли переиспользовать этот хендлер,
  // не расширяя сам сценарий-эталон.
  return { files: { 'NOTES.md': 'mock coder: задача вне сценария калькулятора, файл-заглушка.\n' } };
});

// --- Фаза 3: router --------------------------------------------------------
registerMockHandler('router', ({ userMsg }) => {
  const m = userMsg.match(/## Запрос клиента\n([^\n]*)/);
  const text = (m ? m[1] : userMsg).trim();

  // \b не годится с кириллицей — в JS \w не включает кириллические буквы,
  // граница "буква→пробел" там не распознаётся как word boundary.
  if (/^(что делает|почему)/i.test(text) && /\?\s*$/.test(text)) {
    return { route: 'question', reason: 'вопрос о существующем коде, ничего не меняется' };
  }
  if (/^(поменяй|почини|замени)(\s|$)/i.test(text)) {
    return {
      route: 'tweak',
      reason: 'точечная правка существующего продукта',
      criteria: {
        cmd: 'node -e "const fs=require(\'fs\'); const s=fs.readFileSync(\'calc.js\',\'utf8\'); if(s.includes(\'Итого\')){console.log(\'PASS содержит Итого\')}else{console.error(\'FAIL: calc.js не содержит строку Итого\'); process.exit(1)}"',
      },
      complexity_score: { files: 1, lines: 3, trivial: true },
    };
  }
  return { route: 'wish', reason: 'клиент описал желаемый результат нового продукта' };
});

// --- Фаза 3: advisor (intake wish/problem/spec + analyst) -----------------
registerMockHandler('advisor', ({ userMsg, opts }) => {
  if (opts.json === false) {
    // advisor_analyst (question-протокол): обычный текст, не JSON.
    return 'Мок-аналитик: calc.js экспортирует функции add(a,b) и subtract(a,b) для сложения и вычитания.';
  }

  // evals/interview.js: маркер, который заставляет мок-советника СНАЧАЛА
  // задать технический вопрос (как ошибающаяся модель), чтобы реально
  // прогнать код-уровневый guard (containsTechnicalQuestion + ретрай) в MOCK,
  // а не только на реальных вызовах.
  if (/ТЕСТ_ТЕХ_ВОПРОС/.test(userMsg)) {
    const alreadyNudged = /Предыдущий вопрос содержал техническую деталь/.test(userMsg);
    if (!alreadyNudged) {
      return { ask: 'Какая должна быть скорость анимации кнопки в px/мс?' };
    }
    return { ask: 'Опишите подробнее, что именно должно происходить при клике?' };
  }

  const clientLine = (userMsg.match(/Клиент: ([^\n]*)/) || [])[1] || 'Простой калькулятор с веб-страницей';
  return {
    ready: true,
    summary: clientLine,
    engineering_defaults: [
      'Node.js + чистый JS без фреймворка — минимальный объём первой версии',
      'Один HTML-файл на клиенте, подключает calc.js через <script src>',
    ],
  };
});

// --- Фаза 3: architect ------------------------------------------------------
// Переиспользует сценарий калькулятора — тот же MOCK_HANDLERS.coder уже умеет
// отвечать на эти title/spec, так что весь конвейер router→advisor→architect→
// coordinator проверяется на одном известном продукте без дублирования логики.
registerMockHandler('architect', () => ({
  packages: [],
  tasks: [
    {
      title: 'calc.js: экспортирует add(a,b) и subtract(a,b)',
      spec: 'Создай calc.js в корне workspace. module.exports = { add, subtract }. add(a,b)=a+b, subtract(a,b)=a-b.',
      criteria: {
        cmd: 'node -e "const c=require(\'./calc.js\'); const a=c.add(2,3), s=c.subtract(5,2); if(a===5 && s===3){console.log(\'PASS add=\'+a+\' subtract=\'+s)}else{console.error(\'FAIL: add(2,3)=\'+a+\' (ожидалось 5), subtract(5,2)=\'+s+\' (ожидалось 3)\'); process.exit(1)}"',
      },
      touches_files: ['calc.js'],
      depends_on_title: null,
    },
    {
      title: 'index.html: калькулятор подключает calc.js и показывает 2+3 и 5-2',
      spec: 'Создай index.html. Подключи calc.js через <script src="calc.js"></script>. В теле должны быть числа 5 и 3.',
      criteria: {
        cmd: 'node -e "const fs=require(\'fs\'); const h=fs.readFileSync(\'index.html\',\'utf8\'); const ok=h.includes(\'calc.js\')&&h.includes(\'5\')&&h.includes(\'3\'); if(ok){console.log(\'PASS html содержит calc.js и результаты\')}else{console.error(\'FAIL: index.html не содержит calc.js или результаты\'); process.exit(1)}"',
      },
      touches_files: ['index.html'],
      depends_on_title: 'calc.js: экспортирует add(a,b) и subtract(a,b)',
    },
  ],
}));

// --- Фаза 3: skill_writer ---------------------------------------------------
registerMockHandler('skill', ({ userMsg }) => {
  const m = userMsg.match(/## Файлы, которых касалась задача \(touches_files\)\n([\s\S]*?)\n\n##/);
  const files = m ? m[1].split('\n').map((s) => s.trim()).filter((s) => s && s !== '(не указаны)') : [];
  if (!files.length) return { skip: true };
  return { lesson: `${files[0]}: реализовать ВСЕ ветки функции сразу — тестер ловит частичные реализации говорящим провалом.` };
});

// --- cheap (используется как псевдо-judge в evals/interview.js) -----------
// Переиспользует ТОЧНО ТУ ЖЕ функцию, что и код-уровневый guard в
// agents/advisor.js — не дублирует регэксп второй раз с риском разъехаться.
registerMockHandler('cheap', ({ userMsg }) => ({ has_technical_terms: containsTechnicalQuestion(userMsg) }));

// --- Сценарий А (Фаза 1/2): голый координатор без советника/роутера -------
async function runCalculatorScenario() {
  const { addTask, getTask } = await import('./journal.js');
  const { runCoordinatorLoop } = await import('./coordinator.js');
  const { WORKSPACE } = await import('./config.js');

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

  console.log(`[mock] calculator: задачи созданы calc=${calcId}, page=${pageId}`);
  await runCoordinatorLoop({ role: 'coder', workspaceDir: WORKSPACE });

  const calcTask = getTask(calcId);
  const pageTask = getTask(pageId);
  console.log(`[mock] calculator: calc status=${calcTask.status} attempts=${calcTask.attempts}, page status=${pageTask.status} attempts=${pageTask.attempts}`);

  const ok = calcTask.status === 'done' && calcTask.attempts === 2
    && pageTask.status === 'done' && pageTask.attempts === 1;
  if (!ok) {
    throw new Error('calculator: не сошлось с эталоном (calc: 2 попытки с поимкой ошибки, page: 1 попытка)');
  }
  console.log('[mock] calculator OK — цикл поймал → отчёт → починил воспроизведён.');
}

// --- Сценарий Б (Фаза 3): полный конвейер router → advisor → architect → --
// --- coordinator → skill_writer для wish-входа -----------------------------
async function runProjectPipelineScenario() {
  const { newRunId, setRootSpec, getTask } = await import('./journal.js');
  const { routeRequest } = await import('./agents/router.js');
  const { startIntake, buildBrief } = await import('./agents/advisor.js');
  const { runArchitect } = await import('./agents/architect.js');
  const { runCoordinatorLoop } = await import('./coordinator.js');
  const { listWorkspaceFileNames } = await import('./agents/coder.js');
  const { listSkills } = await import('./skills.js');
  const { WORKSPACE } = await import('./config.js');
  const fsMod = await import('node:fs');

  // Сценарий самодостаточен: не должен зависеть от того, что оставил
  // предыдущий сценарий в workspace (иначе предпроверка архитектора увидит
  // уже готовый calc.js/index.html и ЗАКОНОМЕРНО сочтёт критерии фиктивными).
  if (fsMod.existsSync(WORKSPACE)) fsMod.rmSync(WORKSPACE, { recursive: true, force: true });

  const runId = newRunId();
  const text = 'Хочу простой калькулятор с веб-страницей: сложение и вычитание.';

  const routed = await routeRequest({ text, workspaceFiles: listWorkspaceFileNames(WORKSPACE), runId });
  if (routed.route !== 'wish') throw new Error(`project pipeline: ожидали route=wish, получили ${routed.route}`);

  const { step } = await startIntake({ protocol: 'wish', initialText: text, runId });
  if (step.type !== 'ready') throw new Error('project pipeline: мок-советник должен сразу вернуть ready');

  const brief = buildBrief({ protocol: 'wish', initialText: text, step });
  setRootSpec('default', brief.summary, brief.engineering_defaults, 'wish');

  const architectResult = await runArchitect({
    brief, workspaceDir: WORKSPACE, workspaceListing: listWorkspaceFileNames(WORKSPACE), runId, projectId: 'default',
  });
  if (!architectResult.ok) throw new Error(`project pipeline: architect failed: ${architectResult.error}`);
  if (architectResult.taskIds.length !== 2) {
    throw new Error(`project pipeline: ожидали 2 обычные задачи, получили ${architectResult.taskIds.length}`);
  }
  architectResult.precheckLog.forEach((l) => console.log(`[mock]   ${l}`));

  await runCoordinatorLoop({ role: 'coder', workspaceDir: WORKSPACE });

  const allIds = [...architectResult.taskIds, architectResult.regressionId];
  const finalTasks = allIds.map(getTask);
  console.log(`[mock] project pipeline: ${finalTasks.map((t) => `${t.type}:${t.status}`).join(', ')}`);
  if (!finalTasks.every((t) => t.status === 'done')) {
    throw new Error('project pipeline: не все задачи дерева (включая регрессию) дошли до done');
  }

  const skills = listSkills();
  if (!skills.length) throw new Error('project pipeline: ни одного урока не записано skill_writer-ом');
  console.log(`[mock] project pipeline OK — 2 задачи + регрессия done, ${skills.length} урок(ов) записано.`);
}

// --- Сценарий В (Фаза 3): tweak — router сам пишет критерий ---------------
async function runTweakScenario() {
  const { addTask, getTask, newRunId } = await import('./journal.js');
  const { routeRequest } = await import('./agents/router.js');
  const { runCoordinatorLoop } = await import('./coordinator.js');
  const { listWorkspaceFileNames } = await import('./agents/coder.js');
  const { WORKSPACE } = await import('./config.js');

  const runId = newRunId();
  const text = 'поменяй вывод calc на слово Итого';

  const routed = await routeRequest({ text, workspaceFiles: listWorkspaceFileNames(WORKSPACE), runId });
  if (routed.route !== 'tweak') throw new Error(`tweak: ожидали route=tweak, получили ${routed.route}`);
  if (!routed.criteria) throw new Error('tweak: router не вернул criteria (контракт §1 нарушен)');

  const id = addTask({
    title: text, spec: text, criteria: JSON.stringify(routed.criteria), role: 'coder', type: 'tweak',
  });
  await runCoordinatorLoop({ role: 'coder', workspaceDir: WORKSPACE });

  const task = getTask(id);
  console.log(`[mock] tweak: status=${task.status} attempts=${task.attempts}`);
  if (task.status !== 'done') throw new Error(`tweak: ожидали done, получили ${task.status}`);
  console.log('[mock] tweak OK — одна задача, критерий сгенерирован роутером.');
}

// --- Сценарий Г (Фаза 3): question — read-only, без задач на доске --------
async function runQuestionScenario() {
  const { newRunId, getRootSpec } = await import('./journal.js');
  const { routeRequest } = await import('./agents/router.js');
  const { runAnalyst } = await import('./agents/advisor.js');
  const { listWorkspaceFileNames } = await import('./agents/coder.js');
  const { WORKSPACE } = await import('./config.js');

  const runId = newRunId();
  const text = 'что делает calc.js?';

  const routed = await routeRequest({ text, workspaceFiles: listWorkspaceFileNames(WORKSPACE), runId });
  if (routed.route !== 'question') throw new Error(`question: ожидали route=question, получили ${routed.route}`);

  const rootSpec = getRootSpec('default');
  const answer = await runAnalyst({
    question: text, rootSpec: rootSpec?.spec, workspaceListing: listWorkspaceFileNames(WORKSPACE), runId,
  });
  if (typeof answer !== 'string' || !answer.trim()) throw new Error('question: пустой ответ аналитика');
  console.log(`[mock] question OK — route=question, ответ аналитика получен ("${answer.slice(0, 50)}...").`);
}

// --- Сценарий Д (Фаза 4): замок пути — запись вне workspace блокируется ---
// --- и логируется отдельным событием (§12.1) ------------------------------
async function runPathLockScenario() {
  const { addTask, getTask, newRunId, listEvents } = await import('./journal.js');
  const { runCoordinatorLoop } = await import('./coordinator.js');
  const { WORKSPACE } = await import('./config.js');

  const runId = newRunId();
  const title = 'ТЕСТ_ПУТЬ_НАРУШЕНИЕ: попытка выйти из workspace';
  const id = addTask({
    title, spec: title, criteria: JSON.stringify({ cmd: 'node -e "console.log(\'PASS\')"' }), role: 'coder', type: 'project', budget_usd: 100,
  });

  await runCoordinatorLoop({ role: 'coder', workspaceDir: WORKSPACE });

  const task = getTask(id);
  console.log(`[mock] path-lock: status=${task.status} attempts=${task.attempts}`);
  if (task.status !== 'blocked_needs_human') {
    throw new Error(`path-lock: ожидали blocked_needs_human (кодер только пытался выйти из workspace), получили ${task.status}`);
  }

  const events = listEvents({ task_id: id });
  const blockedEvent = events.find((e) => {
    try { return JSON.parse(e.payload || '{}').event === 'path_lock_blocked'; } catch { return false; }
  });
  if (!blockedEvent) throw new Error('path-lock: событие path_lock_blocked не найдено в journal (нарушение НЕ залогировано)');

  const fs = await import('node:fs');
  const path = await import('node:path');
  const escapedPath = path.join(WORKSPACE, '..', 'evil.js');
  if (fs.existsSync(escapedPath)) {
    throw new Error(`path-lock: файл вне workspace всё-таки материализовался на диске: ${escapedPath}`);
  }
  console.log('[mock] path-lock OK — запись вне workspace заблокирована и залогирована событием path_lock_blocked.');
}

// --- Точка входа `npm run mock` -------------------------------------------
async function main() {
  const { MOCK } = await import('./config.js');
  if (!MOCK) {
    console.error('[mock] MOCK !== true — запусти через "npm run mock" (использует .env.mock).');
    process.exit(1);
  }

  resetMockState();

  const fs = await import('node:fs');
  const { JOURNAL_DB_PATH, SKILLS_DB_PATH, WORKSPACE } = await import('./config.js');
  for (const dbPath of [JOURNAL_DB_PATH, SKILLS_DB_PATH]) {
    for (const suffix of ['', '-wal', '-shm']) {
      const p = dbPath + suffix;
      if (fs.existsSync(p)) fs.rmSync(p);
    }
  }
  if (fs.existsSync(WORKSPACE)) fs.rmSync(WORKSPACE, { recursive: true, force: true });

  const { releaseStuck } = await import('./journal.js');
  releaseStuck();

  const scenarios = [
    ['calculator (Фаза 1/2)', runCalculatorScenario],
    ['project pipeline: wish → router/advisor/architect/coordinator/skill (Фаза 3)', runProjectPipelineScenario],
    ['tweak: router пишет критерий сам (Фаза 3)', runTweakScenario],
    ['question: read-only аналитик, без задач (Фаза 3)', runQuestionScenario],
    ['path-lock: запись вне workspace блокируется и логируется (Фаза 4)', runPathLockScenario],
  ];

  let failed = false;
  for (const [name, fn] of scenarios) {
    console.log(`\n[mock] === ${name} ===`);
    try {
      // eslint-disable-next-line no-await-in-loop
      await fn();
    } catch (e) {
      failed = true;
      console.error(`[mock] FAIL в сценарии "${name}": ${e.message}`);
    }
  }

  if (failed) {
    console.error('\n[mock] ИТОГ: провал (см. выше).');
    process.exit(1);
  }
  console.log('\n[mock] ИТОГ: все сценарии зелёные.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error('[mock] FAIL', e); process.exit(1); });
}

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
import { containsTechnicalQuestion } from '../agents/advisor.js';

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
registerMockHandler('coder', ({ userMsg, idx }) => {
  // ВАЖНО: матчим по title из "## Задача", а не по всему userMsg — секция
  // критерия часто содержит имена файлов (readFileSync('calc.js')), что даёт
  // ложные срабатывания, если смотреть на весь текст промпта.
  const titleMatch = userMsg.match(/## Задача\n([^\n]*)/);
  const title = titleMatch ? titleMatch[1] : userMsg;
  const hasFeedback = /## Отчёт тестера/.test(userMsg);
  const isViewportPolish = /viewport/i.test(title);
  const isWordCountBuild = /Инструмент word-count/.test(title);
  const isWordCountResultPage = /результат подсчёта слов/.test(title);
  const isCalc = /calc\.js/.test(title) && !/index\.html/.test(title);
  // isPage матчит по "index.html" в title — исключаем viewport-правку и
  // Кузницу явно, иначе они перехватываются сюда (их title тоже упоминает
  // index.html) — тот же класс бага, что уже пойман для viewport (DECISIONS
  // Фаза 5.5): сопоставление по подстроке в тексте, где встречаются чужие подстроки.
  const isPage = /index\.html/.test(title) && !isViewportPolish && !isWordCountResultPage;

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

  // Фаза 5.5: polish-задача от live_in — добавить meta viewport.
  if (/viewport/i.test(title)) {
    return {
      files: {
        'index.html': [
          '<!doctype html>',
          '<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Калькулятор</title></head>',
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

  // scar 34 (П§11): критерий сломан (задвоенное экранирование regex, тот же
  // класс бага, что в реальном инциденте со змейкой) — правильный код НИКОГДА
  // не пройдёт эту проверку. Контент варьируется по idx (глобальный счётчик
  // вызовов роли coder), чтобы git tree-хэш РЕАЛЬНО отличался между попытками
  // — иначе детектор корректно отказался бы подозревать критерий («код не
  // менялся» — тоже законный повод не чинить).
  if (/ТЕСТ_БРАК_КРИТЕРИЯ_ЧИНИМ/.test(title)) {
    return { files: { 'notes.txt': `запись номер ${idx}\n` } };
  }
  // scar 34: критерий ЗДЕСЬ верный (SECRET_WORD достижим), но мок-кодер
  // каждый раз честно НЕ пишет его — эмулирует «код правда не так», чтобы
  // проверить, что эвристика (одинаковый провал + разный код) сама по себе
  // НЕ чинит рабочий критерий — решает архитектор-ревьюер.
  if (/ТЕСТ_БРАК_КРИТЕРИЯ_ПОДТВЕРЖДАЕМ/.test(title)) {
    return { files: { 'notes2.txt': `попытка номер ${idx}, слова нет\n` } };
  }

  // §26.6 Кузница: инструмент word-count. Первая попытка — нарочная ошибка
  // (неверный код выхода, а не логика подсчёта) — демонстрирует цикл
  // поймал→отчёт→починил ровно для tool-задачи, как калькулятор — для project.
  if (isWordCountBuild) {
    const toolManifest = JSON.stringify({
      name: 'word-count',
      version: 1,
      description: 'считает слова в текстовом файле, пишет {count} в JSON-файл',
      args: ['inFile', 'outFile'],
      network: 'none',
      timeout_ms: 10000,
    }, null, 2);
    const runJsBody = [
      "const fs = require('fs');",
      'const [, , inFile, outFile] = process.argv;',
      "const text = fs.readFileSync(inFile, 'utf8');",
      'const count = text.trim().split(/\\s+/).filter(Boolean).length;',
      'fs.writeFileSync(outFile, JSON.stringify({ count }));',
    ];
    if (!hasFeedback) {
      return {
        files: {
          'run.js': [...runJsBody, 'process.exit(1); // БАГ: неверный код выхода даже при успешном подсчёте', ''].join('\n'),
          'tool.json': `${toolManifest}\n`,
        },
      };
    }
    return {
      files: {
        'run.js': [...runJsBody, ''].join('\n'),
        'tool.json': `${toolManifest}\n`,
      },
    };
  }

  // §26.6: продукт читает result.json, который написал tool_run word-count.
  if (isWordCountResultPage) {
    return {
      files: {
        'index.html': [
          '<!doctype html>',
          '<html><head><meta charset="utf-8"><title>Результат</title></head>',
          '<body><div id="result">Слов: 5</div></body></html>',
          '',
        ].join('\n'),
      },
    };
  }

  // Фаза 6 (П§5): «8 задач / 2 воркера» — 6 чистых задач (каждая свой файл)
  // + 2 задачи 7/8, которые ДОПОЛНИТЕЛЬНО (не заявляя это в touches_files —
  // искусственный, но реалистичный blind spot file-level weave) пишут в
  // ОБЩИЙ shared.js разными версиями — настоящий git-конфликт при слиянии,
  // ловит core/merge.js:reconcile().
  const parallelClean = title.match(/^Параллельная задача (\d+): (file\d+\.js)$/);
  if (parallelClean) {
    const [, n, file] = parallelClean;
    return { files: { [file]: `module.exports = { n: ${n} };\n` } };
  }
  const parallelConflict = title.match(/^Параллельная задача (\d+): (file\d+\.js) \+ shared\.js \(версия ([AB])\)$/);
  if (parallelConflict) {
    const [, n, file, version] = parallelConflict;
    return {
      files: {
        [file]: `module.exports = { n: ${n} };\n`,
        'shared.js': `module.exports = { version: '${version}' };\n`,
      },
    };
  }

  // Фаза 7 (П§6.1): исследователь заказывает demo-fetch — детерминированный
  // run.js, пишущий {count:3} в файл, указанный первым аргументом.
  if (/^Инструмент demo-fetch:/.test(title)) {
    return {
      files: {
        'run.js': [
          "const fs = require('fs');",
          'const [, , outFile] = process.argv;',
          "fs.writeFileSync(outFile, JSON.stringify({ count: 3 }));",
          '',
        ].join('\n'),
        'tool.json': `${JSON.stringify({
          name: 'demo-fetch', version: 1, description: 'скачивает демо-данные в JSON (MOCK)',
          args: ['outFile'], network: 'none', timeout_ms: 10000,
        }, null, 2)}\n`,
      },
    };
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
  // Фаза 7 (П§6.1): маркер MOCK-сценария исследователя — симптом без готового
  // решения, требует диагностики (protocol=problem), не хотелка.
  if (/^ТЕСТ_ИССЛЕДОВАТЕЛЬ/.test(text)) {
    return { route: 'problem', reason: 'клиент описывает боль, не решение — требует диагностики' };
  }
  return { route: 'wish', reason: 'клиент описал желаемый результат нового продукта' };
});

// --- Фаза 3: advisor (intake wish/problem/spec + analyst) -----------------
registerMockHandler('advisor', ({ userMsg, opts }) => {
  if (opts.agent === 'consultant_report') {
    // §17: печатается при закрытии project-дерева — обычный текст, не JSON.
    return [
      'Отчёт консультанта (MOCK).',
      'Принятые решения: см. engineering_defaults брифа — каждое с обоснованием.',
      'Проверено обоими контурами: код (checkRunner + регрессия) и впечатление (обживание).',
      'Задач, требующих вашего решения, на доске не найдено.',
      'Следующий шаг: можно расширять функциональность через tweak.',
    ].join('\n');
  }
  if (opts.json === false) {
    // advisor_analyst (question-протокол): обычный текст, не JSON.
    return 'Мок-аналитик: calc.js экспортирует функции add(a,b) и subtract(a,b) для сложения и вычитания.';
  }

  // --- Фаза 7 (П§6.2, §11): ingest ТЗ-пакета — разбор документа и поиск дыр.
  // Требования узнаются по формату фикстур (строка "- текст" = требование) —
  // намеренно НЕ завязано на конкретное содержимое фикстуры, тот же путь,
  // которым размечен любой реальный документ в markdown/txt.
  if (/^## Режим: разбор документа/.test(userMsg)) {
    const requirements = [];
    let n = 0;
    for (const line of userMsg.split('\n')) {
      const m = line.match(/^- (.+)$/);
      if (m) { n += 1; requirements.push({ id: `R${n}`, text: m[1].trim() }); }
    }
    return { requirements };
  }
  if (/^## Режим: поиск дыр/.test(userMsg)) {
    // Маркер TODO_HOLE в тексте требования (см. фикстуру evals/fixtures/
    // spec-package/02-payment.md) — требование без проверяемого критерия,
    // ровно то, что §11 велит ловить: "требование без критерия — дыра".
    const holes = [];
    const questions = [];
    const reqRe = /^- (\S+) \([^)]*\): (.+)$/gm;
    let m = reqRe.exec(userMsg);
    while (m) {
      const [, id, text] = m;
      if (/TODO_HOLE/.test(text)) {
        const clean = text.replace('TODO_HOLE', '').trim();
        holes.push({ req_id: id, description: `требование "${clean}" не даёт числа/условия — непроверяемо` });
        questions.push({ req_id: id, question: `Уточните измеримый критерий для: ${clean}` });
      }
      m = reqRe.exec(userMsg);
    }
    return { holes, contradictions: [], questions };
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
registerMockHandler('architect', ({ userMsg, opts }) => {
  // scar 34 (П§11): agents/architect.js:reviewCriterion() — отдельный
  // JSON-контракт поверх ТОГО ЖЕ architect.md (симметрично regenerateCriteria
  // выше — «фиктивный критерий»), различается по opts.agent, не по title,
  // т.к. это НЕ вызов планирования дерева.
  if (opts?.agent === 'architect_criteria_review') {
    if (/ТЕСТ_БРАК_КРИТЕРИЯ_ЧИНИМ/.test(userMsg)) {
      return {
        verdict: 'criterion_defect',
        cmd: 'node -e "const fs=require(\'fs\');const t=fs.readFileSync(\'notes.txt\',\'utf8\');if(/\\d/.test(t)){console.log(\'PASS notes.txt содержит цифру\')}else{console.error(\'FAIL: notes.txt должен содержать цифру, got: \'+JSON.stringify(t));process.exit(1)}"',
        reason: 'MOCK: в исходном критерии было задвоенное экранирование (совпадает с буквальным \\d, не с цифрой) — заменено на одинарное.',
      };
    }
    if (/ТЕСТ_БРАК_КРИТЕРИЯ_ПОДТВЕРЖДАЕМ/.test(userMsg)) {
      return {
        verdict: 'confirmed_block',
        reason: 'MOCK: критерий требует SECRET_WORD — текст корректен и достижим правильным кодом, дело в коде, не в проверке.',
      };
    }
    return { verdict: 'confirmed_block', reason: 'MOCK: дефолтная ветка ревью критерия — блок остаётся (консервативный дефолт).' };
  }

  // §11, П§6.2: ingest ТЗ-пакета — architect обязан трассировать covers.
  // Намеренно НЕ покрываем ПОСЛЕДНЕЕ требование из списка — честная проверка,
  // что harness ловит именно пропуск архитектора (отдельный класс дыры от
  // TODO_HOLE, который уже поймал ingest ДО этого вызова).
  if (/## Требования ТЗ-пакета/.test(userMsg)) {
    const ids = [];
    const reqRe = /^- (\S+): /gm;
    let m = reqRe.exec(userMsg);
    while (m) { ids.push(m[1]); m = reqRe.exec(userMsg); }
    const covered = ids.slice(0, -1);
    return {
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
          covers: covered,
        },
        {
          title: 'index.html: калькулятор подключает calc.js и показывает 2+3 и 5-2',
          spec: 'Создай index.html. Подключи calc.js через <script src="calc.js"></script>. В теле должны быть числа 5 и 3.',
          criteria: {
            cmd: 'node -e "const fs=require(\'fs\'); const h=fs.readFileSync(\'index.html\',\'utf8\'); const ok=h.includes(\'calc.js\')&&h.includes(\'5\')&&h.includes(\'3\'); if(ok){console.log(\'PASS html содержит calc.js и результаты\')}else{console.error(\'FAIL: index.html не содержит calc.js или результаты\'); process.exit(1)}"',
          },
          touches_files: ['index.html'],
          depends_on_title: 'calc.js: экспортирует add(a,b) и subtract(a,b)',
          covers: [],
        },
      ],
    };
  }

  // §26.6 Кузница: DAG tool → tool_run → project, читающий результат.
  if (/ТЕСТ_КУЗНИЦА/.test(userMsg)) {
    return {
      packages: [],
      tasks: [
        {
          title: 'Инструмент word-count: считает слова в файле',
          type: 'tool',
          tool_name: 'word-count',
          spec: 'Собери tools/word-count/run.js — первый аргумент: путь входного файла, второй: путь выходного JSON. Пишет {"count":N} и завершается кодом 0. Плюс обязательный tool.json.',
          criteria: {
            cmd: "node -e \"const fs=require('fs');const{execFileSync}=require('child_process');fs.writeFileSync('fixture.txt','one two three four five');try{execFileSync('node',['run.js','fixture.txt','out.json']);}catch(e){console.error('FAIL: run.js завершился с ошибкой: '+e.message);process.exit(1);}const out=JSON.parse(fs.readFileSync('out.json','utf8'));if(out.count===5){console.log('PASS count=5')}else{console.error('FAIL: ожидали count=5, получили '+JSON.stringify(out));process.exit(1)}\"",
          },
          touches_files: ['run.js', 'tool.json'],
          depends_on_title: null,
        },
        {
          title: 'Запуск word-count на demo.txt продукта',
          type: 'tool_run',
          tool_name: 'word-count',
          tool_args: ['demo.txt', 'result.json'],
          spec: 'Запусти word-count на demo.txt продукта, результат — result.json.',
          criteria: {
            cmd: "node -e \"const fs=require('fs');if(!fs.existsSync('result.json')){console.error('FAIL: result.json не создан');process.exit(1)}const r=JSON.parse(fs.readFileSync('result.json','utf8'));if(r.count===5){console.log('PASS result.json count=5')}else{console.error('FAIL: result.json содержит '+JSON.stringify(r));process.exit(1)}\"",
          },
          depends_on_title: 'Инструмент word-count: считает слова в файле',
        },
        {
          title: 'index.html: показывает результат подсчёта слов',
          spec: 'Создай index.html, который печатает "Слов: N" — N результат word-count из result.json (лежит рядом, в корне workspace).',
          criteria: {
            cmd: "node -e \"const fs=require('fs');const h=fs.readFileSync('index.html','utf8');const r=JSON.parse(fs.readFileSync('result.json','utf8'));const needle='Слов: '+r.count;if(h.includes(needle)){console.log('PASS html содержит '+needle)}else{console.error('FAIL: index.html не содержит \\''+needle+'\\'');process.exit(1)}\"",
          },
          touches_files: ['index.html'],
          depends_on_title: 'Запуск word-count на demo.txt продукта',
        },
      ],
    };
  }

  return {
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
  };
});

// --- Фаза 5.5: live_in (обживатель) ----------------------------------------
// Реальная (не выдуманная) шероховатость: architect-сценарий калькулятора не
// добавляет <meta name="viewport">, из-за чего страница не адаптируется под
// мобильные 375px — ровно то наблюдение, которое обживание обязано ловить.
registerMockHandler('live_in', ({ userMsg }) => {
  // Если в собранных фактах о продукте (## Собранные факты) уже упоминается
  // "viewport" — значит, meta-тег на месте (повторный обход после фикса),
  // шероховатостей больше нет. Иначе — репортим её.
  if (!/viewport/i.test(userMsg)) {
    return {
      rough_spots: [{
        title: 'index.html: добавить meta viewport для мобильных 375px',
        description: 'Добавить <meta name="viewport" content="width=device-width, initial-scale=1"> в <head>.',
        justification: 'Собранные факты о продукте не показывают meta viewport — на мобильном 375px страница будет отображаться как уменьшенная десктопная версия, а не адаптированная.',
        criteria: {
          cmd: 'node -e "const fs=require(\'fs\'); const h=fs.readFileSync(\'index.html\',\'utf8\'); if(h.includes(\'viewport\')){console.log(\'PASS содержит viewport\')}else{console.error(\'FAIL: index.html не содержит meta viewport\'); process.exit(1)}"',
        },
      }],
    };
  }
  return { rough_spots: [] };
});

// --- Фаза 3: skill_writer ---------------------------------------------------
registerMockHandler('skill', ({ userMsg }) => {
  const m = userMsg.match(/## Файлы, которых касалась задача \(touches_files\)\n([\s\S]*?)\n\n##/);
  const files = m ? m[1].split('\n').map((s) => s.trim()).filter((s) => s && s !== '(не указаны)') : [];
  if (!files.length) return { skip: true };
  return { lesson: `${files[0]}: реализовать ВСЕ ветки функции сразу — тестер ловит частичные реализации говорящим провалом.` };
});

// --- cheap (псевдо-judge в evals/interview.js И reconciler Фазы 6) --------
// Переиспользует ТОЧНО ТУ ЖЕ функцию, что и код-уровневый guard в
// agents/advisor.js — не дублирует регэксп второй раз с риском разъехаться.
registerMockHandler('cheap', ({ userMsg }) => {
  // §16 mock-reconciler (DoD П§5: «mock-reconciler выбирает theirs») —
  // распознаётся по маркеру заголовка, который всегда пишет core/merge.js:reconcile().
  if (/^## Конфликт слияния/.test(userMsg)) {
    const files = {};
    const fileRe = /### Файл: (\S+)/g;
    let m = fileRe.exec(userMsg);
    while (m) {
      files[m[1]] = 'theirs';
      m = fileRe.exec(userMsg);
    }
    return { files };
  }
  return { has_technical_terms: containsTechnicalQuestion(userMsg) };
});

// --- Фаза 7 (П§6.1): researcher — план + оценка -----------------------------
// Маркер отличия двух путей ('OK' vs 'NODATA') не может читаться из брифа на
// звонке 2 (Звонок 2 по спеке видит ТОЛЬКО отчёты tool_run + глаза, не
// исходный текст problem) — поэтому маркер прокидывается через args
// tool_run'а, что попадает в title задачи, а title виден в отчёте ("##
// Отчёт tool_run ...") — честно, без бокового канала мимо контракта.
registerMockHandler('researcher', ({ userMsg }) => {
  if (/^## Режим: план/.test(userMsg)) {
    const noData = /ТЕСТ_ИССЛЕДОВАТЕЛЬ_НЕТ_ДАННЫХ/.test(userMsg);
    return {
      sources: [{ url: 'https://example.test/demo', what: 'демо-источник для MOCK', freshness_hint: 'раз в день' }],
      need_tools: [{
        tool_name: 'demo-fetch',
        purpose: 'скачивает демо-данные в JSON',
        io: 'outFile -> {count}',
        criteria: {
          cmd: "node -e \"const fs=require('fs');const{execFileSync}=require('child_process');try{execFileSync('node',['run.js','out.json']);}catch(e){console.error('FAIL: '+e.message);process.exit(1);}const r=JSON.parse(fs.readFileSync('out.json','utf8'));if(r.count===3){console.log('PASS count=3')}else{console.error('FAIL: '+JSON.stringify(r));process.exit(1)}\"",
        },
      }],
      tool_runs: [{
        tool: 'demo-fetch',
        args: noData ? ['data.json', 'NODATA'] : ['data.json'],
        data_criteria: [{ cmd: "node -e \"const fs=require('fs');if(fs.existsSync('data.json')){console.log('PASS data.json существует')}else{console.error('FAIL: data.json не создан');process.exit(1)}\"" }],
      }],
      data_criteria: [],
    };
  }
  if (/^## Режим: оценка/.test(userMsg)) {
    if (/NODATA/.test(userMsg)) {
      return { verdict: 'data_unavailable', client_note: 'MOCK: этих данных не существует в открытом виде — демонстрация стоп-фактора §10.' };
    }
    return { verdict: 'proceed', data_summary: 'MOCK: 3 демо-записи добыты успешно из demo-fetch.', for_architect: 'Данные (3 демо-записи) лежат в data.json продукта — используй как есть.' };
  }
  throw new Error('mock.js: researcher — не распознан режим (план/оценка) в userMsg');
});

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
  const { routeRequest } = await import('../agents/router.js');
  const { startIntake, buildBrief } = await import('../agents/advisor.js');
  const { runArchitect } = await import('../agents/architect.js');
  const { runCoordinatorLoop } = await import('./coordinator.js');
  const { listWorkspaceFileNames } = await import('../agents/coder.js');
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

  // --- Фаза 5.5: обживание ОДИН раз после зелёной доски + отчёт консультанта
  const { runLivein } = await import('../agents/livein.js');
  const { buildConsultantReport } = await import('../agents/advisor.js');

  const liveinResult = await runLivein({ rootSpec: brief.summary, workspaceDir: WORKSPACE, runId, projectId: 'default' });
  if (!liveinResult.ok) throw new Error(`live_in: не удалось осмотреть продукт: ${liveinResult.error}`);
  if (liveinResult.roughSpotsFound < 1) throw new Error('live_in: ожидали ≥1 реальную шероховатость (отсутствие meta viewport), нашли 0');
  console.log(`[mock] live_in: найдено шероховатостей ${liveinResult.roughSpotsFound}, создано polish-задач ${liveinResult.taskIds.length}`);

  await runCoordinatorLoop({ role: 'coder', workspaceDir: WORKSPACE });
  const polishTasks = liveinResult.taskIds.map(getTask);
  if (!polishTasks.every((t) => t.status === 'done')) {
    throw new Error(`live_in: polish-задача(и) не закрылись: ${polishTasks.map((t) => t.status).join(', ')}`);
  }
  console.log('[mock] live_in OK — шероховатость найдена и закрыта tweak/polish-циклом.');

  const report = await buildConsultantReport({
    protocol: 'wish', rootSpec: brief.summary, engineeringDefaults: brief.engineering_defaults,
    problem: brief.problem, boardSummary: `${allIds.length + polishTasks.length} задач в дереве`,
    liveinSummary: `найдено и закрыто: ${liveinResult.roughSpotsFound}`, runId,
  });
  if (typeof report !== 'string' || !report.trim()) throw new Error('consultant report: пустой отчёт');
  console.log(`[mock] consultant report OK (${report.length} симв.):\n${report.split('\n').map((l) => `    ${l}`).join('\n')}`);

  // --- Фаза 5 (П§3): публикация — MOCK всегда dry-run (§24), ни gh, ни сеть
  // не трогаются; проверяется только корректность построенной команды.
  const { ensureProductRepo, slugify } = await import('./github.js');
  const repoName = slugify(brief.summary);
  const githubResult = ensureProductRepo(WORKSPACE, repoName, { dryRun: true });
  if (!githubResult.dryRun) throw new Error('github: MOCK обязан быть dry-run (GITHUB_PUSH игнорируется в MOCK, §24)');
  if (!githubResult.dryRunCmd.includes('gh repo create') || !githubResult.dryRunCmd.includes(repoName)) {
    throw new Error(`github: dry-run команда выглядит некорректно: ${githubResult.dryRunCmd}`);
  }
  console.log(`[mock] github dry-run OK: ${githubResult.dryRunCmd}`);
}

// --- Сценарий В (Фаза 3): tweak — router сам пишет критерий ---------------
async function runTweakScenario() {
  const { addTask, getTask, newRunId } = await import('./journal.js');
  const { routeRequest } = await import('../agents/router.js');
  const { runCoordinatorLoop } = await import('./coordinator.js');
  const { listWorkspaceFileNames } = await import('../agents/coder.js');
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
  const { routeRequest } = await import('../agents/router.js');
  const { runAnalyst } = await import('../agents/advisor.js');
  const { listWorkspaceFileNames } = await import('../agents/coder.js');
  const { WORKSPACE } = await import('./config.js');

  const runId = newRunId();
  const text = 'что делает calc.js?';

  const routed = await routeRequest({ text, workspaceFiles: listWorkspaceFileNames(WORKSPACE), runId });
  if (routed.route !== 'question') throw new Error(`question: ожидали route=question, получили ${routed.route}`);

  const rootSpec = getRootSpec('default');
  const answer = await runAnalyst({
    question: text, rootSpec: rootSpec?.spec, workspaceDir: WORKSPACE, runId,
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

// --- Сценарий (scar 34, П§11): подозрение на брак критерия ----------------
// Две задачи: ЧИНИМ — критерий сломан (задвоенный regex, тот же класс бага,
// что реальный инцидент со змейкой: работающий код не мог пройти проверку
// НИКОГДА) — эвристика находит одинаковый провал при разном коде, архитектор
// подтверждает поломку и чинит критерий, дерево доходит до done с первой
// попытки ПОСЛЕ починки. ПОДТВЕРЖДАЕМ — критерий корректен, код мок-кодера
// каждый раз честно не соответствует ему — эвристика подозревает то же
// самое (одинаковый провал + разный код), но архитектор-ревьюер отклоняет
// «починку»: задача остаётся blocked_needs_human, как обычно.
async function runCriteriaDefectScenario() {
  const {
    addTask, getTask, listEvents,
  } = await import('./journal.js');
  const { runCoordinatorLoop } = await import('./coordinator.js');
  const { WORKSPACE } = await import('./config.js');

  const eventNames = (taskId) => listEvents({ task_id: taskId }).map((e) => {
    try { return JSON.parse(e.payload || '{}').event; } catch { return null; }
  });

  const titleRepair = 'ТЕСТ_БРАК_КРИТЕРИЯ_ЧИНИМ: notes.txt с цифрой';
  const idRepair = addTask({
    title: titleRepair,
    spec: 'Создай notes.txt с любым текстом, содержащим хотя бы одну цифру.',
    criteria: JSON.stringify({
      // Реальный класс бага (scar 34): /\\d/ (два реальных бэкслеша) ищет
      // буквальную подстроку "\d", а не цифру — правильный код пройти НЕ МОЖЕТ.
      cmd: 'node -e "const fs=require(\'fs\');const t=fs.readFileSync(\'notes.txt\',\'utf8\');if(/\\\\d/.test(t)){console.log(\'PASS\')}else{console.error(\'FAIL: notes.txt должен содержать цифру, got: \'+JSON.stringify(t));process.exit(1)}"',
    }),
    role: 'coder',
    type: 'project',
    budget_usd: 100,
  });

  const titleConfirm = 'ТЕСТ_БРАК_КРИТЕРИЯ_ПОДТВЕРЖДАЕМ: notes2.txt с SECRET_WORD';
  const idConfirm = addTask({
    title: titleConfirm,
    spec: 'Создай notes2.txt, содержащий слово SECRET_WORD.',
    criteria: JSON.stringify({
      cmd: 'node -e "const fs=require(\'fs\');const t=fs.readFileSync(\'notes2.txt\',\'utf8\');if(t.includes(\'SECRET_WORD\')){console.log(\'PASS\')}else{console.error(\'FAIL: notes2.txt не содержит SECRET_WORD\');process.exit(1)}"',
    }),
    role: 'coder',
    type: 'project',
    budget_usd: 100,
  });

  await runCoordinatorLoop({ role: 'coder', workspaceDir: WORKSPACE });

  const repaired = getTask(idRepair);
  console.log(`[mock] criteria-defect (чиним): status=${repaired.status} attempts=${repaired.attempts}`);
  if (repaired.status !== 'done') {
    throw new Error(`criteria-defect (чиним): ожидали done после починки критерия архитектором, получили ${repaired.status}`);
  }
  const repairEvents = eventNames(idRepair);
  if (!repairEvents.includes('criteria_defect_suspected')) {
    throw new Error('criteria-defect (чиним): событие criteria_defect_suspected не найдено — эвристика не сработала');
  }
  if (!repairEvents.includes('criteria_repaired')) {
    throw new Error('criteria-defect (чиним): событие criteria_repaired не найдено — критерий не был пересобран');
  }
  console.log('[mock] criteria-defect (чиним) OK — сломанный критерий (задвоенный regex) обнаружен и пересобран архитектором, дерево дошло до done.');

  const confirmed = getTask(idConfirm);
  console.log(`[mock] criteria-defect (подтверждаем): status=${confirmed.status} attempts=${confirmed.attempts}`);
  if (confirmed.status !== 'blocked_needs_human') {
    throw new Error(`criteria-defect (подтверждаем): ожидали blocked_needs_human (критерий подтверждён верным), получили ${confirmed.status}`);
  }
  const confirmEvents = eventNames(idConfirm);
  if (!confirmEvents.includes('criteria_defect_suspected')) {
    throw new Error('criteria-defect (подтверждаем): событие criteria_defect_suspected не найдено — эвристика не сработала');
  }
  if (!confirmEvents.includes('criteria_defect_confirmed')) {
    throw new Error('criteria-defect (подтверждаем): событие criteria_defect_confirmed не найдено — архитектор не подтвердил критерий');
  }
  if (confirmEvents.includes('criteria_repaired')) {
    throw new Error('criteria-defect (подтверждаем): критерий НЕ должен был чиниться — это ложное срабатывание репарации на рабочем критерии');
  }
  console.log('[mock] criteria-defect (подтверждаем) OK — эвристика заподозрила брак, архитектор подтвердил критерий верным, блок остался (доверие построено на недоверии).');
}

// --- Сценарий Е (§26.6, П§4): Кузница инструментов — сборка (поймал→починил) →
// --- регистрация → tool_run → продукт читает результат; version-bump ------
async function runForgeScenario() {
  const {
    newRunId, setRootSpec, getTask, listEvents,
  } = await import('./journal.js');
  const { routeRequest } = await import('../agents/router.js');
  const { startIntake, buildBrief } = await import('../agents/advisor.js');
  const { runArchitect } = await import('../agents/architect.js');
  const { runCoordinatorLoop } = await import('./coordinator.js');
  const { listWorkspaceFileNames } = await import('../agents/coder.js');
  const { getTool, registerTool } = await import('./tools.js');
  const { WORKSPACE, TOOLS_DIR } = await import('./config.js');
  const fsMod = await import('node:fs');
  const pathMod = await import('node:path');

  // Сценарий самодостаточен (тот же принцип, что и project pipeline): не
  // зависит от того, что оставили предыдущие сценарии в workspace/tools.
  if (fsMod.existsSync(WORKSPACE)) fsMod.rmSync(WORKSPACE, { recursive: true, force: true });
  if (fsMod.existsSync(TOOLS_DIR)) fsMod.rmSync(TOOLS_DIR, { recursive: true, force: true });
  fsMod.mkdirSync(WORKSPACE, { recursive: true });
  // demo.txt продукта — вход для tool_run; в реальном сценарии его создала бы
  // предыдущая задача дерева, здесь сценарий готовит его сам, чтобы не тянуть
  // многозвенный fan-in (task_deps на ДВЕ задачи) только ради демонстрации Кузницы.
  fsMod.writeFileSync(pathMod.join(WORKSPACE, 'demo.txt'), 'one two three four five', 'utf8');

  const runId = newRunId();
  const text = 'ТЕСТ_КУЗНИЦА: хочу инструмент, который считает слова в demo.txt, и страницу с результатом.';

  const routed = await routeRequest({ text, workspaceFiles: listWorkspaceFileNames(WORKSPACE), runId });
  if (routed.route !== 'wish') throw new Error(`forge: ожидали route=wish, получили ${routed.route}`);

  const { step } = await startIntake({ protocol: 'wish', initialText: text, runId });
  if (step.type !== 'ready') throw new Error('forge: мок-советник должен сразу вернуть ready');

  const brief = buildBrief({ protocol: 'wish', initialText: text, step });
  setRootSpec('default', brief.summary, brief.engineering_defaults, 'wish');

  const architectResult = await runArchitect({
    brief, workspaceDir: WORKSPACE, workspaceListing: listWorkspaceFileNames(WORKSPACE), runId, projectId: 'default',
  });
  if (!architectResult.ok) throw new Error(`forge: architect failed: ${architectResult.error}`);
  if (architectResult.taskIds.length !== 3) {
    throw new Error(`forge: ожидали 3 задачи (tool+tool_run+project), получили ${architectResult.taskIds.length}`);
  }

  await runCoordinatorLoop({ role: 'coder', workspaceDir: WORKSPACE, runId });

  const allIds = [...architectResult.taskIds, architectResult.regressionId];
  const finalTasks = allIds.map(getTask);
  console.log(`[mock] forge: ${finalTasks.map((t) => `${t.type}:${t.status}`).join(', ')}`);
  if (!finalTasks.every((t) => t.status === 'done')) {
    throw new Error('forge: не все задачи дерева (включая регрессию) дошли до done');
  }

  const buildTask = finalTasks.find((t) => t.type === 'tool');
  if (!buildTask) throw new Error('forge: задача type=tool не найдена в дереве');
  if (buildTask.attempts < 2) {
    throw new Error(`forge: ожидали ≥2 попытки сборки word-count (демонстрация поймал→починил), получили ${buildTask.attempts}`);
  }

  const tool = getTool('word-count');
  if (!tool) throw new Error('forge: word-count не зарегистрирован в tools после done');
  if (tool.created_by_task !== buildTask.id) {
    throw new Error(`forge: tools.created_by_task (${tool.created_by_task}) не совпадает с задачей сборки (${buildTask.id})`);
  }
  console.log(`[mock] forge: word-count зарегистрирован (v${tool.version}, created_by_task=${tool.created_by_task})`);

  const toolRunEvents = listEvents({ type: 'tool_run' });
  if (!toolRunEvents.length) throw new Error('forge: событие tool_run не найдено в events');
  console.log(`[mock] forge: событие tool_run найдено (${toolRunEvents.length})`);

  const resultPath = pathMod.join(WORKSPACE, 'result.json');
  if (!fsMod.existsSync(resultPath)) throw new Error('forge: result.json не создан tool_run в workspace продукта (§26.3 п.1: cwd=workspace)');
  const result = JSON.parse(fsMod.readFileSync(resultPath, 'utf8'));
  if (result.count !== 5) throw new Error(`forge: ожидали count=5 в result.json, получили ${JSON.stringify(result)}`);

  console.log('[mock] forge OK — сборка (поймал→починил) → регистрация → tool_run → продукт честно читает результат.');

  // --- reuse + version-bump при повторном заказе с изменённым описанием (DoD §26.6) ---
  const before = getTool('word-count');
  registerTool({ name: 'word-count', description: `${before.description} (обновлено)`, created_by_task: buildTask.id });
  const afterBump = getTool('word-count');
  if (afterBump.version !== before.version + 1) {
    throw new Error(`forge: ожидали version-bump v${before.version}→v${before.version + 1} при изменённом описании, получили v${afterBump.version}`);
  }
  console.log(`[mock] forge: version-bump подтверждён (v${before.version} → v${afterBump.version}) при изменённом описании.`);

  // Повторная регистрация с ТЕМ ЖЕ описанием — reuse идемпотентен, версия не растёт.
  registerTool({ name: 'word-count', description: afterBump.description, created_by_task: buildTask.id });
  const afterSame = getTool('word-count');
  if (afterSame.version !== afterBump.version) {
    throw new Error(`forge: повторная регистрация с тем же описанием не должна менять версию (v${afterBump.version} → v${afterSame.version})`);
  }
  console.log('[mock] forge: повторная регистрация с тем же описанием — версия не изменилась (reuse идемпотентен).');
}

// --- Сценарий Ж (§16, П§5): параллельность — 8 задач / 2 воркера ----------
async function runParallelScenario() {
  const {
    addTask, listTasks, listEvents, newRunId,
  } = await import('./journal.js');
  const { runCoordinatorLoop } = await import('./coordinator.js');
  const { WORKSPACE, WORKTREES_DIR, ROOT } = await import('./config.js');
  const { tscGate } = await import('./merge.js');
  const fsMod = await import('node:fs');
  const pathMod = await import('node:path');
  const osMod = await import('node:os');

  if (fsMod.existsSync(WORKSPACE)) fsMod.rmSync(WORKSPACE, { recursive: true, force: true });
  if (fsMod.existsSync(WORKTREES_DIR)) fsMod.rmSync(WORKTREES_DIR, { recursive: true, force: true });
  fsMod.mkdirSync(WORKSPACE, { recursive: true });

  // --- tsc-ворота: юнит-проверка трёх веток, БЕЗ сети (npx без предустановленного
  // пакета качает его из сети — недопустимо в MOCK, §24). typescript — optionalDependency:
  // может быть установлен или нет на конкретной машине — ветку "недоступен локально"
  // проверяем НЕ полагаясь на реальное отсутствие пакета в ROOT/node_modules (раньше
  // scratch лежал внутри ROOT на той же глубине, что и настоящий worktree, поэтому
  // resolveTscBin() случайно находил РЕАЛЬНЫЙ ROOT/node_modules/.bin/tsc, стоило
  // typescript оказаться установленным — реальный баг, вскрытый этим же прогоном).
  // scratch — вне дерева ROOT (os.tmpdir()), так что fallback-кандидат
  // `worktreePath/../../node_modules/.bin` физически не может попасть на ROOT.
  const scratch = pathMod.join(osMod.tmpdir(), `loom-tsc-gate-scratch-${process.pid}`);
  fsMod.rmSync(scratch, { recursive: true, force: true });

  const noConfigDir = pathMod.join(scratch, 'no-config');
  fsMod.mkdirSync(noConfigDir, { recursive: true });
  const gateNoConfig = tscGate(noConfigDir);
  if (!gateNoConfig.ok) throw new Error('tsc-gate: без tsconfig.json ворота обязаны быть ok=true (не применимы)');

  const noBinDir = pathMod.join(scratch, 'no-bin');
  fsMod.mkdirSync(noBinDir, { recursive: true });
  fsMod.writeFileSync(pathMod.join(noBinDir, 'tsconfig.json'), '{}', 'utf8');
  const gateNoBin = tscGate(noBinDir);
  if (!gateNoBin.ok || !gateNoBin.skipped) {
    throw new Error('tsc-gate: typescript недоступен локально — ворота обязаны graceful-degrade (ok=true, skipped=true), не блокировать и не лезть в сеть');
  }

  const badDir = pathMod.join(scratch, 'bad-dts');
  const binDir = pathMod.join(badDir, 'node_modules', '.bin');
  fsMod.mkdirSync(binDir, { recursive: true });
  fsMod.writeFileSync(pathMod.join(badDir, 'tsconfig.json'), '{}', 'utf8');
  fsMod.writeFileSync(pathMod.join(badDir, 'bad.d.ts'), 'declare const x: DoesNotExist;\n', 'utf8');
  const fakeTscImplPath = pathMod.join(ROOT, 'evals', 'fixtures', 'fake-tsc-impl.js');
  if (process.platform === 'win32') {
    fsMod.writeFileSync(pathMod.join(binDir, 'tsc.cmd'), `@echo off\r\nnode "${fakeTscImplPath}" %*\r\n`, 'utf8');
  } else {
    const shPath = pathMod.join(binDir, 'tsc');
    fsMod.writeFileSync(shPath, `#!/bin/sh\nnode "${fakeTscImplPath}" "$@"\n`, 'utf8');
    fsMod.chmodSync(shPath, 0o755);
  }
  const gateBad = tscGate(badDir);
  if (gateBad.ok) throw new Error('tsc-gate: с подсунутым битым bad.d.ts (через тестовый двойник tsc) ворота обязаны быть ok=false');
  fsMod.rmSync(scratch, { recursive: true, force: true });
  console.log('[mock] tsc-gate юнит-проверки OK: без tsconfig → не применимо; tsc недостижим из scratch → graceful skip (без сети); битый d.ts → gate=false.');

  // --- 8 задач / 2 воркера: 6 «чистых» + 2 с искусственным конфликтом на shared.js ---
  const runId = newRunId();
  for (let n = 1; n <= 6; n++) {
    addTask({
      title: `Параллельная задача ${n}: file${n}.js`,
      spec: `Создай file${n}.js.`,
      criteria: JSON.stringify({ cmd: `node -e "const fs=require('fs'); if(fs.existsSync('file${n}.js')){console.log('PASS file${n}.js')}else{console.error('FAIL: file${n}.js missing');process.exit(1)}"` }),
      role: 'coder',
      type: 'project',
      touches_files: [`file${n}.js`],
    });
  }
  // 7/8 НЕ объявляют shared.js в touches_files (реалистичный blind spot
  // file-level weave, §16 п.3: touches_functions/tree-sitter сознательно НЕ
  // в v1.0-final) — оба claim'ятся в одном раунде, оба пишут shared.js
  // разными версиями в СВОИХ worktree, конфликт всплывает на merge, не раньше.
  for (const [n, version] of [[7, 'A'], [8, 'B']]) {
    addTask({
      title: `Параллельная задача ${n}: file${n}.js + shared.js (версия ${version})`,
      spec: `Создай file${n}.js; также запиши shared.js версии ${version} (искусственный конфликт для проверки reconciler'а).`,
      criteria: JSON.stringify({ cmd: `node -e "const fs=require('fs'); if(fs.existsSync('file${n}.js')){console.log('PASS file${n}.js')}else{console.error('FAIL: file${n}.js missing');process.exit(1)}"` }),
      role: 'coder',
      type: 'project',
      touches_files: [`file${n}.js`],
    });
  }

  await runCoordinatorLoop({
    role: 'coder', workspaceDir: WORKSPACE, workers: 2, runId,
  });

  const tasks = listTasks({ role: 'coder' }).filter((t) => t.title.startsWith('Параллельная задача'));
  console.log(`[mock] parallel: ${tasks.map((t) => `${t.title.split(':')[0]}=${t.status}`).join(', ')}`);
  if (tasks.length !== 8) throw new Error(`parallel: ожидали 8 задач, нашли ${tasks.length}`);
  if (!tasks.every((t) => t.status === 'merged')) {
    throw new Error(`parallel: не все 8 задач дошли до merged: ${tasks.map((t) => `${t.id}=${t.status}`).join('; ')}`);
  }
  if (!tasks.every((t) => t.attempts === 1)) {
    throw new Error(`parallel: ожидали ровно 1 попытку на задачу (ни одного двойного захвата/повтора), получили ${tasks.map((t) => t.attempts).join(',')}`);
  }

  const mergedEvents = listEvents({ type: 'merged' }).filter((e) => tasks.some((t) => t.id === e.task_id));
  if (mergedEvents.length !== 8) throw new Error(`parallel: ожидали 8 merged-событий, получили ${mergedEvents.length}`);
  for (let i = 1; i < mergedEvents.length; i++) {
    if (mergedEvents[i].created_at < mergedEvents[i - 1].created_at) {
      throw new Error('parallel: merge-события не монотонны по времени — очередь мёржей не последовательна');
    }
  }
  const workersUsed = new Set(mergedEvents.map((e) => {
    try { return JSON.parse(e.payload || '{}').worker; } catch { return null; }
  }).filter(Boolean));
  if (workersUsed.size < 2) throw new Error(`parallel: ожидали, что оба воркера (w1,w2) реально поучаствовали, видно только: ${[...workersUsed].join(',')}`);

  const resolvedConflict = mergedEvents.find((e) => {
    try {
      const p = JSON.parse(e.payload || '{}');
      return p.conflict === true && p.resolved === true;
    } catch { return false; }
  });
  if (!resolvedConflict) throw new Error('parallel: не найдено ни одного успешно разрешённого конфликта — reconciler не сработал');

  const sharedContent = fsMod.readFileSync(pathMod.join(WORKSPACE, 'shared.js'), 'utf8');
  if (!/version:\s*'[AB]'/.test(sharedContent)) {
    throw new Error(`parallel: shared.js в main не похож на результат reconcile: ${sharedContent}`);
  }

  console.log(`[mock] parallel OK — 8/8 merged с первой попытки, очередь мёржей последовательна (${mergedEvents.length} событий), оба воркера (${[...workersUsed].join(',')}) поучаствовали, конфликт shared.js разрешён reconciler'ом ("theirs"), итоговое содержимое: ${sharedContent.trim()}`);
}

// --- Сценарий З (§10, П§6.1): исследователь — proceed И жёсткий стоп-фактор ---
async function runResearcherScenario() {
  const {
    newRunId, setRootSpec, getTask,
  } = await import('./journal.js');
  const { routeRequest } = await import('../agents/router.js');
  const { startIntake, buildBrief, buildConsultantReport } = await import('../agents/advisor.js');
  const { planResearch, evaluateResearch } = await import('../agents/researcher.js');
  const { runArchitect } = await import('../agents/architect.js');
  const { runCoordinatorLoop } = await import('./coordinator.js');
  const { listWorkspaceFileNames } = await import('../agents/coder.js');
  const { WORKSPACE } = await import('./config.js');
  const fsMod = await import('node:fs');

  if (fsMod.existsSync(WORKSPACE)) fsMod.rmSync(WORKSPACE, { recursive: true, force: true });

  // --- Путь 1: данные найдены → proceed → доходит до отчёта с блоком данных ---
  {
    const runId = newRunId();
    const text = 'ТЕСТ_ИССЛЕДОВАТЕЛЬ_OK: в КР растёт покупка-продажа демо-товара, не знаю что заказывать.';

    const routed = await routeRequest({ text, workspaceFiles: listWorkspaceFileNames(WORKSPACE), runId });
    if (routed.route !== 'problem') throw new Error(`researcher: ожидали route=problem, получили ${routed.route}`);

    const { step } = await startIntake({ protocol: 'problem', initialText: text, runId });
    if (step.type !== 'ready') throw new Error('researcher: мок-советник должен сразу вернуть ready для problem');

    const brief = buildBrief({ protocol: 'problem', initialText: text, step });
    setRootSpec('default', brief.summary, brief.engineering_defaults, 'problem');

    const planResult = await planResearch({
      brief, rootSpec: brief.summary, workspaceDir: WORKSPACE, runId, projectId: 'default',
    });
    if (!planResult.ok) throw new Error(`researcher: план (путь OK) не удался: ${planResult.error}`);
    if (planResult.empty) throw new Error('researcher: ожидали непустой план (need_tools/tool_runs)');
    console.log(`[mock] researcher (OK): план — инструментов ${planResult.toolTaskIds.length}, запусков ${planResult.toolRunTaskIds.length}`);

    await runCoordinatorLoop({ role: 'coder', workspaceDir: WORKSPACE, runId });

    const toolRunTasks = planResult.toolRunTaskIds.map(getTask);
    if (!toolRunTasks.every((t) => t.status === 'done')) {
      throw new Error(`researcher: не все tool_run задачи (путь OK) дошли до done: ${toolRunTasks.map((t) => t.status).join(',')}`);
    }

    const evalResult = await evaluateResearch({
      toolRunTaskIds: planResult.toolRunTaskIds, workspaceDir: WORKSPACE, runId,
    });
    if (!evalResult.ok) throw new Error(`researcher: оценка (путь OK) не удалась: ${evalResult.error}`);
    if (evalResult.verdict !== 'proceed') throw new Error(`researcher: ожидали verdict=proceed, получили ${evalResult.verdict}`);
    console.log(`[mock] researcher (OK): оценка — proceed, ${evalResult.dataSummary}`);

    const fullBrief = { ...brief, summary: `${brief.summary}\n\n[Данные]\n${evalResult.forArchitect}` };
    const architectResult = await runArchitect({
      brief: fullBrief, workspaceDir: WORKSPACE, workspaceListing: listWorkspaceFileNames(WORKSPACE), runId, projectId: 'default',
    });
    if (!architectResult.ok) throw new Error(`researcher: architect после исследования не удался: ${architectResult.error}`);

    await runCoordinatorLoop({ role: 'coder', workspaceDir: WORKSPACE, runId });
    const allIds = [...architectResult.taskIds, architectResult.regressionId];
    const finalTasks = allIds.map(getTask);
    if (!finalTasks.every((t) => t.status === 'done')) {
      throw new Error(`researcher: дерево архитектора после исследования не дошло до done: ${finalTasks.map((t) => t.status).join(',')}`);
    }

    const report = await buildConsultantReport({
      protocol: 'problem', rootSpec: fullBrief.summary, engineeringDefaults: brief.engineering_defaults,
      problem: brief.problem, boardSummary: `${allIds.length} задач в дереве`, liveinSummary: '(не проводилось в этом сценарии)',
      dataSources: evalResult.dataSummary, runId,
    });
    if (typeof report !== 'string' || !report.trim()) throw new Error('researcher: пустой отчёт консультанта (путь OK)');
    console.log('[mock] researcher OK (proceed) — problem-маршрут доходит до отчёта консультанта с данными.');
  }

  // --- Путь 2: данные недоступны → жёсткий стоп-фактор, архитектор НЕ вызывается ---
  {
    const runId = newRunId();
    const text = 'ТЕСТ_ИССЛЕДОВАТЕЛЬ_НЕТ_ДАННЫХ: в КР растёт покупка-продажа демо-товара, не знаю что заказывать.';

    const routed = await routeRequest({ text, workspaceFiles: listWorkspaceFileNames(WORKSPACE), runId });
    if (routed.route !== 'problem') throw new Error(`researcher: (путь NODATA) ожидали route=problem, получили ${routed.route}`);

    const { step } = await startIntake({ protocol: 'problem', initialText: text, runId });
    const brief = buildBrief({ protocol: 'problem', initialText: text, step });

    const planResult = await planResearch({
      brief, rootSpec: brief.summary, workspaceDir: WORKSPACE, runId, projectId: 'default',
    });
    if (!planResult.ok) throw new Error(`researcher: план (путь NODATA) не удался: ${planResult.error}`);

    await runCoordinatorLoop({ role: 'coder', workspaceDir: WORKSPACE, runId });

    const evalResult = await evaluateResearch({
      toolRunTaskIds: planResult.toolRunTaskIds, workspaceDir: WORKSPACE, runId,
    });
    if (!evalResult.ok) throw new Error(`researcher: оценка (путь NODATA) не удалась: ${evalResult.error}`);
    if (evalResult.verdict !== 'data_unavailable') {
      throw new Error(`researcher: ожидали verdict=data_unavailable, получили ${evalResult.verdict}`);
    }
    if (!evalResult.clientNote || !evalResult.clientNote.trim()) {
      throw new Error('researcher: client_note пуст при data_unavailable — §10 требует дословный текст человеку');
    }
    console.log(`[mock] researcher (NODATA): стоп-фактор сработал — client_note: "${evalResult.clientNote}"`);
    console.log('[mock] researcher OK (data_unavailable) — жёсткий стоп-фактор §10, архитектор НЕ вызывается (ветки «продолжить без данных» структурно нет).');
  }
}

// --- Сценарий (§11, П§6.2): ingest ТЗ-пакета — дыра поймана ДО архитектора --
// --- (TODO_HOLE), непокрытое требование поймано ПОСЛЕ архитектора (covers) -
async function runIngestScenario() {
  const { newRunId, getTask } = await import('./journal.js');
  const { runIngest } = await import('../agents/ingest.js');
  const { runArchitect } = await import('../agents/architect.js');
  const { runCoordinatorLoop } = await import('./coordinator.js');
  const { listWorkspaceFileNames } = await import('../agents/coder.js');
  const { WORKSPACE, ROOT } = await import('./config.js');
  const fsMod = await import('node:fs');
  const pathMod = await import('node:path');

  if (fsMod.existsSync(WORKSPACE)) fsMod.rmSync(WORKSPACE, { recursive: true, force: true });

  const runId = newRunId();
  const folderPath = pathMod.join(ROOT, 'evals', 'fixtures', 'spec-package');
  const result = await runIngest({ folderPath, runId });
  if (!result.ok) throw new Error(`ingest: сбой разбора пакета: ${result.error}`);
  if (result.docs.length !== 3) throw new Error(`ingest: ожидали 3 документа, получили ${result.docs.length}`);
  if (result.requirements.length !== 6) throw new Error(`ingest: ожидали 6 требований, получили ${result.requirements.length}`);
  console.log(`[mock] ingest: документов ${result.docs.length}, требований ${result.requirements.length}`);

  if (result.holes.length !== 1) throw new Error(`ingest: ожидали ровно 1 нарочную дыру (TODO_HOLE), нашли ${result.holes.length}`);
  if (result.holes[0].req_id !== '02-payment.md:R2') {
    throw new Error(`ingest: дыра найдена не там, где посажена: ${result.holes[0].req_id}`);
  }
  if (result.questions.length !== 1) throw new Error(`ingest: ожидали 1 вопрос по дыре, получили ${result.questions.length}`);
  console.log(`[mock] ingest: нарочная дыра поймана — [${result.holes[0].req_id}] ${result.holes[0].description}, вопрос: "${result.questions[0].question}"`);

  const architectResult = await runArchitect({
    brief: {
      protocol: 'spec', request: 'ingest fixture', summary: result.combinedText, engineering_defaults: [], requirements: result.requirements,
    },
    workspaceDir: WORKSPACE, workspaceListing: listWorkspaceFileNames(WORKSPACE), runId, projectId: 'default',
  });
  if (!architectResult.ok) throw new Error(`ingest: architect не удался: ${architectResult.error}`);
  if (architectResult.uncoveredRequirements.length !== 1) {
    throw new Error(`ingest: ожидали ровно 1 непокрытое требование (намеренный пропуск в mock-architect), получили ${architectResult.uncoveredRequirements.length}`);
  }
  if (architectResult.uncoveredRequirements[0].id !== '03-design.txt:R1') {
    throw new Error(`ingest: непокрытое требование не то, что ожидалось: ${architectResult.uncoveredRequirements[0].id}`);
  }
  console.log(`[mock] ingest: architect не покрыл требование [${architectResult.uncoveredRequirements[0].id}] — трассировка covers честно это поймала.`);

  await runCoordinatorLoop({ role: 'coder', workspaceDir: WORKSPACE, runId });
  const allIds = [...architectResult.taskIds, architectResult.regressionId];
  const finalTasks = allIds.map(getTask);
  if (!finalTasks.every((t) => t.status === 'done')) {
    throw new Error(`ingest: дерево не дошло до done: ${finalTasks.map((t) => t.status).join(',')}`);
  }
  console.log('[mock] ingest OK — дыра ТЗ поймана до архитектора, непокрытое требование поймано после архитектора (covers), дерево done.');
}

// --- Сценарий (§22 Фаза 8, П§7.2): дашборд — node:http на эфемерном порту,
// --- три ручки (список/детали/чат), ноль реальной сети наружу -------------
async function runDashboardSmokeScenario() {
  const { createDashServer } = await import('../bin/dash.js');
  const { addTask, getTask } = await import('./journal.js');

  const taskId = addTask({
    title: 'ТЕСТ_ДАШБОРД: демо-задача для смоука',
    spec: 'демо',
    criteria: JSON.stringify({ cmd: 'node -e "console.log(\'PASS\')"' }),
    role: 'coder',
    type: 'project',
  });

  const server = createDashServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  try {
    const home = await fetch(`${base}/`);
    if (home.status !== 200 || !(home.headers.get('content-type') || '').includes('text/html')) {
      throw new Error(`dash: GET / ожидали 200 text/html, получили ${home.status} ${home.headers.get('content-type')}`);
    }

    const tasksRes = await fetch(`${base}/api/tasks`);
    const tasks = await tasksRes.json();
    if (!Array.isArray(tasks) || !tasks.some((t) => t.id === taskId)) {
      throw new Error(`dash: GET /api/tasks не содержит созданную задачу ${taskId}`);
    }

    const detailRes = await fetch(`${base}/api/task/${encodeURIComponent(taskId)}`);
    const detail = await detailRes.json();
    if (detailRes.status !== 200 || !detail.task || detail.task.id !== taskId || !Array.isArray(detail.events)) {
      throw new Error(`dash: GET /api/task/${taskId} вернул некорректную форму: ${JSON.stringify(detail)}`);
    }

    const missingRes = await fetch(`${base}/api/task/nonexistent-id`);
    if (missingRes.status !== 404) {
      throw new Error(`dash: GET /api/task/<не существует> ожидали 404, получили ${missingRes.status}`);
    }

    const askRes = await fetch(`${base}/api/ask`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question: 'что делает calc.js?' }),
    });
    const askData = await askRes.json();
    if (askRes.status !== 200 || typeof askData.answer !== 'string' || !askData.answer.trim()) {
      throw new Error(`dash: POST /api/ask вернул пустой/некорректный ответ: ${JSON.stringify(askData)}`);
    }

    const emptyAskRes = await fetch(`${base}/api/ask`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question: '' }),
    });
    if (emptyAskRes.status !== 400) {
      throw new Error(`dash: POST /api/ask с пустым question ожидали 400, получили ${emptyAskRes.status}`);
    }

    console.log(`[mock] dash: сервер на эфемерном порту ${port}, задача видна в /api/tasks и /api/task/:id, аналитик ответил через /api/ask, 404/400 честные.`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  if (getTask(taskId).status !== 'pending') {
    throw new Error('dash: дашборд не должен менять состояние доски (задача сдвинулась со статуса pending)');
  }
  console.log('[mock] dash OK — интерфейс наблюдения не тронул состояние доски.');
}

// --- Сценарий (§18, П§7 п.3): maintenance-минимум — regression_detected --
// --- маршрутизируется как tweak, AUTO_MERGES_PER_DAY реально ограничивает -
// --- drainMergeQueue ---------------------------------------------------
async function runMaintenanceScenario() {
  const {
    addTask, getTask, setStatus, logEvent,
  } = await import('./journal.js');
  const { runCoordinatorLoop } = await import('./coordinator.js');
  const { drainMergeQueue } = await import('./merge.js');
  const { WORKSPACE } = await import('./config.js');
  const fsMod = await import('node:fs');

  if (fsMod.existsSync(WORKSPACE)) fsMod.rmSync(WORKSPACE, { recursive: true, force: true });

  // regression_detected НЕ упомянут ни в одной специальной ветке
  // coordinator.js (только 'tool'/'tool_run'/'regression' там особые) —
  // значит он уже сегодня идёт обычным путём кодера, как tweak, безо всякой
  // новой ветки харнесса; тест это подтверждает, а не создаёт заново.
  const id = addTask({
    // ВАЖНО: title намеренно НЕ содержит подстроку "calc.js" — мок-кодер
    // матчит по подстрокам в title (см. комментарии выше в этом файле про
    // isViewportPolish/isPage), а "calc.js" перехватывается веткой isCalc
    // РАНЬШЕ ветки "Итого" (найдено именно на этом тесте — заголовок с обоими
    // словами утыкался не в тот сценарий кодера).
    title: 'regression_detected: prod-мониторинг заметил, что из вывода пропало слово Итого',
    spec: 'мониторинг обнаружил регрессию в проде (файл вывода — calc.js)',
    criteria: JSON.stringify({
      cmd: 'node -e "const fs=require(\'fs\'); const s=fs.readFileSync(\'calc.js\',\'utf8\'); if(s.includes(\'Итого\')){console.log(\'PASS содержит Итого\')}else{console.error(\'FAIL: calc.js не содержит строку Итого\'); process.exit(1)}"',
    }),
    role: 'coder',
    type: 'regression_detected',
  });
  await runCoordinatorLoop({ role: 'coder', workspaceDir: WORKSPACE });
  const task = getTask(id);
  if (task.status !== 'done') throw new Error(`maintenance: regression_detected ожидали done (маршрут как у tweak), получили ${task.status}`);
  console.log('[mock] maintenance: type=regression_detected прошёл обычным путём кодера (как tweak, без особой ветки) — done.');

  // AUTO_MERGES_PER_DAY: гейт проверяется ДО обращения к самой merge_pending
  // задаче (worktreesDir намеренно фиктивный — до mergeOneTask дело дойти не
  // должно), поэтому синтетического события 'merged' достаточно, без
  // повторного полного параллельного прогона (§16-гонка уже отдельно
  // проверена своим сценарием выше).
  logEvent({ type: 'merged', task_id: 'synthetic-prior-merge', payload: {} });
  const pendingId = addTask({
    title: 'синтетическая merge_pending задача для rate-limit',
    spec: '',
    criteria: JSON.stringify({ cmd: 'node -e "console.log(1)"' }),
    role: 'coder',
    type: 'project',
  });
  setStatus(pendingId, 'claimed');
  setStatus(pendingId, 'merge_pending');

  const processed = await drainMergeQueue({
    workspaceDir: WORKSPACE, worktreesDir: '(не используется — гейт срабатывает раньше)', workerIds: [], maxPerDay: 1,
  });
  if (processed !== 0) throw new Error(`maintenance: rate-limit должен был остановить очередь ДО обработки, обработано ${processed}`);
  const stillPending = getTask(pendingId);
  if (stillPending.status !== 'merge_pending') {
    throw new Error(`maintenance: задача должна остаться merge_pending при исчерпанном лимите, статус=${stillPending.status}`);
  }
  console.log('[mock] maintenance: AUTO_MERGES_PER_DAY=1 (уже 1 мёрж за последние 24ч) → drainMergeQueue не тронул очередь, задача осталась merge_pending.');
}

// --- Сценарий (П§7, опционально): Telegram-вход — parseUpdate чистой ------
// --- функцией + handleIncoming с подставным fetch (сеть НЕ трогается) -----
async function runTelegramScenario() {
  const { parseUpdate, handleIncoming } = await import('../bin/telegram.js');
  const { WORKSPACE } = await import('./config.js');
  const fsMod = await import('node:fs');
  if (fsMod.existsSync(WORKSPACE)) fsMod.rmSync(WORKSPACE, { recursive: true, force: true });

  const valid = parseUpdate({ update_id: 1, message: { chat: { id: 42 }, text: '  привет  ' } });
  if (!valid || valid.chatId !== 42 || valid.text !== 'привет') {
    throw new Error(`telegram: parseUpdate не разобрал валидный апдейт: ${JSON.stringify(valid)}`);
  }
  if (parseUpdate({ update_id: 2 }) !== null) throw new Error('telegram: parseUpdate должен вернуть null для апдейта без message');
  if (parseUpdate({ update_id: 3, message: { chat: { id: 1 }, text: '   ' } }) !== null) {
    throw new Error('telegram: parseUpdate должен вернуть null для пустого текста');
  }
  if (parseUpdate({ update_id: 4, edited_message: { chat: { id: 1 }, text: 'x' } }) !== null) {
    throw new Error('telegram: parseUpdate должен игнорировать edited_message (это не message)');
  }
  console.log('[mock] telegram: parseUpdate — валидный/без message/пустой текст/edited_message — все ветки корректны.');

  // handleIncoming — РЕАЛЬНАЯ маршрутизация через MOCK-модели (тот же
  // MOCK_HANDLERS, что и весь остальной прогон), подменена ТОЛЬКО сама
  // сетевая точка выхода (fetch на api.telegram.org) — тот же принцип, что
  // Кузница/tsc-ворота: мокаем ровно границу с внешним миром, не логику.
  const sent = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    sent.push({ url: String(url), body: opts?.body ? JSON.parse(opts.body) : null });
    return { ok: true, json: async () => ({ ok: true, result: [] }) };
  };
  try {
    await handleIncoming({ chatId: 777, text: 'поменяй вывод calc на слово Итого' });
  } finally {
    globalThis.fetch = realFetch;
  }
  const sendCalls = sent.filter((s) => s.url.includes('/sendMessage'));
  if (!sendCalls.length) throw new Error('telegram: handleIncoming (tweak) не отправил ни одного sendMessage');
  if (sendCalls[0].body.chat_id !== 777) throw new Error(`telegram: sendMessage ушёл не в тот chat_id: ${JSON.stringify(sendCalls[0].body)}`);
  console.log(`[mock] telegram: handleIncoming (tweak-маршрут, MOCK-модели) → sendMessage в chat 777: "${sendCalls[0].body.text.slice(0, 60)}..."`);
}

// --- Сценарий (П§9, закрывает долг части 1): advisor не переспрашивает --
// --- уже решённое — сквозной тест на buildUserText + mergeRootSpec --------
// DECISIONS «Часть 1» прямо отмечает: ветка hasExisting была синтаксически
// проверена, но не прогнана сквозным тестом — «стоит добавить в следующем
// цикле правок». Это он.
async function runContextInheritanceRegressionScenario() {
  const { buildUserText } = await import('../agents/advisor.js');
  const { mergeRootSpec } = await import('./journal.js');

  const withoutContext = buildUserText('wish', [{ role: 'client', text: 'хочу сайт' }], null);
  if (/Контекст УЖЕ существующего продукта/.test(withoutContext)) {
    throw new Error('advisor: секция существующего контекста не должна появляться без rootSpec/engineeringDefaults');
  }

  const withContext = buildUserText('wish', [{ role: 'client', text: 'добавь фильтр по цвету' }], {
    rootSpec: 'Кофейня-лайт: меню, онлайн-заказ',
    engineeringDefaults: ['Тёмная тема по умолчанию', 'Один HTML-файл на клиенте'],
  });
  if (!/Контекст УЖЕ существующего продукта/.test(withContext)
    || !/Тёмная тема по умолчанию/.test(withContext)
    || !/Кофейня-лайт: меню, онлайн-заказ/.test(withContext)) {
    throw new Error(`advisor: секция существующего контекста должна дословно включать rootSpec И прежние engineering_defaults, получили:\n${withContext}`);
  }
  console.log('[mock] advisor context-inheritance: buildUserText корректно включает/опускает «Контекст УЖЕ существующего продукта» — закрывает долг части 1.');

  // mergeRootSpec — второй заход ДОПОЛНЯЕТ, не стирает (тот самый реальный
  // баг из DECISIONS «Часть 1»: второй project затирал engineering_defaults
  // первого до setRootSpec).
  const merged1 = mergeRootSpec(null, 'Кофейня-лайт: меню, онлайн-заказ', ['Тёмная тема по умолчанию']);
  const merged2 = mergeRootSpec(
    { spec: merged1.spec, engineering_defaults: JSON.stringify(merged1.engineeringDefaults) },
    'добавь фильтр по цвету',
    ['Фильтр — выпадающий список'],
  );
  if (!merged2.engineeringDefaults.includes('Тёмная тема по умолчанию')) {
    throw new Error(`mergeRootSpec: второй заход потерял решение первого захода: ${JSON.stringify(merged2)}`);
  }
  if (!merged2.engineeringDefaults.includes('Фильтр — выпадающий список')) {
    throw new Error(`mergeRootSpec: второй заход не добавил своё решение: ${JSON.stringify(merged2)}`);
  }
  if (!merged2.spec.includes('Кофейня-лайт') || !merged2.spec.includes('добавь фильтр по цвету')) {
    throw new Error(`mergeRootSpec: summary должен расти припиской, а не заменяться: ${merged2.spec}`);
  }
  console.log('[mock] mergeRootSpec: второй заход дополняет engineering_defaults/summary первого, ничего не теряет — закрывает долг части 1.');
}

// --- Сценарий (Г§13(1), регрессия «чистая машина»): live_in — падение
// browserType.launch() внутри Playwright тоже откатывается на статический
// разбор, а не роняет прогон -------------------------------------------
// На чистой машине пакет playwright ставится (optionalDependency), но
// браузерные бинарники — отдельный шаг (`npx playwright install chromium`),
// который никто не выполнял: import('playwright') удаётся, а launch()
// бросает. Раньше inspectWithPlaywright() в этом случае возвращала
// {ok:false, live:true, error} — истинное значение, поэтому `evidence ||
// inspectStatic()` НЕ откатывалась, и весь live_in (а с ним npm run mock)
// падал. Тот же урок, что и tsc-gate регрессия (DECISIONS выше): не
// полагаемся на случайное состояние ЭТОЙ машины (здесь браузеры реально
// стоят, см. project pipeline выше) — подсовываем заведомо падающий
// загрузчик через сеемую точку inspectProduct(..., loadPlaywright).
async function runLiveinLaunchFailureScenario() {
  const { inspectProduct } = await import('../agents/livein.js');
  const fsMod = await import('node:fs');
  const pathMod = await import('node:path');
  const osMod = await import('node:os');

  const scratch = pathMod.join(osMod.tmpdir(), `loom-livein-launch-fail-${process.pid}`);
  fsMod.rmSync(scratch, { recursive: true, force: true });
  fsMod.mkdirSync(scratch, { recursive: true });
  fsMod.writeFileSync(
    pathMod.join(scratch, 'index.html'),
    '<!doctype html><html><head><title>Т</title></head><body><button>Иди</button></body></html>',
  );

  const failingLoader = async () => ({
    chromium: {
      launch: async () => {
        throw new Error("browserType.launch: Executable doesn't exist at .../chromium_headless_shell");
      },
    },
  });

  const evidence = await inspectProduct(scratch, 'index.html', failingLoader);
  if (!evidence.ok) {
    throw new Error(`live_in launch-failure fallback: ожидали ok=true (деградация на статику), получили error=${evidence.error}`);
  }
  if (evidence.live !== false) {
    throw new Error('live_in launch-failure fallback: ожидали live=false (статический разбор, не живой рендер)');
  }
  if (!/playwright install chromium/i.test(evidence.note || '')) {
    throw new Error(`live_in launch-failure fallback: note обязан подсказывать "npx playwright install chromium", получили: ${evidence.note}`);
  }
  console.log('[mock] live_in launch-failure fallback OK — падение browserType.launch() не роняет прогон, честный live:false note с подсказкой про браузеры.');

  fsMod.rmSync(scratch, { recursive: true, force: true });
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
  const {
    JOURNAL_DB_PATH, SKILLS_DB_PATH, WORKSPACE, TOOLS_DIR, WORKTREES_DIR,
  } = await import('./config.js');
  for (const dbPath of [JOURNAL_DB_PATH, SKILLS_DB_PATH]) {
    for (const suffix of ['', '-wal', '-shm']) {
      const p = dbPath + suffix;
      if (fs.existsSync(p)) fs.rmSync(p);
    }
  }
  if (fs.existsSync(WORKSPACE)) fs.rmSync(WORKSPACE, { recursive: true, force: true });
  // Кузница (§26, П§4): tools.mock/ — та же изоляция, что у workspace.mock
  // (баг №1 первого живого прогона — MOCK и реальный режим не делят состояние).
  if (fs.existsSync(TOOLS_DIR)) fs.rmSync(TOOLS_DIR, { recursive: true, force: true });
  // Параллельность (Фаза 6, П§5): .worktrees.mock/ — та же изоляция.
  if (fs.existsSync(WORKTREES_DIR)) fs.rmSync(WORKTREES_DIR, { recursive: true, force: true });

  const { releaseStuck } = await import('./journal.js');
  releaseStuck();

  const scenarios = [
    ['calculator (Фаза 1/2)', runCalculatorScenario],
    ['project pipeline: wish → router/advisor/architect/coordinator/skill (Фаза 3)', runProjectPipelineScenario],
    ['Кузница инструментов: word-count (§26.6)', runForgeScenario],
    ['параллельность: 8 задач / 2 воркера + конфликт + tsc-ворота (§16, П§5)', runParallelScenario],
    ['исследователь: proceed с данными + жёсткий стоп-фактор data_unavailable (§10, П§6.1)', runResearcherScenario],
    ['ingest ТЗ-пакета: дыра TODO_HOLE + непокрытое требование (§11, П§6.2)', runIngestScenario],
    ['tweak: router пишет критерий сам (Фаза 3)', runTweakScenario],
    ['question: read-only аналитик, без задач (Фаза 3)', runQuestionScenario],
    ['path-lock: запись вне workspace блокируется и логируется (Фаза 4)', runPathLockScenario],
    ['подозрение на брак критерия: чиним сломанный / подтверждаем верный (scar 34, П§11)', runCriteriaDefectScenario],
    ['дашборд: node:http смоук — список/детали/чат, ноль записи в доску (§22, П§7.2)', runDashboardSmokeScenario],
    ['maintenance-минимум: regression_detected как tweak + AUTO_MERGES_PER_DAY (§18, П§7.3)', runMaintenanceScenario],
    ['Telegram-вход (опционально): parseUpdate + handleIncoming с подставным fetch (П§7)', runTelegramScenario],
    ['advisor не переспрашивает уже решённое (buildUserText + mergeRootSpec, закрывает долг части 1, П§9)', runContextInheritanceRegressionScenario],
    ['live_in: падение browserType.launch() откатывается на статику, не роняет прогон (Г§13(1))', runLiveinLaunchFailureScenario],
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

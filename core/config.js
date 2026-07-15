// LOOM config — стартовая claude-cli-конфигурация (§5 ТЗ v4).
// Ничего не хардкодим по памяти о ID моделей (шрам 10): используем алиасы
// claude-cli ("haiku"|"sonnet"|"opus"), которые CLI сам резолвит в актуальный ID.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// core/ живёт на один уровень ниже корня репозитория — ROOT указывает на
// родителя core/, чтобы workspace/, prompts/, .loom-tmp/, journal.db и
// остальные корневые пути не переехали вместе с этим файлом (реорганизация
// в core/bin/docs).
export const ROOT = path.dirname(__dirname);

// Цепочки фолбэков на роль (§5). Порядок = порядок попыток внутри круга.
// architect: в основном Opus (качество дерева и критериев определяет весь прогон),
// фолбэк на Sonnet при недоступности/лимите.
export const ROLES = {
  advisor:    ['claude-cli:haiku'],
  router:     ['claude-cli:haiku'],
  architect:  ['claude-cli:opus', 'claude-cli:sonnet'],
  coder:      ['claude-cli:sonnet', 'claude-cli:opus'],
  live_in:    ['claude-cli:sonnet'],
  researcher: ['claude-cli:sonnet', 'claude-cli:opus'],
  skill:      ['claude-cli:haiku'],
  cheap:      ['claude-cli:haiku'],
};

// THINKING per-role: reasoning выключен для лёгких быстрых ролей (шрам 14).
export const THINKING = {
  advisor: false,
  router: false,
  cheap: false,
  skill: false,
  architect: true,
  coder: true,
  live_in: true,
  researcher: true,
};

// Условные цены (USD за 1M токенов) — claude-cli подписка не биллит по токену,
// но для сопоставимости метрик (§13) считаем по номинальным ценам API-тиров.
// В реальности берём total_cost_usd прямо из ответа claude-cli (см. gateway.js);
// эта таблица — резервный расчёт, если total_cost_usd вдруг отсутствует.
export const TIER_PRICES_USD_PER_1M = {
  haiku:  { in: 1, out: 5 },
  sonnet: { in: 3, out: 15 },
  opus:   { in: 15, out: 75 },
};

// Известные ограничения моделей (шрам 8). Пример:
// MODEL_LIMITATIONS['claude-cli:llama'] = { oneToolCallPerTurn: true };
export const MODEL_LIMITATIONS = {};

export const MAX_ATTEMPTS = 4;          // лестница попыток задачи (§7)
export const MODEL_TIMEOUT_MS = 300_000; // 300с — таймаут 180с убивал честно думающие модели (шрам 12)
export const RETRY_ROUNDS = 2;           // два круга по цепочке (§5)
export const RETRY_PAUSE_MS = 60_000;    // пауза 60с между кругами (шрам 13)
export const MAX_RETRIES_SDK = 0;        // retry только в шлюзе (шрам 2)

export const DEFAULT_TASK_BUDGET_USD = 2.0;
export const DEFAULT_PROJECT_BUDGET_USD = 20.0;

// MOCK и реальный режим НИКОГДА не должны делить состояние (реальный баг,
// найден на первом живом прогоне пользователя: npm run mock оставлял свои
// тестовые задачи И тестовые файлы workspace, которые затем подмешивались
// в npm run talk) — раздельные journal/skills/workspace вместо общих.
const MOCK_FLAG = process.env.MOCK === '1';
export const WORKSPACE = path.join(ROOT, MOCK_FLAG ? 'workspace.mock' : 'workspace');
export const PROMPTS_DIR = path.join(ROOT, 'prompts');
export const TMP_DIR = path.join(ROOT, '.loom-tmp');
export const HISTORY_DIR = path.join(ROOT, '.history');

export const JOURNAL_DB_PATH = path.join(ROOT, MOCK_FLAG ? 'journal.mock.db' : 'journal.db');
export const SKILLS_DB_PATH = path.join(ROOT, MOCK_FLAG ? 'skills.mock.db' : 'skills.db');

// Фильтр мусора в глазах кодера (шрам 9, шрам 30).
export const EYES_MAX_FILE_BYTES = 50 * 1024;
export const EYES_IGNORE_PATTERNS = [/\.min\.(js|css)$/i, /\.map$/i];
export const EYES_BINARY_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.ico', '.woff', '.woff2', '.ttf', '.eot',
  '.zip', '.gz', '.pdf', '.mp4', '.mp3', '.wasm', '.db', '.sqlite',
]);

// Предохранитель на длину интервью советника — не вечный допрос (§1, §20.16).
export const MAX_INTERVIEW_TURNS = 6;

export const MOCK = process.env.MOCK === '1';
// Флаг тишины для evals: подавляет живой прогресс (io.js: progress()),
// не трогает итоговые отчёты (report/status печатаются как обычно).
export const QUIET = process.env.LOOM_QUIET === '1';
// Синтетическая стоимость одного мок-вызова — позволяет детерминированно
// проверять budget_usd-стоп без единого реального вызова модели (DEV_GUIDE
// §4 DoD: «бюджет-стоп срабатывает на игрушечном лимите 0.01»), см. evals/budget.js.
export const MOCK_CALL_COST_USD = 0.01;

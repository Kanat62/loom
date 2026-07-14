// Шлюз моделей — единственная точка звонков (§5 ТЗ v4). Контракт:
// chat(role, messages, {json}) → текст | распарсенный объект. Валидация
// JSON — ВНУТРИ шлюза (кривой JSON = сбой модели, не смерть прогона, шрам 11).
//
// Стартовая конфигурация: единственный провайдер — claude-cli. HTTP-ветка
// лежит в коде ВЫКЛЮЧЕННОЙ (см. chatHttp ниже) и включается конфигом без
// правки логики выше (§5).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  ROLES, MODEL_LIMITATIONS, MODEL_TIMEOUT_MS, RETRY_ROUNDS, RETRY_PAUSE_MS,
  TIER_PRICES_USD_PER_1M, TMP_DIR, MOCK, MOCK_CALL_COST_USD,
} from './config.js';
import { logEvent } from './journal.js';

fs.mkdirSync(TMP_DIR, { recursive: true });

const MCP_EMPTY_PATH = path.join(TMP_DIR, 'mcp.empty.json');
const SETTINGS_HEADLESS_PATH = path.join(TMP_DIR, 'settings.headless.json');
ensureStaticFile(MCP_EMPTY_PATH, JSON.stringify({ mcpServers: {} }));
// Пустые hooks — изоляция headless-вызова (--bare не годится, требует API-ключ
// и игнорирует подписку, шрам 29).
ensureStaticFile(SETTINGS_HEADLESS_PATH, JSON.stringify({ hooks: {} }));

function ensureStaticFile(p, content) {
  if (!fs.existsSync(p)) fs.writeFileSync(p, content, 'utf8');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Системный промпт — статичный файл, побайтово идентичный между вызовами
 * (§5, кэширование). Контент-адресация по sha256 гарантирует идентичность
 * файла для идентичного контента без ручного управления путями со стороны
 * вызывающего агента.
 */
function ensureSystemPromptFile(content) {
  const hash = crypto.createHash('sha256').update(content, 'utf8').digest('hex').slice(0, 16);
  const p = path.join(TMP_DIR, `sys-${hash}.txt`);
  if (!fs.existsSync(p)) fs.writeFileSync(p, content, 'utf8');
  return p;
}

// Windows режет CLI-аргументы с пробелами при spawn(..., {shell:true})
// (обнаружено при сборке шлюза: пути с пробелами обрезались по первому
// пробелу). Оборачиваем каждый аргумент в JSON.stringify — валидное
// cmd.exe-экранирование для простых значений (пути, флаги, пустые строки).
// На POSIX shell не используется — аргументы идут как есть.
function buildSpawnArgs(args) {
  if (process.platform === 'win32') {
    return args.map((a) => JSON.stringify(String(a)));
  }
  return args.map(String);
}

function spawnClaudeCli(args, { input, timeoutMs }) {
  return new Promise((resolve) => {
    const isWin = process.platform === 'win32';
    // claude-cli на Windows ставится как .cmd — прямой spawn без shell даёт
    // EINVAL (инвариант §20.6: явные Windows-ветки для claude.cmd).
    const child = isWin
      ? spawn('claude', buildSpawnArgs(args), { shell: true, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
      : spawn('claude', args.map(String), { shell: false, stdio: ['pipe', 'pipe', 'pipe'] });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      resolve({ ok: false, reason: 'timeout', stdout, stderr });
    }, timeoutMs);

    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, reason: `spawn-error:${e.message}`, stdout, stderr });
    });
    child.on('exit', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) resolve({ ok: false, reason: `exit-${code}`, stdout, stderr });
      else resolve({ ok: true, stdout, stderr });
    });

    child.stdin.on('error', () => { /* EPIPE после ранней смерти процесса — игнорируем, exit-обработчик разберётся */ });
    child.stdin.write(input ?? '');
    child.stdin.end();
  });
}

function safeJsonParse(text) {
  try { return JSON.parse(text); } catch { return null; }
}

/** Снимает фенсы ```json ... ``` / ``` ... ``` перед JSON.parse (модели любят их добавлять). */
function tryParseModelJson(text) {
  if (typeof text !== 'string') return undefined;
  let t = text.trim();
  const fenced = t.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced) t = fenced[1].trim();
  try {
    return JSON.parse(t);
  } catch {
    return undefined;
  }
}

function extractUsage(envelope) {
  const u = envelope.usage || {};
  const tokensIn = u.input_tokens ?? 0;
  const tokensOut = u.output_tokens ?? 0;
  const cacheRead = u.cache_read_input_tokens ?? 0;
  const cacheCreation = u.cache_creation_input_tokens ?? 0;
  let costUsd = envelope.total_cost_usd;
  if (typeof costUsd !== 'number') {
    // Резервный расчёт по условным ценам тиров, если total_cost_usd отсутствует.
    costUsd = 0;
  }
  return { tokensIn, tokensOut, cacheRead, cacheCreation, costUsd };
}

function fallbackCostUsd(tier, tokensIn, tokensOut) {
  const price = TIER_PRICES_USD_PER_1M[tier];
  if (!price) return 0;
  return (tokensIn / 1_000_000) * price.in + (tokensOut / 1_000_000) * price.out;
}

/**
 * chat(role, messages, opts) → текст | распарсенный объект (opts.json:true).
 * messages: [{role:'system', content}, {role:'user', content}, ...]
 * opts: {json, run_id, task_id, agent}
 */
export async function chat(role, messages, opts = {}) {
  if (MOCK) {
    const { mockChat } = await import('./mock.js');
    const res = mockChat(role, messages, opts);
    logEvent({
      run_id: opts.run_id, task_id: opts.task_id, type: 'usage',
      agent: opts.agent || role, duration_ms: 0, tokens_in: 0, tokens_out: 0,
      cost_usd: MOCK_CALL_COST_USD, payload: { mock: true, role },
    });
    return res;
  }

  const chain = ROLES[role];
  if (!chain || !chain.length) {
    throw new Error(`gateway: нет цепочки моделей для роли "${role}" (проверь config.js ROLES)`);
  }

  const systemMsg = messages.find((m) => m.role === 'system');
  const userText = messages.filter((m) => m.role !== 'system').map((m) => m.content).join('\n\n');
  const systemPath = systemMsg ? ensureSystemPromptFile(systemMsg.content) : null;

  let lastFail = 'unknown';

  for (let round = 1; round <= RETRY_ROUNDS; round++) {
    for (const modelSpec of chain) {
      const [provider, tier] = modelSpec.split(':');
      if (provider !== 'claude-cli') {
        lastFail = `unsupported-provider:${provider}`;
        continue;
      }
      if (MODEL_LIMITATIONS[modelSpec]?.skipRoles?.includes(role)) {
        continue;
      }

      let attemptUserText = userText;
      const maxJsonAttempts = opts.json ? 2 : 1; // §5 шрам 11: ретрай с напоминанием на том же тире, затем следующая модель

      for (let jsonAttempt = 1; jsonAttempt <= maxJsonAttempts; jsonAttempt++) {
        const args = [
          '-p', '--model', tier, '--output-format', 'json',
          ...(systemPath ? ['--system-prompt-file', systemPath] : []),
          '--tools', '', '--strict-mcp-config',
          '--mcp-config', MCP_EMPTY_PATH,
          '--settings', SETTINGS_HEADLESS_PATH,
        ];

        const t0 = Date.now();
        const call = await spawnClaudeCli(args, { input: attemptUserText, timeoutMs: MODEL_TIMEOUT_MS });
        const durationMs = Date.now() - t0;

        if (!call.ok) {
          lastFail = call.reason;
          logEvent({
            run_id: opts.run_id, task_id: opts.task_id, type: 'status', agent: opts.agent || role,
            duration_ms: durationMs, payload: { role, tier, round, fail: call.reason, stderr: call.stderr.slice(0, 200) },
          });
          break; // технический сбой -> следующая модель в цепочке (DEV_GUIDE §1)
        }

        const envelope = safeJsonParse(call.stdout);
        if (!envelope || envelope.is_error) {
          lastFail = envelope ? `cli-error:${envelope.subtype || ''}` : 'cli-output-not-json';
          logEvent({
            run_id: opts.run_id, task_id: opts.task_id, type: 'status', agent: opts.agent || role,
            duration_ms: durationMs, payload: { role, tier, round, fail: lastFail, raw200: call.stdout.slice(0, 200) },
          });
          break;
        }

        const resultText = envelope.result ?? '';
        const usage = extractUsage(envelope);
        if (!usage.costUsd) usage.costUsd = fallbackCostUsd(tier, usage.tokensIn, usage.tokensOut);

        logEvent({
          run_id: opts.run_id, task_id: opts.task_id, type: 'usage', agent: opts.agent || role,
          duration_ms: durationMs, tokens_in: usage.tokensIn, tokens_out: usage.tokensOut,
          cost_usd: usage.costUsd,
          payload: { role, tier, round, cache_read: usage.cacheRead, cache_creation: usage.cacheCreation },
        });

        if (!opts.json) {
          return resultText;
        }

        const parsed = tryParseModelJson(resultText);
        if (parsed !== undefined) {
          return parsed;
        }

        lastFail = 'invalid-json';
        logEvent({
          run_id: opts.run_id, task_id: opts.task_id, type: 'status', agent: opts.agent || role,
          payload: { role, tier, round, fail: 'invalid-json', raw200: resultText.slice(0, 200) },
        });

        if (jsonAttempt < maxJsonAttempts) {
          attemptUserText = `${userText}\n\n[СИСТЕМА] Предыдущий ответ не был валидным JSON. Ответь СТРОГО валидным JSON без пояснений и markdown-фенсов.`;
        }
      }
    }
    if (round < RETRY_ROUNDS) await sleep(RETRY_PAUSE_MS);
  }

  throw new Error(`gateway: роль "${role}" — все модели недоступны после ${RETRY_ROUNDS} кругов (причина: ${lastFail})`);
}

// HTTP-ветка (OpenAI-совместимый провайдер, например NIM/DeepSeek) — §5:
// провайдеры равноправны архитектурно, но в стартовой конфигурации ветка
// ВЫКЛЮЧЕНА. Включение: добавить 'http:<model>' записи в ROLES и раскрыть
// реализацию ниже без правки логики chat() выше неё.
// eslint-disable-next-line no-unused-vars
async function chatHttp(role, messages, opts) {
  throw new Error('HTTP-ветка шлюза выключена в стартовой конфигурации (§5 ТЗ v4): единственный провайдер — claude-cli.');
}

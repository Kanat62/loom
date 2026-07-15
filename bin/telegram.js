// bin/telegram.js — Telegram-вход (опционально, П§7 DEV_GUIDE part2, НЕ
// входит в release-критерий: §23-дух, "не собралось за день — в бэклог без
// сожалений"). Long-poll getUpdates через stdlib fetch (Node 22) — БЕЗ
// grammY/telegraf, ноль зависимостей, тот же принцип, что bin/dash.js
// (node:http без фреймворка). Включается только при заданном
// TELEGRAM_BOT_TOKEN — без него скрипт честно завершается, не падает.
//
// Сообщение маршрутизируется тем же routeRequest, что и строка talk.js:
// question/tweak — сразу; wish/problem — интервью в чате (состояние
// диалога по chat_id — В ПАМЯТИ процесса, не в journal: это временный
// диалоговый контекст ДО брифа, симметрично тому, как talk.js держит
// history в переменной цикла, а не на доске). Сознательно урезано против
// полного bin/talk.js:runBuildFlow — БЕЗ researcher/ingest/live_in-стадий
// (см. docs/DECISIONS.md «Часть 2» П§7: явный, документированный вырез
// объёма, не забытая недоделка).
import {
  isGarbageInput, startIntake, continueIntake, buildBrief, runAnalyst, buildConsultantReport,
} from '../agents/advisor.js';
import { routeRequest } from '../agents/router.js';
import { runArchitect } from '../agents/architect.js';
import { listWorkspaceFileNames } from '../agents/coder.js';
import { runCoordinatorLoop } from '../core/coordinator.js';
import {
  addTask, getTask, newRunId, setRootSpec, getRootSpec, releaseStuck,
} from '../core/journal.js';
import { WORKSPACE, MOCK } from '../core/config.js';

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const POLL_TIMEOUT_S = 30;

function apiUrl(method) {
  return `https://api.telegram.org/bot${TOKEN}/${method}`;
}

export async function sendMessage(chatId, text) {
  const res = await fetch(apiUrl('sendMessage'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: String(text).slice(0, 4000) }),
  });
  return res.ok;
}

/** parseUpdate(update) -> {chatId, text} | null — чистая функция, юнит-тестируема без сети (MOCK). */
export function parseUpdate(update) {
  const msg = update && update.message;
  if (!msg || typeof msg.text !== 'string' || !msg.chat || msg.chat.id === undefined) return null;
  const text = msg.text.trim();
  if (!text) return null;
  return { chatId: msg.chat.id, text };
}

const sessions = new Map(); // chatId -> {protocol, history}

function boardSummaryText(taskIds) {
  return taskIds.map((id) => {
    const t = getTask(id);
    if (!t) return `- ${id}: (не найдена)`;
    return `- [${t.type}] "${t.title}" — ${t.status}`;
  }).join('\n');
}

function mergeRootSpec(existing, newSummary, newDefaults) {
  const existingDefaults = existing?.engineering_defaults ? JSON.parse(existing.engineering_defaults) : [];
  const mergedDefaults = [...existingDefaults];
  for (const d of newDefaults) if (!mergedDefaults.includes(d)) mergedDefaults.push(d);
  const spec = existing?.spec ? `${existing.spec}\n\n[Дополнение] ${newSummary}` : newSummary;
  return { spec, engineeringDefaults: mergedDefaults };
}

async function finishProject(chatId, protocol, step, runId) {
  const existingRootSpec = getRootSpec('default');
  const brief = buildBrief({ protocol, initialText: sessions.get(chatId)?.history?.[0]?.text || '', step });
  const merged = mergeRootSpec(existingRootSpec, brief.summary, brief.engineering_defaults);
  setRootSpec('default', merged.spec, merged.engineeringDefaults, protocol);

  await sendMessage(chatId, `Принял инженерные решения:\n${step.engineeringDefaults.map((d) => `- ${d}`).join('\n')}\n\nСтрою...`);

  const architectResult = await runArchitect({
    brief: { ...brief, summary: merged.spec, engineering_defaults: merged.engineeringDefaults },
    workspaceDir: WORKSPACE,
    workspaceListing: listWorkspaceFileNames(WORKSPACE),
    runId,
    projectId: 'default',
  });
  if (!architectResult.ok) {
    await sendMessage(chatId, `Архитектор не смог построить план: ${architectResult.error}`);
    return;
  }
  await runCoordinatorLoop({ role: 'coder', workspaceDir: WORKSPACE, runId });

  const treeIds = [...architectResult.taskIds, architectResult.regressionId];
  const allDone = treeIds.every((id) => getTask(id)?.status === 'done');
  if (!allDone) {
    await sendMessage(chatId, `Дерево не полностью зелёное — см. /status в npm run talk.\n${boardSummaryText(treeIds)}`);
    return;
  }

  const report = await buildConsultantReport({
    protocol, rootSpec: merged.spec, engineeringDefaults: merged.engineeringDefaults, problem: brief.problem, boardSummary: boardSummaryText(treeIds), liveinSummary: '(обживание — только в npm run talk, за рамками Telegram-входа v1)', runId,
  });
  await sendMessage(chatId, report);
}

/** handleIncoming({chatId, text}) — вся маршрутизация одного сообщения. Экспортирована для MOCK-юнита. */
export async function handleIncoming({ chatId, text }) {
  if (isGarbageInput(text)) {
    await sendMessage(chatId, 'Не понял запрос — слишком коротко или похоже на случайный ввод.');
    return;
  }

  const session = sessions.get(chatId);
  const runId = newRunId();

  if (session && session.awaitingReply) {
    const { protocol, history } = session;
    const { history: newHistory, step } = await continueIntake({
      protocol, history, clientReply: text, runId, turnCount: (session.turnCount || 1) + 1,
    });
    if (step.type === 'ask') {
      sessions.set(chatId, {
        protocol, history: newHistory, awaitingReply: true, turnCount: (session.turnCount || 1) + 1,
      });
      await sendMessage(chatId, step.question);
      return;
    }
    sessions.delete(chatId);
    await finishProject(chatId, protocol, step, runId);
    return;
  }

  const routed = await routeRequest({ text, workspaceFiles: listWorkspaceFileNames(WORKSPACE), runId });

  if (routed.route === 'question') {
    const rootSpec = getRootSpec('default');
    const answer = await runAnalyst({
      question: text, rootSpec: rootSpec?.spec, workspaceDir: WORKSPACE, runId,
    });
    await sendMessage(chatId, answer);
    return;
  }

  if (routed.route === 'tweak') {
    const id = addTask({
      title: text.slice(0, 80), spec: text, criteria: JSON.stringify(routed.criteria), role: 'coder', type: 'tweak',
    });
    await runCoordinatorLoop({ role: 'coder', workspaceDir: WORKSPACE, runId });
    const task = getTask(id);
    await sendMessage(chatId, `Готово: ${task.status}${task.feedback ? `\n${task.feedback}` : ''}`);
    return;
  }

  const protocol = ['wish', 'problem', 'spec'].includes(routed.route) ? routed.route : 'wish';
  const history = [{ role: 'client', text }];
  const { step } = await startIntake({ protocol, initialText: text, runId });
  if (step.type === 'ask') {
    sessions.set(chatId, {
      protocol, history, awaitingReply: true, turnCount: 1,
    });
    await sendMessage(chatId, step.question);
    return;
  }
  await finishProject(chatId, protocol, step, runId);
}

async function pollOnce(offset) {
  const res = await fetch(`${apiUrl('getUpdates')}?offset=${offset}&timeout=${POLL_TIMEOUT_S}`);
  const data = await res.json();
  return Array.isArray(data.result) ? data.result : [];
}

async function main() {
  if (!TOKEN) {
    console.log('[telegram] TELEGRAM_BOT_TOKEN не задан — Telegram-вход выключен (опционально, П§7).');
    return;
  }
  releaseStuck();
  console.log('[telegram] long-poll запущен...');
  let offset = 0;
  for (;;) {
    let updates;
    try {
      // eslint-disable-next-line no-await-in-loop
      updates = await pollOnce(offset);
    } catch (e) {
      console.error(`[telegram] getUpdates сбой (продолжаю опрос): ${e.message}`);
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => { setTimeout(r, 5000); });
      continue;
    }
    for (const update of updates) {
      offset = update.update_id + 1;
      const parsed = parseUpdate(update);
      if (!parsed) continue;
      try {
        // eslint-disable-next-line no-await-in-loop
        await handleIncoming(parsed);
      } catch (e) {
        console.error(`[telegram] ошибка обработки сообщения (сессия продолжает работу): ${e.message}`);
        // eslint-disable-next-line no-await-in-loop
        await sendMessage(parsed.chatId, `Внутренняя ошибка: ${e.message}`).catch(() => {});
      }
    }
  }
}

if (!MOCK && process.argv[1] && process.argv[1].endsWith('telegram.js')) {
  main();
}

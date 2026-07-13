// engine.js — общий цикл агента (Фаза 3+, DEV_GUIDE §0): промпт+контекст →
// вызов шлюза → парсинг. Используется router/advisor/architect/skill (coder
// и tester остаются на своих специфичных путях варианта А / без LLM).
import fs from 'node:fs';
import path from 'node:path';
import { PROMPTS_DIR } from './config.js';
import { chat } from './gateway.js';

const promptCache = new Map();

/** Статичный системный промпт из prompts/<name> — читается с диска один раз и кэшируется в памяти. */
export function loadPrompt(name) {
  if (!promptCache.has(name)) {
    promptCache.set(name, fs.readFileSync(path.join(PROMPTS_DIR, name), 'utf8'));
  }
  return promptCache.get(name);
}

/**
 * callAgent({role, promptFile, userText, json, runId, taskId, agent}) →
 * текст | распарсенный объект. Тонкая обёртка над gateway.chat с
 * единообразной сборкой system(файл)+user(динамика) — динамика ВСЕГДА в user,
 * никогда не подмешивается в системный промпт (§6.3, кэш).
 */
export async function callAgent({ role, promptFile, userText, json = true, runId, taskId, agent }) {
  const system = loadPrompt(promptFile);
  const messages = [
    { role: 'system', content: system },
    { role: 'user', content: userText },
  ];
  return chat(role, messages, { json, run_id: runId, task_id: taskId, agent: agent || role });
}

// agents/livein.js — live_in / обживатель (§3, §9 ТЗ v4, DEV_GUIDE §8):
// второй контур тестирования. После зелёной доски проходит продукт как
// первый пользователь; выход — tweak-задачи с обоснованиями. Один цикл на
// сдачу (ограничение накладывает вызывающий — talk.js, не этот модуль).
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { callAgent } from '../core/engine.js';
import { addTask } from '../core/journal.js';

/**
 * Живой браузер через Playwright (§8.1: pathToFileURL, не склейка file://).
 * Playwright — опциональная зависимость, и её отсутствие — не единственный
 * способ остаться без живого рендера: пакет ставится через
 * `optionalDependencies`, но браузерные бинарники (`npx playwright install
 * chromium`) — отдельный шаг, который на чистой машине никто не выполнял.
 * Тогда `import('playwright')` УДАЁТСЯ, а `chromium.launch()` бросает —
 * раньше это шло в `{ok:false, live:true, error}`, что для вызывающего
 * (inspectProduct) неотличимо от «осмотр провалился», и весь live_in
 * (а с ним npm run mock, Г§13(1)) падал вместо честной деградации.
 * Теперь любая ошибка после успешного import (launch, newPage, goto,
 * evaluate) тоже уходит на статический фолбэк — деградация, а не смерть
 * прогона. loadPlaywright — сеемая точка для тестов (см. mock.js):
 * позволяет подсунуть заведомо падающий загрузчик, не трогая node_modules.
 */
async function inspectWithPlaywright(entryFile, loadPlaywright = () => import('playwright')) {
  let playwright;
  try {
    playwright = await loadPlaywright();
  } catch {
    return null;
  }

  let browser;
  try {
    browser = await playwright.chromium.launch();
    const page = await browser.newPage({ viewport: { width: 375, height: 667 } }); // мобильный, §9
    const consoleErrors = [];
    page.on('pageerror', (e) => consoleErrors.push(String(e)));
    page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });

    const url = pathToFileURL(entryFile).href;
    const t0 = Date.now();
    await page.goto(url, { timeout: 10000 });
    const loadMs = Date.now() - t0;

    const title = await page.title();
    const bodyTextSample = (await page.evaluate(() => document.body?.innerText || '')).slice(0, 500);
    const visibleActionableCount = await page.evaluate(() => {
      const els = Array.from(document.querySelectorAll('button, a, [role="button"], input[type="submit"]'));
      return els.filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && r.top >= 0 && r.top < window.innerHeight;
      }).length;
    });

    return {
      ok: true, live: true, loadMs, title, bodyTextSample, visibleActionableCount,
      consoleErrors: consoleErrors.slice(0, 10),
    };
  } catch (e) {
    return { fallbackError: e.message };
  } finally {
    if (browser) await browser.close();
  }
}

/**
 * Фолбэк без живого рендера — честно помечен как менее надёжный.
 * failureReason непустой ⇔ пакет playwright был найден, но launch/инспекция
 * упали (скорее всего браузерные бинарники не поставлены) — note в этом
 * случае называет конкретную причину вместо общей «недоступен».
 */
function inspectStatic(entryFile, failureReason) {
  try {
    const html = fs.readFileSync(entryFile, 'utf8');
    const titleMatch = html.match(/<title>([^<]*)<\/title>/i);
    const note = failureReason
      ? `Playwright установлен, но живой рендер не удался (${failureReason}) — статический разбор HTML вместо браузера на 375px. Поставить браузеры: npx playwright install chromium.`
      : 'Playwright недоступен (не установлен) — статический разбор HTML, не живой рендер на 375px. Поставить: npx playwright install chromium.';
    return {
      ok: true,
      live: false,
      title: titleMatch ? titleMatch[1] : null,
      hasActionable: /<button|role=["']button["']|<a\s/i.test(html),
      length: html.length,
      note,
    };
  } catch (e) {
    return { ok: false, live: false, error: e.message };
  }
}

export async function inspectProduct(workspaceDir, entryFileName = 'index.html', loadPlaywright) {
  const entryFile = path.join(workspaceDir, entryFileName);
  if (!fs.existsSync(entryFile)) {
    return { ok: false, error: `входной файл продукта не найден: ${entryFileName}` };
  }
  const live = await inspectWithPlaywright(entryFile, loadPlaywright);
  if (live?.ok) return live;
  return inspectStatic(entryFile, live?.fallbackError);
}

function buildLiveinPrompt(rootSpec, evidence) {
  return [
    `## root_spec проекта\n${rootSpec || '(нет)'}`,
    `## Собранные факты о продукте\n${JSON.stringify(evidence, null, 2)}`,
    '## Задача\nПройди продукт глазами первого пользователя-новичка и перечисли шероховатости по формату из системного промпта.',
  ].join('\n\n');
}

/**
 * runLivein({rootSpec, workspaceDir, entryFileName, runId, projectId}) →
 * {ok, evidence, roughSpotsFound, taskIds} | {ok:false, error, evidence?}
 */
export async function runLivein({
  rootSpec, workspaceDir, entryFileName = 'index.html', runId, projectId,
}) {
  const evidence = await inspectProduct(workspaceDir, entryFileName);
  if (!evidence.ok) {
    return { ok: false, error: `live_in: не удалось осмотреть продукт: ${evidence.error}`, evidence };
  }

  let result;
  try {
    result = await callAgent({
      role: 'live_in', promptFile: 'livein.md', userText: buildLiveinPrompt(rootSpec, evidence),
      json: true, runId, agent: 'live_in',
    });
  } catch (e) {
    return { ok: false, error: `live_in: сбой шлюза (${e.message})`, evidence };
  }

  const roughSpots = Array.isArray(result?.rough_spots) ? result.rough_spots : [];
  const createdIds = [];
  for (const spot of roughSpots) {
    if (!spot || typeof spot.title !== 'string' || !spot.criteria || typeof spot.criteria.cmd !== 'string') continue;
    const id = addTask({
      project_id: projectId,
      title: spot.title,
      spec: `${spot.description || ''}\n\nОбоснование (обживание, §9): ${spot.justification || ''}`,
      criteria: JSON.stringify(spot.criteria),
      role: 'coder',
      type: 'polish',
    });
    createdIds.push(id);
  }

  return { ok: true, evidence, roughSpotsFound: roughSpots.length, taskIds: createdIds };
}

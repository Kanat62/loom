// evals/interview.js — банк эталонных желаний → авто-проверка «нет
// технических вопросов клиенту» (§14 ТЗ v4: eval интервью, урок регрессии
// советника). Судья — лёгкая модель (роль 'cheap'); под MOCK=1 судит тот же
// код-уровневый regex, что и agents/advisor.js — детерминированно и без
// единого реального вызова (см. mock.js: MOCK_HANDLERS.cheap).
import { startIntake } from '../agents/advisor.js';
import { chat } from '../core/gateway.js';
import { newRunId, releaseStuck } from '../core/journal.js';

const WISHES = [
  { protocol: 'wish', text: 'Хочу одностраничник кофейни с меню и контактами.' },
  { protocol: 'wish', text: 'Напиши простой парсер котировок с одного публичного сайта.' },
  { protocol: 'problem', text: 'Растёт купля-продажа машин в городе, не знаю какие заказывать.' },
  { protocol: 'wish', text: 'Хочу VTOL-дрон, напиши кодовую часть управления.' },
  { protocol: 'spec', text: 'Вот моё ТЗ: нужен трекер задач с досками и метками, дедлайны опциональны.' },
  // Под MOCK=1 этот маркер заставляет мок-советника сперва задать технический
  // вопрос — проверяет, что код-уровневый guard (agents/advisor.js) реально
  // перехватывает и заменяет его, а не просто полагается на промпт.
  { protocol: 'wish', text: 'ТЕСТ_ТЕХ_ВОПРОС: хочу анимированную кнопку на сайте.' },
];

async function judgeHasTechnicalTerms(text, runId) {
  const messages = [
    { role: 'system', content: 'Ты judge. Определи, содержит ли вопрос технические детали (числа с единицами px/ms/сек/fps, протоколы, форматы данных, названия технологий/фреймворков), которые нельзя задавать клиенту-не-технарю. Ответь строго JSON {"has_technical_terms": true|false}.' },
    { role: 'user', content: text },
  ];
  const result = await chat('cheap', messages, { json: true, run_id: runId, agent: 'interview-judge' });
  return !!(result && result.has_technical_terms);
}

async function main() {
  releaseStuck();
  let failed = false;

  for (const { protocol, text } of WISHES) {
    const runId = newRunId();
    // eslint-disable-next-line no-await-in-loop
    const { step } = await startIntake({ protocol, initialText: text, runId });

    if (step.type !== 'ask') {
      console.log(`[interview] "${text.slice(0, 40)}..." → сразу ready, вопросов нет — OK`);
      continue;
    }

    // eslint-disable-next-line no-await-in-loop
    const hasTech = await judgeHasTechnicalTerms(step.question, runId);
    const verdict = hasTech ? 'FAIL' : 'OK';
    console.log(`[interview] "${text.slice(0, 40)}..." → вопрос: "${step.question}" — ${verdict}${step.forcedFallback ? ' (code-guard уже подменил вопрос)' : ''}`);
    if (hasTech) failed = true;
  }

  if (failed) {
    console.error('\n[interview] FAIL — хотя бы один вопрос содержал техническую деталь.');
    process.exit(1);
  }
  console.log('\n[interview] OK — ни один вопрос из банка не содержит технических деталей.');
}

main().catch((e) => { console.error('[interview] FAIL', e); process.exit(1); });

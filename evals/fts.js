// evals/fts.js — FTS5 порог/деградация для skills/tools (§4, П§7 DEV_GUIDE
// part2). Заводит 100+ записей внутри ОДНОГО процесса, чтобы доказать: порог
// ловится динамически (не только при следующем перезапуске процесса),
// LIKE-путь корректен НИЖЕ порога, FTS5-путь (если сборка sqlite его
// поддерживает — try/catch-деградация, не гарантия) корректен ВЫШЕ порога,
// и в обоих случаях поиск находит именно посаженный маркер, не что попало.
//
// Сбрасывает journal.mock.db/skills.mock.db перед прогоном (тот же паттерн,
// что core/mock.js:main()) — иначе повторный запуск дублировал бы маркер
// (writeSkill не дедуплицирует лестницу уроков, это НЕ баг — уроки честно
// накопительны в проде, дедуп нужен только этому изолированному eval-скрипту).
import fs from 'node:fs';
import {
  JOURNAL_DB_PATH, SKILLS_DB_PATH, MOCK,
} from '../core/config.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function resetMockDbs() {
  for (const dbPath of [JOURNAL_DB_PATH, SKILLS_DB_PATH]) {
    for (const suffix of ['', '-wal', '-shm']) {
      const p = dbPath + suffix;
      if (fs.existsSync(p)) fs.rmSync(p);
    }
  }
}

async function checkSkills() {
  const {
    writeSkill, searchSkills, _ftsDebugStatus,
  } = await import('../core/skills.js');

  // Ниже порога (90 < 100) — LIKE-путь.
  for (let i = 0; i < 90; i++) {
    writeSkill({ task_id: `t${i}`, files: [], lesson: `общий урок номер ${i} про обработку ошибок` });
  }
  writeSkill({ task_id: 'needle', files: [], lesson: 'нашлюфтс5 уникальный маркер для проверки поиска уроков' });

  let hits = searchSkills('нашлюфтс5');
  assert(hits.length === 1 && hits[0].task_id === 'needle', `skills: LIKE-путь не нашёл маркер, hits=${JSON.stringify(hits)}`);
  let status = _ftsDebugStatus();
  assert(status.active === false, `skills: ожидали LIKE-путь ниже порога 100, получили ${JSON.stringify(status)}`);
  console.log('[fts] skills < 100 записей: LIKE-путь OK, маркер найден.');

  // Пересекаем порог 100 — ещё 15, итог 106.
  for (let i = 0; i < 15; i++) {
    writeSkill({ task_id: `u${i}`, files: [], lesson: `дополнительный урок номер ${i} про кэширование` });
  }
  hits = searchSkills('нашлюфтс5');
  assert(hits.length === 1 && hits[0].task_id === 'needle', `skills: поиск после порога не нашёл маркер, hits=${JSON.stringify(hits)}`);
  status = _ftsDebugStatus();
  console.log(`[fts] skills >= 100 записей (106): путь=${status.active ? 'FTS5' : 'LIKE (сборка sqlite без FTS5 — честная деградация)'}, маркер найден верно.`);
}

async function checkTools() {
  // tools.js открывает JOURNAL_DB_PATH напрямую, но таблицу `tools` создаёт
  // МИГРАЦИЯ journal.js (core/journal.js:migrate) — в обычном коде journal.js
  // уже импортирован до любого обращения к tools.js; здесь тот же порядок
  // нужно повторить руками (releaseStuck() — любой безобидный вызов,
  // который трогает db() и тем самым прогоняет migrate()).
  const { releaseStuck } = await import('../core/journal.js');
  releaseStuck();
  const { registerTool, findTools, _ftsDebugStatus } = await import('../core/tools.js');

  for (let i = 0; i < 90; i++) {
    registerTool({ name: `demo-tool-${i}`, description: `демо-инструмент номер ${i} для теста FTS` });
  }
  registerTool({ name: 'needle-tool', description: 'нашлюфтс5 уникальный маркер для проверки поиска инструментов' });

  let hits = findTools('нашлюфтс5');
  assert(hits.length === 1 && hits[0].name === 'needle-tool', `tools: LIKE-путь не нашёл маркер, hits=${JSON.stringify(hits)}`);
  let status = _ftsDebugStatus();
  assert(status.active === false, `tools: ожидали LIKE-путь ниже порога 100, получили ${JSON.stringify(status)}`);
  console.log('[fts] tools < 100 записей: LIKE-путь OK, маркер найден.');

  for (let i = 0; i < 15; i++) {
    registerTool({ name: `demo-tool-extra-${i}`, description: `ещё один демо-инструмент номер ${i}` });
  }
  hits = findTools('нашлюфтс5');
  assert(hits.length === 1 && hits[0].name === 'needle-tool', `tools: поиск после порога не нашёл маркер, hits=${JSON.stringify(hits)}`);
  status = _ftsDebugStatus();
  console.log(`[fts] tools >= 100 записей (106): путь=${status.active ? 'FTS5' : 'LIKE (сборка sqlite без FTS5 — честная деградация)'}, маркер найден верно.`);
}

async function main() {
  if (!MOCK) {
    console.error('[fts] MOCK !== true — запусти через "npm run fts-eval:mock" (изолированные journal.mock.db/skills.mock.db).');
    process.exit(1);
  }
  resetMockDbs();
  await checkSkills();
  await checkTools();
  console.log('\n[fts] OK — порог 100 и LIKE↔FTS5-деградация работают корректно для skills и tools.');
}

main().catch((e) => { console.error('[fts] FAIL', e.message); process.exit(1); });

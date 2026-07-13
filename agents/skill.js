// agents/skill.js — skill_writer (§3, §4 ТЗ v4): вызывается механически
// координатором после каждой завершённой (done) задачи. Фильтр галлюцинаций
// + SKIP (шрам 24) — реализован в skills.js:hallucinationGuard, здесь только
// формируем запрос модели и передаём результат в writeSkill().
import { callAgent } from '../engine.js';
import { writeSkill } from '../skills.js';

function buildSkillPrompt(task) {
  let files = [];
  try { files = JSON.parse(task.touches_files || '[]'); } catch { files = []; }
  return [
    `## Задача\n${task.title}\n\n${task.spec || ''}`,
    `## Файлы, которых касалась задача (touches_files)\n${files.length ? files.join('\n') : '(не указаны)'}`,
    `## Итоговый отчёт тестера\n${task.feedback || '(нет)'}`,
  ].join('\n\n');
}

/**
 * runSkillWriter({task, runId}) → {skipped: bool, reason?}
 * Никогда не бросает — сбой этой роли не должен ронять координатор.
 */
export async function runSkillWriter({ task, runId }) {
  let files = [];
  try { files = JSON.parse(task.touches_files || '[]'); } catch { files = []; }

  let result;
  try {
    result = await callAgent({
      role: 'skill', promptFile: 'skill.md', userText: buildSkillPrompt(task),
      json: true, runId, taskId: task.id, agent: 'skill_writer',
    });
  } catch (e) {
    return { skipped: true, reason: `gateway-error:${e.message}` };
  }

  if (!result || result.skip || typeof result.lesson !== 'string' || !result.lesson.trim()) {
    return { skipped: true, reason: 'model-skip' };
  }

  return writeSkill({ task_id: task.id, files, lesson: result.lesson.trim() });
}

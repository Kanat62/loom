// ask.js — npm run ask -- "вопрос" (§25 ТЗ v4): прямой вход в advisor_analyst
// (question-протокол), read-only, без интервью, без задач на доске.
import { runAnalyst } from '../agents/advisor.js';
import { getRootSpec, newRunId } from '../core/journal.js';
import { resolveSingleActiveProject } from '../core/projects.js';

async function main() {
  const questionText = process.argv.slice(2).join(' ').trim();
  if (!questionText) {
    console.error('Использование: npm run ask -- "вопрос"');
    process.exit(1);
    return;
  }

  // §29.1: ask.js — read-only, вне сеанса talk.js, поэтому не может спросить
  // человека "какой проект" — честно требует ОДНОЗНАЧНОСТИ (ровно один
  // активный проект), иначе явная ошибка вместо угадывания (шрам 35).
  const resolved = resolveSingleActiveProject();
  if (!resolved.ok) {
    console.error(resolved.reason === 'none'
      ? '[ask] нет активных проектов — запустите npm run talk и опишите задачу.'
      : `[ask] несколько активных проектов — используйте npm run talk и /project <id>. Активные: ${resolved.projects.map((p) => p.id).join(', ')}`);
    process.exit(1);
    return;
  }
  const { project } = resolved;

  const rootSpec = getRootSpec(project.id);
  const runId = newRunId();

  const answer = await runAnalyst({
    question: questionText, rootSpec: rootSpec?.spec, workspaceDir: project.workspace_dir, runId,
  });
  console.log(answer);
}

main().catch((e) => { console.error('[ask] FAIL', e); process.exit(1); });

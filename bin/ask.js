// ask.js — npm run ask -- "вопрос" (§25 ТЗ v4): прямой вход в advisor_analyst
// (question-протокол), read-only, без интервью, без задач на доске.
import { runAnalyst } from '../agents/advisor.js';
import { getRootSpec, newRunId } from '../core/journal.js';
import { WORKSPACE } from '../core/config.js';

async function main() {
  const questionText = process.argv.slice(2).join(' ').trim();
  if (!questionText) {
    console.error('Использование: npm run ask -- "вопрос"');
    process.exit(1);
    return;
  }

  const rootSpec = getRootSpec('default');
  const runId = newRunId();

  const answer = await runAnalyst({
    question: questionText, rootSpec: rootSpec?.spec, workspaceDir: WORKSPACE, runId,
  });
  console.log(answer);
}

main().catch((e) => { console.error('[ask] FAIL', e); process.exit(1); });

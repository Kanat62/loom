// agents/tester.js — контур 1 (Checker), §9 ТЗ v4: тестер БЕЗ LLM, чистый
// детерминированный код. Критерии из журнала, таймаут, отчёты до 1000
// символов (шрам 20: 200 символов душили диагностику вложенных процессов).
import { runCheck } from '../checkRunner.js';
import { getTask } from '../journal.js';

const REPORT_MAX_LEN = 1000;

function parseCriteriaValue(parsed, raw) {
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === 'object') {
    // Контракт регрессии (§8.9): {regression_of:[id,...]} — склейка УЖЕ
    // СУЩЕСТВУЮЩИХ критериев done-задач, никакой новой генерации проверки
    // (шрам 31: самописная регрессия систематически билась).
    if (Array.isArray(parsed.regression_of)) {
      const expanded = [];
      for (const refId of parsed.regression_of) {
        const refTask = getTask(refId);
        if (!refTask) {
          expanded.push({ cmd: `node -e "console.error('FAIL: регрессия ссылается на несуществующую задачу ${refId}'); process.exit(1)"` });
          continue;
        }
        expanded.push(...parseCriteria(refTask.criteria));
      }
      return expanded;
    }
    return [parsed];
  }
  if (typeof parsed === 'string') return [{ cmd: parsed }];
  return [{ cmd: raw }];
}

function parseCriteria(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return parseCriteriaValue(parsed, raw);
  } catch {
    return [{ cmd: raw }]; // критерий задан голой командой без JSON-обёртки
  }
}

function truncate(s, n) {
  if (typeof s !== 'string') s = String(s);
  return s.length > n ? `${s.slice(0, n - 3)}...` : s;
}

/**
 * runTester({task, workspaceDir}) → {pass, report}
 * report — не единственная истина (§9), но должен быть читаем LLM-кодером:
 * какое условие не выполнено, с фактическими значениями.
 */
export async function runTester({ task, workspaceDir }) {
  const criteria = parseCriteria(task.criteria);
  if (!criteria.length) {
    return { pass: false, report: 'FAIL: у задачи нет критерия приёмки (criteria пуст или не распарсился)' };
  }

  const lines = [];
  let allPass = true;
  for (let i = 0; i < criteria.length; i++) {
    const c = criteria[i];
    const timeout = (typeof c === 'object' && c.timeout) || 10000;
    const res = await runCheck(c, { cwd: workspaceDir, timeout });
    allPass = allPass && res.pass;
    const status = res.pass ? 'PASS' : 'FAIL';
    const out = truncate((res.output || '(пустой вывод)').trim(), 300);
    lines.push(`[${i + 1}/${criteria.length}] ${status}: ${out}`);
  }

  const report = truncate(lines.join('\n'), REPORT_MAX_LEN);
  return { pass: allPass, report };
}

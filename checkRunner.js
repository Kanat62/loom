// checkRunner — исполнение критериев приёмки (§8 ТЗ v4). Единственный
// разрешённый способ прогнать JS-критерий: инлайн `node -e "<code>"` НИКОГДА
// не идёт в shell строкой — код вынимается во временный `.cjs`-файл ВНУТРИ
// workspace и запускается `node <file>.cjs` (шрам 7: `$$` в bash-критериях
// ломал `$$eval` до того, как до него добирался Node; tmpdir не годится —
// require() не резолвится до node_modules проекта).
//
// Windows-зависимость документирована (инвариант §20.8): shell-обвязка —
// Git Bash (`bash -c "<cmd>"`), т.к. cmd.exe не даёт единообразных
// пайпов/ретраев между платформами.
//
// Фаза 4 (§12): опциональная песочница Docker (docker.js) — если демон
// доступен, критерий исполняется В КОНТЕЙНЕРЕ (--network none, лимиты),
// иначе — прежний локальный путь. Переключение прозрачно для вызывающих.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { isDockerAvailable, runInDocker } from './docker.js';

// Матчит ЦЕЛУЮ команду вида: node -e "<код>" / node --eval '<код>'.
// Команды другого вида (node --check file.js, curl ..., готовый node file.cjs)
// проходят в shell как есть — извлекать нечего.
const NODE_EVAL_RE = /^node\s+(?:-e|--eval)\s+(['"])([\s\S]*)\1\s*$/;

function extractNodeEval(cmdStr) {
  const m = cmdStr.match(NODE_EVAL_RE);
  return m ? m[2] : null;
}

function runShellLocal(cmd, { cwd, timeout }) {
  return new Promise((resolve) => {
    let output = '';
    let timedOut = false;
    const child = spawn('bash', ['-c', cmd], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeout);

    child.stdout.on('data', (d) => { output += d.toString(); });
    child.stderr.on('data', (d) => { output += d.toString(); });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ exitCode: null, output: `FAIL: не удалось запустить проверку: ${e.message}`, timedOut: false });
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ exitCode: timedOut ? null : code, output, timedOut });
    });
  });
}

/**
 * runCheck(criterion, {cwd, timeout, sandbox}) → {pass, output, exitCode, timedOut}
 * criterion: {cmd, expect?} либо голая строка команды.
 * sandbox: 'local' (по умолчанию — безопасный дефолт, не зависит от Docker),
 * 'docker' (жёстко Docker — вызывающий сам отвечает за то, что образ уже
 * собран, см. coordinator.js:ensureDockerSandbox), 'auto' (Docker, если демон
 * отвечает, иначе локально — НЕ используется по умолчанию, т.к. не гарантирует
 * что образ workspace вообще собран).
 * Правило говорящего провала (§8.4) — забота автора критерия (архитектора,
 * см. prompts/architect.md); checkRunner лишь честно возвращает вывод команды
 * без искажений (правило 5: не подменяет и не имитирует проверку).
 */
export async function runCheck(criterion, { cwd, timeout = 10000, sandbox = 'local' } = {}) {
  const cmdStr = (typeof criterion === 'string' ? criterion : criterion?.cmd || '').trim();
  const expect = typeof criterion === 'object' && criterion ? criterion.expect : undefined;

  if (!cmdStr) {
    return { pass: false, output: 'FAIL: критерий пуст (нет cmd)', exitCode: null, timedOut: false };
  }
  if (!cwd || !fs.existsSync(cwd)) {
    return { pass: false, output: `FAIL: workspace не существует: ${cwd}`, exitCode: null, timedOut: false };
  }

  let execCmd = cmdStr;
  let tmpFile = null;
  const evalSrc = extractNodeEval(cmdStr);
  if (evalSrc !== null) {
    const name = `.loom-check-${crypto.randomUUID().slice(0, 8)}.cjs`;
    tmpFile = path.join(cwd, name);
    fs.writeFileSync(tmpFile, evalSrc, 'utf8');
    execCmd = `node ${name}`;
  }

  const useDocker = sandbox === 'docker' || (sandbox === 'auto' && isDockerAvailable());

  try {
    const res = useDocker
      ? await runInDocker(execCmd, { cwd, timeout })
      : await runShellLocal(execCmd, { cwd, timeout });
    let pass = res.exitCode === 0 && !res.timedOut;
    if (pass && expect) pass = res.output.includes(expect);
    if (res.timedOut) res.output += `\nFAIL: таймаут проверки (${timeout}мс)`;
    return { pass, output: res.output, exitCode: res.exitCode, timedOut: res.timedOut };
  } finally {
    if (tmpFile) {
      try { fs.unlinkSync(tmpFile); } catch { /* уже удалён/недоступен — не критично */ }
    }
  }
}

/**
 * Предпроверка (капкан на пустышки, §8.8): тихо (pipe, 5с) прогоняет критерий
 * на ТЕКУЩЕМ workspace ДО работы кодера. Если критерий уже проходит —
 * фиктивен (ничего не тестирует по сути). Локально — предпроверка сама по
 * себе не требует изоляции (критерий ещё не порождён кодером с потенциально
 * опасным кодом), но уважает тот же sandbox-режим для единообразия.
 */
export async function precheck(criterion, cwd, { sandbox = 'local' } = {}) {
  return runCheck(criterion, { cwd, timeout: 5000, sandbox });
}

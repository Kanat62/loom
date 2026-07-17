// evals/spawn-windows.js — регрессия для core/spawnUtil.js:buildSpawnArgs
// (Windows ENOENT на shim-командах npm/npx/tsc, см. docs/DECISIONS.md) И
// (§29.5) для core/checkRunner.js:SPAWN_SHIM_PREAMBLE — живой прогон
// показал, что 63f6c57 (спавны ВНУТРИ core/*.js) был частичным: код
// КРИТЕРИЯ пишет архитектор-LLM, вне статического контроля core/, и
// prompt-guidance (shell:true в сгенерированном коде) не держит стабильно
// на каждой попытке. checkRunner теперь безусловно патчит
// child_process.spawn/execFile внутри исполняемого .cjs критерия — эта
// проверка гоняет НАИВНЫЙ (без shell:true) spawn('npm', [...]) через
// РЕАЛЬНЫЙ checkRunner.runCheck() и требует, чтобы он прошёл.
// MOCK никогда реально не зовёт npx, поэтому обычный `npm run mock` не может
// поймать регрессию квотирования — эта проверка мокает process.platform (обе
// ветки, Windows и POSIX, прогоняются независимо от реальной ОС хоста) и
// сверяет РЕЗУЛЬТАТ buildSpawnArgs напрямую, без реального spawn.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildSpawnArgs } from '../core/spawnUtil.js';
import { runCheck } from '../core/checkRunner.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function withPlatform(platform, fn) {
  const real = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  try {
    fn();
  } finally {
    Object.defineProperty(process, 'platform', real);
  }
}

function checkWindows() {
  withPlatform('win32', () => {
    const args = buildSpawnArgs(['install', '--no-audit', 'left-pad', 'C:\\path with spaces\\pkg']);
    assert(args.length === 4, `win32: ожидалось 4 аргумента, получили ${args.length}`);
    for (const a of args) {
      assert(a.startsWith('"') && a.endsWith('"'), `win32: аргумент не обёрнут в кавычки JSON.stringify: ${a}`);
    }
    assert(args[3] === '"C:\\\\path with spaces\\\\pkg"', `win32: путь с пробелом не сохранился одним аргументом: ${args[3]}`);
    // JSON.parse откатывает кавычки/экранирование — доказывает, что квотирование обратимо и не портит значение.
    assert(JSON.parse(args[3]) === 'C:\\path with spaces\\pkg', `win32: JSON.parse(args[3]) не восстановил исходное значение: ${args[3]}`);
  });
}

function checkPosix() {
  withPlatform('linux', () => {
    const input = ['install', '--no-audit', 'left-pad', '/path with spaces/pkg'];
    const args = buildSpawnArgs(input);
    assert(JSON.stringify(args) === JSON.stringify(input), `posix: аргументы не должны меняться (кавычки на POSIX без shell портят значение): ${JSON.stringify(args)}`);
  });
}

/**
 * checkCheckRunnerPreamble — §29.5, интеграционная (не мок-платформы, как
 * checkWindows выше): дочерний .cjs-процесс сам читает РЕАЛЬНЫЙ
 * process.platform хоста, подделать его из родительского процесса нельзя
 * (в отличие от buildSpawnArgs — чистой функции). Критерий НАРОЧНО не
 * ставит shell:true сам — именно этот класс бага уронил живой прогон.
 */
async function checkCheckRunnerPreamble() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-spawn-shim-eval-'));
  try {
    const criterion = {
      cmd: 'node -e "const{spawn}=require(\'child_process\');const cp=spawn(\'npm\',[\'--version\']);let out=\'\';cp.stdout.on(\'data\',d=>out+=d);cp.on(\'error\',e=>{console.error(\'FAIL: spawn error: \'+e.message);process.exit(1)});cp.on(\'exit\',c=>{if(c===0){console.log(\'PASS npm version=\'+out.trim())}else{console.error(\'FAIL: exit \'+c);process.exit(1)}})"',
      expect: 'PASS',
    };
    const result = await runCheck(criterion, { cwd, timeout: 15000 });
    assert(result.pass, `checkRunner: наивный spawn('npm', [...]) без shell:true обязан пройти через harness-преамбулу, получили: ${JSON.stringify(result)}`);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

async function main() {
  checkWindows();
  checkPosix();
  await checkCheckRunnerPreamble();
  console.log('[spawn-windows] OK — buildSpawnArgs корректно квотирует на win32/POSIX, checkRunner делает наивный spawn(shim) Windows-safe изнутри критерия.');
}

main().catch((e) => { console.error('[spawn-windows] FAIL', e.message); process.exit(1); });

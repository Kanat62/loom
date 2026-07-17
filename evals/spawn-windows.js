// evals/spawn-windows.js — регрессия для core/spawnUtil.js:buildSpawnArgs
// (Windows ENOENT на shim-командах npm/npx/tsc, см. docs/DECISIONS.md).
// MOCK никогда реально не зовёт npx, поэтому обычный `npm run mock` не может
// поймать регрессию квотирования — эта проверка мокает process.platform (обе
// ветки, Windows и POSIX, прогоняются независимо от реальной ОС хоста) и
// сверяет РЕЗУЛЬТАТ buildSpawnArgs напрямую, без реального spawn.
import { buildSpawnArgs } from '../core/spawnUtil.js';

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

function main() {
  checkWindows();
  checkPosix();
  console.log('[spawn-windows] OK — buildSpawnArgs корректно квотирует на win32 и оставляет аргументы как есть на POSIX.');
}

main();

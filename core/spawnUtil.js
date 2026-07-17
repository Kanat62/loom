// core/spawnUtil.js — общий Windows-safe spawn-паттерн (§20.6, Фаза 1
// DECISIONS: gateway.js:buildSpawnArgs). npm/npx/tsc/claude — на Windows
// это `.cmd`-шимы, не настоящие `.exe`: прямой `spawn('npx', ...)`/
// `execFileSync('npm', ...)` без `shell:true` падает `ENOENT`. `shell:true`,
// в свою очередь, режет CLI-аргументы с пробелами по первому пробелу —
// оборачиваем каждый аргумент в `JSON.stringify()`, валидное
// cmd.exe-экранирование для путей/имён пакетов/JSON-строк. На POSIX shell не
// нужен — команда резолвится по PATH напрямую, аргументы идут как есть (там
// же кавычки от JSON.stringify испортили бы значение).
//
// Единый источник паттерна: любой новый вызов shim-based команды
// (npm/npx/tsc/vite/…) через spawn/execFileSync должен использовать этот
// хелпер, а не переизобретать квотирование вручную.

/** buildSpawnArgs(args) → аргументы, безопасные для spawn(cmd, args, {shell:true}) на Windows. */
export function buildSpawnArgs(args) {
  if (process.platform === 'win32') {
    return args.map((a) => JSON.stringify(String(a)));
  }
  return args.map(String);
}

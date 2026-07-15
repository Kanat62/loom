// evals/fixtures/fake-tsc-impl.js — детерминированный двойник `tsc --noEmit`
// для MOCK-проверки tsc-ворот (Фаза 6, П§5 п.5) БЕЗ реального пакета
// typescript и БЕЗ сети (npx без предустановленного пакета тянет его из
// сети — недопустимо в MOCK, §24). Имитирует ровно то, что нужно воротам:
// ненулевой код выхода + текст ошибки, если рядом лежит "битый" bad.d.ts.
const fs = require('fs');
const path = require('path');

const badPath = path.join(process.cwd(), 'bad.d.ts');
if (fs.existsSync(badPath)) {
  const content = fs.readFileSync(badPath, 'utf8');
  if (/DoesNotExist/.test(content)) {
    process.stderr.write("bad.d.ts(1,15): error TS2304: Cannot find name 'DoesNotExist'.\n");
    process.exit(2);
  }
}
process.exit(0);

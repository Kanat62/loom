// core/domain.js — §27.1 ТЗ v4: доменный тег, включающий/выключающий весь
// дизайн-контур (§27). Инвариант стоимости: domain !== 'ui' → ни designer,
// ни дизайн-критерии, ни визуальное ревью не вызываются, ни один вызов не
// тратится (§27.1).
export const DOMAINS = new Set(['ui', 'cli', 'lib', 'data']);
export const DEFAULT_DOMAIN = 'cli';

// Эвристика-страховка (§27.1): если советник не выставил домен (или выставил
// что-то невалидное), но в тексте есть явные UI-сигналы — считаем ui. Без
// `\b`: DECISIONS уже зафиксировал баг advisor.js — `\b` в JS не распознаёт
// кириллицу как \w, граница «буква→пробел» вокруг кириллического слова не
// матчится обычным \b (то же самое было с "мс"/"протокол"). Здесь это не
// нужно вовсе: простой substring-тест через .test() без границ, потому что
// все сигналы — самостоятельные, достаточно длинные слова/корни (html,
// canvas, страниц-, экран-), риск ложного совпадения внутри другого слова
// пренебрежимо мал (в отличие от коротких аббревиатур вроде "мс"/"px" в
// advisor.js, где он был реальным).
const UI_SIGNAL_RE = /html|canvas|страниц|экран|вёрстк|интерфейс/iu;

/**
 * resolveDomain(declaredDomain, textForHeuristic) -> 'ui'|'cli'|'lib'|'data'
 * declaredDomain — то, что вернул советник (может быть undefined/мусор).
 * textForHeuristic — root_spec/бриф/требования, по которым ищем UI-сигналы,
 * если советник домен не дал.
 */
export function resolveDomain(declaredDomain, textForHeuristic) {
  if (DOMAINS.has(declaredDomain)) return declaredDomain;
  if (UI_SIGNAL_RE.test(textForHeuristic || '')) return 'ui';
  return DEFAULT_DOMAIN;
}

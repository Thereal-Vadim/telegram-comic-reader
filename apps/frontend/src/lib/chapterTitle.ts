/**
 * Display helper for issue titles that still arrive as bare "# 440" from cache
 * or upstream. Matches the backend formatter for the common hash-only case.
 */
export function displayChapterTitle(title: string, number?: number): string {
  const raw = title.replace(/\s+/g, ' ').trim();
  const hashOnly = raw.match(/^#\s*(\d+)\s*$/);
  if (hashOnly) return `Выпуск № ${hashOnly[1]}`;
  if (/^#\s*\d+/.test(raw)) return raw.replace(/^#\s*(\d+)\b/, 'Выпуск № $1');
  if (raw) return raw;
  if (number !== undefined && number > 0) return `Выпуск № ${number}`;
  return 'Выпуск';
}

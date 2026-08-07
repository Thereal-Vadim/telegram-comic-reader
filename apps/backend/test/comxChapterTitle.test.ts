import { describe, expect, it } from 'vitest';
import { formatComxChapterTitle } from '../src/adapters/comxAdapter.js';

describe('formatComxChapterTitle', () => {
  it('turns bare # N labels into readable issue titles', () => {
    expect(formatComxChapterTitle({ title: '# 163', number: 163, volume: 1 })).toBe(
      'Том 1 · Выпуск № 163',
    );
    expect(formatComxChapterTitle({ title: '# 8', number: 8 })).toBe('Выпуск № 8');
  });

  it('keeps descriptive titles and normalizes a leading #', () => {
    expect(
      formatComxChapterTitle({ title: '# 52 Список', number: 52, volume: 1 }),
    ).toBe('Том 1 · Выпуск № 52 Список');
    expect(formatComxChapterTitle({ title: '1 - 1 Сингл', number: 1, volume: 1 })).toBe(
      '1 - 1 Сингл',
    );
    expect(formatComxChapterTitle({ title: 'Chapter 1', number: 1, volume: 1 })).toBe('Chapter 1');
  });
});


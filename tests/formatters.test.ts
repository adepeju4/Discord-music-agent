import { describe, it, expect } from 'vitest';
import { formatDuration, truncate } from '../src/utils/formatters';

describe('formatDuration', () => {
  it('formats seconds only', () => {
    expect(formatDuration(45)).toBe('0:45');
  });

  it('formats minutes and seconds', () => {
    expect(formatDuration(125)).toBe('2:05');
  });

  it('formats hours', () => {
    expect(formatDuration(3661)).toBe('1:01:01');
  });

  it('formats zero', () => {
    expect(formatDuration(0)).toBe('0:00');
  });
});

describe('truncate', () => {
  it('returns short strings unchanged', () => {
    expect(truncate('hello', 10)).toBe('hello');
  });

  it('truncates long strings with ellipsis', () => {
    expect(truncate('this is a very long string', 15)).toBe('this is a ve...');
  });

  it('handles exact length', () => {
    expect(truncate('exact', 5)).toBe('exact');
  });
});

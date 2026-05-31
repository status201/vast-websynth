import { describe, it, expect } from 'vitest';
import { assertIndex, IndexError } from '../../src/utils/array';

describe('assertIndex', () => {
  it('returns the element for a valid index', () => {
    const arr = [10, 20, 30];
    expect(assertIndex(arr, 0)).toBe(10);
    expect(assertIndex(arr, 1)).toBe(20);
    expect(assertIndex(arr, 2)).toBe(30);
  });

  it('throws IndexError for a negative index', () => {
    const arr = [10, 20, 30];
    expect(() => assertIndex(arr, -1)).toThrow(IndexError);
    expect(() => assertIndex(arr, -1)).toThrow('out of bounds');
  });

  it('throws IndexError for an out-of-range index', () => {
    const arr = [10, 20, 30];
    expect(() => assertIndex(arr, 3)).toThrow(IndexError);
    expect(() => assertIndex(arr, 100)).toThrow(IndexError);
  });

  it('includes array name in the error message', () => {
    const arr: number[] = [];
    expect(() => assertIndex(arr, 0, 'myList')).toThrow('myList');
  });

  it('uses default name "array" when omitted', () => {
    const arr: number[] = [];
    expect(() => assertIndex(arr, 0)).toThrow('array');
  });

  it('round-trips type through generic', () => {
    const arr = ['a', 'b'] as const;
    const el: string = assertIndex(arr, 1);
    expect(el).toBe('b');
  });

  it('works on empty arrays', () => {
    const arr: number[] = [];
    expect(() => assertIndex(arr, 0)).toThrow(IndexError);
  });
});

describe('IndexError', () => {
  it('is an instance of RangeError', () => {
    expect(new IndexError(5, 3, 'test')).toBeInstanceOf(RangeError);
  });

  it('has a descriptive message', () => {
    const err = new IndexError(5, 3, 'items');
    expect(err.message).toBe('Index 5 out of bounds [0, 2] for items');
    expect(err.name).toBe('IndexError');
  });
});

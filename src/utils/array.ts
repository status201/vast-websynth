export class IndexError extends RangeError {
  constructor(index: number, length: number, name: string) {
    super(`Index ${index} out of bounds [0, ${length - 1}] for ${name}`);
    this.name = 'IndexError';
  }
}

export function assertIndex<T>(
  arr: readonly T[],
  index: number,
  name = 'array',
): T {
  if (index < 0 || index >= arr.length) {
    throw new IndexError(index, arr.length, name);
  }
  return arr[index] as T;
}

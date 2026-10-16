export function total(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0);
}

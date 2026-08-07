/**
 * "Features select an index into a pre-defined musical palette" is the rule that keeps the
 * output musical, and this is the only sanctioned way to perform that selection.
 *
 * It clamps instead of returning undefined on purpose. An out-of-range index that silently
 * yields `undefined` becomes a NaN pitch or duration downstream, and NaN is silence or a
 * click rather than a wrong note — the hardest kind of audio bug to trace back.
 */
export function pick<T>(palette: readonly T[], index: number): T {
  const clamped = Math.min(Math.max(Math.trunc(index), 0), palette.length - 1);
  const value = palette[clamped];
  if (value === undefined) {
    throw new Error(`Cannot select index ${index} from a palette of ${palette.length}.`);
  }
  return value;
}

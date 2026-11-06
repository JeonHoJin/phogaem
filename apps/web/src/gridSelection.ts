/** Apply one inclusive drag range against the immutable selection at gesture start. */
export function rangeSelection(ids: readonly string[], baseline: ReadonlySet<string>, anchor: number, end: number): Set<string> {
  const result = new Set(baseline);
  if (anchor < 0 || end < 0 || anchor >= ids.length || end >= ids.length) return result;
  const remove = baseline.has(ids[anchor]!);
  for (let index = Math.min(anchor, end); index <= Math.max(anchor, end); index += 1) {
    if (remove) result.delete(ids[index]!);
    else result.add(ids[index]!);
  }
  return result;
}

/** Pinching apart enlarges tiles; pinching together increases the column count. */
export function pinchColumns(initialColumns: number, initialDistance: number, distance: number, maxColumns = 8): number {
  const maximum = Math.min(8, Math.max(2, Math.round(maxColumns)));
  const initial = Math.min(maximum, Math.max(2, Math.round(initialColumns)));
  if (!(initialDistance > 0) || !(distance > 0) || !Number.isFinite(initialDistance) || !Number.isFinite(distance)) return initial;
  const steps = Math.trunc(Math.log(distance / initialDistance) / Math.log(1.25));
  return Math.min(maximum, Math.max(2, initial - steps));
}

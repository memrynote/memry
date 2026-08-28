/**
 * Grouped thousands, hand-rolled rather than `toLocaleString`.
 *
 * Hermes ships a trimmed Intl and the grouping it produces varies by build, so
 * an item count could render "1,000" in one place and "1000" in another.
 */
export function withThousands(value: number): string {
  return value.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

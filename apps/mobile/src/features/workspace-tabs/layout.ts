export function workspaceTabCardWidth(screenWidth: number): number {
  const horizontalPadding = 12 * 2
  const columnGap = 8
  return Math.max(0, Math.floor((screenWidth - horizontalPadding - columnGap) / 2))
}

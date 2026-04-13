const MAX_MINUTES = 1425 // 23:45

export function pixelToSnappedMinutes(
  pixelY: number,
  hourHeight: number,
  snapMinutes: number
): number {
  const rawMinutes = (pixelY / hourHeight) * 60
  const snapped = Math.round(rawMinutes / snapMinutes) * snapMinutes
  return Math.max(0, Math.min(snapped, MAX_MINUTES))
}

export function minutesToTimeString(totalMinutes: number): string {
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`
}

export interface MarqueeSelectionGeometry {
  startMinutes: number
  endMinutes: number
  top: number
  height: number
}

export function selectionFromDrag(
  startPixelY: number,
  endPixelY: number,
  hourHeight: number,
  snapMinutes: number
): MarqueeSelectionGeometry {
  const startMin = pixelToSnappedMinutes(startPixelY, hourHeight, snapMinutes)
  const endMin = pixelToSnappedMinutes(endPixelY, hourHeight, snapMinutes)
  const lo = Math.min(startMin, endMin)
  const hi = Math.max(startMin, endMin)
  const finalEnd = hi === lo ? lo + snapMinutes : hi
  const pxPerMinute = hourHeight / 60
  return {
    startMinutes: lo,
    endMinutes: Math.min(finalEnd, MAX_MINUTES + snapMinutes),
    top: lo * pxPerMinute,
    height: (Math.min(finalEnd, MAX_MINUTES + snapMinutes) - lo) * pxPerMinute,
  }
}

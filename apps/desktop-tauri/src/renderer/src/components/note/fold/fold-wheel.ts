export interface WheelStepper {
  /** Feed one wheel delta. Returns -1 toward Full, 1 toward Topic, 0 for no step yet. */
  push(deltaY: number, now: number): -1 | 0 | 1
}

/**
 * Turns ⌘/Ctrl + scroll and trackpad pinch (a ctrl wheel in Chromium) into
 * discrete level steps. A pinch is many tiny deltas, so they accumulate to a
 * threshold; after a step the stepper ignores input for a short cooldown so one
 * gesture moves one level. Scrolling up or pinching out is "closer": toward Full.
 * With `untilIdle`, events during the cooldown extend it, so a trackpad's
 * inertial tail cannot step a second level: the next step waits for a pause.
 */
export function createWheelStepper(
  threshold = 40,
  cooldownMs = 250,
  untilIdle = false
): WheelStepper {
  let sum = 0
  let lockedUntil = 0
  return {
    push(deltaY, now) {
      if (now < lockedUntil) {
        if (untilIdle) lockedUntil = now + cooldownMs
        return 0
      }
      sum += deltaY
      if (Math.abs(sum) < threshold) return 0
      const step = sum < 0 ? -1 : 1
      sum = 0
      lockedUntil = now + cooldownMs
      return step
    }
  }
}

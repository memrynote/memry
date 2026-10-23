import { describe, expect, it } from 'vitest'
import { createWheelStepper } from './fold-wheel'

describe('wheel stepper', () => {
  it('accumulates a pinch’s tiny deltas into one step', () => {
    const stepper = createWheelStepper(40, 250)
    const results = [10, 10, 10, 10].map((delta, i) => stepper.push(delta, i * 16))
    expect(results).toEqual([0, 0, 0, 1])
  })

  it('steps toward Full when scrolling up or pinching out', () => {
    expect(createWheelStepper().push(-60, 0)).toBe(-1)
  })

  it('moves one level per gesture: the cooldown swallows the tail of a flick', () => {
    const stepper = createWheelStepper(40, 250)
    expect(stepper.push(80, 0)).toBe(1)
    expect(stepper.push(80, 100)).toBe(0)
    expect(stepper.push(80, 300)).toBe(1)
  })

  it('does not step on opposite deltas that cancel out', () => {
    const stepper = createWheelStepper(40, 250)
    expect(stepper.push(30, 0)).toBe(0)
    expect(stepper.push(-30, 10)).toBe(0)
  })
})

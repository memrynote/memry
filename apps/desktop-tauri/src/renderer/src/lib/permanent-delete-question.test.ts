import { describe, expect, it } from 'vitest'
import { answer, askPermanentDelete, current } from './permanent-delete-question'

describe('permanent-delete-question', () => {
  it('asks one question at a time, in order, and answers each once', async () => {
    const first = askPermanentDelete('One')
    const second = askPermanentDelete('Two')
    const asked = current()
    expect(asked?.title).toBe('One')

    answer(asked, true)
    // The close a button causes answers again: it must not reach the next question.
    answer(asked, false)
    expect(await first).toBe(true)
    expect(current()?.title).toBe('Two')

    answer(current(), false)
    expect(await second).toBe(false)
    expect(current()).toBeNull()
  })
})

import { describe, expect, it } from 'vitest'
import { describeRecurrence, splitLinks, stripConferenceBoilerplate } from './calendar-event-text'

describe('stripConferenceBoilerplate', () => {
  const block = [
    '-::~:~::~:~:~:~:~:~:~:~::~:~::-',
    'Join with Google Meet: https://meet.google.com/fmf-mjds-dpp',
    'Please do not edit this section.',
    '-::~:~::~:~:~:~:~:~:~:~::~:~::-'
  ].join('\n')

  it('removes the Google Meet block and keeps the real description', () => {
    expect(stripConferenceBoilerplate(`Stand-up notes.\n\n${block}\n`)).toBe('Stand-up notes.')
    expect(stripConferenceBoilerplate(`${block}\n\nStand-up notes.`)).toBe('Stand-up notes.')
  })

  it('removes an unclosed block to the end and leaves ordinary text alone', () => {
    expect(
      stripConferenceBoilerplate('Agenda\n-::~:~::~::-\nJoin: https://meet.google.com/x')
    ).toBe('Agenda')
    expect(stripConferenceBoilerplate('Just text.')).toBe('Just text.')
  })
})

describe('splitLinks', () => {
  it('splits links out of text and leaves trailing punctuation as text', () => {
    expect(splitLinks('Board: https://example.atlassian.net/x?id=259. Thanks')).toEqual([
      { kind: 'text', value: 'Board: ' },
      { kind: 'link', value: 'https://example.atlassian.net/x?id=259' },
      { kind: 'text', value: '. Thanks' }
    ])
    expect(splitLinks('no links')).toEqual([{ kind: 'text', value: 'no links' }])
  })
})

describe('describeRecurrence', () => {
  it('names weekly days in week order, whatever order the rule lists them', () => {
    expect(describeRecurrence('FREQ=WEEKLY;BYDAY=FR,TH,TU,WE', 'en')).toEqual({
      key: 'weeklyOn',
      count: 1,
      days: 'Tuesday, Wednesday, Thursday, and Friday'
    })
  })

  it('keeps the interval and falls back when a sentence cannot say the rule', () => {
    expect(describeRecurrence('FREQ=DAILY;INTERVAL=2', 'en')).toEqual({ key: 'daily', count: 2 })
    expect(describeRecurrence('FREQ=WEEKLY;BYDAY=1MO', 'en')).toEqual({ key: 'weekly', count: 1 })
    expect(describeRecurrence('FREQ=MONTHLY;BYSETPOS=-1', 'en').key).toBe('monthly')
    expect(describeRecurrence('RRULE:FREQ=YEARLY', 'en')).toEqual({ key: 'yearly', count: 1 })
    expect(describeRecurrence('FREQ=SECONDLY', 'en').key).toBe('other')
  })
})

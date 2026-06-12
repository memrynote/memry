import assert from 'node:assert/strict'
import test from 'node:test'

import { reminderTargetType } from '@memry/contracts/reminder-types'

test('reminder target types: canonical set is exactly the four supported targets', () => {
  assert.deepEqual(Object.values(reminderTargetType).sort(), [
    'highlight',
    'journal',
    'note',
    'task'
  ])
})

import { test } from 'node:test'

import { selfcheck } from './generate-homebrew-cask.mjs'

test('the rendered cask passes the generator self-check', () => {
  selfcheck()
})

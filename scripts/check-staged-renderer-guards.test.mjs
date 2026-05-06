import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { scanRendererText } from './check-staged-renderer-guards.mjs'

describe('staged renderer guards', () => {
  it('flags raw console calls and physical Tailwind direction classes', () => {
    const findings = scanRendererText(
      'apps/desktop/src/renderer/src/components/example.tsx',
      '<div className="ml-2 text-left">Value</div>\nconsole.log("debug")'
    )

    assert.deepEqual(
      findings.map((finding) => finding.rule),
      ['physical-tailwind-class', 'raw-console']
    )
  })

  it('allows logical Tailwind classes', () => {
    const findings = scanRendererText(
      'apps/desktop/src/renderer/src/components/example.tsx',
      '<div className="ms-2 text-start">Value</div>'
    )

    assert.equal(findings.length, 0)
  })
})

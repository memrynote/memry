import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { scanRendererText } from './check-staged-renderer-guards.mjs'

const rendererPath = 'apps/desktop/src/renderer/src/components/sample.tsx'

const physical = (findings) =>
  findings.filter((finding) => finding.rule === 'physical-tailwind-class')

describe('physical Tailwind classes in class lists', () => {
  it('reports the className line and not the adjacent comment', () => {
    const source = [
      'export function Sample() {',
      '  // Open the context menu on right-click.',
      '  return <div className="absolute right-0" />',
      '}'
    ].join('\n')

    const findings = scanRendererText(rendererPath, source)

    assert.deepEqual(findings, [
      {
        filePath: rendererPath,
        line: 3,
        rule: 'physical-tailwind-class',
        message: 'right-0'
      }
    ])
  })

  it('reports a class inside cn(), clsx(), cva() and twMerge()', () => {
    const source = [
      'const a = cn("flex", isOpen && "ml-2")',
      'const b = clsx("pr-4")',
      'const c = cva("base", { variants: { side: { start: "left-0" } } })',
      'const d = twMerge("border-l-2")'
    ].join('\n')

    assert.deepEqual(
      physical(scanRendererText(rendererPath, source)).map((finding) => [
        finding.line,
        finding.message
      ]),
      [
        [1, 'ml-2'],
        [2, 'pr-4'],
        [3, 'left-0'],
        [4, 'border-l-2']
      ]
    )
  })

  it('reports a class inside a className template literal and its interpolated class list', () => {
    const source = [
      'const e = <div className={`flex ${wide ? "pl-8" : ""} text-left`} />',
      'const f = <div className={isOpen ? "rounded-r-md" : "rounded-none"} />'
    ].join('\n')

    assert.deepEqual(
      physical(scanRendererText(rendererPath, source)).map((finding) => [
        finding.line,
        finding.message
      ]),
      [
        [1, 'pl-8'],
        [2, 'rounded-r-md']
      ]
    )
  })

  it('leaves logical direction classes alone', () => {
    const source = 'const g = <div className="ms-2 pe-4 start-0 text-end border-s rounded-e-md" />'

    assert.deepEqual(physical(scanRendererText(rendererPath, source)), [])
  })
})

describe('text that only looks like a physical Tailwind class', () => {
  it('ignores prose in line and block comments', () => {
    const source = [
      '// Fires on right-click and keeps the text-left reading order.',
      '/**',
      ' * Aligns to the left-hand edge, mirroring ml-4 in the legacy sheet.',
      ' */',
      'export const noop = () => {}'
    ].join('\n')

    assert.deepEqual(scanRendererText(rendererPath, source), [])
  })

  it('ignores a commented-out className', () => {
    const source = '// return <div className="right-0" />'

    assert.deepEqual(scanRendererText(rendererPath, source), [])
  })

  it('ignores string literals that are not class lists', () => {
    const source = [
      'import { Panel } from "./right-panel"',
      'const label = t("menu.right-click")',
      'const hint = "Aligned to the right-hand edge"',
      'const el = <button data-testid="context-menu-right-click" aria-label="Move left-1 step" />'
    ].join('\n')

    assert.deepEqual(scanRendererText(rendererPath, source), [])
  })

  it('ignores a non-class-list call that happens to take direction words', () => {
    const source = 'const h = describeShortcut("right-click", "text-left")'

    assert.deepEqual(scanRendererText(rendererPath, source), [])
  })

  // Known limit of anchoring on className and cn/clsx/cva/twMerge. A class list
  // parked in a config table reaches className through a variable, and following
  // that would need a real parser. DENSITY_CONFIG in use-display-density.ts is the
  // only such site in the renderer tree today.
  it('does not follow a class list held in a config object', () => {
    const source = 'const config = { watermarkOffset: "-left-2 lg:-left-4" }'

    assert.deepEqual(scanRendererText(rendererPath, source), [])
  })
})

describe('raw console calls', () => {
  it('still reports every raw console call with its line', () => {
    const source = ['const i = 1', 'console.warn("boom")', 'console.log("again")'].join('\n')

    assert.deepEqual(scanRendererText(rendererPath, source), [
      {
        filePath: rendererPath,
        line: 2,
        rule: 'raw-console',
        message: 'console.warn('
      },
      {
        filePath: rendererPath,
        line: 3,
        rule: 'raw-console',
        message: 'console.log('
      }
    ])
  })
})

describe('scanned paths', () => {
  it('skips files outside the renderer source tree', () => {
    const source = 'const j = <div className="right-0" />'

    assert.deepEqual(scanRendererText('apps/desktop/src/main/sample.tsx', source), [])
  })

  it('skips renderer test files', () => {
    const source = 'const k = <div className="right-0" />'

    assert.deepEqual(
      scanRendererText('apps/desktop/src/renderer/src/components/sample.test.tsx', source),
      []
    )
  })
})

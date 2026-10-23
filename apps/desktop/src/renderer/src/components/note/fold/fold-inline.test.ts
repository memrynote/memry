import { describe, expect, it } from 'vitest'
import { parseInline } from './fold-inline'

const t = (text: string) => ({ type: 'text', text })

describe('parseInline', () => {
  it('reads bold, italic, strike and code', () => {
    expect(parseInline('a **b** *c* _d_ ~~e~~ `f`')).toEqual([
      t('a '),
      { type: 'strong', children: [t('b')] },
      t(' '),
      { type: 'em', children: [t('c')] },
      t(' '),
      { type: 'em', children: [t('d')] },
      t(' '),
      { type: 'del', children: [t('e')] },
      t(' '),
      { type: 'code', text: 'f' }
    ])
  })

  it('nests marks and keeps code literal', () => {
    expect(parseInline('**bold *and* more** `**x**`')).toEqual([
      { type: 'strong', children: [t('bold '), { type: 'em', children: [t('and')] }, t(' more')] },
      t(' '),
      { type: 'code', text: '**x**' }
    ])
  })

  it('reads links and wiki-links by their visible text', () => {
    expect(
      parseInline('see [the plan](https://x.test/a_(b)) and [[Pro plan|Pro]] or [[Plan]]')
    ).toEqual([
      t('see '),
      { type: 'link', children: [t('the plan')] },
      t(' and '),
      { type: 'wiki', label: 'Pro' },
      t(' or '),
      { type: 'wiki', label: 'Plan' }
    ])
  })

  it('keeps an image’s alt text without the image', () => {
    expect(parseInline('a ![shot](x.png) b')).toEqual([t('a '), t('shot'), t(' b')])
  })

  it('leaves unmatched markers, snake_case and escapes as text', () => {
    expect(parseInline('2 * 3 and snake_case_name \\*not\\* [open')).toEqual([
      t('2 * 3 and snake_case_name *not* [open')
    ])
  })

  it('never produces markup from raw HTML: it stays text', () => {
    expect(parseInline('<img src=x onerror=alert(1)> <b>hi</b>')).toEqual([
      t('<img src=x onerror=alert(1)> <b>hi</b>')
    ])
  })
})

import { describe, expect, it } from 'vitest'
import {
  normalizeTaskBlocks,
  parseTaskBlockSuffix,
  scanTaskCheckboxStates,
  serializeTaskBlock,
  stripTaskBlockSuffixes
} from './task-block'

describe('scanTaskCheckboxStates', () => {
  it('returns an empty map when the note has no task lines', () => {
    expect(scanTaskCheckboxStates('# Title\n\nJust prose.\n- [x] plain checkbox').size).toBe(0)
  })

  it('reads unchecked and checked task lines', () => {
    const md = ['- [ ] Buy milk {task:a1}', '- [x] Ship release {task:b2}'].join('\n')
    expect(scanTaskCheckboxStates(md)).toEqual(
      new Map([
        ['a1', false],
        ['b2', true]
      ])
    )
  })

  it('round-trips what serializeTaskBlock writes, including subtask indentation', () => {
    const md = [
      serializeTaskBlock({ taskId: 'parent', title: 'Parent', checked: false }),
      serializeTaskBlock({
        taskId: 'child',
        title: 'Child',
        checked: true,
        parentTaskId: 'parent'
      })
    ].join('\n')

    expect(scanTaskCheckboxStates(md)).toEqual(
      new Map([
        ['parent', false],
        ['child', true]
      ])
    )
  })

  it('tolerates other editors: any list marker, deep indent, uppercase X', () => {
    const md = ['* [X] Star {task:s1}', '+ [x] Plus {task:p1}', '      - [ ] Deep {task:d1}'].join(
      '\n'
    )
    expect(scanTaskCheckboxStates(md)).toEqual(
      new Map([
        ['s1', true],
        ['p1', true],
        ['d1', false]
      ])
    )
  })

  it('ignores non-checkbox lines that merely mention a task suffix', () => {
    const md = ['Some prose about {task:x9}', '- Bullet {task:y8}', '> [x] Quote {task:z7}'].join(
      '\n'
    )
    expect(scanTaskCheckboxStates(md).size).toBe(0)
  })

  it('ignores checkbox states other than space and x', () => {
    expect(scanTaskCheckboxStates('- [-] Half done {task:h1}').size).toBe(0)
  })
})

describe('parseTaskBlockSuffix with an Obsidian Tasks tail', () => {
  it('still finds the id after the plugin appends a done date', () => {
    expect(parseTaskBlockSuffix('Buy milk {task:abc} ✅ 2026-09-05')).toEqual({
      taskId: 'abc',
      title: 'Buy milk'
    })
  })

  it('still finds the id after the plugin appends a dataview completion field', () => {
    expect(parseTaskBlockSuffix('Buy milk {task:abc}  [completion:: 2026-09-05]')).toEqual({
      taskId: 'abc',
      title: 'Buy milk'
    })
  })

  it('leaves ordinary trailing prose alone so the line is not claimed', () => {
    expect(parseTaskBlockSuffix('Buy milk {task:abc} and eggs')).toBeNull()
  })

  it('reconciles a checkbox the plugin completed in Obsidian', () => {
    expect(scanTaskCheckboxStates('- [x] Buy milk {task:abc} ✅ 2026-09-05')).toEqual(
      new Map([['abc', true]])
    )
  })
})

describe('stripTaskBlockSuffixes', () => {
  it('turns task lines back into plain checkboxes and keeps every other byte', () => {
    const md = [
      '# Weekly review',
      '',
      '- [ ] Call the plumber {task:a1}',
      '  - [x] Book a slot {task:b2}',
      '* [ ] Other marker {task:c3}',
      'Prose that mentions {task:d4} stays.',
      '- [ ] plain checkbox'
    ].join('\n')

    expect(stripTaskBlockSuffixes(md)).toBe(
      [
        '# Weekly review',
        '',
        '- [ ] Call the plumber',
        '  - [x] Book a slot',
        '* [ ] Other marker',
        'Prose that mentions {task:d4} stays.',
        '- [ ] plain checkbox'
      ].join('\n')
    )
  })

  it('drops the empty suffix a task block that never got an id wrote', () => {
    expect(stripTaskBlockSuffixes('- [ ] Draft task {task:}')).toBe('- [ ] Draft task')
  })

  it('keeps an Obsidian Tasks tail that follows the suffix', () => {
    expect(stripTaskBlockSuffixes('- [x] Buy milk {task:abc} ✅ 2026-09-05')).toBe(
      '- [x] Buy milk ✅ 2026-09-05'
    )
  })

  it('keeps CRLF line endings and a missing final newline', () => {
    expect(stripTaskBlockSuffixes('- [ ] One {task:a}\r\n- [ ] Two {task:b}')).toBe(
      '- [ ] One\r\n- [ ] Two'
    )
  })

  it('returns the input unchanged when there is nothing to strip', () => {
    const md = '- [ ] Buy milk {task:abc} and then some prose'
    expect(stripTaskBlockSuffixes(md)).toBe(md)
  })
})

describe('normalizeTaskBlocks title from the source line', () => {
  // What the parser hands over for `- [ ] **Dune** [[Dune (2021)]] x {task:…}`:
  // the bold run is a styled text node and the wiki link a node with no text.
  function parsedCheckbox(taskId: string) {
    return {
      type: 'checkListItem',
      props: { checked: false },
      content: [
        { type: 'text', text: 'Dune', styles: { bold: true } },
        { type: 'text', text: ' ', styles: {} },
        { type: 'wikiLink', props: { target: 'Dune (2021)' } },
        { type: 'text', text: ` x {task:${taskId}}`, styles: {} }
      ]
    }
  }

  function titles(blocks: Array<{ props?: Record<string, unknown> }>): unknown[] {
    return blocks.map((block) => block.props?.title)
  }

  it('takes the title as the line spells it', () => {
    const { blocks } = normalizeTaskBlocks(
      [parsedCheckbox('t1')],
      '- [ ] **Dune** [[Dune (2021)]] x {task:t1}'
    )
    expect(titles(blocks)).toEqual(['**Dune** [[Dune (2021)]] x'])
  })

  it('keeps the plain text when there is no source', () => {
    const { blocks } = normalizeTaskBlocks([parsedCheckbox('t1')], null)
    expect(titles(blocks)).toEqual(['Dune  x'])
  })

  it('gives two lines naming one task their own titles, in order', () => {
    const source = '- [ ] **Dune** [[Dune (2021)]] x {task:t1}\n- [ ] _Dune_ x {task:t1}'
    const { blocks } = normalizeTaskBlocks([parsedCheckbox('t1'), parsedCheckbox('t1')], source)
    expect(titles(blocks)).toEqual(['**Dune** [[Dune (2021)]] x', '_Dune_ x'])
  })

  it("skips a source line whose text is not the block's own", () => {
    const source =
      '<!--\n- [ ] OLD COMMENT {task:t1}\n-->\n\n- [ ] **Dune** [[Dune (2021)]] x {task:t1}'
    const { blocks } = normalizeTaskBlocks([parsedCheckbox('t1')], source)
    expect(titles(blocks)).toEqual(['**Dune** [[Dune (2021)]] x'])
  })

  it('keeps the plain text when no source line matches the block', () => {
    const { blocks } = normalizeTaskBlocks([parsedCheckbox('t1')], '- [ ] Something else {task:t1}')
    expect(titles(blocks)).toEqual(['Dune  x'])
  })

  it('ignores a task line inside a code fence', () => {
    const source = '```\n- [ ] Dune `fenced` x {task:t1}\n```\n- [ ] **Dune** x {task:t1}'
    const { blocks } = normalizeTaskBlocks([parsedCheckbox('t1')], source)
    expect(titles(blocks)).toEqual(['**Dune** x'])
  })
})

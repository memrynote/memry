/**
 * Cases of task-block and obsidian-tasks: the `{task:<id>}` suffix, the task
 * tree rules and the Obsidian Tasks plugin's field syntax.
 */
import { CaseList } from './markers-support'

const run = (text: string, styles: Record<string, unknown> = {}): object => ({
  type: 'text',
  text,
  styles
})

const task = (
  id: string,
  children: object[] = [],
  extra: Record<string, unknown> = {}
): object => ({
  id: `b-${id}`,
  type: 'taskBlock',
  props: { taskId: id, title: `Task ${id}`, checked: false, parentTaskId: '', ...extra },
  children
})

const item = (
  text: string,
  children: object[] = [],
  props: Record<string, unknown> = {}
): object => ({
  id: `i-${text.length}`,
  type: 'checkListItem',
  props: { checked: false, ...props },
  content: [run(text)],
  children
})

const para = (text: string, children: object[] = []): object => ({
  type: 'paragraph',
  props: {},
  content: [run(text)],
  children
})

export const TASK_SUFFIX_TEXTS = [
  'Buy milk {task:abc}',
  'Buy milk {task:abc}   ',
  'Buy milk {task:abc}\t\n',
  'Buy milk {task:abc}\u00a0\ufeff',
  '{task:abc}',
  '  {task:abc}',
  'Buy milk {task:}',
  'Buy milk {task:}  ',
  'Buy milk {task: }',
  'Buy milk {task:a b}',
  'Buy milk {task:a}b}',
  'Buy milk {task:a} b',
  'Buy milk {task:a} trailing prose',
  'Buy milk {task:a} 📅 2026-01-01',
  'Buy milk {task:a} ⏫',
  'Buy milk {task:a} [due:: 2026-01-01]',
  'Buy milk {task:a} #tag',
  'Buy milk {task:a} #tag 📅 2026-01-01',
  'Buy milk {task:a} ^block-id',
  'Buy milk {task:a} 🆔 xyz',
  'Buy milk {task:a} ⛔ one,two',
  'Buy milk {task:a} 📅 2026-01-01 text',
  'Buy milk {task:a',
  'Buy milk task:a}',
  'Buy milk {task',
  '{task:a}{task:b}',
  '{task:a} {task:b}',
  '{task:a} {task:b} 📅 2026-01-01',
  'x {task:a} y {task:b}',
  'x {task:a}} ',
  'x {task:a}}',
  'x }{task:a}',
  'x {task:{task:a}',
  'x {task:a} }',
  'x {task:pcd_-_0nm}',
  '**Dune** [[Dune (2021)]] {task:abc}',
  '日本語 😀 {task:日本}',
  '😀 {task:a} 📅 2026-01-01',
  'tab\t{task:a}',
  '',
  '   ',
  '{task:'
]

function suffixCases(c: CaseList): void {
  c.each('taskBlock.parseTaskBlockSuffix', TASK_SUFFIX_TEXTS)
  const lines = [
    '- [ ] Buy milk {task:abc}',
    '- [x] Buy milk {task:abc}',
    '- [X] Buy milk {task:abc}',
    '* [ ] star {task:a}',
    '+ [x] plus {task:a}',
    '  - [ ] indented {task:a}',
    '\t- [ ] tabbed {task:a}',
    '\u00a0- [ ] nbsp {task:a}',
    '\ufeff- [ ] bom {task:a}',
    '- [ ]  double space {task:a}',
    '- [ ] ',
    '- [ ]',
    '-[ ] nospace {task:a}',
    '- [] empty {task:a}',
    '- [-] dash {task:a}',
    '- [/] slash {task:a}',
    '1. [ ] ordered {task:a}',
    '> - [ ] quoted {task:a}',
    '- [ ] Buy milk {task:}',
    '- [x] Buy milk {task:} ',
    '- [ ] Buy milk {task:a} 📅 2026-01-01',
    '- [ ] Buy milk {task:a} prose',
    '- [ ] Buy milk {task:a}\r',
    '- [ ] Buy milk {task:a}  \r',
    '- [ ] 😀 日本語 {task:a}',
    '- [ ] text only',
    'plain {task:a}',
    '- [ ] {task:a}',
    '- [ ] a {task:a} b {task:b}',
    '- [ ] a {task:a} 📅 2026-01-01 #tag'
  ]
  const docs = [
    ...lines,
    lines.slice(0, 6).join('\n'),
    lines.slice(0, 6).join('\r\n'),
    `${lines[0]}\n${lines[0]}\n${lines[1]}`,
    `${lines[1]}\n${lines[0]}`,
    '- [ ] one {task:a}\n\n```\n- [ ] fenced {task:b}\n```\n- [x] after {task:c}',
    '~~~\n- [ ] fenced {task:a}\n```\n- [ ] still {task:b}\n~~~\n- [ ] out {task:c}',
    '- [ ] top {task:a}\n  - [ ] child {task:b}\n    - [ ] grand {task:c}\n      - [ ] deep {task:d}',
    '- [ ] top {task:a}\n- [ ] sibling {task:b}\n  - [ ] child {task:c}',
    'no tasks here',
    '',
    '{task:a} without checkbox',
    '- [ ] a {task:a}\r\n- [x] b {task:b}\r\n',
    '- [ ] a {task:a}\u2028- [x] b {task:b}',
    '- [ ] a {task:a}\r- [x] b {task:b}'
  ]
  c.each('taskBlock.scanTaskCheckboxStates', docs)
  c.each('taskBlock.stripTaskBlockSuffixes', docs)
  c.each('taskBlock.stripTaskBlockSuffixes', [
    '- [ ] a {task:a} 📅 2026-01-01\n- [ ] b {task:}  \r\n  - [x] c {task:c}\t',
    '- [ ] a {task:a}\n\n- [ ] b {task:b}\n',
    'x {task:a}\n- [ ] {task:b}'
  ])
}

function serializeCases(c: CaseList): void {
  const props: Record<string, unknown>[] = [
    { taskId: 'a', title: 'T', checked: false },
    { taskId: 'a', title: 'T', checked: true },
    { taskId: 'a', title: 'T', checked: false, parentTaskId: 'p' },
    { taskId: 'a', title: 'T', checked: false, parentTaskId: '' },
    { taskId: '', title: 'Draft', checked: false },
    { title: 'No id', checked: true },
    { taskId: 'a', checked: false },
    { taskId: 'a', title: '', checked: false },
    { taskId: 'a', title: 'T' },
    { taskId: 5, title: 7, checked: 1 },
    { taskId: 'a', title: null, checked: 'x' },
    { taskId: 'a', title: ['x', null, 2], checked: 0 },
    { taskId: 'a', title: { a: 1 }, checked: [] },
    { taskId: 'a', title: 'multi\nline 😀 日本', checked: false, parentTaskId: 3 },
    { taskId: 0, title: 'zero', checked: false },
    { taskId: true, title: false, checked: false }
  ]
  c.each('taskBlock.serializeTaskBlock', props)
  c.each('taskBlock.extractInlineText', [
    'plain string',
    [run('a'), run('b', { bold: true })],
    [{ type: 'link', href: 'u', content: [run('in')] }, run('out')],
    ['str', run('x'), 5, null, { type: 'text' }, { type: 'text', text: 5 }, { text: 'no type' }],
    [[run('nested array')]],
    [],
    null,
    undefined,
    5,
    { type: 'text', text: 'obj' },
    [{ type: 'wikiLink', props: { target: 'x' } }]
  ])

  const trees: object[] = [
    task('a'),
    task('a', [task('b')], { title: 'A' }),
    task('a', [task('b', [task('c')])]),
    task('a', [task('b', [task('c', [task('d')])])]),
    task('a', [task('b', [task('c'), task('c2', [task('d')])]), task('b2', [task('c3')])]),
    task('a', [para('p'), task('b', [para('q'), task('c')])]),
    task('a', [task('b', [task('c')], { parentTaskId: 'zz' }), task('b2')], {
      parentTaskId: 'top'
    }),
    task('a', [para('p', [task('hidden', [task('hidden2')])])]),
    {
      type: 'taskBlock',
      props: { taskId: 'a', title: 'A', checked: true },
      children: [{ type: 'taskBlock', props: {}, children: [] }]
    },
    { type: 'taskBlock', props: { taskId: 'a', title: 'A', checked: true } },
    { type: 'taskBlock', props: { taskId: 'a', title: 'A', checked: true }, children: null },
    {
      type: 'taskBlock',
      props: { taskId: 'a', title: 'A' },
      children: [{ type: 'taskBlock', children: [{ type: 'taskBlock', props: { taskId: 'c' } }] }]
    },
    { type: 'taskBlock', children: [] },
    { type: 'taskBlock', props: null, children: [] },
    { type: 'paragraph', props: {}, children: [task('a', [task('b', [task('c')])])] },
    task('a', [task('b', [task('c')]), para('x'), task('d', [task('e', [task('f', [task('g')])])])])
  ]
  for (const tree of trees) {
    c.add('taskBlock.capTaskTreeDepth', [tree])
    c.add('taskBlock.serializeTaskBlockTree', [tree])
  }
}

function normalizeCases(c: CaseList): void {
  const sources: (string | null)[] = [
    null,
    '',
    '- [ ] Buy milk {task:abc}',
    '- [ ] Buy milk {task:other}',
    '- [ ] **Dune** [[Dune (2021)]] {task:abc}',
    '- [ ] a {task:a}\n  - [ ] b {task:b}\n    - [ ] c {task:c}',
    '- [ ] a {task:a}\n  - [ ] b {task:b}\n  - [ ] c {task:c}\n    - [ ] d {task:d}',
    '- [ ] a {task:a}\n\n```\n- [ ] fake {task:a}\n```\n- [ ] Buy milk {task:abc}',
    '- [ ] Buy milk {task:pcd_-_0nm}',
    '- [ ] Buy milk {task:pcd-0nm}',
    '<!--\n- [ ] Buy {task:abc}\n-->\n- [ ] Real Buy milk {task:abc}',
    '- [ ] a {task:a}\n- [ ] a again {task:a}',
    '- [ ] 日本語 😀 {task:abc}'
  ]
  const forests: object[][] = [
    [item('Buy milk {task:abc}')],
    [item('Buy milk {task:abc}', [], { checked: true })],
    [item('Buy milk {task:abc}', [], { isChecked: true })],
    [item('Buy milk {task:abc}', [], { checked: null, isChecked: true })],
    [item('Buy milk {task:abc}', [], { checked: null })],
    [{ type: 'checkListItem', content: [run('Buy milk {task:abc}')], children: [] }],
    [{ id: 'x', type: 'checkListItem', props: { checked: 'yes' }, content: [run('T {task:abc}')] }],
    [{ type: 'checkListItem', props: {}, content: [run('T {task:abc}')], id: null }],
    [item('Buy milk'), item('Buy milk {task:abc}'), item('Other {task:xyz}')],
    [item('Buy {task:abc} 📅 2026-01-01')],
    [item('Buy {task:abc} prose')],
    [item('{task:}')],
    [item('a {task:a}', [item('b {task:b}', [item('c {task:c}')])])],
    [item('a {task:a}', [item('b {task:b}', [item('c {task:c}', [item('d {task:d}')])])])],
    [item('a {task:a}', [item('b {task:b}'), item('c {task:c}', [item('d {task:d}')])])],
    [item('a {task:a}', [para('mid', [item('b {task:b}')])])],
    [item('a {task:a}', [item('plain child'), item('b {task:b}')])],
    [item('a plain', [item('b {task:b}')])],
    [para('p', [item('a {task:a}', [item('b {task:b}')])])],
    [{ type: 'bulletListItem', props: {}, content: [run('x')], children: [item('a {task:a}')] }],
    [task('a', [item('b {task:b}')])],
    [task('a', [task('b')]), item('c {task:c}')],
    [task('a'), para('x {task:y}')],
    [{ type: 'checkListItem', props: {}, content: 'Buy {task:abc}', children: [] }],
    [
      {
        type: 'checkListItem',
        props: {},
        content: [run('Buy '), run('milk', { bold: true }), run(' {task:abc}')]
      }
    ],
    [
      {
        type: 'checkListItem',
        props: {},
        content: [{ type: 'link', href: 'u', content: [run('x {task:abc}')] }]
      }
    ],
    [{ type: 'paragraph', props: {}, content: [run('no task')] }],
    [{ type: 'paragraph', props: { 'k{task:': 1 }, content: [] }],
    [{ type: 'taskBlock', props: { title: '{task:' }, children: [] }],
    []
  ]
  for (const blocks of forests) {
    for (const source of sources.slice(0, 3))
      c.add('taskBlock.normalizeTaskBlocks', [blocks, source])
  }
  for (const source of sources.slice(3)) {
    for (const blocks of [
      forests[0],
      forests[4],
      forests[12],
      forests[13],
      forests[14],
      forests[10]
    ]) {
      c.add('taskBlock.normalizeTaskBlocks', [blocks, source])
    }
  }
  c.add('taskBlock.normalizeTaskBlocks', [
    [item('Dune {task:abc}')],
    '- [ ] **Dune** [[Dune (2021)]] {task:abc}'
  ])
  c.add('taskBlock.normalizeTaskBlocks', [
    [item('A B {task:abc}')],
    '<!--\n- [ ] B A {task:abc}\n-->\n- [ ] A **B** {task:abc}\n'
  ])
  c.add('taskBlock.normalizeTaskBlocks', [
    [item('a {task:a}', [item('b {task:b}', [item('c {task:c}')])])],
    '- [ ] a {task:a}\n\n  - [ ] b {task:b}\n\n      - [ ] c {task:c}'
  ])
  c.add('taskBlock.normalizeTaskBlocks', [
    [item('a {task:a}', [item('b {task:b}', [item('c {task:c}', [item('d {task:d}')])])])],
    '- [ ] a {task:a}\n  - [ ] b {task:b}\n  - [ ] c {task:c}\n    - [ ] d {task:d}\n'
  ])
  c.add('taskBlock.normalizeTaskBlocks', [
    [item('a {task:a}', [item('b {task:b}'), item('c {task:c}')])],
    '- [ ] a {task:a}\n  - [ ] b {task:b}\n- [ ] c {task:c}'
  ])
  c.add('taskBlock.normalizeTaskBlocks', [
    [item('a {task:a}', [item('b {task:b}', [item('c {task:c}')])])],
    '- [ ] a {task:a}\n  - [ ] b {task:b}\n  - [ ] c {task:c}'
  ])
}

const OBSIDIAN_TEXTS = [
  '',
  'Buy milk',
  'Buy milk ⏫',
  'Buy milk 🔺',
  'Buy milk 🔼',
  'Buy milk 🔽',
  'Buy milk ⏬',
  'Buy milk ⏫\ufe0f',
  'Buy milk 📅 2026-01-01',
  'Buy milk 📅2026-01-01',
  'Buy milk 📅\ufe0f 2026-01-01',
  'Buy milk 📆 2026-01-01',
  'Buy milk 🗓 2026-01-01',
  'Buy milk 🗓\ufe0f 2026-01-01',
  'Buy milk ⏳ 2026-01-02',
  'Buy milk ⌛ 2026-01-02',
  'Buy milk 🛫 2026-01-03',
  'Buy milk ➕ 2026-01-04',
  'Buy milk ✅ 2026-01-05',
  'Buy milk ❌ 2026-01-06',
  'Buy milk 📅 2026-1-1',
  'Buy milk 📅 2026-01-01 extra',
  'Buy milk 🔁 every day',
  'Buy milk 🔁 every 3 days',
  'Buy milk 🔁 every week',
  'Buy milk 🔁 every 2 weeks when done',
  'Buy milk 🔁 every month',
  'Buy milk 🔁 every year',
  'Buy milk 🔁 every weekday',
  'Buy milk 🔁 every monday',
  'Buy milk 🔁 every Monday and wednesday',
  'Buy milk 🔁 every mon, wed, fri',
  'Buy milk 🔁 every tue and thu and sat',
  'Buy milk 🔁 every sun,sun,sat',
  'Buy milk 🔁 every , ,',
  'Buy milk 🔁 every funday',
  'Buy milk 🔁 every',
  'Buy milk 🔁 every  3   days',
  'Buy milk 🔁 EVERY DAY',
  'Buy milk 🔁 every 99999999999999999999 days',
  'Buy milk 🔁 every 1e3 days',
  'Buy milk 🔁 every 0 days',
  'Buy milk 🔁 every other day',
  'Buy milk 🔁 every 2 months on the 1st',
  'Buy milk 🔁 daily',
  'Buy milk 🏁 delete',
  'Buy milk 🏁 keep',
  'Buy milk 🆔 abc123',
  'Buy milk 🆔 a-b_c',
  'Buy milk ⛔ abc',
  'Buy milk ⛔ abc, def',
  'Buy milk ⛔ abc ,def , ghi ',
  'Buy milk ⛔ ',
  'Buy milk ⏫ 📅 2026-01-01',
  'Buy milk 📅 2026-01-01 ⏫',
  'Buy milk 🔁 every day ⏫ 📅 2026-01-01 ✅ 2026-01-02',
  'Buy milk ✅ 2026-01-02 📅 2026-01-01 ⏳ 2026-01-03 🛫 2026-01-04 ➕ 2026-01-05 ❌ 2026-01-06',
  'Buy milk ⏫ ⏫',
  'Buy milk ⏫ 🔽',
  'Buy milk 📅 2026-01-01 📅 2026-02-02',
  'Buy milk [due:: 2026-01-01]',
  'Buy milk (due:: 2026-01-01)',
  'Buy milk [due:: 2026-01-01)',
  'Buy milk (due:: 2026-01-01]',
  'Buy milk [due:: 2026-01-01],',
  'Buy milk [due:: 2026-01-01] ,',
  'Buy milk [due::2026-01-01]',
  'Buy milk [ due:: 2026-01-01 ]',
  'Buy milk  [due:: 2026-01-01]  [scheduled:: 2026-01-02]',
  'Buy milk [scheduled:: 2026-01-02]',
  'Buy milk [start:: 2026-01-03]',
  'Buy milk [created:: 2026-01-04]',
  'Buy milk [completion:: 2026-01-05]',
  'Buy milk [cancelled:: 2026-01-06]',
  'Buy milk [priority:: high]',
  'Buy milk [priority:: highest]',
  'Buy milk [priority:: medium]',
  'Buy milk [priority:: low]',
  'Buy milk [priority:: lowest]',
  'Buy milk [priority:: urgent]',
  'Buy milk [priority:: highx]',
  'Buy milk [repeat:: every day]',
  'Buy milk [repeat:: every 2 weeks when done]',
  'Buy milk [onCompletion:: delete]',
  'Buy milk [id:: abc]',
  'Buy milk [dependsOn:: abc,def]',
  'Buy milk [dependsOn:: abc, def ]',
  'Buy milk [due:: 2026-01-01] [priority:: high] [repeat:: every day]',
  'Buy milk [[wiki]] [due:: 2026-01-01]',
  'Buy milk [x] [due:: 2026-01-01]',
  'Buy milk [a] ] [due:: 2026-01-01]',
  'Buy milk ] [due:: 2026-01-01]',
  'Buy milk [due:: 2026-01-01] ]',
  'Buy milk (a) [due:: 2026-01-01]',
  'Buy milk 📅 2026-01-01 [priority:: high]',
  'Buy milk [priority:: high] 📅 2026-01-01',
  'Buy milk :: not a field',
  'Buy milk a::b',
  'Buy milk ^block-id',
  'Buy milk 📅 2026-01-01 ^block-id',
  'Buy milk ^block-id 📅 2026-01-01',
  'Buy milk ^',
  'Buy milk ^a b',
  'Buy milk^block',
  'Buy milk #tag',
  'Buy milk #tag1 #tag2',
  'Buy milk #Tag #tag #TAG',
  'Buy milk #İş #iş #İŞ',
  'Buy milk #ΟΔΟΣ #οδος #οδοσ',
  '#tag Buy milk',
  'Buy #tag milk',
  'Buy milk #tag/sub',
  'Buy milk #tag-with-dash_and_underscore',
  'Buy milk # notatag',
  'Buy milk #',
  'Buy milk #tag.dot',
  'Buy milk #a,b',
  'Buy milk #a#b',
  'Buy milk\t#tab',
  'Buy milk\u00a0#nbsp',
  'Buy milk\u2028#ls',
  'Buy milk #😀 #日本語',
  'Do it #tag1 📅 2026-01-01 #tag2',
  'Do it #tag1 [due:: 2026-01-01] #tag2',
  'Do it 📅 2026-01-01 #tag',
  '📅 2026-01-01 #tag',
  '📅 2026-01-01',
  '#tag',
  '⏫',
  '   ⏫   ',
  '\u2028⏫\u2029',
  'a\nb 📅 2026-01-01',
  'a 📅 2026-01-01\nb',
  'Buy milk ⏫ 📅 2026-01-01 ⏳ 2026-01-02 🛫 2026-01-03 ➕ 2026-01-04 ✅ 2026-01-05 ❌ 2026-01-06 🔁 every day 🏁 delete 🆔 abc ⛔ def',
  'Buy milk [priority:: high] [due:: 2026-01-01] [scheduled:: 2026-01-02] [start:: 2026-01-03] [created:: 2026-01-04] [completion:: 2026-01-05] [cancelled:: 2026-01-06] [repeat:: every day] [onCompletion:: delete] [id:: abc] [dependsOn:: def]',
  '日本語 😀 📅 2026-01-01 🔽',
  '📅 2026-01-01 📅 2026-01-02 📅 2026-01-03 📅 2026-01-04 📅 2026-01-05 📅 2026-01-06 📅 2026-01-07 📅 2026-01-08 📅 2026-01-09 📅 2026-01-10 📅 2026-01-11 📅 2026-01-12 📅 2026-01-13 📅 2026-01-14 📅 2026-01-15 📅 2026-01-16 📅 2026-01-17 📅 2026-01-18 📅 2026-01-19 📅 2026-01-20 📅 2026-01-21 📅 2026-01-22 📅 2026-01-23',
  'x ⏫ #a ⏫ #b ⏫ #c',
  'x [due:: 2026-01-01] #a [due:: 2026-01-02] #b'
]

const OBSIDIAN_LINES = [
  '- [ ] Buy milk 📅 2026-01-01 ⏫',
  '- [x] Done ✅ 2026-01-02',
  '- [X] Done upper',
  '- [/] In progress',
  '- [-] Cancelled',
  '- [?] Question',
  '- [ ] ',
  '- [ ]',
  '-  [ ]  two spaces',
  '* [ ] star',
  '+ [ ] plus',
  '1. [ ] ordered',
  '12) [ ] paren',
  '1.[ ] nospace',
  '  - [ ] indented',
  '\t- [ ] tabbed',
  '> - [ ] quoted',
  '> > - [ ] double quoted',
  ' \t > - [ ] mixed',
  '\u00a0- [ ] nbsp',
  '\ufeff- [ ] bom',
  '- [😀] emoji status',
  '- [é] accent status',
  '- [\u00a0] nbsp status',
  '- [ ] [due:: 2026-01-01]',
  '- [ ] Buy milk ^block-id',
  '- [ ] Buy milk 🆔 abc ⛔ def',
  '- [ ] Buy milk {task:abc} 📅 2026-01-01',
  '- [ ] a\u2028b',
  '- [ ] a\rb',
  '- [ ] a\nb',
  '-[ ] nospace',
  '- [] empty',
  '- [ ]x',
  '- [ ] 日本語 😀 #tag',
  '- text',
  'plain text',
  '',
  '[ ] no marker',
  '- [ ] Buy milk 📅 2026-01-01\r'
]

function obsidianCases(c: CaseList): void {
  c.each('obsidianTasks.hasObsidianTaskFields', OBSIDIAN_TEXTS)
  c.each('obsidianTasks.parseObsidianTaskFields', OBSIDIAN_TEXTS)
  c.each('obsidianTasks.obsidianTaskImportBlocker', OBSIDIAN_TEXTS)
  c.each('obsidianTasks.parseObsidianTaskLine', OBSIDIAN_LINES)
  c.each('obsidianTasks.hasObsidianTaskFields', [
    'plain',
    'a:b',
    'a::b',
    '^x',
    ' ^x',
    'x ^x',
    'x ^x y',
    '#x',
    'x #x',
    'x#x',
    'x\u00a0#x',
    'x # y',
    '🔺',
    '⏬',
    '🛫',
    '➕',
    '⏳',
    '⌛',
    '📅',
    '📆',
    '🗓',
    '✅',
    '❌',
    '🔁',
    '🏁',
    '⛔',
    '🆔',
    '😀',
    '日本語'
  ])
}

export function taskCases(): CaseList[] {
  const tasks = new CaseList('task-block')
  suffixCases(tasks)
  serializeCases(tasks)
  normalizeCases(tasks)
  const obsidian = new CaseList('obsidian-tasks')
  obsidianCases(obsidian)
  return [tasks, obsidian]
}

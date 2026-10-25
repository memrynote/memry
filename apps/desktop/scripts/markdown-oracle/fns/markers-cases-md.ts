/**
 * Markdown-driven cases of the `markers` layer: hand-written notes that hold
 * the constructs the layer reads (task lines, color spans, tables) and the
 * shared markdown corpus. A source is fed to a function only when it holds
 * something the function acts on, plus every 40th source as a no-op control,
 * so the vector file stays small.
 */
import type { MarkdownSource } from '../cases-bn'
import { CaseList } from './markers-support'

const HAND: string[] = [
  '- [ ] Buy milk {task:abc}',
  '- [x] Done {task:abc}\n- [ ] Open {task:def}',
  '- [ ] **Dune** [[Dune (2021)]] {task:abc}',
  '- [ ] Buy milk {task:pcd_-_0nm}',
  '- [ ] Buy milk {task:a_b_c}',
  '- [ ] a {task:a}\n  - [ ] b {task:b}\n    - [ ] c {task:c}',
  '- [ ] a {task:a}\n  - [ ] b {task:b}\n  - [ ] c {task:c}\n    - [ ] d {task:d}',
  '- [ ] a {task:a}\n    - [ ] b {task:b}\n        - [ ] c {task:c}',
  '- [ ] a {task:a}\n- [ ] b {task:b}\n  - [ ] c {task:c}',
  '- [ ] a {task:a}\n  text\n  - [ ] b {task:b}',
  '- item\n  - [ ] nested task {task:abc}',
  '1. [ ] ordered {task:abc}',
  '* [ ] star {task:abc}\n+ [x] plus {task:def}',
  '- [ ] Buy milk {task:abc} 📅 2026-01-01',
  '- [ ] Buy milk {task:abc} prose',
  '- [ ] Buy milk {task:}',
  '- [ ] a {task:a}\n\n```\n- [ ] fenced {task:b}\n```\n\n- [ ] c {task:c}',
  '- [ ] Buy {task:abc}\n\n<!--\n- [ ] Buy {task:abc}\n-->',
  '    - [ ] indented code {task:abc}',
  '> - [ ] quoted {task:abc}',
  '- [ ] 日本語 😀 {task:abc}',
  '- [ ] dup {task:a}\n- [ ] dup {task:a}',
  '- [ ] Passport {check}\n- [ ] Visa {check}\n- [x] Tickets {check}',
  '- [ ] Passport {check}\n  - [ ] copy {check}\n  - [ ] plain child',
  '- [ ] {check}',
  '- [ ] **bold** {check}',
  '- [ ] **bold {check}**',
  '- [ ] link [a](b) {check}',
  '- [ ] Buy milk {task:abc} {check}',
  '- [ ] Passport {check} {task:abc}',
  '- item {check}\n- [ ] item {check}',
  'a <span style="color:red">red</span> b',
  '<span style="color:red">**bold red**</span> and *<span style="background-color:blue">blue</span>*',
  '<span style="text-decoration:underline">under</span>',
  '<span style="color:red"><span style="text-decoration:underline">both</span></span>',
  '<span style="color:red;text-decoration:underline">merged</span>',
  '<span style="color:red">a</span><span style="color:red">b</span>',
  '<span style="color:red">a **b** c</span>',
  '<span style="color:red">multi\nline</span>',
  '`<span style="color:red">code</span>` <span style="color:blue">x</span>',
  '```\n<span style="color:red">code</span>\n```\n\n<span style="color:blue">x</span>',
  '    <span style="color:red">indented code</span>',
  '# <span style="color:red">heading</span>',
  '- <span style="color:red">item</span>\n  - <span style="color:blue">child</span>',
  '> <span style="color:red">quote</span>',
  '| a | b |\n|---|---|\n| <span style="color:red">x</span> | y |',
  '[<span style="color:red">link</span>](https://x.y)',
  '[[Wiki]] <span style="color:red">[[Wiki]]</span>',
  '<span style="color:red">[[Wiki|alias]]</span>',
  '<span style="color:red">unclosed',
  'closed</span> only',
  '<span style="color:red;font-size:9px">unknown decl</span>',
  '<span style="color:red">MEMRYICO0:literal:MEMRYICC;</span>',
  'MEMRYICO0:no span:MEMRYICC;',
  '| a | b | c |\n|:--|:-:|--:|\n| 1 | 2 | 3 |',
  '| a | b |\n|---|---|\n| 1 | 2 |',
  '| a |\n|:-:|\n| 1 |',
  '<!-- align:center -->\ncentered',
  '<!-- colors:{"textColor":"red"} -->\ncolored',
  '<!-- table-align:{"0:0":"center"} -->\n| a |\n|---|\n| b |',
  '[[A]]\n\n<!-- link-card:{"size":"small"} -->\n[[B]]',
  'plain paragraph'
]

const INTERESTING = [
  '{task:',
  '{check}',
  '- [ ]',
  '- [x]',
  '<span',
  '</span>',
  '<!--',
  '|---',
  '| ---',
  ':--',
  '[['
]

function relevant(markdown: string): boolean {
  return INTERESTING.some((needle) => markdown.includes(needle))
}

/** Hand notes, every relevant corpus source and every 40th other one. */
function sources(external: MarkdownSource[]): string[] {
  const picked = external.filter((s, i) => relevant(s.markdown) || i % 40 === 0)
  return [...HAND, ...picked.map((s) => s.markdown)]
}

/** Slugs carry the source index, so ids stay unique and stable. */
function named(list: CaseList, fn: string, md: string, i: number): void {
  list.add(fn, [md], `src-${String(i).padStart(4, '0')}`)
}

export function markdownCases(external: MarkdownSource[]): CaseList[] {
  const tasks = new CaseList('task-block')
  const plain = new CaseList('plain-checkbox')
  const inline = new CaseList('inline-colors')
  const markers = new CaseList('block-markers')
  const all = sources(external)
  all.forEach((md, i) => {
    named(tasks, 'taskBlock.normalizeFromMarkdown', md, i)
    named(markers, 'blockMarkers.linesFromMarkdown', md, i)
    if (md.includes('{task:') || md.includes('- [') || i < HAND.length) {
      named(tasks, 'taskBlock.normalizeFromMarkdownNoSource', md, i)
      named(tasks, 'taskBlock.serializeTreesFromMarkdown', md, i)
      named(tasks, 'taskBlock.scanTaskCheckboxStates', md, i)
      named(tasks, 'taskBlock.stripTaskBlockSuffixes', md, i)
      named(plain, 'plainCheckbox.pipelineFromMarkdown', md, i)
    }
    if (md.includes('<span') || md.includes('</span>') || i < HAND.length) {
      named(inline, 'inlineColors.pipelineFromMarkdown', md, i)
      named(inline, 'inlineColors.maskInlineColorSpans', md, i)
      named(inline, 'inlineColors.stripInlineStyleSpanTags', md, i)
    }
  })
  return [tasks, plain, inline, markers]
}

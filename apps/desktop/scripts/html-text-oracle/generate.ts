/**
 * Generates `html-text.json` by running Electron's HTML block reader
 * (`src/main/file-text/html-text.ts`) in place as the oracle.
 *
 *   pnpm --filter @memry/desktop vectors:html-text          # write the file
 *   pnpm --filter @memry/desktop vectors:html-text:check    # regenerate in memory, diff, write nothing
 *
 * The file lives in `packages/contracts/test-vectors/`; the Rust port
 * (`crates/memry-desktop/src/services/file_text/html.rs`) reproduces every case.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { readHtmlText } from '../../src/main/file-text/html-text'

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const PATH = join(resolve(appRoot, '../../packages/contracts/test-vectors'), 'html-text.json')

const CASES: Array<{ name: string; html: string }> = [
  {
    name: 'hidden elements and comments',
    html:
      '<style>p::after { content: "styled away" }</style><p>Visible <em>words</em></p>' +
      '<script type="module">document.body.append("scripted away")</script>' +
      '<noscript>Fallback away</noscript><template><p>Template away</p></template>' +
      '<!-- comment away -->'
  },
  {
    name: 'blocks, cells, breaks and entities',
    html:
      '<ul><li>First&amp;one</li><li>Second</li></ul>' +
      '<table><tr><td>Cell&nbsp;a</td><td>Cell b</td></tr></table>Line one<br>Line two'
  },
  {
    name: 'code, pre, kbd and samp',
    html:
      '<p>Write <code>[[Inline Code]]</code> or <kbd>[[Typed Keys]]</kbd>, see ' +
      '<samp>[[Sample Output]]</samp>.</p><pre><code>let a = "`"\n[[Fenced Code]]\n```</code></pre>' +
      '<p>Then [[Visible Link]].</p>'
  },
  { name: 'a fragment', html: 'Plain [[Linked Note]] text' },
  { name: 'empty', html: '' },
  { name: 'whitespace only', html: ' \n\t <p>  </p> ' },
  {
    name: 'a full document with head',
    html:
      '<!doctype html><html><head><title>Head title</title><meta charset="utf-8"></head>' +
      '<body><h1>Heading</h1><p>Body text</p></body></html>'
  },
  {
    name: 'noscript in head with a paragraph',
    html: '<html><head><noscript><p>Head fallback</p></noscript></head><body>b</body></html>'
  },
  {
    name: 'svg and math elements are not html blocks',
    html: '<svg><style>svg style</style><p>in svg</p></svg>after<math><mi>x</mi></math>'
  },
  { name: 'code with backticks at the ends', html: '<code>`tick`</code> and <code>a``b</code>' },
  { name: 'code with only whitespace', html: 'a<code>  \n </code>b<pre>\n\n</pre>c' },
  { name: 'code with a br and hidden child', html: '<code>one<br>two<script>no</script></code>' },
  {
    name: 'pre keeps inner lines and trims outer newlines',
    html: '<pre>\n\nline 1\n  line 2\n\n</pre>'
  },
  { name: 'pre with a long backtick run', html: '<pre>a ```` b</pre>' },
  {
    name: 'nested blocks collapse breaks',
    html: '<div><div><p>deep</p></div></div><section>next</section>'
  },
  {
    name: 'inline elements run together',
    html: '<span>a</span><b>b</b><i>c</i> <a href="#">d</a>'
  },
  { name: 'misnested formatting is reconstructed', html: '<b>bold<p>para</b>tail</p>' },
  { name: 'table foster parenting', html: '<table>loose<tr><td>cell</td></tr></table>' },
  {
    name: 'unicode whitespace',
    html: '<p>a\u00a0\u2003b\u3000c\ufeffd</p><code>x\u00a0\u2028y</code>'
  },
  { name: 'cdata in svg', html: '<svg><![CDATA[raw <text>]]></svg>' },
  { name: 'invalid tags and attributes', html: '<p class=x id="y">ok<//p><p<>q</p>' },
  {
    name: 'textarea and title in body',
    html: '<textarea>typed</textarea><title>body title</title>'
  },
  {
    name: 'iframe and object fallback',
    html: '<iframe>frame text</iframe><object>object text</object>'
  },
  { name: 'details and summary', html: '<details><summary>Sum</summary>Hidden body</details>' },
  { name: 'hr and dl', html: 'a<hr>b<dl><dt>term</dt><dd>def</dd></dl>' },
  { name: 'replacement characters', html: 'a\u0000b<p>\ufffdc</p>' }
]

async function render(): Promise<string> {
  const cases: Array<{ name: string; html: string; text: string }> = []
  for (const item of CASES) cases.push({ ...item, text: await readHtmlText(item.html) })
  const document = {
    meta: {
      spec: 'tauri-v2-3542-html-text',
      oracle:
        'apps/desktop/scripts/html-text-oracle (Electron src/main/file-text/html-text.ts run in place)',
      caseCount: cases.length
    },
    cases
  }
  return `${JSON.stringify(document, null, 2)}\n`
}

async function main(): Promise<void> {
  const fresh = await render()
  if (!process.argv.includes('--check')) {
    writeFileSync(PATH, fresh, 'utf8')
    process.stdout.write(`wrote ${PATH}\n`)
    return
  }
  let committed = ''
  try {
    committed = readFileSync(PATH, 'utf8')
  } catch {
    committed = ''
  }
  if (committed !== fresh) {
    process.stderr.write(
      'vectors:html-text:check failed: html-text.json is missing or regenerates differently.\n' +
        'Regenerate with `pnpm --filter @memry/desktop vectors:html-text`.\n'
    )
    process.exit(1)
  }
  process.stdout.write('vectors:html-text:check passed\n')
}

void main()

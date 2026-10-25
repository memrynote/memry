/** Hand-written `blocks` cases: toggle, file marker, image embeds and youtube. */
import type { Builder } from './blocks-builder'

const TOGGLES: string[] = [
  '<details data-memry-toggle>\n<summary>S</summary>\n\nbody\n\n</details>',
  '<details data-memry-toggle open>\n<summary>S</summary>\n\nbody\n\n</details>',
  '<details data-memry-toggle>\n<summary>S</summary>\n</details>',
  '<details  data-memry-toggle   open >\n<summary>S</summary>\n</details>',
  '<details\tdata-memry-toggle\topen>\n<summary>S</summary>\n</details>',
  '<details\u00a0data-memry-toggle>\n<summary>S</summary>\n</details>',
  '<details data-memry-toggle open  >\n<summary>S</summary>\n</details>',
  '<details data-memry-toggle opened>\n<summary>S</summary>\n</details>',
  '<details data-memry-toggle closed>\n<summary>S</summary>\n</details>',
  '<details data-memry-toggle-x>\n<summary>S</summary>\n</details>',
  '<detailsdata-memry-toggle>\n<summary>S</summary>\n</details>',
  '<DETAILS data-memry-toggle>\n<summary>S</summary>\n</details>',
  '  <details data-memry-toggle>\n<summary>S</summary>\n</details>',
  '<details data-memry-toggle>\n  <summary>  S  </summary>\n  </details>',
  '<details data-memry-toggle>\n<summary></summary>\n</details>',
  '<details data-memry-toggle>\n<summary>a</b></summary>\n</details>',
  '<details data-memry-toggle>\n<summary>a\u2028b</summary>\n</details>',
  '<details data-memry-toggle>\n<summary>a\rb</summary>\n</details>',
  '<details data-memry-toggle>\n<summary>S\r</summary>\r\n</details>',
  '<details data-memry-toggle>\r\n<summary>S</summary>\r\n\r\nbody\r\n\r\n</details>',
  '<details data-memry-toggle>\n\n<summary>S</summary>\n</details>',
  '<details data-memry-toggle>\n<summary>S</summary>',
  '<details data-memry-toggle>\n<summary>S</summary>\n\nbody',
  '<details data-memry-toggle>',
  '<details data-memry-toggle>\nnot a summary\n</details>',
  '<details>\n<summary>S</summary>\nbody\n</details>',
  '<details open>\n<summary>S</summary>\nbody\n</details>',
  '<details class="x" id=y>\n<summary>S</summary>\nbody\n</details>',
  '<details\n<summary>S</summary>\n</details>',
  '<details a>b>\n<summary>S</summary>\n</details>',
  '</details>',
  '<summary>S</summary>',
  '  </details>',
  '  <summary>S</summary>',
  '</details> trailing',
  '<summary>a</summary> trailing',
  '<summary>a</summary></summary>',
  '<summary></summary>',
  '<summary>a\rb</summary>',
  '<summary>a\u2028b</summary>',
  '<details data-memry-toggle>\n<summary>Outer</summary>\n\n<details data-memry-toggle>\n<summary>Inner</summary>\n\nx\n\n</details>\n\n</details>',
  '<details data-memry-toggle>\n<summary>Outer</summary>\n\n<details>\n<summary>Foreign</summary>\nx\n</details>\n\n</details>',
  '<details data-memry-toggle>\n<summary>Outer</summary>\n\n<details class="a">\nunclosed\n\n</details>',
  '<details data-memry-toggle>\n<summary>S</summary>\n\n```\n</details>\n```\n\n</details>',
  '<details data-memry-toggle>\n<summary>S</summary>\n\n~~~\n</details>\n~~~\n\n</details>',
  '<details data-memry-toggle>\n<summary>S</summary>\n\n```\nunclosed fence\n</details>',
  '```\n<details data-memry-toggle>\n<summary>S</summary>\n</details>\n```',
  '~~~\n<details data-memry-toggle>\n<summary>S</summary>\n</details>\n~~~',
  '````\n```\n<details data-memry-toggle>\n<summary>S</summary>\n</details>\n````',
  '```\n<details>\n```\n<details>',
  'before\n\n<details data-memry-toggle>\n<summary>S</summary>\nx\n</details>\n\nafter',
  'before\n<details data-memry-toggle>\n<summary>S</summary>\nx\n</details>\nafter',
  '\n\n\n<details data-memry-toggle>\n<summary>S</summary>\n</details>',
  '<details data-memry-toggle>\n<summary>S</summary>\n</details>\n\n\n\n',
  '<details data-memry-toggle>\n<summary>A</summary>\n</details>\n\n\n\n<details data-memry-toggle>\n<summary>B</summary>\n</details>',
  '<details data-memry-toggle>\n<summary>A</summary>\n</details>\n\n<details data-memry-toggle>\n<summary>B</summary>\n</details>',
  '<details data-memry-toggle>\n<summary>A</summary>\n</details>\n<details data-memry-toggle>\n<summary>B</summary>\n</details>',
  'text\n\n\n\n<details data-memry-toggle>\n<summary>S</summary>\n</details>\n\n\n\n\ntail',
  'text\n   \n \t \n<details data-memry-toggle>\n<summary>S</summary>\n</details>',
  'text\n\u00a0\n\u00a0\n<details data-memry-toggle>\n<summary>S</summary>\n</details>',
  '<!-- colors:{"textColor":"red"} -->\n<details data-memry-toggle>\n<summary>S</summary>\n</details>',
  '<!-- colors:{"textColor":"red"} -->\n\n\n<details data-memry-toggle>\n<summary>S</summary>\n</details>',
  'text\n<!-- colors:{"textColor":"red"} -->\n<details data-memry-toggle>\n<summary>S</summary>\n</details>',
  '  <!-- colors:{"textColor":"red"} -->  \n<details data-memry-toggle>\n<summary>S</summary>\n</details>',
  '<!-- colors:{} -->\n<details data-memry-toggle>\n<summary>S</summary>\n</details>',
  '<!-- colors:{"a":{"b":1}} -->\n<details data-memry-toggle>\n<summary>S</summary>\n</details>',
  '<!-- colors:{"a":1} -->x\n<details data-memry-toggle>\n<summary>S</summary>\n</details>',
  '<!-- colors:{"a":1} -->\n\n<details data-memry-toggle>\n<summary>S</summary>\n</details>',
  '<!-- colors:{"a":1} -->\n<details data-memry-toggle open>\n<summary>S</summary>\nbody\n</details>\n<!-- colors:{"b":2} -->\n<details data-memry-toggle>\n<summary>T</summary>\n</details>',
  '<details data-memry-toggle>\n<summary>S</summary>\n\n- a\n- b\n\n> quote\n\n</details>',
  '<details data-memry-toggle>\n<summary>S</summary>\n\n\n\nbody with gaps\n\n\n\n</details>',
  '<details data-memry-toggle>\n<summary>日本語 😀</summary>\n\n本文 😀\n\n</details>',
  '<details>\n<summary>unclaimed</summary>\n</details>\nnext',
  '  <details>\n  <summary>indented</summary>\n  </details>',
  '<details data-memry-toggle>\n<summary>S</summary>\n</details>\n</details>',
  '</details>\n<details data-memry-toggle>\n<summary>S</summary>\n</details>',
  '<details data-memry-toggle>\n<summary>a</summary>\n<details data-memry-toggle>\n<summary>b</summary>\n</details>',
  '<details data-memry-toggle>\n<summary>a</summary>\n<details data-memry-toggle>',
  'C:\\<path>\n<summary>C:\\<path></summary>',
  'MEMRYDLT;details>\n<summary>x</summary>',
  '',
  '\n',
  '   ',
  'only text'
]

function toggleCases(b: Builder): void {
  const summaries = [
    'S',
    '',
    'a\nb',
    ' a \n  b  \n',
    '\n\n',
    'a\r\nb',
    'a\u00a0\n\u00a0b',
    '日本語\n😀',
    '<b>x</b>'
  ]
  const bodies = ['', 'body', '\n\nbody\n\n', ' \n ', 'a\n\nb', '  indented\n', '日本語']
  for (const summary of summaries) {
    b.add('toggle.serialize', summary, 'body', null, false)
    b.add('toggle.serialize', summary, '', null, true)
  }
  for (const body of bodies) {
    b.add('toggle.serialize', 'S', body, null, false)
    b.add('toggle.serialize', 'S', body, '<!-- colors:{"a":1} -->', true)
  }
  b.add('toggle.serialize', 'S', 'x', '', false)
  for (const text of TOGGLES) b.add('toggle.split', text)
  const restores = [
    '',
    'plain',
    'MEMRYDLT;details>',
    'MEMRYDLT;MEMRYDLT;',
    'aMEMRYDLT;bMEMRYDLT;c',
    'MEMRYDLT',
    'MEMRYDLT; MEMRYDLT;',
    '<details>',
    '日本語MEMRYDLT;😀'
  ]
  restores.forEach((text) => b.add('toggle.restore', text))
}

const FILE_MARKERS: string[] = [
  '<!-- file:{"url":"u","name":"n","size":1,"mimeType":"m"} -->',
  '<!-- file:{"url":"u","name":"n","size":1,"mimeType":"m","width":720} -->',
  '<!-- file:{"url":"u","name":"n","size":1,"mimeType":"m","display":"link"} -->',
  '<!-- file:{"url":"u","name":"n","size":1,"mimeType":"m","display":"embed"} -->',
  '<!-- file:{"url":"u","name":"n","size":1,"mimeType":"m","display":"other"} -->',
  '<!-- file:{"url":"u","name":"n","size":1,"mimeType":"m","display":null} -->',
  '<!-- file:{"display":"link","url":"u"} -->',
  '<!-- file:{"display":"x"} -->',
  '<!-- file:{"a":1,"a":2} -->',
  '<!-- file:{"a":1,"display":"link","a":3,"display":"x"} -->',
  '<!-- file:{"url":"a\\u003eb"} -->',
  '<!-- file:{"url":"a--\\u003eb"} -->',
  '<!-- file:{"n":1.0,"m":0,"e":1E2,"f":1.5e-3} -->',
  '<!-- file:{"s":"日本語 😀"} -->',
  '<!-- file:{"s":"line\\nbreak\\ttab\\u0001"} -->',
  '<!-- file:{"s":"quote\\"back\\\\slash"} -->',
  '<!-- file:{"url":"u","name":"n","size":1,"mimeType":"m"} -->\n',
  '<!-- file:{"url":"u"} --> ',
  ' <!-- file:{"url":"u"} -->',
  '<!--file:{"url":"u"} -->',
  '<!-- file:{"url":"u"}-->',
  '<!-- file: {"url":"u"} -->',
  '<!-- file:{"url":"u"}  -->',
  '<!-- file:{} -->',
  '<!-- file:{ } -->',
  '<!-- file:{"a":{"b":1}} -->',
  '<!-- file:{"a":"}"} -->',
  '<!-- file:{"a":"x" -->',
  '<!-- file:{"a":} -->',
  '<!-- file:{a:1} -->',
  "<!-- file:{'a':1} -->",
  '<!-- file:{"a":1,} -->',
  '<!-- file:{"a":[1,2,3]} -->',
  '<!-- file:{"a":true,"b":null} -->',
  '<!-- file:{"a":\n1} -->',
  '<!-- file:{"a":1}\n -->',
  '<!-- file:[1] -->',
  '<!-- File:{"a":1} -->',
  '<!-- file:{"a":1} --> trailing',
  '<!-- file:{"a":1} -->\r',
  '<!-- file:{"a":"\u2028"} -->',
  '<!-- file:{"url":"u"} --><!-- file:{"url":"v"} -->',
  '<!-- file:{<!-- file:{<!-- file:{ -->',
  '',
  'plain text'
]

function fileCases(b: Builder): void {
  for (const marker of FILE_MARKERS) {
    b.add('file.parse', marker)
    b.add('file.isLine', marker)
  }
  const base = { url: 'u', name: 'n', size: 1, mimeType: 'm' }
  const props: Record<string, unknown>[] = [
    base,
    { ...base, width: 720 },
    { ...base, width: 720.5, height: 300 },
    { ...base, width: 0, height: 0 },
    { ...base, width: -5, height: -5 },
    { ...base, height: 10 },
    { ...base, align: 'left' },
    { ...base, align: 'center' },
    { ...base, align: 'right' },
    { ...base, align: 'justify' },
    { ...base, align: '' },
    { ...base, display: 'link' },
    { ...base, display: 'embed' },
    { ...base, display: 'other' },
    { ...base, width: 1, height: 2, align: 'right', display: 'link' },
    { ...base, size: 0 },
    { ...base, size: 1.5 },
    { ...base, size: -3 },
    { ...base, size: 1e21 },
    { ...base, size: 1e-7 },
    { ...base, size: 123456789012 },
    { ...base, size: 0.1 },
    { ...base, size: 100000000000000000000 },
    { ...base, name: 'a-->b.pdf' },
    { ...base, name: 'a--!>b.pdf' },
    { ...base, name: 'a--->b' },
    { ...base, name: 'a---!>b' },
    { ...base, name: '-->-->' },
    { ...base, name: '--' },
    { ...base, name: '--!' },
    { ...base, name: 'a->b' },
    { ...base, name: 'q"uote\\back' },
    { ...base, name: 'tab\there\nnew\rret\u0001\u001f\b\f' },
    { ...base, name: 'del\u007f nbsp\u00a0 sep\u2028\u2029' },
    { ...base, name: '日本語 😀 é' },
    { ...base, url: 'https://x.test/a b?c=d&e=f#g', mimeType: 'application/pdf' },
    { ...base, url: '', name: '', mimeType: '' }
  ]
  for (const p of props) {
    b.add('file.serialize', p)
    b.add('file.commentData', p)
  }
}

const EMBED_LINES: string[] = [
  '![bookmark](https://example.com)',
  '![bookmark](https://example.com/a b)',
  '![bookmark](a)b)',
  '![bookmark]()',
  '![bookmark](x)\n',
  '![bookmark](x) ',
  ' ![bookmark](x)',
  '![bookmark](x))',
  '![bookmark](  )',
  '![Bookmark](x)',
  '![bookmark](日本語 😀)',
  '![bookmark](a\nb)',
  '![bookmark](a\r)',
  '![](https://youtu.be/dQw4w9WgXcQ)',
  '![embed](https://youtu.be/dQw4w9WgXcQ)',
  '![Embedded YouTube video](https://www.youtube.com/watch?v=dQw4w9WgXcQ)',
  '![embed](https://www.youtube.com/embed/dQw4w9WgXcQ)',
  '![embed](https://www.youtube.com/shorts/dQw4w9WgXcQ)',
  '![embed](https://youtube.com/watch?v=dQw4w9WgXcQ&t=1s)',
  '![bookmark](https://youtu.be/dQw4w9WgXcQ)',
  '![whiteboard](https://youtu.be/dQw4w9WgXcQ)',
  '![a]b](https://youtu.be/dQw4w9WgXcQ)',
  '![a\nb](https://youtu.be/dQw4w9WgXcQ)',
  '![a\rb](https://youtu.be/dQw4w9WgXcQ)',
  '![日本語 😀](https://youtu.be/dQw4w9WgXcQ)',
  '![alt](https://youtu.be/dQw4w9WgXcQ )',
  '![alt](https://youtu.be/dQw4w9WgXcQ\u00a0)',
  '![alt](https://youtu.be/dQw4w9WgXcQ\u2028)',
  '![alt](https://youtu.be/dQw4w9WgXcQ)\n',
  ' ![alt](https://youtu.be/dQw4w9WgXcQ)',
  '![alt](https://youtu.be/dQw4w9WgXcQ) tail',
  '![alt](https://youtu.be/dQw4w9WgXcQ))',
  '![alt]()',
  '![alt](https://example.com/photo.png)',
  '![alt](https://vimeo.com/123)',
  '!alt](https://youtu.be/dQw4w9WgXcQ)',
  '![alt]https://youtu.be/dQw4w9WgXcQ',
  '![alt] (https://youtu.be/dQw4w9WgXcQ)',
  '[alt](https://youtu.be/dQw4w9WgXcQ)',
  '![whiteboard](memry://canvas/abc123)',
  '![whiteboard](memry://canvas/AbC_-9)',
  '![whiteboard](memry://canvas/)',
  '![whiteboard](memry://canvas/a b)',
  '![whiteboard](memry://canvas/a.b)',
  '![whiteboard](memry://canvas/é)',
  '![whiteboard](memry://canvas/a/b)',
  '![whiteboard](memry://canvas/abc)\n',
  '![whiteboard](memry://canvas/abc) ',
  '![Whiteboard](memry://canvas/abc)',
  '![whiteboard](memry://other/abc)',
  '![whiteboard](MEMRY://canvas/abc)',
  '![whiteboard](memry://canvas/abc))',
  '![embed](memry://canvas/abc)',
  '',
  'text'
]

const YOUTUBE_URLS: string[] = [
  'https://youtu.be/dQw4w9WgXcQ',
  'https://youtu.be/dQw4w9WgXcQ?t=5',
  'https://youtu.be//dQw4w9WgXcQ',
  'https://youtu.be/',
  'https://youtu.be/short',
  'https://youtu.be/dQw4w9WgXcQx',
  'https://youtu.be/dQw4w9WgXc!',
  'https://youtu.be/dQw4w9WgXc_',
  'https://youtu.be/dQw4w9WgXc-',
  'https://youtu.be/dQw4w9WgXcé',
  'https://youtu.be/dQw4w9WgX😀',
  'https://youtu.be/dQw4w9Wg%58cQ',
  'https://YOUTU.BE/dQw4w9WgXcQ',
  'https://youtu.be./dQw4w9WgXcQ',
  'https://youtu.be:443/dQw4w9WgXcQ',
  'https://user:pw@youtu.be/dQw4w9WgXcQ',
  'http://youtu.be/dQw4w9WgXcQ',
  'ftp://youtu.be/dQw4w9WgXcQ',
  'foo://youtu.be/dQw4w9WgXcQ',
  'FOO://YOUTU.BE/dQw4w9WgXcQ',
  'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
  'https://youtube.com/watch?v=dQw4w9WgXcQ',
  'https://m.youtube.com/watch?v=dQw4w9WgXcQ',
  'https://music.youtube.com/watch?v=dQw4w9WgXcQ&list=x',
  'https://www.youtube.com/watch?feature=x&v=dQw4w9WgXcQ',
  'https://www.youtube.com/watch?v=dQw4w9WgXcQ&v=aaaaaaaaaaa',
  'https://www.youtube.com/watch?v=',
  'https://www.youtube.com/watch?v',
  'https://www.youtube.com/watch',
  'https://www.youtube.com/watch/?v=dQw4w9WgXcQ',
  'https://www.youtube.com/watch?V=dQw4w9WgXcQ',
  'https://www.youtube.com/watch?v=dQw4w9WgXcQ#frag',
  'https://www.youtube.com/watch?v=dQw4w9Wg+cQ',
  'https://www.youtube.com/watch?v=dQw4w9Wg%2BcQ',
  'https://www.youtube.com/watch?v=dQw4w9Wg%20cQ',
  'https://www.youtube.com/watch?v=%64Qw4w9WgXcQ',
  'https://www.youtube.com/watch?v=dQw4w9WgXc%',
  'https://www.youtube.com/watch?v=dQw4w9WgXcQ%',
  'https://www.youtube.com/embed/dQw4w9WgXcQ',
  'https://www.youtube.com/embed/dQw4w9WgXcQ/extra',
  'https://www.youtube.com/embed//dQw4w9WgXcQ',
  'https://www.youtube.com//embed/dQw4w9WgXcQ',
  'https://www.youtube.com/embed/',
  'https://www.youtube.com/embed',
  'https://www.youtube.com/shorts/dQw4w9WgXcQ',
  'https://www.youtube.com/shorts/dQw4w9WgXcQ?feature=share',
  'https://www.youtube.com/live/dQw4w9WgXcQ',
  'https://www.youtube.com/v/dQw4w9WgXcQ',
  'https://www.youtube.com/EMBED/dQw4w9WgXcQ',
  'https://www.youtube.com/./embed/dQw4w9WgXcQ',
  'https://www.youtube.com/x/../embed/dQw4w9WgXcQ',
  'https://www.youtube.com\\embed\\dQw4w9WgXcQ',
  'https://www.youtube.com/%65mbed/dQw4w9WgXcQ',
  'https://www.youtube.com/',
  'https://www.youtube.com',
  'https://youtube.com.evil.com/watch?v=dQw4w9WgXcQ',
  'https://evilyoutube.com/watch?v=dQw4w9WgXcQ',
  'https://notyoutube.com/watch?v=dQw4w9WgXcQ',
  'https://youtube.com@evil.com/watch?v=dQw4w9WgXcQ',
  'https://evil.com/youtube.com/watch?v=dQw4w9WgXcQ',
  'https://www.youtube.com./watch?v=dQw4w9WgXcQ',
  'https://a.b.youtube.com/watch?v=dQw4w9WgXcQ',
  'https://.youtube.com/watch?v=dQw4w9WgXcQ',
  'https://you%74ube.com/watch?v=dQw4w9WgXcQ',
  'https://ｙｏｕｔｕｂｅ.com/watch?v=dQw4w9WgXcQ',
  'https://YouTube.COM/watch?v=dQw4w9WgXcQ',
  'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ',
  'https://www.youtube.com:8080/watch?v=dQw4w9WgXcQ',
  'https://[::1]/watch?v=dQw4w9WgXcQ',
  'https://127.0.0.1/watch?v=dQw4w9WgXcQ',
  '//www.youtube.com/watch?v=dQw4w9WgXcQ',
  'www.youtube.com/watch?v=dQw4w9WgXcQ',
  'youtu.be/dQw4w9WgXcQ',
  'youtube.com/watch?v=dQw4w9WgXcQ',
  ' https://youtu.be/dQw4w9WgXcQ',
  'https://youtu.be/dQw4w9WgXcQ ',
  '\thttps://youtu.be/dQw4w9WgXcQ\n',
  'https://youtu.be/dQw4w9WgXcQ\n',
  'javascript:alert(1)',
  'data:text/plain,youtu.be/dQw4w9WgXcQ',
  'mailto:a@youtu.be',
  'file:///youtu.be/dQw4w9WgXcQ',
  'about:blank',
  'https:youtu.be/dQw4w9WgXcQ',
  'https:/youtu.be/dQw4w9WgXcQ',
  'https:///youtu.be/dQw4w9WgXcQ',
  'https://',
  '',
  'not a url',
  'http://[invalid',
  'https://youtu.be/dQw4w9WgXcQ\u00a0'
]

function embedCases(b: Builder): void {
  for (const line of EMBED_LINES) {
    b.add('embeds.bookmarkUrl', line)
    b.add('embeds.parseYoutube', line)
    b.add('embeds.parseWhiteboard', line)
  }
  for (const url of YOUTUBE_URLS) {
    b.add('youtube.extractId', url)
    b.add('embeds.parseYoutube', `![alt](${url})`)
  }
  const ids = ['dQw4w9WgXcQ', '', 'x', 'a_b-c']
  ids.forEach((id) => b.add('youtube.thumbnail', id))
  const urls = ['https://youtu.be/dQw4w9WgXcQ', 'u', '']
  for (const url of urls) {
    for (const alt of [null, '', 'embed', 'Embedded YouTube video', '日本語']) {
      b.add('embeds.serializeYoutube', url, alt)
    }
    b.add('embeds.serializeBookmark', url)
  }
  for (const id of ['abc', '', 'a b', '日本語']) {
    b.add('embeds.serializeWhiteboard', id)
    b.add('embeds.whiteboardUrl', id)
  }
}

export function toggleFileEmbedCases(b: Builder): void {
  toggleCases(b)
  fileCases(b)
  embedCases(b)
}

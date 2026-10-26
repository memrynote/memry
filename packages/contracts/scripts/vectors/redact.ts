/**
 * Class: redaction (`redact.json`, `safe-dimension.json`).
 *
 * `redactText`, `redactLogLine` and `redactSensitive` are the production
 * functions of `src/redact.ts` and `src/telemetry-api.ts`; the generator only
 * feeds them inputs. The salted hasher is the one of
 * `apps/desktop/src/main/telemetry/diagnostics-salt.ts` (that file reads the
 * telemetry config, so it cannot be imported here); `hashes` pins it on its own.
 *
 * Every input avoids a cut inside a surrogate pair: a Rust string cannot hold half
 * of one, so the cap rule is covered with BMP text only.
 *
 * Determinism: D1. The salt and every input are constants.
 */
import { createHash } from 'node:crypto'

import { redactLogLine, redactText, type RedactOptions } from '../../src/redact'
import { SafeDimensionValueSchema, redactSensitive } from '../../src/telemetry-api'
import { meta } from './shared'

const SALT = '00112233445566778899aabbccddeeff'
const VAULT = '/home/kaan/My Vault'
const hash = (value: string): string =>
  createHash('sha256').update(SALT).update('\0').update(value).digest('hex').slice(0, 10)

const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc123_-xyzDEF'
const HEX40 = 'a'.repeat(40)
const B64 = 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVowMTIzNDU2Nzg5+/=='
const UUID_1 = '123e4567-e89b-12d3-a456-426614174000'

const TEXTS: string[] = [
  '',
  'plain text with nothing to hide',
  `token ${JWT} end`,
  `Authorization: Bearer ${JWT}`,
  'Authorization: Bearer abc.def-ghi_jkl~mno+pqr/stu=',
  'authorization: Basic dXNlcjpwYXNz',
  'bearer lowercase.token.value',
  'BEARER UPPER',
  'password=hunter2 next',
  'client_secret: s3cr3t-value and more',
  'id_token=abc refresh_token=def',
  'x-api-key: key-123',
  'api_key=ABC api-key=DEF apikey=GHI',
  'sortKey=abc cacheKey: 1 tokenCount=5',
  'secret = spaced value',
  'PASSWD:upper',
  'key sk-abcdefgh12345 and pk_live_abcdef123456',
  'ghp_ABCDEFGH12345678 gho-ABCDEFGH12345678 xoxb_ABCDEFGH12345678',
  'short sk-abc stays',
  'https://example.com/path?token=abc&x=1',
  'https://example.com/a/b?q=1#frag',
  'http://host.test:8080/p#frag',
  'HTTPS://EXAMPLE.COM/PATH?Q=1',
  'see /api?access_token=zzz&other=1 and &sig=abc',
  'url ?key=value&password=p1 &auth=a1',
  'before https://a.test/x?y=1 middle https://b.test/z#q after',
  `key material ${HEX40} here`,
  `b64 ${B64} here`,
  `${'x'.repeat(39)} short of the limit`,
  'y'.repeat(41),
  'mail kaan@example.com now',
  'KAAN@EXAMPLE.COM and a.b+c@sub.example.co.uk',
  'kaan@gmail.com.pdf',
  'not an email: user@localhost and @handle',
  'ip 192.168.1.10 and 10.0.0.255 and 999.1.1.1',
  'version 1.2.3.4.5 and 256.256.256.256',
  'v6 2001:0db8:85a3:0000:0000:8a2e:0370:7334 end',
  'v6 short fe80::1 and ::1 and 2001:db8::ff00:42:8329',
  'time 12:34:56 stays and 01:02 too',
  `id ${UUID_1} end`,
  `UPPER ${UUID_1.toUpperCase()}`,
  `${UUID_1}${UUID_1}`,
  'home /Users/kaan/Documents/x.txt',
  'home /home/kaan and /home/kaan/notes',
  'root /root/secrets and /root and /rootfs and /root.',
  '/root',
  'tail /root',
  'win C:\\Users\\Kaan\\Documents\\a.md',
  'win lower c:\\users\\kaan',
  'quote "/Users/kaan" and (/home/kaan) and /Users/kaan:12',
  `vault ${VAULT}/notes/a.md and ${VAULT}`,
  `vault under home ${VAULT}/x`,
  'My Note Title.md',
  'notes/Meeting (final) v2.pdf end',
  'photo.PNG and archive.zip and sheet.xlsx',
  'Müller Übersicht.docx',
  '日本語のノート.md',
  'ノート 2025.txt and 笔记.csv',
  'script.ts and app.js stay',
  'at fn (/Users/kaan/app/main.ts:12:5)',
  'file.mdx and file.mdd',
  'a.json b.html c.htm d.mp3 e.mp4 f.m4a g.mov h.tif i.tiff j.jpeg k.jpg l.gif m.webp n.svg o.heic',
  'title with trailing .md.',
  'emoji 📝 note.md',
  'mixed kaan@example.com ' + JWT + ' 10.0.0.1 /Users/kaan/n.md',
  'line one\nline two kaan@example.com\r\nline three',
  'tab\tseparated\tpassword=abc\tend',
  'nbsp\u00a0password=abc\u00a0end',
  'zwnbsp\ufeffpassword=abc\ufeffend',
  'em\u2003space password=abc',
  'a\u0085b password=abc\u0085end',
  'secret=\u00a0padded',
  'https://x.test/p?q=1\u00a0after',
  'ünïcödé wörds 한국어 العربية',
  'Bearer\u00a0token.value',
  'password=',
  'password= ',
  'token:',
  'tokenize=notasecret',
  'mytoken=1 my-token=2 my_token=3',
  'x@y.zz',
  'email at end kaan@example.com',
  '(kaan@example.com)',
  'a@b.c',
  '1.2.3.4',
  '0.0.0.0 255.255.255.255',
  '01.02.03.004',
  'sk-',
  'sk-12345678',
  'sk_12345678 rk-12345678',
  'xoxs_12345678 xoxz_12345678',
  '?token=a',
  '&key=b&secret=c',
  'token=a&key=b',
  'http://',
  'http://a',
  'https://a.test?x=1',
  'https://a.test#y',
  'ftp://a.test/x?y=1',
  `Bearer ${JWT}`,
  `eyJ${'a'.repeat(5)}.${'b'.repeat(5)}.${'c'.repeat(5)}`,
  `eyJ${'a'.repeat(4)}.${'b'.repeat(5)}.${'c'.repeat(5)}`,
  'C:\\Users\\a b\\c',
  '/Users//x',
  '/home/',
  '/Users/a/b /Users/c/d',
  'name.md name.md.md',
  ' leading space.md',
  '(paren).md',
  '.md',
  '-dash-.md',
  'a'.repeat(60) + '.md',
  'x'.repeat(2500),
  'y '.repeat(300),
  'ok 1234567890123456789012345678901234567890123456789 tail',
  '12345678-1234-1234-1234-123456789abc',
  '12345678-1234-1234-1234-123456789abg',
  'abcdefab-1234-1234-1234-123456789abcd'
]

const OPTION_SETS: Array<{ name: string; opts?: RedactOptions; wire: Record<string, unknown> }> = [
  { name: 'hash', opts: { hash }, wire: { hash: true } },
  { name: 'mask', opts: undefined, wire: {} },
  { name: 'vault', opts: { hash, vaultRoot: VAULT }, wire: { hash: true, vaultRoot: VAULT } }
]

const LINES: Array<{ message: string; fields?: Record<string, unknown> }> = [
  { message: 'hello' },
  { message: 'hello kaan@example.com', fields: { scope: 'Sync', level: 'warn' } },
  { message: 'x', fields: { errorCode: 'SQLITE_BUSY', action: 'push', reason: 'timeout' } },
  { message: 'x', fields: { errorCode: 'path /Users/kaan/x', status: 7, kind: true } },
  { message: 'x', fields: { noteId: UUID_1, taskId: 42, deviceId: '', vaultId: null } },
  { message: 'x', fields: { itemId: { a: 1 }, sessionId: ['x'], installId: 'abc' } },
  { message: 'x', fields: { durationMs: 12, count: 3, size: 0, exitCode: -1, attempt: 2 } },
  { message: 'x', fields: { latitude: 52, longitude: 13, other: 1 } },
  { message: 'x', fields: { flag: true, off: false } },
  { message: 'x', fields: { path: '/Users/kaan/Notes/a.md', url: 'https://a.test/x?token=abc' } },
  { message: 'x', fields: { unknown: 'kaan@example.com', nested: { a: 'b', z: [1, 2] } } },
  { message: 'x', fields: { empty: null, text: '' } },
  { message: 'x', fields: { long: 'z'.repeat(800) } },
  { message: 'x', fields: { scope: 'k'.repeat(800) } },
  { message: 'm'.repeat(2100) },
  { message: 'x', fields: { shownMs: 5200, vaultOpenPending: false, fallback: true } },
  {
    message: 'launch timeline',
    fields: {
      reason: 'ready-to-show',
      appReadyMs: 120,
      windowCreatedMs: 340,
      vaultOpenStartMs: 350,
      vaultOpenReadyMs: 900,
      rendererLoadedMs: 1200,
      readyToShowMs: 1300,
      shownMs: 1350,
      fallback: false,
      vaultOpenPending: false
    }
  },
  {
    message: 'launch timeline',
    fields: { reason: 'fallback-timeout', appReadyMs: 80, shownMs: 10000, fallback: true }
  },
  { message: 'x', fields: { appReadyMs: 'not a number', shownMs: null } },
  { message: 'x', fields: { value: 1.5, droppedCount: 3, pageCount: 9, sequenceNum: 4 } },
  { message: 'x', fields: { byteCount: 99, itemCount: 1, queueCount: 2, resultCount: 0 } },
  { message: 'x', fields: { retryCount: 3, origin: 'renderer', workerName: 'w1' } },
  { message: 'x', fields: { appVersion: '1.2.3', buildChannel: 'staging', platform: 'darwin' } },
  { message: 'x', fields: { arch: 'arm64', mode: 'a', phase: 'b', result: 'ok' } },
  { message: 'x', fields: { filePath: 'C:\\Users\\Kaan\\a.md', dir: '/home/kaan', file: 'a.pdf' } },
  { message: 'x', fields: { target: 'kaan@example.com', attachmentPath: `${VAULT}/a.png` } },
  { message: 'x', fields: { blockId: 'b1', journalId: 'j1', projectId: 'p1', attachmentId: 'a1' } },
  { message: 'x', fields: { signerDeviceId: 'dev', noteId: 5, taskId: true } },
  { message: 'x', fields: { big: 12345678901, neg: -5, zero: 0 } },
  { message: 'x', fields: { count: 'text', durationMs: true } },
  { message: `Bearer ${JWT}`, fields: { text: `password=abc ${HEX40}` } }
]

const SENSITIVE: string[] = [
  '',
  'plain',
  `jwt ${JWT} end`,
  'Bearer abc.def_ghi-jkl==',
  'bearer lower',
  'Bearer  two spaces',
  'Bearer x/y+z',
  'kaan@example.com and A@B.CO',
  `uuid ${UUID_1} end`,
  `UPPER ${UUID_1.toUpperCase()}`,
  'home /Users/kaan/x /home/kaan/y /root/z',
  '/root',
  '/rootfs',
  '/root/',
  'win C:\\Users\\Kaan\\x d:\\users\\b',
  'quote "/Users/kaan" (/home/kaan)',
  `mix ${JWT} kaan@example.com ${UUID_1} /Users/kaan/f`,
  'Bearer\u00a0nbsp',
  'no change at all 1.2.3.4',
  '/Users/kaan/Documents/My Note.md',
  'eyJabcde.eyJabcde.abcde',
  'eyJabc.eyJabcde.abcde',
  'Bearer a.b.c=== tail',
  'kaan@gmail.com.pdf',
  'x@y.z',
  '/home//x',
  '/Users/',
  'line\nbreak /Users/a/b\n/home/c/d'
]

function dimensionStrings(): string[] {
  const out = [
    '',
    'a',
    'ok_value',
    'a'.repeat(64),
    'a'.repeat(65),
    '😀'.repeat(32),
    '😀'.repeat(33),
    `${'a'.repeat(63)}😀`,
    `${'a'.repeat(62)}😀`,
    'é'.repeat(64),
    'é'.repeat(65),
    'a@b',
    '@',
    'a://b',
    '://',
    ':/',
    'a/b',
    'a\\b',
    '/',
    '\\',
    'line\nbreak',
    'cr\rreturn',
    'ls\u2028sep',
    'ps\u2029sep',
    'tab\tok',
    'vt\u000bok',
    'nel\u0085ok',
    UUID_1,
    UUID_1.toUpperCase(),
    `prefix-${UUID_1}`,
    `${UUID_1}-suffix`,
    '123e4567-e89b-12d3-a456-42661417400',
    '123e4567-e89b-12d3-a456-42661417400g',
    'setting.general.theme',
    'general.fontSizePx',
    'journal.weekdayTemplates',
    'a b c',
    ' ',
    '  leading',
    'trailing  ',
    'dash-and_under.dot:colon',
    '日本語',
    '日'.repeat(64),
    '日'.repeat(65),
    'x'.repeat(63),
    'mail.to',
    'http',
    'http:',
    'http:/',
    'http//x',
    'a:b://c'
  ]
  // A deterministic spread of lengths around the limit and of unit mixes.
  for (let length = 55; length <= 70; length += 1) {
    out.push('b'.repeat(length))
    out.push(`${'c'.repeat(length - 2)}🙂`)
    out.push(`🙂${'d'.repeat(length - 2)}`)
  }
  const chars = ['a', '@', '/', '\\', ':', '-', '_', '.', '1', ' ', 'é', '😀', '\n']
  for (let i = 0; i < 110; i += 1) {
    let s = ''
    for (let k = 0; k < 1 + (i % 7); k += 1) s += chars[(i * 7 + k * 3 + (i >> 2)) % chars.length]
    out.push(s)
  }
  return out
}

export function buildRedact(): Record<string, unknown> {
  const text = TEXTS.flatMap((input) =>
    OPTION_SETS.map(({ name, opts, wire }) => ({
      mode: name,
      options: wire,
      input,
      expected: redactText(input, opts)
    }))
  )
  const lines = LINES.flatMap((line) =>
    OPTION_SETS.slice(0, 2).map(({ name, opts, wire }) => ({
      mode: name,
      options: wire,
      input: line,
      expected: redactLogLine(line, opts)
    }))
  )
  const sensitive = SENSITIVE.map((input) => ({ input, expected: redactSensitive(input) }))
  const hashes = ['', 'a', 'kaan@example.com', '日本語', UUID_1].map((value) => ({
    value,
    expected: hash(value)
  }))
  return {
    meta: meta({
      class: 'redact',
      implementation: 'packages/contracts/src/redact.ts',
      salt: SALT,
      textCases: text.length,
      lineCases: lines.length,
      sensitiveCases: sensitive.length
    }),
    hashes,
    text,
    lines,
    sensitive
  }
}

export function buildSafeDimension(): Record<string, unknown> {
  const cases = dimensionStrings().map((value) => ({
    value,
    expected: SafeDimensionValueSchema.safeParse(value).success
  }))
  return {
    meta: meta({
      class: 'safe-dimension',
      implementation: 'packages/contracts/src/telemetry-api.ts',
      caseCount: cases.length
    }),
    cases
  }
}

/**
 * Class: note-fold-text (`note-fold-text.json`).
 *
 * The text helpers of desktop's fold engine, imported for real
 * (`apps/desktop/src/main/note-fold/`): `engine.ts` `detectLanguage`, `splitSentences`,
 * `countWords`, `estimateTokens` and `isFoldable`, and `engine-tokens.ts`
 * `expandInlineTokens` and `withoutInlineTokens`. The token cases cover every language tag
 * `detectLanguage` answers, with dates written as `Intl.DateTimeFormat` writes them in
 * `timeZone`. A token's date is an ECMAScript date-time string, as every writer emits; the
 * other strings V8's `Date.parse` accepts are implementation-defined and stay out. The Rust
 * port (`crates/memry-desktop/src/fold/{text,tokens}.rs`) reproduces every case
 * (`crates/memry-desktop/tests/note_fold_text_vectors.rs`).
 */
// Namespace imports: desktop's sources are CommonJS to Node, and the ESM loader cannot see
// their named exports statically.
import * as engineModule from '../../../../apps/desktop/src/main/note-fold/engine.ts'
import * as tokensModule from '../../../../apps/desktop/src/main/note-fold/engine-tokens.ts'
import { serializeDateMentionToken } from '@memry/shared/date-mention'

import { meta } from './shared'

type Engine = typeof engineModule
type Tokens = typeof tokensModule

const engine: Engine = (engineModule as Engine & { default?: Engine }).default ?? engineModule
const tokens: Tokens = (tokensModule as Tokens & { default?: Tokens }).default ?? tokensModule

export const NOTE_FOLD_ZONE = 'UTC'

/** Runs `run` with dates formatting in `tz`, so the file is the same on every machine. */
export function withZone<T>(tz: string, run: () => T): T {
  const previous = process.env.TZ
  process.env.TZ = tz
  try {
    return run()
  } finally {
    if (previous === undefined) delete process.env.TZ
    else process.env.TZ = previous
  }
}

const words = (n: number, word = 'note'): string => Array.from({ length: n }, () => word).join(' ')

/** `[name, text, language]`: the language the engine reads the text in. */
const TEXT_CASES: readonly [string, string, string][] = [
  ['empty', '', 'und'],
  ['whitespace only', ' \t\n\u00a0', 'und'],
  ['marks only', '— … !? 123 %', 'und'],
  ['english sentences', 'Ship it. Does it work? Yes! It does…', 'en'],
  ['abbreviation splits as Intl does', 'Dr. Smith came, e.g. on Monday. She left.', 'en'],
  ['decimal and version', 'Cold starts fell 2.4 s to 0.9 s in v1.2.3. Good.', 'en'],
  ['contractions and hyphens', "Don't re-run the well-known check; it's done.", 'en'],
  ['quotes and brackets', '"Is it done?" he asked. (Not yet.) Then [later].', 'en'],
  ['url and email', 'Read https://example.com/a.b?c=1 or mail a@b.co today.', 'en'],
  ['emoji and symbols', 'Launch 🚀 went well ✅. Costs $8 + 20% & more.', 'en'],
  ['crlf and newlines', 'One line.\r\nTwo line.\nThree\n\nFour.', 'en'],
  ['turkish', 'İstanbul’da ılık bir gün. Şimdi ne yapıyoruz? Çok güzel!', 'en'],
  ['japanese', '今日は晴れです。明日は雨でしょう！本当ですか？', 'ja'],
  ['japanese mixed with latin', 'MemryNoteは速い。Tauri版も速い。', 'ja'],
  ['chinese', '今天天气很好。我们明天出发！你呢？', 'zh'],
  ['korean', '오늘은 날씨가 좋습니다. 내일 떠나요! 정말요?', 'ko'],
  ['russian', 'Сегодня хорошая погода. Завтра мы уедем! Правда?', 'ru'],
  ['arabic', 'الطقس جميل اليوم. سنغادر غدا! حقا؟', 'ar'],
  ['kana at a tenth is not japanese', 'abcdefghi か', 'en'],
  ['kana over a tenth is japanese', 'abcdefgh か', 'ja'],
  ['hangul at three tenths is not korean', 'abcdefg 한국어', 'en'],
  ['hangul over three tenths is korean', 'abcdef 한국어', 'ko'],
  ['han at three tenths is not chinese', 'abcdefg 中文中', 'en'],
  ['cyrillic at half is not russian', 'abc где', 'en'],
  ['arabic over half is arabic', 'ab سلام', 'ar'],
  ['english at the threshold does not fold', words(150), 'en'],
  ['english one over the threshold folds', words(151), 'en'],
  ['cjk at the threshold does not fold', '日'.repeat(300), 'ja'],
  ['cjk one over the threshold folds', '日'.repeat(300) + '。日', 'ja']
]

const date = (dateISO: string, hasTime: boolean): string =>
  serializeDateMentionToken({
    anchorId: 'dm_vector',
    dateISO,
    hasTime,
    dateFormat: 'full',
    remind: 'none',
    timeFormat: 'system'
  })

/** A token from before `remind` was an enum: refused by the parser, salvaged for its date. */
const legacyDate = (dateISO: string): string =>
  `((date:${btoa(JSON.stringify({ anchorId: 'dm_old', dateISO, hasTime: true, remind: true }))
    .replace(/\+/g, ',')
    .replace(/\//g, ';')
    .replace(/=+$/, '')}))`

const mention = (url: string): string => `((mention:${encodeURIComponent(url)}))`

const LANGUAGES = ['en', 'ja', 'zh', 'ko', 'ru', 'ar'] as const

/** `[name, markdown, language]`. */
const TOKEN_CASES: readonly [string, string, string][] = [
  ...LANGUAGES.flatMap((language): [string, string, string][] => [
    [`${language} date`, `Due ${date('2024-03-05', false)}.`, language],
    [`${language} afternoon`, `At ${date('2024-03-05T15:04:00Z', true)}.`, language],
    [`${language} just after midnight`, `At ${date('2024-01-09T00:07:00Z', true)}.`, language],
    [`${language} noon`, `At ${date('2024-12-31T12:00:00.000Z', true)}.`, language]
  ]),
  ['a date-only token shows no time', date('2024-03-05', true), 'en'],
  ['a timed token without hasTime shows the date', date('2024-03-05T15:04:00Z', false), 'en'],
  ['an offset moves the time to the zone', date('2024-03-05T23:30:00+03:00', true), 'en'],
  ['an offset crosses midnight', date('2024-03-05T01:30:00+03:00', true), 'en'],
  ['no offset reads as local time', date('2024-03-05T23:30', true), 'en'],
  ['a month alone is its first day', date('2024-03', true), 'en'],
  ['a year alone is its first day', date('2024', true), 'en'],
  ['a day past the month rolls over', date('2024-02-31', false), 'en'],
  ['month thirteen rolls into the next year', date('2024-13-01', false), 'en'],
  ['day zero is the last of the month before', date('2024-01-00', false), 'en'],
  ['a two-digit year is the 1900s', date('0024-03-05', false), 'en'],
  ['a leap day', date('2024-02-29', false), 'en'],
  ['a date that is no date is dropped', `[${date('not a date', true)}]`, 'en'],
  ['a legacy token is salvaged for its date', legacyDate('2024-03-05T15:04:00Z'), 'en'],
  ['a token that does not decode is dropped', 'See ((date:abc)) here.', 'en'],
  ['an escaped token alphabet still decodes', date('2024-03-05', false).replace(/;/g, '_'), 'en'],
  ['a mention shows its host', `See ${mention('https://en.wikipedia.org/wiki/Rust')}.`, 'en'],
  ['a mention with a port and user', mention('https://u:p@Example.COM:8080/x'), 'en'],
  ['a mention that is no url is dropped', `See ${mention('not a url')}.`, 'en'],
  ['a mention that does not decode is dropped', 'See ((mention:%E0%A4%A)).', 'en'],
  [
    'several tokens in a line',
    `${date('2024-03-05', false)} ${mention('https://a.io')} ${date('2025-01-01', false)}`,
    'ja'
  ],
  ['a token across a line break is not one', '((date:\nabc))', 'en']
]

export function buildNoteFoldText(): Record<string, unknown> {
  return withZone(NOTE_FOLD_ZONE, () => ({
    meta: meta({
      source: 'apps/desktop/src/main/note-fold/{engine,engine-tokens}.ts',
      note: 'The fold text helpers: language, sentences, words and the inline tokens. Dates format in timeZone.'
    }),
    timeZone: NOTE_FOLD_ZONE,
    text: TEXT_CASES.map(([name, input, language]) => ({
      name,
      input,
      language,
      expected: {
        detected: engine.detectLanguage(input),
        sentences: engine.splitSentences(input, language),
        words: engine.countWords(input, language),
        tokens: engine.estimateTokens(input, language),
        foldable: engine.isFoldable(input, language)
      }
    })),
    tokens: TOKEN_CASES.map(([name, input, language]) => ({
      name,
      input,
      language,
      expected: {
        expanded: tokens.expandInlineTokens(input, language),
        blanked: tokens.withoutInlineTokens(input)
      }
    }))
  }))
}

/**
 * The 40 documents of `note-fold.json`: English, Turkish and Japanese
 * notes that reach every rule of the local fold (sections, chunk splits,
 * skipped blocks, list items, inline marks, date and link tokens, the
 * sentence and word boundaries, the Brief pick, the fold threshold).
 */
import { serializeDateMentionToken, type DateMentionData } from '@memry/shared/date-mention'

export interface NoteFoldCase {
  name: string
  /** The language the note is written in; the engine detects its own tag. */
  written: 'en' | 'tr' | 'ja'
  markdown: string
}

const doc = (...blocks: string[]): string => blocks.join('\n\n')
const repeat = (block: string, times: number): string[] =>
  Array.from({ length: times }, () => block)

const date = (dateISO: string, hasTime: boolean, extra: Partial<DateMentionData> = {}): string =>
  serializeDateMentionToken({
    anchorId: 'a1',
    dateISO,
    hasTime,
    dateFormat: 'full',
    remind: 'none',
    timeFormat: 'system',
    ...extra
  })

/** A pre-enum token (`remind: true`): refused by the parser, salvaged as a plain date. */
const oldDate = (dateISO: string): string =>
  `((date:${btoa(JSON.stringify({ anchorId: 'a2', dateISO, hasTime: false, remind: true }))
    .replace(/\+/g, ',')
    .replace(/\//g, ';')
    .replace(/=+$/, '')}))`

const mention = (url: string): string => `((mention:${encodeURIComponent(url)}))`

// ---------------------------------------------------------------------------
// English
// ---------------------------------------------------------------------------

const EN_A =
  'The migration plan moves the desktop app from Electron to Tauri in small steps. Each step ships on its own and keeps every vault readable. The team measured startup time on three machines before the first change landed. Cold starts dropped from 2.4 seconds to 0.9 seconds on the oldest laptop.'
const EN_B =
  'Why does the order matter? A step that changes a stored format must ship after every reader of that format understands it. Otherwise an older build on a second device would fail to open the vault. That rule is written down in the protocol chapters and checked by vectors.'
const EN_C =
  'Dr. Smith reviewed the storage layer on Monday, e.g. the write-ahead log and the index rebuild. She found one race in the U.S. build of the sync server. The fix took about 3.5 hours and shipped the same week with a regression test.'
const EN_D =
  'Local-first apps keep the user’s data on the device. The network is an optimization, not a requirement! Sync catches up when a connection returns, and nothing waits on a server to save a keystroke.'
const EN_E =
  'Short notes stay as they are. A reader opens them and sees every word, since folding a few lines would only hide what is already quick to read.'

const EN_LONG = Array.from(
  { length: 9 },
  (_, i) =>
    `Paragraph ${i + 1} of the long section describes another part of the system in plain words. It mentions the queue, the cache and the database that holds every row. A reader skimming it should still find the main point in the first sentence, which is why the fold keeps that one.`
)

const EN: NoteFoldCase[] = [
  { name: 'en-short', written: 'en', markdown: doc(EN_E) },
  { name: 'en-paragraphs', written: 'en', markdown: doc(EN_A, EN_B, EN_C, EN_D) },
  {
    name: 'en-headings',
    written: 'en',
    markdown: doc('# Migration ##', EN_A, '## Ordering', EN_B, '### Review notes', EN_C, EN_D)
  },
  {
    name: 'en-lists',
    written: 'en',
    markdown: doc(
      EN_A,
      [
        '- keep every vault readable',
        '- ship each step on its own',
        '* measure startup time before and after',
        '1. write the vectors first',
        '2) port the code until they pass',
        '- [ ] update the docs',
        '- [x] check the migration numbers;',
        '+ run the gates locally!'
      ].join('\n'),
      EN_B,
      EN_C
    )
  },
  {
    name: 'en-skipped-blocks',
    written: 'en',
    markdown: doc(
      '```ts\nconst x = 1\n```',
      EN_A,
      '| a | b |\n| --- | --- |\n| 1 | 2 |',
      '![diagram](attachments/n1/abc123-diagram.png)',
      '![[Embedded note]]',
      '<div>\n<span>html</span>\n</div>',
      '> [!note] A callout\n> with a second line that never folds',
      EN_B,
      '~~~\nplain fence\n~~~',
      '```\nopen fence that never closes',
      EN_C
    )
  },
  {
    name: 'en-inline-marks',
    written: 'en',
    markdown: doc(
      'The **storage layer** keeps _every_ row in `SQLite`, and the [design doc](https://example.com/doc) explains why. It links to [[Sync protocol|the protocol]] and to [[Glossary]] for the terms. A ~~deleted~~ idea stays out. Some *emphasis* ends a sentence *here*.',
      'A **bold run that crosses. Two sentences** is cut in half by the splitter. The `code span` stays whole. An <b>inline tag</b> is dropped from the text.',
      EN_A,
      EN_B
    )
  },
  {
    name: 'en-questions',
    written: 'en',
    markdown: doc(
      'Is the cache needed at all? What happens when it is empty? The fold computes the Brief again from the note itself, so an empty cache only costs a moment of work on the next open.',
      'Can a reader trust the Brief? It shows sentences the author wrote, never new ones. Nothing is invented and nothing is translated.',
      EN_A,
      EN_D,
      EN_C
    )
  },
  {
    name: 'en-quotes-ellipsis',
    written: 'en',
    markdown: doc(
      '“This is the end of the old app.” The team said it twice… Then they wrote the plan (“step one”). It had forty-four steps!',
      'He wrote: "Ship it." She answered \'not yet.\' The release waited one more day.',
      EN_B,
      EN_C,
      EN_A
    )
  },
  {
    name: 'en-frontmatter',
    written: 'en',
    markdown: `---\ntitle: Plan\ntags: [a, b]\n---\n${doc('# Plan', EN_A, EN_B, EN_D, EN_C)}`
  },
  {
    name: 'en-long-section',
    written: 'en',
    markdown: doc('## Long section', ...EN_LONG, '## Tail', EN_B)
  },
  {
    name: 'en-date-tokens',
    written: 'en',
    markdown: doc(
      `The review is on ${date('2024-03-05', false)} and the release on ${date('2024-11-25T09:07:00.000Z', true)}. A date without a time reads ${date('2024-06-01T12:00:00.000Z', false)}. A broken token ((date:%%%)) stays as typed, and an unreadable one ((date:abc)) is dropped. An old one reads ${oldDate('2023-01-31')}.`,
      EN_A,
      EN_B,
      EN_D
    )
  },
  {
    name: 'en-mention-tokens',
    written: 'en',
    markdown: doc(
      `The spec lives at ${mention('https://docs.example.com/spec?x=1')} and the tracker at ${mention('https://github.com/memrynote/memry/issues/1')}. A mention that is not a URL ${mention('not a url')} reads as nothing.`,
      EN_A,
      EN_C,
      EN_B
    )
  },
  {
    name: 'en-quote-crlf',
    written: 'en',
    markdown: doc('> ' + EN_A, '>' + EN_B, EN_C, EN_D).replace(/\n/g, '\r\n')
  },
  {
    name: 'en-numbers-emoji',
    written: 'en',
    markdown: doc(
      'Version 2 shipped 🎉 on time. Then 14 bugs came in 👩‍💻 over 3 days. The last one was a crash on 1.5% of launches.',
      EN_D,
      EN_A,
      EN_B
    )
  },
  {
    name: 'en-threshold-150',
    written: 'en',
    markdown: doc(Array.from({ length: 150 }, (_, i) => `w${i}`).join(' ') + '.')
  },
  {
    name: 'en-threshold-151',
    written: 'en',
    markdown: doc(Array.from({ length: 151 }, (_, i) => `w${i}`).join(' ') + '.')
  }
]

// ---------------------------------------------------------------------------
// Turkish
// ---------------------------------------------------------------------------

const TR_A =
  'Göç planı masaüstü uygulamasını küçük adımlarla Electron’dan Tauri’ye taşıyor. Her adım kendi başına yayımlanıyor ve her kasa okunabilir kalıyor. Ekip ilk değişiklikten önce üç makinede açılış süresini ölçtü. En eski dizüstünde soğuk açılış 2,4 saniyeden 0,9 saniyeye indi.'
const TR_B =
  'Sıra neden önemli? Kayıtlı bir biçimi değiştiren adım, o biçimi okuyan her sürüm onu anladıktan sonra çıkmalı. Yoksa ikinci bir cihazdaki eski sürüm kasayı açamaz. Bu kural protokol bölümlerinde yazılı ve vektörlerle denetleniyor.'
const TR_C =
  'Dr. Yılmaz pazartesi günü depolama katmanını inceledi, örn. günlük dosyasını ve dizinin yeniden kurulmasını. İstanbul’daki sunucuda bir yarış durumu buldu. Düzeltme yaklaşık 3 saat sürdü vb. işlerle aynı hafta yayımlandı.'
const TR_D =
  'Yerel öncelikli uygulamalar kullanıcının verisini cihazda tutar. Ağ bir iyileştirmedir, zorunluluk değil! Bağlantı geri geldiğinde eşitleme yetişir ve hiçbir tuş vuruşu bir sunucuyu beklemez.'
const TR_F =
  'Bu planın en önemli parçası, her değişikliğin geri alınabilir olmasıdır. Bir adım beklenmedik bir sorun çıkarırsa ekip onu kaldırır, kullanıcının verisi ise yerinde kalır. Testler her gece çalışır ve sonuçlar sabah toplantısında konuşulur. Böylece hiçbir hata uzun süre fark edilmeden kalmaz.'
const TR_E = 'Kısa notlar olduğu gibi kalır. Okuyan her kelimeyi görür.'

const TR_LONG = Array.from(
  { length: 16 },
  (_, i) =>
    `Uzun bölümün ${i + 1}. paragrafı sistemin başka bir parçasını sade sözcüklerle anlatıyor. Kuyruktan, önbellekten ve her satırı tutan veritabanından söz ediyor. Göz gezdiren bir okur ana fikri ilk cümlede bulmalı, katlama da bu yüzden onu tutuyor.`
)

const TR: NoteFoldCase[] = [
  { name: 'tr-short', written: 'tr', markdown: doc(TR_E) },
  { name: 'tr-paragraphs', written: 'tr', markdown: doc(TR_A, TR_B, TR_C, TR_F, TR_D) },
  {
    name: 'tr-headings',
    written: 'tr',
    markdown: doc('# Göç', TR_A, '## Sıralama', TR_B, '### İnceleme notları', TR_C, TR_D, TR_F)
  },
  {
    name: 'tr-lists',
    written: 'tr',
    markdown: doc(
      TR_A,
      [
        '- her kasayı okunabilir tut',
        '- her adımı ayrı yayımla',
        '1. önce vektörleri yaz',
        '- [ ] belgeleri güncelle'
      ].join('\n'),
      TR_B,
      TR_D,
      TR_F,
      TR_D
    )
  },
  {
    name: 'tr-inline-marks',
    written: 'tr',
    markdown: doc(
      '**Depolama katmanı** _her_ satırı `SQLite` içinde tutar ve [tasarım belgesi](https://example.com/belge) nedenini anlatır. [[Eşitleme protokolü|protokole]] bağlanır. Bazı *vurgular* cümleyi *bitirir*.',
      TR_A,
      TR_B,
      TR_F,
      TR_D
    )
  },
  { name: 'tr-abbreviations', written: 'tr', markdown: doc(TR_C, TR_A, TR_B, TR_F, TR_D) },
  {
    name: 'tr-questions',
    written: 'tr',
    markdown: doc(
      'Önbellek gerçekten gerekli mi? Boş olduğunda ne olur? Katlama özeti nottan yeniden hesaplar, boş bir önbellek yalnızca bir anlık iş demektir.',
      TR_A,
      TR_D,
      TR_B,
      TR_F
    )
  },
  {
    name: 'tr-dotted-i',
    written: 'tr',
    markdown: doc(
      'İzmir’deki ekip IŞIK adlı aracı ılık bir öğleden sonra denedi. İlk sürüm çalıştı, ikincisi ise ıssız bir hata verdi. Çözüm İnci’nin notlarında yazılıydı.',
      TR_A,
      TR_B,
      TR_F,
      TR_D
    )
  },
  {
    name: 'tr-quotes',
    written: 'tr',
    markdown: doc(
      '“Eski uygulamanın sonu bu.” Ekip bunu iki kez söyledi… Sonra planı yazdı (“birinci adım”).',
      TR_C,
      TR_A,
      TR_D,
      TR_F,
      TR_D
    )
  },
  { name: 'tr-long-section', written: 'tr', markdown: doc('## Uzun bölüm', ...TR_LONG) },
  {
    name: 'tr-date-tokens',
    written: 'tr',
    markdown: doc(
      `İnceleme ${date('2024-03-05', false)} tarihinde, yayın ise ${date('2024-11-25T21:30:00.000Z', true)} saatinde.`,
      TR_A,
      TR_B,
      TR_C,
      TR_F
    )
  },
  {
    name: 'tr-skipped-blocks',
    written: 'tr',
    markdown: doc(
      TR_A,
      '```\nkod\n```',
      '| a |\n| b |',
      TR_B,
      '> [!uyarı] Dikkat\n> ikinci satır',
      TR_C,
      TR_F,
      TR_D
    )
  }
]

// ---------------------------------------------------------------------------
// Japanese
// ---------------------------------------------------------------------------

const JA_A =
  '移行計画では、デスクトップアプリを小さな段階に分けてElectronからTauriへ移します。各段階は単独でリリースされ、すべての保管庫が読めるまま残ります。チームは最初の変更の前に三台のマシンで起動時間を測りました。最も古いノートパソコンでは、コールドスタートが2.4秒から0.9秒に縮みました。'
const JA_B =
  'なぜ順番が大切なのでしょうか？保存形式を変える段階は、その形式を読むすべてのビルドが理解した後に出す必要があります。そうしないと、別の端末にある古いビルドが保管庫を開けなくなります。この規則はプロトコルの章に書かれ、ベクトルで確かめられています。'
const JA_C =
  'ローカルファーストのアプリは、利用者のデータを端末に置きます。ネットワークは最適化であって、必須ではありません！接続が戻れば同期が追いつき、キー入力の保存がサーバーを待つことはありません。'
const JA_D =
  '「これが古いアプリの終わりだ。」とチームは言いました。それから計画を書きました（第一段階）。全部で四十四の段階がありました。'
const JA_E = '短いメモはそのまま残ります。読む人はすべての言葉を見ます。'

const JA_LONG = Array.from(
  { length: 6 },
  (_, i) =>
    `長い節の第${i + 1}段落は、システムの別の部分をやさしい言葉で説明します。キューやキャッシュ、そしてすべての行を持つデータベースについて述べます。ざっと読む人でも最初の文で要点が分かるように、折りたたみはその文を残します。この段落はさらに説明を続け、利用者が何を期待できるかを丁寧に書いています。`
)

const JA: NoteFoldCase[] = [
  { name: 'ja-short', written: 'ja', markdown: doc(JA_E) },
  { name: 'ja-paragraphs', written: 'ja', markdown: doc(JA_A, JA_B, JA_C) },
  {
    name: 'ja-headings',
    written: 'ja',
    markdown: doc('# 移行', JA_A, '## 順番', JA_B, '### 補足', JA_C)
  },
  {
    name: 'ja-lists',
    written: 'ja',
    markdown: doc(
      JA_A,
      [
        '- すべての保管庫を読めるままにする',
        '- 各段階を単独で出す',
        '1. まずベクトルを書く。',
        '- [x] 文書を更新する'
      ].join('\n'),
      JA_B,
      JA_C
    )
  },
  {
    name: 'ja-inline-marks',
    written: 'ja',
    markdown: doc(
      '**保存層**はすべての行を`SQLite`に置き、[設計資料](https://example.com/doc)がその理由を説明します。[[同期プロトコル|プロトコル]]にもつながります。',
      JA_A,
      JA_B
    )
  },
  { name: 'ja-punctuation', written: 'ja', markdown: doc(JA_B, JA_C, JA_A) },
  { name: 'ja-quotes', written: 'ja', markdown: doc(JA_D, JA_A, JA_B) },
  {
    name: 'ja-mixed-ascii',
    written: 'ja',
    markdown: doc(
      'Tauri v2 への移行では、Rust の core が sync と crypto を担当します。UI は SwiftUI と React のままです。テストは CI で毎回走ります。',
      JA_A,
      JA_C
    )
  },
  { name: 'ja-long-section', written: 'ja', markdown: doc('## 長い節', ...JA_LONG) },
  {
    name: 'ja-date-tokens',
    written: 'ja',
    markdown: doc(
      `レビューは${date('2024-03-05', false)}、リリースは${date('2024-11-25T09:07:00.000Z', true)}です。`,
      JA_A,
      JA_B,
      JA_C
    )
  },
  {
    name: 'ja-skipped-blocks',
    written: 'ja',
    markdown: doc(
      JA_A,
      '```\nコード\n```',
      '![図](attachments/n1/abc123-zu.png)',
      JA_B,
      '<br>',
      JA_C
    )
  },
  { name: 'ja-repeated', written: 'ja', markdown: doc(...repeat(JA_C, 4)) }
]

export const NOTE_FOLD_CASES: readonly NoteFoldCase[] = [...EN, ...TR, ...JA]

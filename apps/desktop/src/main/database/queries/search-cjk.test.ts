import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import { createTestIndexDb, createTestDataDb, type TestDatabaseResult } from '@tests/utils/test-db'
import { initializeFts, insertFtsNote } from '../fts'
import { initializeFtsTasks } from '../fts-tasks'
import { initializeFtsInbox } from '../fts-inbox'
import { searchAll } from './search'

/**
 * What a user gets when a note holds Chinese, Japanese or Korean text. The FTS
 * tokenizer is `porter unicode61`, which keeps a run of CJK letters as ONE
 * token and never segments it. So a search finds a whole run or a prefix of it,
 * and never a word in the middle or at the end.
 *
 * `crates/memry-core/tests/api_search_cjk.rs` holds the same corpus and the
 * same table: the core must answer each query exactly as this does. Change a
 * row in one file and change it in the other.
 */

/** id, title, body. */
const NOTES: Array<[string, string, string]> = [
  ['zh', 'Chinese study', '我喜欢学习中文'],
  ['ja', 'Japanese study', '日本語の勉強'],
  ['ko', 'Korean study', '한국어 공부'],
  ['latin-first', 'Plan A', 'memry笔记'],
  ['latin-last', 'Plan B', '笔记memry'],
  ['spaced', 'Plan C', 'hello 世界 world'],
  ['glued', 'Plan D', 'meeting会议'],
  ['title-adjacent', '项目Plan', ''],
  ['title-spaced', 'Memry 笔记 notes', ''],
  ['title-cjk', '学习中文', '']
]

/**
 * Query, then the hits as `id:kind`. `exact` is a full-text hit and `fuzzy` the
 * title fallback. Hits are compared as a set: bm25 ties between notes of equal
 * length are not what this pins.
 */
const CASES: Array<[query: string, hits: string[]]> = [
  // A whole run.
  ['我喜欢学习中文', ['zh:exact']],
  ['日本語の勉強', ['ja:exact']],
  ['한국어 공부', ['ko:exact']],
  // A prefix of a run.
  ['我喜欢', ['zh:exact']],
  ['日本語', ['ja:exact']],
  ['한국', ['ko:exact']],
  // A word inside a run is not a token. `学习` and `中文` do not find `zh`
  // (`我喜欢学习中文`); they find only the note TITLED `学习中文`, whose whole
  // run starts with `学习`, or its title by the fuzzy fallback for `中文`.
  ['学习', ['title-cjk:exact']],
  ['中文', ['title-cjk:fuzzy']],
  ['勉強', []],
  ['국어', []],
  // A space ends a Korean token, so the second word of `한국어 공부` is one.
  ['공부', ['ko:exact']],
  // A single character inside a title is found by the fuzzy title fallback.
  ['记', ['title-spaced:fuzzy']],
  // A Latin word glued to CJK is part of the same token: `meeting` is a prefix
  // of `meeting会议`, but `会议` is not a word in it.
  ['meeting', ['glued:exact']],
  ['meeting会议', ['glued:exact']],
  ['会议', []],
  // The same prefix rule for the CJK side first: `笔记` is a prefix of the
  // token `笔记memry` but not of `memry笔记`.
  ['笔记', ['title-spaced:exact', 'latin-last:exact']],
  // `memry` does not find the body `memry笔记`. Porter stems the typed word to
  // `memri` and leaves the glued token `memry笔记` as it is, so the prefix
  // never lines up. A space-separated `Memry` in a title is stemmed both ways.
  ['memry', ['title-spaced:exact']],
  ['memry 笔记', ['title-spaced:exact']],
  // A space-separated CJK word inside Latin text is a token of its own.
  ['世界', ['spaced:exact']],
  ['hello', ['spaced:exact']],
  // A Latin word glued to CJK in a title is one token: `项目` is its prefix,
  // and `plan` finds the four `Plan` notes but not `项目Plan`.
  ['项目', ['title-adjacent:exact']],
  ['项目Plan', ['title-adjacent:exact']],
  ['plan', ['latin-first:exact', 'latin-last:exact', 'glued:exact', 'spaced:exact']]
]

describe('CJK search', () => {
  let indexDb: TestDatabaseResult
  let dataDb: TestDatabaseResult

  beforeEach(() => {
    indexDb = createTestIndexDb()
    dataDb = createTestDataDb()
    initializeFts(indexDb.db)
    initializeFtsTasks(dataDb.db as never)
    initializeFtsInbox(dataDb.db as never)
    for (const [id, title, content] of NOTES) {
      indexDb.db.run(sql`
        INSERT INTO note_cache (id, path, title, file_type, created_at, modified_at)
        VALUES (${id}, ${`vault/${id}`}, ${title}, 'markdown', '2026-01-01', '2026-01-01')
      `)
      insertFtsNote(indexDb.db, id, title, content, [])
    }
  })

  afterEach(() => {
    indexDb.close()
    dataDb.close()
  })

  it.each(CASES)('%s', (text, hits) => {
    const found = searchAll(indexDb.db as never, dataDb.db as never, {
      text,
      types: ['note'],
      tags: [],
      dateRange: null,
      projectId: null,
      folderPath: null,
      limit: 10,
      offset: 0
    }).groups.flatMap((group) => group.results.map((hit) => `${hit.id}:${hit.matchType}`))

    expect(found.toSorted()).toEqual(hits.toSorted())
  })
})

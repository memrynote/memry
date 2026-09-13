/**
 * FR-008 as a test rather than an intention.
 *
 * `docs/protocol/00..14` state constants they were derived from. Nothing stops
 * a constant changing while the chapter that quotes it does not, and a
 * specification that is quietly wrong is worse than one that is missing.
 *
 * Two mechanisms, both required:
 *
 *  1. Per-constant assertions. Each row in `COVERED` imports the production
 *     constant and asserts the chapter's fact table still spells it, so a
 *     failure points at the paragraph to fix.
 *  2. A digest over the whole constant set, recorded in chapter 00. It catches
 *     a change to something no row lists yet: the digest moves, chapter 00 has
 *     to be edited, and a reviewer is then looking at the fact tables.
 *
 * Neither alone is enough. Rows only cover what someone remembered to list;
 * the digest only says "something moved". Together they say what moved and
 * where it is written down.
 *
 * This file imports only from `packages/contracts`, so it runs identically in
 * all three pickups (the desktop vitest `shared` project,
 * `turbo run test --filter=@memry/contracts`, and iOS CI). Constants that live
 * outside contracts are pinned by the vector classes instead, which is where a
 * cross-package import is already paid for.
 */
import { describe, expect, it } from 'vitest'

import {
  C00,
  C01,
  C03,
  C04,
  C08,
  C09,
  C10,
  C11,
  C12,
  COVERED,
  chapter,
  chapterConstantsDigest,
  normalize,
  rawChapter
} from './protocol-chapter-constants'

const DIGEST_LINE = /^[ \t]*protocol-constants-sha256:\s*([0-9a-f]{64})$/m

describe('FR-008: the chapters track the constants they were derived from', () => {
  it('covers at least one constant in every chapter that carries a fact table', () => {
    const slugs = new Set(COVERED.map((row) => row.slug))
    // Chapters 02, 05, 07, 13 and 14 quote constants that live in
    // apps/sync-server or apps/desktop, which this file cannot import without
    // crossing a package boundary; those are pinned by the vector classes and
    // by their own suites instead. Every chapter whose constants DO live in
    // packages/contracts must be covered here.
    for (const slug of [C00, C01, C03, C04, C08, C09, C10, C11, C12]) {
      expect(slugs.has(slug), `no constant row covers ${slug}`).toBe(true)
    }
  })

  for (const row of COVERED) {
    it(`${row.slug}: ${row.label}`, () => {
      const text = chapter(row.slug)
      for (const literal of row.spelledAs) {
        expect(
          text.includes(normalize(literal)),
          `docs/protocol/${row.slug}.md no longer spells ${row.label} as ${JSON.stringify(literal)}. ` +
            `The production value is ${JSON.stringify(row.value)}. ` +
            'A covered format change updates the chapter and its vectors in the same change (FR-008).'
        ).toBe(true)
      }
    })
  }

  it('chapter 00 records the current constant digest', () => {
    const text = rawChapter(C00)
    const match = DIGEST_LINE.exec(text)
    expect(
      match,
      'docs/protocol/00-overview-and-versioning.md must carry a line reading ' +
        '`protocol-constants-sha256: <64 hex>` inside its FR-008 section.'
    ).not.toBeNull()
    expect(
      match![1],
      'A constant covered by protocol-chapters.test.ts changed without chapter 00 being ' +
        `updated. Replace the recorded digest with ${chapterConstantsDigest()} and re-read ` +
        'the fact tables while you are in there (FR-008).'
    ).toBe(chapterConstantsDigest())
  })
})

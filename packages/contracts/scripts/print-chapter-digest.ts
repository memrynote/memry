/**
 * Print the FR-008 constant digest chapter 00 must record.
 *
 * `npx tsx packages/contracts/scripts/print-chapter-digest.ts`
 *
 * Exists so updating the digest does not require reading it out of a vitest
 * failure message, and so `vectors:check` can report it in CI.
 */
import { chapterConstantsDigest } from '../src/__tests__/protocol-chapter-constants'

process.stdout.write(`${chapterConstantsDigest()}\n`)

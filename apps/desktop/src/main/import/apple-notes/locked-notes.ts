/**
 * Locked (password-protected) notes in the NoteStore snapshot: reading each
 * note's crypto material, deciding whether a Notes password unlocks it, and
 * counting/verifying them for the import dialog.
 *
 * The crypto itself lives in `decrypt-note.ts`. The importer and the dialog's
 * password check share this file so both read the same columns the same way.
 */

import type Database from 'better-sqlite3'
import type { AppleNotesCheckUnlockResult } from '@memry/contracts/import-channels'
import { IMPORT_MESSAGE_CODES } from '@memry/importers/messages'
import type { ImportMessage } from '@memry/contracts/import-channels'
import { createNoteDecryptor, type LockedNoteCrypto, type NoteDecryptor } from './decrypt-note'
import { LOCKED_NOTES_FROM_WHERE, hasColumn, loadPrimaryKeys, openNoteStore } from './note-store'

/** Crypto columns as hex, in the shape `parseLockedCrypto` reads. */
export interface LockedCryptoRow {
  cryptoSalt: string | null
  cryptoIterations: number | null
  cryptoWrappedKey: string | null
  cryptoIv: string | null
  cryptoTag: string | null
}

// Salt, iteration count and wrapped key sit on the note's ZICCLOUDSYNCINGOBJECT
// row; the IV and tag sit on its ZICNOTEDATA row. Neither alias is guaranteed
// to exist on an older macOS schema, so each is selected only when present.
const CRYPTO_COLUMNS = [
  {
    table: 'ziccloudsyncingobject',
    alias: 'zcso',
    column: 'zcryptosalt',
    as: 'cryptoSalt',
    hex: true
  },
  {
    table: 'ziccloudsyncingobject',
    alias: 'zcso',
    column: 'zcryptoiterationcount',
    as: 'cryptoIterations',
    hex: false
  },
  {
    table: 'ziccloudsyncingobject',
    alias: 'zcso',
    column: 'zcryptowrappedkey',
    as: 'cryptoWrappedKey',
    hex: true
  },
  {
    table: 'zicnotedata',
    alias: 'nd',
    column: 'zcryptoinitializationvector',
    as: 'cryptoIv',
    hex: true
  },
  { table: 'zicnotedata', alias: 'nd', column: 'zcryptotag', as: 'cryptoTag', hex: true }
] as const

/** `, expr AS alias` fragments to append to a query joining `zcso` and `nd`. */
export function lockedCryptoSelect(db: Database.Database): string {
  return CRYPTO_COLUMNS.map((c) => {
    const ref = `${c.alias}.${c.column}`
    const expr = hasColumn(db, c.table, c.column) ? (c.hex ? `hex(${ref})` : ref) : 'NULL'
    return `, ${expr} AS ${c.as}`
  }).join('')
}

/** Null when any piece is missing — such a note cannot be decrypted by anyone. */
export function parseLockedCrypto(row: LockedCryptoRow): LockedNoteCrypto | null {
  if (
    !row.cryptoSalt ||
    !row.cryptoWrappedKey ||
    !row.cryptoIv ||
    !row.cryptoTag ||
    !row.cryptoIterations
  ) {
    return null
  }
  return {
    salt: Buffer.from(row.cryptoSalt, 'hex'),
    iterations: row.cryptoIterations,
    wrappedKey: Buffer.from(row.cryptoWrappedKey, 'hex'),
    iv: Buffer.from(row.cryptoIv, 'hex'),
    tag: Buffer.from(row.cryptoTag, 'hex')
  }
}

const skip = (code: string, message: string): { ok: false; reason: ImportMessage } => ({
  ok: false,
  reason: { code, message }
})

/**
 * Decrypt a locked note's body, or say why it stays out. Without a password the
 * reason is the original "locked" line, so a run that never offers one reads as
 * it always did.
 */
export function unlockNoteBody(
  decryptor: NoteDecryptor | null,
  row: LockedCryptoRow,
  encrypted: Buffer
): { ok: true; data: Buffer } | { ok: false; reason: ImportMessage } {
  if (!decryptor) {
    return skip(
      IMPORT_MESSAGE_CODES.appleNotesLockedNote,
      'Locked notes were not imported; Memry cannot read them without your Notes password'
    )
  }
  const crypto = parseLockedCrypto(row)
  const result = crypto ? decryptor.decrypt(crypto, encrypted) : null
  if (result?.ok) return result
  if (result?.reason === 'wrong-password') {
    return skip(
      IMPORT_MESSAGE_CODES.appleNotesLockedWrongPassword,
      'Locked notes use a different password than the one you entered'
    )
  }
  return skip(
    IMPORT_MESSAGE_CODES.appleNotesLockedUnreadable,
    'Locked notes could not be decrypted and were not imported'
  )
}

export function parseNotesPassword(options: Record<string, unknown> | undefined): string | null {
  const raw = options?.notesPassword
  return typeof raw === 'string' && raw.length > 0 ? raw : null
}

export function decryptorFor(options: Record<string, unknown> | undefined): NoteDecryptor | null {
  const password = parseNotesPassword(options)
  return password === null ? null : createNoteDecryptor(password)
}

/**
 * How many locked notes `password` unlocks. Checks the key unwrap only, so no
 * note body is read or decrypted; notes locked with an older password count as
 * locked, which is what the dialog warns about.
 */
export async function checkNotesUnlock(
  sourcePath: string,
  password: string
): Promise<AppleNotesCheckUnlockResult> {
  const store = await openNoteStore(sourcePath)
  try {
    const keys = loadPrimaryKeys(store.db)
    const rows = store.db
      .prepare(`SELECT 1 AS present ${lockedCryptoSelect(store.db)} ${LOCKED_NOTES_FROM_WHERE}`)
      .all(keys.ICNote) as LockedCryptoRow[]
    const decryptor = createNoteDecryptor(password)
    let unlocked = 0
    for (const row of rows) {
      const crypto = parseLockedCrypto(row)
      if (crypto && decryptor.canUnlock(crypto)) unlocked++
    }
    return { unlocked, total: rows.length }
  } finally {
    await store.close()
  }
}

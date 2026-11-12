//! `vault_lock`: desktop read-only locks (`VaultLockSyncPayloadSchema`,
//! `packages/contracts/src/sync-payloads.ts`, migration `0022`).
//!
//! Six fields under a whole-row clock. `createdAt` and `updatedAt` are ISO
//! strings on the wire and epoch milliseconds in the table (§A.6); the push
//! reads the verbatim payload, so the conversion never runs backwards. Electron
//! seeds a lock made before sync with its whole row, so `id` and `syncedAt`
//! can arrive as unmodelled keys and are preserved.
//!
//! `targetKind` is free text here: the merge ([`crate::domain::vault_locks::merge`])
//! decides what a kind this build does not know does, and a row of such a kind
//! locks nothing (`domain::vault_locks`). The three NOT NULL row fields
//! substitute (§13.3): an absent `targetKind` or `target` is empty text, which
//! names no note or folder, and an absent `locked` is unlocked. An absent or
//! unreadable instant falls back to the apply time, as Electron's `?? now`.

use rusqlite::{Connection, params};

use crate::api::errors::StorageError;

use super::super::schema::{Field, Kind, Object, ProjectionError, read_fields};
use super::{ItemContext, clock_text, failed, flag, instant, text_or_default};

const VAULT_LOCK_FIELDS: &[Field] = &[
    Field::opt_null("targetKind", Kind::Text),
    Field::opt_null("target", Kind::Text),
    Field::opt_null("locked", Kind::Bool),
    Field::opt_null("clock", Kind::Clock),
    Field::opt_null("createdAt", Kind::Text),
    Field::opt_null("updatedAt", Kind::Text),
];

pub fn read_vault_lock(parsed: &Object) -> Result<Object, ProjectionError> {
    read_fields("vault_lock", parsed, VAULT_LOCK_FIELDS)
}

pub fn project_vault_lock(
    conn: &Connection,
    item: ItemContext<'_>,
    view: &Object,
) -> Result<(), StorageError> {
    conn.execute(
        "INSERT INTO vault_locks (
             id, target_kind, target, locked, created_at, updated_at, clock, synced_at,
             deleted_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
         ON CONFLICT(id) DO UPDATE SET
             target_kind = excluded.target_kind,
             target = excluded.target,
             locked = excluded.locked,
             created_at = excluded.created_at,
             updated_at = excluded.updated_at,
             clock = excluded.clock,
             synced_at = excluded.synced_at,
             deleted_at = excluded.deleted_at",
        params![
            item.item_id,
            text_or_default(view, "targetKind", ""),
            text_or_default(view, "target", ""),
            flag(view, "locked").unwrap_or(0),
            instant(view, "createdAt").unwrap_or(item.synced_at),
            instant(view, "updatedAt").unwrap_or(item.synced_at),
            clock_text(view),
            item.synced_at,
            item.deleted_at,
        ],
    )
    .map_err(failed)?;
    Ok(())
}

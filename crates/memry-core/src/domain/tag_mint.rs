//! A definition for every tag the vault's notes use (#4418), as Electron's indexer makes one for
//! each tag it reads from a file (`ensureTagDefinitions`, `vault/indexer.ts`). Without it the tag
//! hub's ready-made strip offers "Add" for a tag already in use, and the tag's colour is the hash
//! of its name instead of the one Electron gives it.
//!
//! Electron's `getOrCreateTag` (`database/queries/tag-definitions.ts`) colours a new definition
//! by how many it already holds, `TAG_COLOR_PALETTE[count % 24]`, marks the colour unauthored,
//! and gives the row no clock: it stays on the device until its full sync, after the pull, seeds
//! every unclocked row (`seedUnclocked`, `tag-definition-handler.ts`) and pushes it. So a
//! definition another device made first, in any spelling, lands before the mint could reach
//! anyone, and a mint never replaces a colour or an icon someone picked.
//!
//! Here a mint is a `tag_definition` record with no clock and no outbox row ([`define_used`]),
//! and the sync pass seeds it ([`seed`]) once its pull reached the feed head
//! ([`crate::sync::engine::PassSeed`]). A tag with a record of any spelling, live or deleted, is
//! never minted: a deletion stays deleted while a file still carries the tag.

use std::collections::BTreeSet;

use rusqlite::{Connection, params};
use serde_json::json;

use crate::api::errors::StorageError;
use crate::domain::notes::{failed, insert_local, iso, next_clock, object, require_payload};
use crate::domain::tag_admin::{DEFINITION_TYPE, definitions};
use crate::domain::tags::tag_key;
use crate::storage::repositories::projectors::{self, ItemContext};
use crate::storage::repositories::{Change, StoredPayload, sync_items};
use crate::sync::outbox;

/// Electron's `TAG_COLOR_PALETTE`, in its order. Twelve of its names are not in the chip table
/// (`packages/contracts/src/tag-colors.ts`), which paints those by the name's hash, as on
/// Electron.
const PALETTE: [&str; 24] = [
    "rose", "pink", "fuchsia", "purple", "violet", "indigo", "blue", "sky", "cyan", "teal",
    "emerald", "green", "lime", "yellow", "amber", "orange", "stone", "slate", "gray", "zinc",
    "neutral", "warm", "red", "coral",
];

/// Mints a definition for each of `tags` whose key has no record, live or deleted, in their
/// order, named by the tag's key (`Idea` defines `idea`) and coloured by the number of live
/// definitions before it, in one transaction. Nothing is queued. Returns how many it minted.
pub fn define_used(conn: &Connection, tags: &[String], now_ms: i64) -> Result<usize, StorageError> {
    // Read and written in one transaction: a record that lands meanwhile is never minted over.
    let tx = conn.unchecked_transaction().map_err(failed)?;
    let mut known: BTreeSet<String> = records(&tx)?.iter().map(|id| tag_key(id)).collect();
    known.extend(definitions(&tx)?.into_keys());
    // Named by the tag's key, as `ensureTagDefinitions` hands `getOrCreateTag` `tagKey(tag)`.
    let missing: Vec<String> = tags
        .iter()
        .map(|tag| tag_key(tag))
        .filter(|key| !key.is_empty() && known.insert(key.clone()))
        .collect();
    if missing.is_empty() {
        return Ok(0);
    }
    let live: i64 = tx
        .query_row(
            "SELECT COUNT(*) FROM tag_definitions WHERE deleted_at IS NULL",
            [],
            |row| row.get(0),
        )
        .map_err(failed)?;
    let live = usize::try_from(live).unwrap_or_default();
    for (count, tag) in (live..).zip(&missing) {
        let payload = object(json!({
            "name": tag,
            "color": PALETTE[count % PALETTE.len()],
            "colorAuthored": false,
            "createdAt": iso(now_ms)?,
        }));
        insert_local(&tx, DEFINITION_TYPE, tag, payload, now_ms)?;
    }
    tx.commit().map_err(failed)?;
    Ok(missing.len())
}

/// Electron's `seedUnclocked` for the mints: each one whose key has no other record, live or
/// deleted, gets a clock and is queued as a `create`; one whose key another record holds (a
/// spelling another device pushed first, or its deletion) is dropped, and that record keeps the
/// tag. Run by the sync pass after a pull that reached the feed head. Idempotent: a seeded mint
/// has a clock and a dropped one is gone. Returns the seeded ids.
pub fn seed(conn: &Connection, device_id: &str, now_ms: i64) -> Result<Vec<String>, StorageError> {
    let tx = conn.unchecked_transaction().map_err(failed)?;
    let records = records(&tx)?;
    let mut seeded = Vec::new();
    for id in mints(&tx)? {
        let key = tag_key(&id);
        let others: Vec<&String> = records
            .iter()
            .filter(|other| **other != id && tag_key(other) == key)
            .collect();
        if others.is_empty() {
            let clock = next_clock(
                require_payload(&tx, DEFINITION_TYPE, &id)?.object(),
                device_id,
            )?;
            sync_items::apply_local_edit_in(
                &tx,
                DEFINITION_TYPE,
                &id,
                &[("clock", Change::Set(clock))],
                now_ms,
            )?;
            outbox::enqueue(&tx, &outbox::Change::create(DEFINITION_TYPE, &id), now_ms)?;
            seeded.push(id);
            continue;
        }
        tx.execute(
            "DELETE FROM sync_items WHERE item_type = ?1 AND item_id = ?2",
            params![DEFINITION_TYPE, id],
        )
        .map_err(failed)?;
        // The projection keys names without ASCII case, so the mint's row is the one the other
        // spelling projected into, under the mint's name: it is made again from the records.
        tx.execute("DELETE FROM tag_definitions WHERE name = ?1", [&id])
            .map_err(failed)?;
        for other in others {
            project(&tx, other, now_ms)?;
        }
    }
    tx.commit().map_err(failed)?;
    Ok(seeded)
}

/// Every `tag_definition` record's id: live, deleted, or not yet fetched.
fn records(conn: &Connection) -> Result<Vec<String>, StorageError> {
    ids(conn, "SELECT item_id FROM sync_items WHERE item_type = ?1")
}

/// The live mints: records this device wrote with no clock, which no pull touched.
fn mints(conn: &Connection) -> Result<Vec<String>, StorageError> {
    ids(
        conn,
        "SELECT item_id FROM sync_items
          WHERE item_type = ?1 AND clock IS NULL AND signer_device_id IS NULL
            AND server_cursor IS NULL AND deleted_at IS NULL AND payload IS NOT NULL
            AND corrupt_at IS NULL
          ORDER BY rowid",
    )
}

fn ids(conn: &Connection, sql: &str) -> Result<Vec<String>, StorageError> {
    let mut statement = conn.prepare(sql).map_err(failed)?;
    let ids = statement
        .query_map([DEFINITION_TYPE], |row| row.get(0))
        .map_err(failed)?
        .collect::<Result<_, _>>()
        .map_err(failed)?;
    Ok(ids)
}

/// Projects the record `id` again from its stored payload; one with none has no row to make.
fn project(conn: &Connection, id: &str, now_ms: i64) -> Result<(), StorageError> {
    let Some(row) = sync_items::load(conn, DEFINITION_TYPE, id)? else {
        return Ok(());
    };
    let Some(view) = row
        .payload
        .as_deref()
        .and_then(|raw| StoredPayload::parse(raw).ok())
        .and_then(|payload| projectors::read(DEFINITION_TYPE, payload.object()).ok())
    else {
        return Ok(());
    };
    projectors::project(
        conn,
        DEFINITION_TYPE,
        ItemContext {
            item_id: id,
            synced_at: now_ms,
            deleted_at: row.deleted_at,
        },
        &view,
    )
}

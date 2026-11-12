//! A definition for every tag the vault's notes use (#4418), as Electron's indexer makes one for
//! each tag it reads from a file (`ensureTagDefinitions`, `vault/indexer.ts`). Without it the tag
//! hub's ready-made strip offers "Add" for a tag already in use, and the tag's colour is the hash
//! of its name instead of the one Electron gives it.
//!
//! Electron's `getOrCreateTag` (`database/queries/tag-definitions.ts`) colours a new definition
//! by how many it already holds, `TAG_COLOR_PALETTE[count % 24]`, and marks the colour
//! unauthored: a peer holding the tag keeps its own (§13.7.7). It never changes a definition
//! that exists. The row goes to sync as a `tag_definition` record with `colorAuthored: false`;
//! here the record is written and queued at once, where Electron's full sync seeds it
//! (`seedUnclocked`).

use std::collections::BTreeSet;

use rusqlite::Connection;

use crate::api::errors::StorageError;
use crate::domain::notes::failed;
use crate::domain::tag_admin::{definitions, upsert_definition_in};
use crate::domain::tags::tag_key;
use crate::storage::repositories::Change;

/// Electron's `TAG_COLOR_PALETTE`, in its order. Twelve of its names are not in the chip table
/// (`packages/contracts/src/tag-colors.ts`), which paints those by the name's hash, as on
/// Electron.
const PALETTE: [&str; 24] = [
    "rose", "pink", "fuchsia", "purple", "violet", "indigo", "blue", "sky", "cyan", "teal",
    "emerald", "green", "lime", "yellow", "amber", "orange", "stone", "slate", "gray", "zinc",
    "neutral", "warm", "red", "coral",
];

/// Creates a definition for each of `tags` that has none, in their order, named by the tag's key
/// (`Idea` defines `idea`) and coloured by the number of live definitions before it, in one transaction. A tag with a definition keeps it as
/// it is. Returns how many it created.
pub fn define_used(
    conn: &Connection,
    tags: &[String],
    device_id: &str,
    now_ms: i64,
) -> Result<usize, StorageError> {
    // Read and written in one transaction: a definition made meanwhile is never edited.
    let tx = conn.unchecked_transaction().map_err(failed)?;
    let mut defined: BTreeSet<String> = definitions(&tx)?.into_keys().collect();
    // Named by the tag's key, as `ensureTagDefinitions` hands `getOrCreateTag` `tagKey(tag)`.
    let missing: Vec<String> = tags
        .iter()
        .map(|tag| tag_key(tag))
        .filter(|key| !key.is_empty() && defined.insert(key.clone()))
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
        let color = PALETTE[count % PALETTE.len()];
        let changes = vec![
            ("color", Change::set(color)),
            ("colorAuthored", Change::set(false)),
        ];
        upsert_definition_in(&tx, tag, None, changes, device_id, now_ms)?;
    }
    tx.commit().map_err(failed)?;
    Ok(missing.len())
}

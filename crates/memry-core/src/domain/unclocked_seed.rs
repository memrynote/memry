//! Electron's `seedUnclocked` (`runInitialSeed`, `apps/desktop/src/main/sync/initial-seed.ts`)
//! for the records an Electron vault import stages with no clock (Step 36, #3553). Electron gives
//! such a row its first clock and queues it as a `create` in its full sync, after the pull, so a
//! version another device pushed first lands on the unclocked row and wins
//! (`resolveUpsertClock(null, remote)`), and the seed then passes it by. The import stages these
//! rows with no clock and no outbox row, and the sync pass runs this seed after a pull that reached
//! the feed head ([`UnclockedSeed`], [`crate::sync::engine::PassSeed`]).
//!
//! A core write commits its clock and its outbox row together, so a vault the core made has no
//! such row and this seed finds nothing. `tag_definition` is [`super::tag_mint`]'s: its seed
//! matches spellings without case.

use rusqlite::Connection;

use super::notes::{failed, next_clock};
use super::recreate::recreate_clock;
use crate::api::errors::StorageError;
use crate::api::tasks_write::now_ms;
use crate::domain::note_files::is_local_only;
use crate::storage::{Db, nested_tx};
use crate::storage::repositories::{Change, StoredPayload, sync_items};
use crate::sync::engine::PassSeed;
use crate::sync::hardening::purged::RECREATABLE_AFTER_PURGE_ITEM_TYPES;
use crate::sync::{outbox, store};

/// The types whose handlers seed unclocked rows, less `tag_definition` ([`super::tag_mint`]) and
/// the types an import does not stage yet.
pub const SEEDED_TYPES: [&str; 7] = [
    "folder_config",
    "property_definition",
    "tag_category",
    "template",
    "custom_icon",
    "note",
    "journal",
];

/// Gives each live unclocked record of [`SEEDED_TYPES`] that no pull touched its first clock under
/// `device_id` and queues it as a `create`, in one transaction, as each Electron handler's
/// `seedUnclocked` does:
///
/// - a re-creatable type's clock is past the id's delete clock (`nextLocalClock(.., 'create')`),
///   the others' is `increment({}, deviceId)`;
/// - a `relation` property definition stays local (`isPersistableDefinitionType`);
/// - a local-only note stays local;
/// - a note or journal day with a delete clock is a leftover of the delete and is held back
///   (`seedSkipsDeletedNote`).
///
/// Idempotent: a seeded record has a clock. Returns the seeded `(type, id)`s.
pub fn seed(
    conn: &Connection,
    device_id: &str,
    now_ms: i64,
) -> Result<Vec<(String, String)>, StorageError> {
    let tx = nested_tx::begin(conn).map_err(failed)?;
    let mut seeded = Vec::new();
    for (item_type, item_id) in unclocked(&tx)? {
        let Some(stored) = sync_items::load(&tx, &item_type, &item_id)?
            .and_then(|row| row.payload)
            .map(|raw| StoredPayload::parse(&raw))
            .transpose()
            .map_err(|error| StorageError::Failed {
                what: format!("unclocked record {item_type}/{item_id} is unreadable: {error}"),
            })?
        else {
            continue;
        };
        let held = match item_type.as_str() {
            "property_definition" => {
                stored.object().get("type").and_then(|v| v.as_str()) == Some("relation")
            }
            "note" => {
                is_local_only(&tx, &item_id)?
                    || store::tombstone_clock(&tx, &item_type, &item_id)?.is_some()
            }
            "journal" => store::tombstone_clock(&tx, &item_type, &item_id)?.is_some(),
            _ => false,
        };
        if held {
            continue;
        }
        let clock = if RECREATABLE_AFTER_PURGE_ITEM_TYPES.contains(&item_type.as_str()) {
            recreate_clock(&tx, &item_type, &item_id, stored.object(), None, device_id)?
        } else {
            next_clock(stored.object(), device_id)?
        };
        sync_items::apply_local_edit_in(
            &tx,
            &item_type,
            &item_id,
            &[("clock", Change::Set(clock))],
            now_ms,
        )?;
        outbox::enqueue(&tx, &outbox::Change::create(&item_type, &item_id), now_ms)?;
        seeded.push((item_type, item_id));
    }
    tx.commit().map_err(failed)?;
    Ok(seeded)
}

/// The live records of [`SEEDED_TYPES`] this device holds with no clock, which no pull touched.
fn unclocked(conn: &Connection) -> Result<Vec<(String, String)>, StorageError> {
    let types = SEEDED_TYPES.map(|t| format!("'{t}'")).join(", ");
    let mut statement = conn
        .prepare(&format!(
            "SELECT item_type, item_id FROM sync_items
              WHERE item_type IN ({types}) AND clock IS NULL AND server_cursor IS NULL
                AND signer_device_id IS NULL AND deleted_at IS NULL AND payload IS NOT NULL
                AND corrupt_at IS NULL
              ORDER BY rowid"
        ))
        .map_err(failed)?;
    let rows = statement
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .map_err(failed)?
        .collect::<Result<_, _>>()
        .map_err(failed)?;
    Ok(rows)
}

/// [`seed`] as the sync pass's [`PassSeed`], under the vault's device id. The sync driver
/// registers it for every open vault.
pub struct UnclockedSeed {
    db: Db,
    device_id: String,
}

impl UnclockedSeed {
    pub fn new(db: Db, device_id: String) -> Self {
        Self { db, device_id }
    }
}

#[async_trait::async_trait]
impl PassSeed for UnclockedSeed {
    async fn seed(&self) -> Result<(), StorageError> {
        let device_id = self.device_id.clone();
        self.db
            .call(move |conn| seed(conn, &device_id, now_ms()))
            .await?;
        Ok(())
    }
}

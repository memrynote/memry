//! The server's id for this vault, which `X-Memry-Vault-Id` and the socket
//! carry (chapter 05 §5.2), owned by core as one `meta` key (#3534 decision K1).
//!
//! Electron kept it in the vault registry (`vaultUuid`); here the registry
//! entry becomes a cache of this key, so a vault opened from another path or
//! after a registry reset still syncs to the vault the server knows. It may
//! differ from the local `vault.id` (`storage::vault_identity`): a device that
//! downloaded the vault binds it over a freshly minted local id. Synced records
//! that name their vault (canvases, canvas folders, agent conversations) state
//! this id once it is bound ([`RecordVault`], #5505), and the ones written
//! before the bind are restamped once ([`restamp`], #5535), because Electron adopts the server uuid as
//! its local one (`vault-adoption.ts:49-80`) and §13.7.21's `vaultId` is the
//! value of `X-Memry-Vault-Id`.
//!
//! Additive: an older build ignores the key. `SyncDriver` refuses a vault with
//! none, which would send no header and be routed to the account's only vault.

use rusqlite::Connection;
use serde::Deserialize;
use serde_json::{Value, json};

use crate::api::errors::StorageError;
use crate::domain::notes::{clock_in, failed};
use crate::domain::{agent_conversation, agent_queue, canvas, canvas_folder, desktop_records};
use crate::storage::nested_tx;
use crate::storage::repositories::schema::Object;
use crate::storage::repositories::{Change, StoredPayload, sync_items};

use super::clock::{ClockOrder, VectorClock, compare, increment};
use super::first_sync_store::{read_meta, write_meta};
use super::outbox;

/// `meta` key of the bound server vault id.
pub const META_SERVER_VAULT_ID: &str = "sync.server_vault_id";

/// Binds this vault to the server's vault `id`. Binding the id it already
/// has is a no-op; another id is refused, because the feed cursor, the outbox
/// and every stored record belong to the vault first bound. An empty or
/// whitespace id is refused: it would send an empty header.
pub fn bind(conn: &Connection, id: &str) -> Result<(), StorageError> {
    let id = id.trim();
    if id.is_empty() {
        return Err(StorageError::Failed {
            what: "a server vault id is empty".into(),
        });
    }
    match bound(conn)? {
        Some(current) if current == id => Ok(()),
        Some(current) => Err(StorageError::Failed {
            what: format!("this vault is bound to server vault `{current}`, not `{id}`"),
        }),
        None => write_meta(conn, META_SERVER_VAULT_ID, id),
    }
}

/// The bound server vault id, if any.
pub fn bound(conn: &Connection) -> Result<Option<String>, StorageError> {
    read_meta(conn, META_SERVER_VAULT_ID)
}

/// The vault a synced record that names one belongs to here: the one owner of
/// which `vaultId` such a record states and which ones list in this vault.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecordVault {
    stamp: String,
    local: String,
}

impl RecordVault {
    /// Reads the binding now, so a bind made while the vault is open applies to
    /// the next write. `local` is the vault's own id, which an unbound vault
    /// states and which its server id becomes when it binds first.
    pub fn read(conn: &Connection, local: &str) -> Result<Self, StorageError> {
        Ok(Self {
            stamp: bound(conn)?.unwrap_or_else(|| local.to_owned()),
            local: local.to_owned(),
        })
    }

    /// The `vaultId` a record written here states: the bound server id, else the local id.
    pub fn stamp(&self) -> &str {
        &self.stamp
    }

    /// The local id, which records written before the bind, or by a build before #5505, state
    /// until [`restamp`] runs. A vault lists records of either id.
    pub fn local(&self) -> &str {
        &self.local
    }
}

/// The `vaultId` a pulled canvas, canvas folder or agent conversation states over a stored one,
/// the one owner of that choice in a merge of every [`STAMPED`] type: the stored id, as Electron
/// keeps `existing.vaultId` (§13.7.21 rule 4, §13.7.23 rule 3, §13.7.26 rule 3), unless the
/// remote states the bound server id, which wins (#5669, #5784).
/// Invariant: a merge never moves a record off the bound id. A peer that pulled a record before
/// its writer's [`restamp`] stores the writer's old local id; keeping that over the restamp would
/// push it again, and every fresh device would hide the record. `None` when neither side states
/// a string, so the merge leaves the key as the winning payload has it.
pub(crate) fn merged_vault_id(
    conn: &Connection,
    local: &Object,
    remote: &Object,
) -> Result<Option<Value>, StorageError> {
    let stated = |object: &Object| {
        object
            .get("vaultId")
            .filter(|value| value.is_string())
            .cloned()
    };
    if let Some(remote_id) = stated(remote)
        && bound(conn)?.is_some_and(|server| remote_id.as_str() == Some(server.as_str()))
    {
        return Ok(Some(remote_id));
    }
    Ok(stated(local))
}

/// Pushes a record that a fast-forward stored under the bound server id while the dominating remote
/// states another id, which [`merged_vault_id`] kept off the record (#5784, #5812).
/// Invariant: a record this device holds under the server vault id is never left on the server
/// under a pre-bind id. A fresh device lists only the server id and its own local id, and a
/// pre-#5784 or Electron peer pushes the id it stored, so the server copy would stay hidden.
/// The fast-forward stored the remote's clock, which the server already holds and refuses to see
/// again (`detectReplay`), so the record is a local edit under this device's next tick, queued
/// once. The echo states the server id, so pulling it queues nothing; a peer that states the old
/// id again costs one push per edit of its. A concurrent merge stores a clock past the remote's
/// and re-queues on its own, so it is left as it is. `clock_device` is this device's clock id.
pub(crate) fn repush_kept(
    tx: &Connection,
    item_type: &str,
    item_id: &str,
    remote: &Object,
    clock_device: Option<&str>,
    now_ms: i64,
) -> Result<(), StorageError> {
    let Some(server) = bound(tx)? else {
        return Ok(());
    };
    let Some(stored) = desktop_records::stored(tx, item_type, item_id, true)? else {
        return Ok(());
    };
    let held = stored.object().get("vaultId").and_then(Value::as_str);
    if held != Some(server.as_str())
        || remote.get("vaultId").and_then(Value::as_str) == held
        || compare(&clock_in(stored.object())?, &clock_in(remote)?) != ClockOrder::Equal
    {
        return Ok(());
    }
    let device = clock_device.ok_or_else(|| StorageError::Failed {
        what: format!(
            "{item_type} {item_id} keeps the server vault id over a remote and this pull has no \
             device clock id to push it"
        ),
    })?;
    push_edit(tx, item_type, item_id, &stored, Vec::new(), device, now_ms)
}

/// Writes `changes` under `device_id`'s next tick and queues the record, unless it is a
/// conversation the agent backfill still owes ([`agent_queue::backfill`]).
fn push_edit(
    tx: &Connection,
    item_type: &str,
    id: &str,
    stored: &StoredPayload,
    changes: Vec<(&'static str, Change)>,
    device_id: &str,
    now_ms: i64,
) -> Result<(), StorageError> {
    desktop_records::edit(tx, item_type, id, stored, changes, device_id, now_ms)?;
    if item_type != agent_conversation::ITEM_TYPE || !agent_queue::backfill_pending(tx)? {
        outbox::enqueue(tx, &outbox::Change::upsert(item_type, id), now_ms)?;
    }
    Ok(())
}

/// `meta` key set once [`restamp`] ran for the bound vault.
const META_RESTAMPED: &str = "sync.record_vault_restamped";

/// The payload key in which a [`restamp`] of a canvas or a canvas folder states a [`Restamp`],
/// which [`restamp_superseded`] reads. Additive: desktop resolves a record without it but pushes
/// it again (§13.2.1), and a core before it carries it as an unknown key (§13.2 rule 3).
const RESTAMP: &str = "vaultRestamp";

/// The device that restamped a record and the clock the record had before. A value of any other
/// shape is no restamp.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Restamp {
    device: String,
    base: VectorClock,
}

/// The synced types that state their vault, each with its projection table.
const STAMPED: [(&str, &str); 3] = [
    (canvas::ITEM_TYPE, "canvases"),
    (canvas_folder::ITEM_TYPE, "canvas_folders"),
    (agent_conversation::ITEM_TYPE, "agent_conversations"),
];

/// Makes every live record that states the local id `local` state the bound server id instead,
/// once per vault (#5535). Records written before the bind (a merge or an adoption over a vault
/// with content), by a build before #5505, or a conflict copy of one, state the local id, which
/// every other device filters out (Electron's `store.ts:538`, `folder-store.ts:126`). Each one is
/// a local edit under this device's next tick, since the server refuses a clock that does not
/// advance (`detectReplay`, `apps/sync-server/src/services/sync.ts:230`), the rest of the payload
/// stays as stored, and it is queued as an update. A canvas or a canvas folder also states this
/// device and its clock before the restamp ([`RESTAMP`]), so a concurrent edit on either side outranks it
/// ([`restamp_superseded`]) and the restamp contests only `vaultId`. A deleted record is never
/// queued, so no update revives it, and a conversation waiting for the agent backfill is left to
/// it ([`agent_queue::backfill`]). Unbound: nothing, and the run stays owed. Returns how many it
/// restamped.
pub fn restamp(
    conn: &Connection,
    local: &str,
    device_id: &str,
    now_ms: i64,
) -> Result<usize, StorageError> {
    let Some(server) = bound(conn)? else {
        return Ok(0);
    };
    if read_meta(conn, META_RESTAMPED)?.is_some() {
        return Ok(0);
    }
    let tx = nested_tx::begin(conn).map_err(failed)?;
    let mut restamped = 0;
    if server != local {
        for (item_type, table) in STAMPED {
            for id in stated(&tx, table, local)? {
                restamped += usize::from(restamp_one(
                    &tx, item_type, &id, local, &server, device_id, now_ms,
                )?);
            }
        }
    }
    write_meta(&tx, META_RESTAMPED, "1")?;
    tx.commit().map_err(failed)?;
    Ok(restamped)
}

fn stated(tx: &Connection, table: &str, local: &str) -> Result<Vec<String>, StorageError> {
    let mut statement = tx
        .prepare(&format!(
            "SELECT id FROM {table} WHERE vault_id = ?1 AND deleted_at IS NULL ORDER BY id"
        ))
        .map_err(failed)?;
    statement
        .query_map([local], |row| row.get(0))
        .map_err(failed)?
        .collect::<Result<_, _>>()
        .map_err(failed)
}

fn restamp_one(
    tx: &Connection,
    item_type: &str,
    id: &str,
    local: &str,
    server: &str,
    device_id: &str,
    now_ms: i64,
) -> Result<bool, StorageError> {
    let Some(row) = sync_items::load(tx, item_type, id)? else {
        return Ok(false);
    };
    let Some(stored) = row
        .payload
        .filter(|_| row.deleted_at.is_none())
        .and_then(|raw| StoredPayload::parse(&raw).ok())
    else {
        return Ok(false);
    };
    let object = stored.object();
    let deleted = object
        .get("deletedAt")
        .is_some_and(|value| !value.is_null());
    if deleted || object.get("vaultId").and_then(Value::as_str) != Some(local) {
        return Ok(false);
    }
    let mut changes = vec![("vaultId", Change::Set(json!(server)))];
    if item_type != agent_conversation::ITEM_TYPE {
        let base = clock_in(object)?;
        changes.push((
            RESTAMP,
            Change::Set(json!({ "device": device_id, "base": base })),
        ));
    }
    push_edit(tx, item_type, id, &stored, changes, device_id, now_ms)?;
    Ok(true)
}

/// Whether a merge keeps the other side's content over `record`'s: `record` is a [`restamp`], its
/// clock exactly its [`Restamp`] base ticked once by the restamping device, so it changed only
/// `vaultId` since that base, and `other` is strictly after the base, so it holds every edit
/// `record` holds. Any later edit ticks again, the restamper's own included, and a device that
/// stored the marker without applying the restamp (desktop, §13.2.1) ticks its own id, so a
/// marker carried along is inert. An empty base names no content and is no restamp.
pub(crate) fn restamp_superseded(record: &Object, other: &VectorClock) -> bool {
    let marker = record
        .get(RESTAMP)
        .filter(|marker| marker.is_object())
        .and_then(|marker| serde_json::from_value::<Restamp>(marker.clone()).ok());
    let (Some(Restamp { device, base }), Ok(clock)) = (marker, clock_in(record)) else {
        return false;
    };
    base.values().any(|&tick| tick > 0)
        && compare(&clock, &increment(&base, &device)) == ClockOrder::Equal
        && compare(other, &base) == ClockOrder::After
}

#[cfg(test)]
#[path = "server_vault_restamp_tests.rs"]
mod restamp_tests;

#[cfg(test)]
#[path = "server_vault_merge_tests.rs"]
mod merge_tests;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::{open_data, test_support::temp_dir};

    #[test]
    fn a_binding_is_kept_across_a_reopen_and_an_empty_or_other_id_is_refused() {
        let dir = temp_dir("server-vault");
        let path = dir.path().join("data.db");
        let db = open_data(&path).expect("open");
        db.call_blocking(|conn| {
            assert_eq!(bound(conn)?, None);
            assert!(bind(conn, "  ").is_err());
            bind(conn, "vault-1")?;
            assert!(bind(conn, "vault-2").is_err());
            bind(conn, " vault-1 ")
        })
        .expect("bind");
        drop(db);
        let db = open_data(&path).expect("reopen");
        let id = db.call_blocking(|conn| bound(conn)).expect("read");
        assert_eq!(id.as_deref(), Some("vault-1"));
    }
}

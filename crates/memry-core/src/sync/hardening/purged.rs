//! Purged tombstones, chapter 05 §5.12.3 (#2302, #2408), ported from
//! Electron's `engine/pull-envelope.ts` (admission and
//! `applicablePurgedTombstones`), `delete-attestation.ts` and
//! `engine/purged-tombstone-guard.ts`.
//!
//! A declaring client ([`crate::protocol::types::Declaration::desktop`]) gets
//! a marker's id in `GET /sync/changes` `deleted` and the marker itself in the
//! `purgedTombstones` of `POST /sync/pull`, never in `items`. A marker is
//! unsigned: the server asserts it, so each one passes, in order,
//!
//! 1. admission ([`Entries::read`]): the request named its id, its type has a
//!    required clock, its clock is not empty;
//! 2. `skip`: a run from cursor 0, or a permanently quarantined item;
//! 3. the deleting device's attestation over the entry's own claim
//!    ([`delete_attestation::verify`]), under a key [`SignerKeys`] resolves;
//! 4. the local refusals ([`local`]);
//!
//! and only then applies as the signed tombstone with the same clock
//! ([`Pending::Tombstone`]), under §5.8's clock rule. Every id an entry names
//! is reported in [`Entries::named`] whatever happens to it, so the pull never
//! applies it as an untyped §5.12.1 delete.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

use rusqlite::{Connection, OptionalExtension, params};
use serde_json::Value as Json;

use crate::api::errors::{ApiError, StorageError};
use crate::protocol::delete_attestation::{self, DeleteClaim};
use crate::protocol::http::HttpClient;
use crate::protocol::types::is_record_item_type;
use crate::storage::Db;
use crate::storage::repositories::{instants, sync_items};
use crate::sync::apply::Pending;
use crate::sync::clock::{OFFLINE_CLOCK_DEVICE_ID, VectorClock};
use crate::sync::first_sync_store::{read_meta, write_meta};
use crate::sync::pull::PullError;
use crate::sync::store::{self, RECORD_CURSOR_SCOPE};

/// `RECREATABLE_AFTER_PURGE_ITEM_TYPES` (`packages/contracts/src/sync-api.ts:217-228`).
pub const RECREATABLE_AFTER_PURGE_ITEM_TYPES: [&str; 10] = [
    "journal",
    "tag_definition",
    "property_definition",
    "folder_config",
    "canvas_folder",
    "bookmark",
    "calendar_source",
    "calendar_external_event",
    "calendar_binding",
    "note",
];

/// The one record type with no required clock (`RECORD_CLOCK_REQUIRED_ITEM_TYPES`).
const CLOCK_EXEMPT_ITEM_TYPE: &str = "settings";

/// Electron's `toEpochSeconds` reads a number above this as milliseconds.
const MILLISECONDS_ABOVE: i64 = 1_000_000_000_000;

/// Present while a pull run that started from cursor 0 has not reached the
/// head (§5.12.3): its pages apply no marker. Kept in `meta`, not in memory,
/// because such a run spans passes (`MAX_PAGES_PER_PASS`) and restarts.
const META_FROM_ZERO: &str = "sync.purged_from_zero";

/// The record cursor, and whether the page read from it belongs to a run from
/// cursor 0. Reading from cursor 0 starts such a run.
pub(crate) fn cursor_and_from_zero(
    conn: &Connection,
) -> Result<(Option<String>, bool), StorageError> {
    let cursor = store::read_cursor(conn, RECORD_CURSOR_SCOPE)?;
    if cursor.as_deref().is_none_or(|cursor| cursor == "0") {
        write_meta(conn, META_FROM_ZERO, "1")?;
        return Ok((cursor, true));
    }
    Ok((cursor, read_meta(conn, META_FROM_ZERO)?.is_some()))
}

/// Ends a run from cursor 0: called in the transaction that lands a page at
/// the head that was not refused.
pub(crate) fn end_from_zero(conn: &Connection) -> Result<(), StorageError> {
    conn.execute("DELETE FROM meta WHERE key = ?1", params![META_FROM_ZERO])
        .map_err(|error| StorageError::Failed {
            what: error.to_string(),
        })?;
    Ok(())
}

/// The signing keys a marker's attestation verifies under (Electron's
/// `resolveDeviceKey`).
#[async_trait::async_trait]
pub trait SignerKeys: Send + Sync {
    /// The key of `device_id`. `Ok(None)` only when a completed device lookup
    /// does not name it; `Err` when the lookup could not complete, which the
    /// pull turns into a failed page with its cursor held, never a refusal.
    async fn signing_key(
        &self,
        http: &HttpClient,
        device_id: &str,
    ) -> Result<Option<Vec<u8>>, ApiError>;

    /// The account's device ids this client knows, `None` when it knows none
    /// (Electron's `readKnownDeviceIds`).
    fn known_devices(&self) -> Option<HashSet<String>>;

    /// A pull run starts or ends: forget the signers it did not find, as
    /// Electron clears `deviceKeyCache` (`pull-coordinator.ts:153`, `:587`).
    fn forget_absent(&self) {}
}

/// Why a marker applies nothing, logged by reason (Electron's
/// `RefusedTombstoneReason`, `AttestationRefusal`, `LocalTombstoneRefusal`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) enum Refusal {
    Shape,
    NotRequested,
    TypeNotClocked,
    Clockless,
    Unattested,
    SignerUnknown,
    AttestationInvalid,
    LocalClockless,
    LocalPendingWrite,
    LocalNewer,
    UnknownDevice,
}

/// One admitted marker.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Marker {
    pub item_type: String,
    pub item_id: String,
    /// As pushed: seconds from Electron, milliseconds from this core.
    pub deleted_at: i64,
    pub clock: VectorClock,
    pub server_cursor: i64,
    /// `(signerDeviceId, deleteAttestation)`, present only together.
    pub attestation: Option<(String, String)>,
}

impl Marker {
    fn claim(&self) -> DeleteClaim<'_> {
        DeleteClaim {
            item_type: &self.item_type,
            item_id: &self.item_id,
            clock: &self.clock,
            deleted_at: self.deleted_at,
        }
    }

    /// The apply input a signed tombstone with this clock produces
    /// (`purgedTombstoneToApplyItem`).
    fn into_pending(self) -> Pending {
        Pending::Tombstone {
            item_type: self.item_type,
            item_id: self.item_id,
            deleted_at: self.deleted_at,
            server_cursor: Some(self.server_cursor),
            clock: Some(self.clock),
            body_state_vector: None,
        }
    }
}

/// The `purgedTombstones` of one pull's responses.
#[derive(Debug, Default)]
pub(crate) struct Entries {
    pub markers: Vec<Marker>,
    /// Every id an entry names, admitted or not: none is an untyped delete.
    pub named: BTreeSet<String>,
    pub refused: Vec<Refusal>,
}

impl Entries {
    /// Reads one `POST /sync/pull` body's entries, each on its own (§5.14);
    /// `requested` are the ids that request named.
    pub(crate) fn read(&mut self, body: &Json, requested: &[String]) {
        let Some(entries) = body.get("purgedTombstones").and_then(Json::as_array) else {
            return;
        };
        let requested: HashSet<&str> = requested.iter().map(String::as_str).collect();
        for entry in entries {
            if let Some(id) = entry.get("id").and_then(Json::as_str) {
                self.named.insert(id.to_owned());
            }
            match admit(entry, &requested) {
                Ok(marker) => self.markers.push(marker),
                Err(refusal) => self.refused.push(refusal),
            }
        }
    }
}

/// `RecordPullPurgedTombstoneSchema`, then admission (`admitTombstone`).
fn admit(entry: &Json, requested: &HashSet<&str>) -> Result<Marker, Refusal> {
    let text = |key: &str| match entry.get(key) {
        None => Ok(None),
        Some(Json::String(text)) if !text.is_empty() => Ok(Some(text.clone())),
        Some(_) => Err(Refusal::Shape),
    };
    let count = |key: &str| entry.get(key).and_then(Json::as_i64).filter(|n| *n >= 0);
    let item_id = text("id")?.ok_or(Refusal::Shape)?;
    let item_type = text("type")?
        .filter(|name| is_record_item_type(name))
        .ok_or(Refusal::Shape)?;
    let deleted_at = count("deletedAt").ok_or(Refusal::Shape)?;
    let server_cursor = count("serverCursor").ok_or(Refusal::Shape)?;
    let clock = match entry.get("clock") {
        None => None,
        Some(value) => Some(read_clock(value).ok_or(Refusal::Shape)?),
    };
    let signer = text("signerDeviceId")?;
    let signature = text("deleteAttestation")?;

    if !requested.contains(item_id.as_str()) {
        return Err(Refusal::NotRequested);
    }
    if item_type == CLOCK_EXEMPT_ITEM_TYPE {
        return Err(Refusal::TypeNotClocked);
    }
    let clock = clock
        .filter(|clock| !clock.is_empty())
        .ok_or(Refusal::Clockless)?;
    Ok(Marker {
        item_type,
        item_id,
        deleted_at,
        clock,
        server_cursor,
        attestation: signer.zip(signature),
    })
}

/// `VectorClockSchema`: device ids to non-negative integers.
fn read_clock(value: &Json) -> Option<VectorClock> {
    value
        .as_object()?
        .iter()
        .map(|(device, tick)| Some((device.clone(), tick.as_u64()?)))
        .collect()
}

/// The attested markers, in order (`applicablePurgedTombstones`' first half).
/// One key lookup per signer; a lookup that cannot complete fails the call.
pub(crate) async fn attest(
    markers: Vec<Marker>,
    keys: Option<&dyn SignerKeys>,
    http: &HttpClient,
    refused: &mut Vec<Refusal>,
) -> Result<Vec<Marker>, ApiError> {
    let mut resolved: HashMap<String, Option<Vec<u8>>> = HashMap::new();
    for (signer, _) in markers
        .iter()
        .filter_map(|marker| marker.attestation.as_ref())
    {
        if !resolved.contains_key(signer) {
            let key = match keys {
                Some(keys) => keys.signing_key(http, signer).await?,
                None => None,
            };
            resolved.insert(signer.clone(), key);
        }
    }
    let mut attested = Vec::with_capacity(markers.len());
    for marker in markers {
        let Some((signer, signature)) = &marker.attestation else {
            refused.push(Refusal::Unattested);
            continue;
        };
        let Some(Some(key)) = resolved.get(signer) else {
            refused.push(Refusal::SignerUnknown);
            continue;
        };
        if delete_attestation::verify(&marker.claim(), signature, key).is_err() {
            refused.push(Refusal::AttestationInvalid);
            continue;
        }
        attested.push(marker);
    }
    Ok(attested)
}

/// What the local row says about one attested marker.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Local {
    Apply,
    /// No live row of the marker's `(type, id)`: nothing to delete.
    Absent,
    Refuse(Refusal),
}

/// `localTombstoneRefusal`, over the `sync_items` row that holds the item's
/// clock. Runs in its own writer call before the page's apply, not in the
/// apply transaction: a local edit can land in between, across the page's
/// `fetch_note_bodies` network call. The apply's §5.8 clock rule still runs.
pub(crate) fn local(
    conn: &Connection,
    marker: &Marker,
    known_devices: Option<&HashSet<String>>,
) -> Result<Local, StorageError> {
    let Some(row) = sync_items::load(conn, &marker.item_type, &marker.item_id)? else {
        return Ok(Local::Absent);
    };
    if row.deleted_at.is_some() {
        return Ok(Local::Absent);
    }
    let local_clock = row
        .clock
        .as_deref()
        .and_then(|text| serde_json::from_str::<VectorClock>(text).ok())
        .filter(|clock| !clock.is_empty());
    let Some(local_clock) = local_clock else {
        return Ok(Local::Refuse(Refusal::LocalClockless));
    };

    if RECREATABLE_AFTER_PURGE_ITEM_TYPES.contains(&marker.item_type.as_str()) {
        if has_pending_write(conn, &marker.item_type, &marker.item_id)? {
            return Ok(Local::Refuse(Refusal::LocalPendingWrite));
        }
        let deleted_ms = to_ms(marker.deleted_at);
        if touched_ms(row.payload.as_deref(), row.updated_at).any(|at| at > deleted_ms) {
            return Ok(Local::Refuse(Refusal::LocalNewer));
        }
    }

    if let Some(known) = known_devices {
        let unknown = marker.clock.keys().any(|device| {
            device != OFFLINE_CLOCK_DEVICE_ID
                && !local_clock.contains_key(device)
                && !known.contains(device)
        });
        if unknown {
            return Ok(Local::Refuse(Refusal::UnknownDevice));
        }
    }
    Ok(Local::Apply)
}

/// A queued write other than a delete, a body update included.
fn has_pending_write(
    conn: &Connection,
    item_type: &str,
    item_id: &str,
) -> Result<bool, StorageError> {
    conn.query_row(
        "SELECT 1 FROM outbox WHERE item_type = ?1 AND item_id = ?2 AND op != 'delete' LIMIT 1",
        params![item_type, item_id],
        |_| Ok(()),
    )
    .optional()
    .map(|found| found.is_some())
    .map_err(|error| StorageError::Failed {
        what: format!("reading the queued writes of a purged tombstone's item: {error}"),
    })
}

/// When the local item was created or modified, in epoch ms: the payload's
/// `createdAt`, `modifiedAt` and `updatedAt` (Electron's row columns), and
/// when this device last stored the row.
fn touched_ms(payload: Option<&str>, stored_at: i64) -> impl Iterator<Item = i64> {
    let payload: Option<Json> = payload.and_then(|text| serde_json::from_str(text).ok());
    let fields: Vec<i64> = ["createdAt", "modifiedAt", "updatedAt"]
        .into_iter()
        .filter_map(|key| match payload.as_ref()?.get(key)? {
            Json::String(text) => instants::to_epoch_ms(text),
            Json::Number(number) => number.as_i64().map(to_ms),
            _ => None,
        })
        .collect();
    fields.into_iter().chain([stored_at])
}

/// Electron's `toEpochSeconds` on a number, in milliseconds.
fn to_ms(at: i64) -> i64 {
    if at > MILLISECONDS_ABOVE {
        at
    } else {
        at.saturating_mul(1_000)
    }
}

/// The pull's half (`purgedTombstoneApplyItems`): the markers that apply, as
/// the pending tombstones the page applies with its records. `skip` drops a
/// marker before its attestation is checked. Refusals are logged by reason.
pub(crate) async fn applicable(
    entries: Entries,
    skip: impl Fn(&Marker) -> bool,
    keys: Option<&dyn SignerKeys>,
    http: &HttpClient,
    db: &Db,
) -> Result<Vec<Pending>, PullError> {
    let Entries {
        markers,
        mut refused,
        ..
    } = entries;
    let candidates: Vec<Marker> = markers.into_iter().filter(|marker| !skip(marker)).collect();
    let attested = attest(candidates, keys, http, &mut refused).await?;
    let known = if attested.is_empty() {
        None
    } else {
        keys.and_then(SignerKeys::known_devices)
    };
    let (apply, local_refused) = db
        .call(move |conn| {
            let mut apply = Vec::new();
            let mut refused = Vec::new();
            for marker in attested {
                match local(conn, &marker, known.as_ref())? {
                    Local::Apply => apply.push(marker.into_pending()),
                    Local::Absent => {}
                    Local::Refuse(reason) => refused.push(reason),
                }
            }
            Ok((apply, refused))
        })
        .await?;
    refused.extend(local_refused);
    log_refusals(&refused);
    Ok(apply)
}

fn log_refusals(refused: &[Refusal]) {
    if refused.is_empty() {
        return;
    }
    let mut by_reason: BTreeMap<Refusal, usize> = BTreeMap::new();
    for reason in refused {
        *by_reason.entry(*reason).or_default() += 1;
    }
    eprintln!("memry-core: refused purged tombstones: {by_reason:?}");
}

#[cfg(test)]
#[path = "purged_tests.rs"]
mod tests;

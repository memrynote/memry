//! The purged markers that remove a live row: the manifest reconcile's stale
//! rows (chapter 05 §5.12.1, §5.12.3, #5402) and a row whose edit the server
//! answered `SYNC_DELETE_WINS` (§5.8, #5406).
//!
//! A marker is unsigned: the server asserts it. One removes a row only when
//! it names a row the caller asked about, its type requires a clock,
//! its clock is not empty, its cursor is past the row's, and the deleting
//! device's attestation over `{id, type, deletedAt, clock}` in this vault
//! verifies under a key the device directory holds
//! ([`delete_attestation::verify`]; v2 binds the vault, #5247). It then
//! applies as the signed tombstone with that clock, under §5.8's clock rule.
//!
//! A marker that passes every check but the clock or the attestation is
//! unattested: it keeps the row. The reconcile remembers it for the push wave
//! ([`crate::sync::delete_wins`], #5406).

use std::collections::HashMap;

use serde_json::Value as Json;

use crate::protocol::delete_attestation::{self, DeleteClaim};
use crate::protocol::types::is_record_item_type;
use crate::sync::apply::Pending;
use crate::sync::clock::VectorClock;
use crate::sync::delete_wins::KeptMarker;
use crate::sync::first_sync_store::HeldRow;
use crate::sync::pull::PullLoop;

/// The one record type with no required clock (chapter 00 §0.7).
const CLOCK_EXEMPT_ITEM_TYPE: &str = "settings";

/// Marker signers' keys a caller looked up ahead, by device id: the desktop
/// driver's directory with one refetch ([`crate::sync::hardening::purged::SignerKeys`],
/// Electron's `resolveDeviceKey`). A signer it does not name falls back to
/// [`PullLoop::signing_key`].
pub(crate) type SignerKeyMap = HashMap<String, Option<Vec<u8>>>;

/// What the markers for the `stale` rows decide.
#[derive(Default)]
pub(crate) struct Verdicts {
    /// Tombstones the attested markers apply.
    pub attested: Vec<Pending>,
    /// Markers past their row with no verified attestation, by `(type, id)`.
    pub unattested: Vec<(String, String, KeptMarker)>,
}

enum Verdict {
    Attested(Pending),
    Unattested(String, String, KeptMarker),
}

/// Sorts the markers among `entries` for the `stale` rows they name. An entry
/// neither attested nor unattested is counted and logged; the reconcile logs
/// the unattested ones it keeps a row against.
pub(crate) fn sort(
    entries: &[Json],
    stale: &[HeldRow],
    pull: &PullLoop,
    keys: &SignerKeyMap,
    out: &mut Verdicts,
) {
    let cursors: HashMap<(&str, &str), i64> = stale
        .iter()
        .filter_map(|row| {
            Some((
                (row.item_type.as_str(), row.item_id.as_str()),
                row.server_cursor?,
            ))
        })
        .collect();
    let mut refused = 0usize;
    for entry in entries {
        match admit(entry, &cursors, pull, keys) {
            Some(Verdict::Attested(pending)) => out.attested.push(pending),
            Some(Verdict::Unattested(item_type, item_id, marker)) => {
                out.unattested.push((item_type, item_id, marker));
            }
            None => refused += 1,
        }
    }
    if refused > 0 {
        eprintln!(
            "memry-core: first sync reconcile: refused {refused} purged tombstone(s) that name no stale row or are malformed"
        );
    }
}

/// The tombstone an attested marker among `entries` applies to the one row
/// `(item_type, item_id)` held at `held_cursor`. `None` when no entry for it
/// verifies.
pub(crate) fn attested(
    entries: &[Json],
    item_type: &str,
    item_id: &str,
    held_cursor: i64,
    pull: &PullLoop,
) -> Option<Pending> {
    let cursors = HashMap::from([((item_type, item_id), held_cursor)]);
    entries.iter().find_map(
        |entry| match admit(entry, &cursors, pull, &SignerKeyMap::new())? {
            Verdict::Attested(pending) => Some(pending),
            Verdict::Unattested(..) => None,
        },
    )
}

fn admit(
    entry: &Json,
    cursors: &HashMap<(&str, &str), i64>,
    pull: &PullLoop,
    keys: &SignerKeyMap,
) -> Option<Verdict> {
    let text = |key: &str| {
        entry
            .get(key)
            .and_then(Json::as_str)
            .filter(|t| !t.is_empty())
    };
    let count = |key: &str| entry.get(key).and_then(Json::as_i64).filter(|n| *n >= 0);
    let item_id = text("id")?;
    let item_type = text("type").filter(|name| is_record_item_type(name))?;
    if item_type == CLOCK_EXEMPT_ITEM_TYPE {
        return None;
    }
    let deleted_at = count("deletedAt")?;
    let server_cursor = count("serverCursor")?;
    let held_at = *cursors.get(&(item_type, item_id))?;
    if server_cursor <= held_at {
        return None;
    }
    // A clockless marker (absent, null or empty) can never be attested.
    let clock: Option<VectorClock> = match entry.get("clock").filter(|c| !c.is_null()) {
        None => None,
        Some(clock) => Some(
            clock
                .as_object()?
                .iter()
                .map(|(device, tick)| Some((device.clone(), tick.as_u64()?)))
                .collect::<Option<_>>()?,
        ),
    };
    let unattested = |clock: Option<VectorClock>| {
        Verdict::Unattested(
            item_type.to_owned(),
            item_id.to_owned(),
            KeptMarker {
                deleted_at,
                server_cursor,
                clock,
            },
        )
    };
    let Some(clock) = clock.filter(|clock| !clock.is_empty()) else {
        return Some(unattested(None));
    };
    let verified = text("signerDeviceId")
        .and_then(|signer| {
            pull.signing_key(signer)
                .or_else(|| keys.get(signer).cloned().flatten())
        })
        .zip(text("deleteAttestation"))
        .is_some_and(|(key, attestation)| {
            let claim = DeleteClaim {
                item_type,
                item_id,
                clock: &clock,
                deleted_at,
            };
            delete_attestation::verify(&claim, pull.vault_id(), attestation, &key).is_ok()
        });
    if !verified {
        return Some(unattested(Some(clock)));
    }
    Some(Verdict::Attested(Pending::Tombstone {
        item_type: item_type.to_owned(),
        item_id: item_id.to_owned(),
        deleted_at,
        server_cursor: Some(server_cursor),
        clock: Some(clock),
        body_state_vector: None,
    }))
}

//! The purged markers the manifest reconcile removes a stale row by (chapter
//! 05 §5.12.1, §5.12.3, #5402).
//!
//! A marker is unsigned: the server asserts it. One removes a row only when
//! it names a stale row the reconcile asked about, its type requires a clock,
//! its clock is not empty, its cursor is past the row's, and the deleting
//! device's attestation over `{id, type, deletedAt, clock}` verifies under a
//! key the device directory holds ([`delete_attestation::verify`]). It then
//! applies as the signed tombstone with that clock, under §5.8's clock rule.

use std::collections::HashMap;

use serde_json::Value as Json;

use crate::protocol::delete_attestation::{self, DeleteClaim};
use crate::protocol::types::is_record_item_type;
use crate::sync::apply::Pending;
use crate::sync::clock::VectorClock;
use crate::sync::first_sync_store::HeldRow;
use crate::sync::pull::PullLoop;

/// The one record type with no required clock (chapter 00 §0.7).
const CLOCK_EXEMPT_ITEM_TYPE: &str = "settings";

/// The tombstones the attested markers among `entries` apply, for the
/// `stale` rows they name. Every other entry is counted and logged.
pub(super) fn attested(entries: &[Json], stale: &[HeldRow], pull: &PullLoop) -> Vec<Pending> {
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
    let mut apply = Vec::new();
    for entry in entries {
        match admit(entry, &cursors, pull) {
            Some(pending) => apply.push(pending),
            None => refused += 1,
        }
    }
    if refused > 0 {
        eprintln!(
            "memry-core: first sync reconcile: refused {refused} purged tombstone(s) with no verified attestation for a stale row"
        );
    }
    apply
}

fn admit(entry: &Json, cursors: &HashMap<(&str, &str), i64>, pull: &PullLoop) -> Option<Pending> {
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
    let clock: VectorClock = entry
        .get("clock")?
        .as_object()?
        .iter()
        .map(|(device, tick)| Some((device.clone(), tick.as_u64()?)))
        .collect::<Option<_>>()?;
    if clock.is_empty() {
        return None;
    }
    let key = pull.signing_key(text("signerDeviceId")?)?;
    let claim = DeleteClaim {
        item_type,
        item_id,
        clock: &clock,
        deleted_at,
    };
    delete_attestation::verify(&claim, text("deleteAttestation")?, &key).ok()?;
    Some(Pending::Tombstone {
        item_type: item_type.to_owned(),
        item_id: item_id.to_owned(),
        deleted_at,
        server_cursor: Some(server_cursor),
        clock: Some(clock),
        body_state_vector: None,
    })
}

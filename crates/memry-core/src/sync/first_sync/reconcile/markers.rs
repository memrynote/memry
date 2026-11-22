//! The purged markers the manifest reconcile removes a stale row by (chapter
//! 05 §5.12.1, §5.12.3, #5402).
//!
//! A marker is unsigned: the server asserts it. One removes a row only when
//! it names a stale row the reconcile asked about, its type requires a clock,
//! its clock is not empty ([`purged::Entries::read`]), its cursor is past the
//! row's, and the deleting device's attestation over `{id, type, deletedAt,
//! clock}` verifies under a key the device directory holds
//! ([`purged::attest`]). It then applies as the signed tombstone with that
//! clock, under §5.8's clock rule.
//!
//! The pull's own marker rule ([`purged::applicable`]) is not used here: its
//! local-newer check reads a row's stored time, and a row this first sync
//! seeded from a pack was stored after the delete it never saw. Here only a
//! local change outranks a marker, checked where the row is deleted.

use std::collections::HashMap;

use crate::sync::apply::Pending;
use crate::sync::first_sync_store::HeldRow;
use crate::sync::hardening::purged;
use crate::sync::pull::{PullError, PullLoop};

/// The tombstones the attested markers among `entries` apply, for the
/// `stale` rows they name. Every other entry is counted and logged.
pub(super) async fn attested(
    entries: purged::Entries,
    stale: &[HeldRow],
    pull: &PullLoop,
) -> Result<Vec<Pending>, PullError> {
    let cursors: HashMap<(&str, &str), i64> = stale
        .iter()
        .filter_map(|row| {
            Some((
                (row.item_type.as_str(), row.item_id.as_str()),
                row.server_cursor?,
            ))
        })
        .collect();
    let mut refused = entries.refused;
    let (asked, unasked): (Vec<purged::Marker>, Vec<purged::Marker>) =
        entries.markers.into_iter().partition(|marker| {
            cursors
                .get(&(marker.item_type.as_str(), marker.item_id.as_str()))
                .is_some_and(|held| marker.server_cursor > *held)
        });
    let attested = purged::attest(asked, pull.signer_keys(), pull.http(), &mut refused).await?;
    let dropped = refused.len() + unasked.len();
    if dropped > 0 {
        eprintln!(
            "memry-core: first sync reconcile: refused {dropped} purged tombstone(s) with no verified attestation past a stale row's cursor ({refused:?})"
        );
    }
    Ok(attested
        .into_iter()
        .map(|marker| Pending::Tombstone {
            item_type: marker.item_type,
            item_id: marker.item_id,
            deleted_at: marker.deleted_at,
            server_cursor: Some(marker.server_cursor),
            clock: Some(marker.clock),
            body_state_vector: None,
        })
        .collect())
}

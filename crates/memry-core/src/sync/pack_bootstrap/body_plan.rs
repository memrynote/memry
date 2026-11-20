//! Which packed bodies a reader may apply, as pure functions (chapter 08
//! §8.4.3, §8.10, #5232).
//!
//! Every answer here rests on a [`BodyCheck`] read **after** the reader holds
//! the pack bytes: a body manifest read, or the batch route when the server
//! has no manifest. Nothing packed is applied without one.

use std::collections::HashMap;

/// What the server said about one document, read after the pack bytes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BodyCheck {
    /// The highest purged sequence number. `None` when the answer carried
    /// none, which makes every packed update unusable (§8.4.3).
    pub floor: Option<i64>,
    pub snapshot: ServerSnapshot,
    /// The highest stored update. Only a body manifest answers it, and only
    /// then can a document be proven current without a pull (§8.10).
    pub max_sequence_num: Option<i64>,
}

/// The server's snapshot of a document.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ServerSnapshot {
    None,
    Some {
        sequence_num: i64,
        revision: String,
    },
    /// An old batch answer without `snapshotMeta`: no packed snapshot can be
    /// confirmed and no packed update is used.
    Unknown,
}

/// The planned updates of one document: the sequence numbers to apply in
/// order, and the cursor after them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Planned {
    pub apply: Vec<i64>,
    pub cursor_after: i64,
}

/// §8.4.3 over one document's packed updates, `(sequenceNum, digest)`:
/// nothing without a `floor` read after the pack, nothing when one sequence
/// number carries two digests, and otherwise each update above the floor that
/// is the cursor plus one, until the first that is not. A snapshot's number is
/// never a lower bound (#5248).
///
/// The port of `planPackedUpdates`
/// (`packages/contracts/src/__tests__/pack-container.test.ts`), pinned by
/// `pack-container.json`'s `updatePlans`.
pub fn plan_packed_updates(
    entries: &[(i64, [u8; 32])],
    cursor: i64,
    floor: Option<i64>,
    floor_read_after_pack: bool,
) -> Planned {
    let unusable = Planned {
        apply: Vec::new(),
        cursor_after: cursor,
    };
    let Some(floor) = floor.filter(|_| floor_read_after_pack) else {
        return unusable;
    };
    let mut digests: HashMap<i64, [u8; 32]> = HashMap::with_capacity(entries.len());
    for (sequence_num, digest) in entries {
        if digests
            .insert(*sequence_num, *digest)
            .is_some_and(|seen| seen != *digest)
        {
            return unusable;
        }
    }
    let mut apply = Vec::new();
    let mut at = cursor;
    while at + 1 > floor && digests.contains_key(&(at + 1)) {
        at += 1;
        apply.push(at);
    }
    Planned {
        apply,
        cursor_after: at,
    }
}

/// Whether packed updates may follow the document's snapshot state: the
/// server has no snapshot, or this device holds the very revision it has
/// (§7.8: a cursor below the watermark takes the snapshot first).
pub fn updates_may_follow(check: &BodyCheck, stored_revision: Option<&str>) -> bool {
    match &check.snapshot {
        ServerSnapshot::None => true,
        ServerSnapshot::Some { revision, .. } => stored_revision == Some(revision.as_str()),
        ServerSnapshot::Unknown => false,
    }
}

/// Whether the document holds everything the server has, so it needs no
/// pull: a body manifest answer, a held cursor at or past `maxSequenceNum`,
/// and the server's snapshot held at that cursor. The probe's own rule
/// (`body_pull/probe.rs`), from the manifest instead of a batch request.
pub fn current(check: &BodyCheck, cursor: Option<i64>, stored_revision: Option<&str>) -> bool {
    let (Some(max), Some(cursor)) = (check.max_sequence_num, cursor) else {
        return false;
    };
    if cursor < max {
        return false;
    }
    match &check.snapshot {
        ServerSnapshot::None => true,
        ServerSnapshot::Some {
            sequence_num,
            revision,
        } => cursor > 0 && cursor >= *sequence_num && stored_revision == Some(revision.as_str()),
        ServerSnapshot::Unknown => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn check(snapshot: ServerSnapshot, max: Option<i64>) -> BodyCheck {
        BodyCheck {
            floor: Some(0),
            snapshot,
            max_sequence_num: max,
        }
    }

    fn snap(sequence_num: i64) -> ServerSnapshot {
        ServerSnapshot::Some {
            sequence_num,
            revision: "r".to_owned(),
        }
    }

    #[test]
    fn a_gap_stops_the_plan_and_a_conflicting_digest_voids_it() {
        let entries = [(1, [1; 32]), (2, [2; 32]), (4, [4; 32])];
        let planned = plan_packed_updates(&entries, 0, Some(0), true);
        assert_eq!(planned.apply, vec![1, 2]);
        assert_eq!(planned.cursor_after, 2);
        let conflict = [(1, [1; 32]), (1, [9; 32]), (2, [2; 32])];
        assert!(
            plan_packed_updates(&conflict, 0, Some(0), true)
                .apply
                .is_empty()
        );
    }

    #[test]
    fn a_document_is_current_only_with_the_manifest_head_and_the_revision_held() {
        assert!(current(
            &check(ServerSnapshot::None, Some(5)),
            Some(5),
            None
        ));
        assert!(!current(
            &check(ServerSnapshot::None, Some(5)),
            Some(4),
            None
        ));
        assert!(!current(&check(ServerSnapshot::None, Some(0)), None, None));
        assert!(!current(&check(ServerSnapshot::None, None), Some(9), None));
        assert!(current(&check(snap(3), Some(5)), Some(5), Some("r")));
        assert!(!current(&check(snap(3), Some(5)), Some(5), Some("old")));
        assert!(!current(&check(snap(0), Some(0)), Some(0), Some("r")));
        assert!(!current(
            &check(ServerSnapshot::Unknown, Some(5)),
            Some(5),
            None
        ));
    }

    #[test]
    fn updates_follow_only_a_held_or_absent_snapshot() {
        assert!(updates_may_follow(&check(ServerSnapshot::None, None), None));
        assert!(updates_may_follow(&check(snap(3), None), Some("r")));
        assert!(!updates_may_follow(&check(snap(3), None), None));
        assert!(!updates_may_follow(
            &check(ServerSnapshot::Unknown, None),
            None
        ));
    }
}

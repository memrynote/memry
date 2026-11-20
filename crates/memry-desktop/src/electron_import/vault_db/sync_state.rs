//! Every Electron `sync_state` key and where it goes. Like `TABLE_MAP`, the list is exhaustive:
//! a source key it does not match fails the import with [`super::ImportError::UnmappedSyncStateKey`]
//! before anything is written. Keys come from `SYNC_STATE_KEYS` (`sync/engine/sync-context.ts`)
//! over Electron's history, plus the per-item prefixes written outside it.

use super::{ImportError, TableCtx};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeyMatch {
    Exact(&'static str),
    /// The prefix followed by at least one character (a note or item id).
    Prefix(&'static str),
}

/// Carries one key's `value` to its core destination.
pub type KeyFn = fn(&mut TableCtx<'_>, &str, &str) -> Result<(), ImportError>;

/// What the import does with a key. A key that carries data names its handler, or the stage that
/// writes it, so a carried key without either cannot be written.
#[derive(Debug, Clone, Copy)]
pub enum KeyRule {
    /// Dropped into the report.
    Skip { reason: &'static str },
    /// Carried by a handler the named stage writes; a source holding the key fails the import
    /// with [`ImportError::NotReady`].
    Pending {
        stage: &'static str,
        reason: &'static str,
    },
    /// Carried by `handler`, which the `sync_state` table's importer runs per key.
    Convert {
        handler: KeyFn,
        reason: &'static str,
    },
}

#[derive(Debug, Clone, Copy)]
pub struct SyncStateKey {
    pub key: KeyMatch,
    pub rule: KeyRule,
}

impl SyncStateKey {
    fn matches(&self, key: &str) -> bool {
        match self.key {
            KeyMatch::Exact(exact) => key == exact,
            KeyMatch::Prefix(prefix) => key.len() > prefix.len() && key.starts_with(prefix),
        }
    }

    /// The report line a dropped key counts under: the key, or the prefix of a prefixed key.
    pub fn report_name(&self) -> String {
        match self.key {
            KeyMatch::Exact(key) | KeyMatch::Prefix(key) => format!("syncState.{key}"),
        }
    }
}

/// A key carried to the core once stage 36c writes its handler.
const fn convert(key: KeyMatch, reason: &'static str) -> SyncStateKey {
    SyncStateKey {
        key,
        rule: KeyRule::Pending {
            stage: "36c",
            reason,
        },
    }
}

const fn skip(key: KeyMatch, reason: &'static str) -> SyncStateKey {
    SyncStateKey {
        key,
        rule: KeyRule::Skip { reason },
    }
}

use KeyMatch::{Exact, Prefix};

pub const SYNC_STATE_KEYS: &[SyncStateKey] = &[
    convert(
        Exact("lastCursor"),
        "sync_cursors scope record, cursor text copied",
    ),
    skip(
        Exact("lastSyncAt"),
        "session status; Electron clears it per session and core keeps it in memory",
    ),
    convert(
        Exact("syncPaused"),
        "Step 17 pause state: a paused vault stays paused",
    ),
    convert(
        Exact("initialSeedDone"),
        "Step 17 seed rule: clock-less syncable rows get an upsert",
    ),
    convert(Exact("quarantinedItems"), "Step 17 sync_quarantine ledger"),
    convert(
        Exact("schemaInvalidItems"),
        "Step 17 refused items; non-empty means lastCursor is not copied",
    ),
    convert(
        Exact("cursorSkipRepair"),
        "Step 17 cursor repair; non-empty means lastCursor is not copied",
    ),
    skip(
        Exact("noteBodyFeedCursor"),
        "core pulls per document and defines no note body feed cursor",
    ),
    skip(
        Exact("noteBodyLegacySweep"),
        "core pulls per document and runs no legacy note body sweep",
    ),
    convert(
        Exact("packsAppliedThroughCursor"),
        "Step 17 pack_bootstrap applied-through cursor",
    ),
    skip(
        Exact("packSeedSettlePending"),
        "pack seed settling is Electron's; dropped with a report line",
    ),
    skip(
        Prefix("packSeeded:"),
        "pack seed settling is Electron's; dropped with a report line",
    ),
    skip(
        Exact("lastManifestCheckAt"),
        "throttle only: the next manifest check runs early",
    ),
    skip(
        Exact("crdtStoreEpoch"),
        "store and database come from one snapshot, nothing left to mismatch",
    ),
    skip(
        Exact("crdtBodyDebtMirrorAt"),
        "store and database come from one snapshot, nothing left to mismatch",
    ),
    convert(
        Exact("crdtUnmergedDebt"),
        "marks every document owed as a core body debt",
    ),
    skip(
        Exact("lastCrdtSweepAt"),
        "retired in #2421; the row stays only for older Electron builds",
    ),
    convert(
        Prefix("journalDayMerge:"),
        "an owed journal day merge (sync/journal-day-merge.ts); destination set by 36c",
    ),
    convert(
        Prefix("note-cover:"),
        "an owed note cover sync marker (item-handlers/note-cover-sync.ts); destination set by 36c",
    ),
];

pub fn classify(key: &str) -> Option<&'static SyncStateKey> {
    SYNC_STATE_KEYS.iter().find(|rule| rule.matches(key))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prefixes_need_an_id_and_exact_keys_match_exactly() {
        assert!(classify("packSeeded:").is_none());
        assert!(classify("packSeeded:-0QKFMSbJ-18").is_some());
        assert!(classify("lastCursor").is_some());
        assert!(classify("lastCursor ").is_none());
        assert!(classify("LASTCURSOR").is_none());
        assert!(matches!(
            classify("note-cover:x").unwrap().rule,
            KeyRule::Pending { .. }
        ));
    }

    #[test]
    fn no_key_matches_two_rules() {
        for rule in SYNC_STATE_KEYS {
            let sample = match rule.key {
                KeyMatch::Exact(key) => key.to_owned(),
                KeyMatch::Prefix(prefix) => format!("{prefix}id"),
            };
            let hits = SYNC_STATE_KEYS
                .iter()
                .filter(|r| r.matches(&sample))
                .count();
            assert_eq!(hits, 1, "{sample}");
        }
    }
}

//! Every Electron `sync_state` key and where it goes. Like `TABLE_MAP`, the list is exhaustive:
//! a source key it does not match fails the import with [`super::ImportError::UnmappedSyncStateKey`]
//! before anything is written. Keys come from `SYNC_STATE_KEYS` (`sync/engine/sync-context.ts`)
//! over Electron's history, plus the per-item prefixes written outside it.

use super::tables::Class;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeyMatch {
    Exact(&'static str),
    /// The prefix followed by at least one character (a note or item id).
    Prefix(&'static str),
}

#[derive(Debug, Clone, Copy)]
pub struct SyncStateKey {
    pub key: KeyMatch,
    /// `Convert` carries the value to a core destination, `Skip` drops it into the report.
    pub class: Class,
    pub pending: Option<&'static str>,
    pub reason: &'static str,
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

const fn convert(key: KeyMatch, reason: &'static str) -> SyncStateKey {
    SyncStateKey {
        key,
        class: Class::Convert,
        pending: Some("36c"),
        reason,
    }
}

const fn skip(key: KeyMatch, reason: &'static str) -> SyncStateKey {
    SyncStateKey {
        key,
        class: Class::Skip,
        pending: None,
        reason,
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
        assert!(classify("note-cover:x").unwrap().pending.is_some());
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

use memry_test_kit::{on_small_stack, proptest_config};
use proptest::prelude::*;

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

/// Every `sync_state` key Electron writes on origin/main (18 Nov 2026), a prefix with an id:
/// `SYNC_STATE_KEYS` in `apps/desktop/src/main/sync/engine/sync-context.ts`, `initialSeedDone`
/// (`sync/initial-seed.ts`), `declinedSyncRefs` (`packages/sync-client/src/declined-refs.ts`),
/// `packSeeded:` (`sync/engine/pack-seeded-docs.ts`), `journalDayMerge:`
/// (`sync/journal-day-merge.ts`) and `note-cover:` (`sync/item-handlers/note-cover-sync.ts`).
/// `lastCrdtSweepAt` is retired (#2421), but older builds wrote it. Found by
/// `git grep -nE "setStateValue\(|insert\(syncState\)"` over those two trees; a new writer
/// goes here and in [`SYNC_STATE_KEYS`].
const ELECTRON_KEYS: &[&str] = &[
    "lastCursor",
    "lastSyncAt",
    "syncPaused",
    "initialSeedDone",
    "quarantinedItems",
    "lastManifestCheckAt",
    "lastCrdtSweepAt",
    "crdtUnmergedDebt",
    "crdtBodyDebtMirrorAt",
    "packsAppliedThroughCursor",
    "packSeedSettlePending",
    "cursorSkipRepair",
    "schemaInvalidItems",
    "noteBodyLegacySweep",
    "noteBodyFeedCursor",
    "crdtStoreEpoch",
    "declinedSyncRefs",
    "packSeeded:n-1",
    "journalDayMerge:2026-11-18",
    "note-cover:n-1",
];

#[test]
fn the_rules_are_exactly_electrons_keys() {
    for key in ELECTRON_KEYS {
        assert!(classify(key).is_some(), "{key} has no rule");
    }
    for rule in SYNC_STATE_KEYS {
        assert!(
            ELECTRON_KEYS.iter().any(|key| rule.matches(key)),
            "{} matches no Electron key",
            rule.report_name()
        );
    }
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

fn handlers() -> Vec<KeyFn> {
    SYNC_STATE_KEYS
        .iter()
        .filter_map(|key| match key.rule {
            KeyRule::Convert { handler, .. } => Some(handler),
            _ => None,
        })
        .collect()
}

/// serde_json's recursion limit (128) bounds the depth: a ledger nested far deeper is
/// unreadable, on a thread with a 2 MiB stack.
#[test]
fn a_deeply_nested_ledger_is_unreadable_not_a_stack_overflow() {
    on_small_stack(|| {
        let deep = format!("{}{}", "[".repeat(100_000), "]".repeat(100_000));
        let nested = format!(r#"{{"entries":{deep}}}"#);
        for value in [deep.as_str(), nested.as_str()] {
            let mut plan = SyncStatePlan::default();
            assert!(matches!(
                quarantined_items(&mut plan, value),
                Carried::Dropped(_)
            ));
            assert!(matches!(
                schema_invalid_items(&mut plan, value),
                Carried::Dropped(_)
            ));
        }
        let entry = format!(r#"{{"k":{deep}}}"#);
        let mut plan = SyncStatePlan::default();
        assert_eq!(
            schema_invalid_items(&mut plan, &entry),
            Carried::Dropped("unreadableSchemaInvalidState")
        );
    });
}

/// One ledger entry is one row: the work grows with the entries and nothing else.
#[test]
fn a_ledger_of_n_entries_plans_n_rows() {
    let entries: Vec<String> = (0..2_000)
        .map(|n| {
            format!(
                r#""t:{n}":{{"id":"{n}","type":"t","kind":"payload","lastRefusedByVersion":"1","failedAt":{n}}}"#
            )
        })
        .collect();
    let mut plan = SyncStatePlan::default();
    let value = format!("{{{}}}", entries.join(","));
    assert_eq!(schema_invalid_items(&mut plan, &value), Carried::Written);
    assert_eq!(plan.state.refused.len(), 2_000);
}

#[test]
fn cursors_carry_only_what_electron_reads_as_an_integer() {
    for (value, carried) in [
        ("4200", Some("4200")),
        ("0", Some("0")),
        ("007", Some("7")),
        ("", None),
        ("-1", None),
        ("1e3", None),
        ("99999999999999999999", None),
    ] {
        let mut plan = SyncStatePlan::default();
        last_cursor(&mut plan, value);
        assert_eq!(
            plan.state.record_cursor.as_ref().map(|c| c.cursor.as_str()),
            carried,
            "{value:?}"
        );
    }
}

proptest! {
    #![proptest_config(proptest_config(256))]

    /// Any value: no handler panics, and planning it twice gives the same state, which is what
    /// stage check 5 relies on.
    #[test]
    fn any_value_plans_the_same_twice(value in ".{0,64}|\\{.{0,64}\\}|\\[.{0,64}\\]") {
        for handler in handlers() {
            let mut first = SyncStatePlan::default();
            let mut second = SyncStatePlan::default();
            let a = handler(&mut first, &value);
            let b = handler(&mut second, &value);
            prop_assert_eq!(a, b);
            prop_assert_eq!(&first.state, &second.state);
        }
    }
}

use super::*;

#[test]
fn the_apply_order_ranks_the_four_tiers_and_defaults_to_one() {
    assert_eq!(apply_rank("project"), 0);
    assert_eq!(apply_rank("note"), 1);
    assert_eq!(apply_rank("hologram"), 1);
    assert_eq!(apply_rank("task"), 2);
    assert_eq!(apply_rank("calendar_binding"), 3);
}

#[test]
fn the_two_field_merged_types_are_the_two_chapter_06_names() {
    // §6.8 is an enumeration, not a heuristic. If either constant ever
    // drifts, the dispatch silently stops merging and the last writer
    // wins the whole payload again.
    assert_eq!(tasks::ITEM_TYPE, "task");
    assert_eq!(projects::ITEM_TYPE, "project");
    // And the third row is named rather than falling through `_`: §6.9's
    // dotted paths are a different algorithm from §6.3.1's document gate,
    // and folding one into the other is what §6.8 forbids.
    assert_eq!(settings::SETTINGS_ITEM_TYPE, "settings");
}

// #2409: a late tombstone the revived row already dominates keeps it; a
// tombstone with no clock has nothing to weigh and applies as before.
#[test]
fn a_tombstone_older_than_a_revived_row_is_skipped_and_a_clockless_one_still_applies() {
    use crate::domain::journal;
    use crate::storage::{open_data, test_support::temp_dir};
    use crate::sync::clock::clock_of;

    let dir = temp_dir("apply-late-tombstone");
    let db = open_data(&dir.path().join("data.db")).expect("open data.db");
    let delete = |clock| Pending::Tombstone {
        item_type: "journal".to_owned(),
        item_id: "j2026-04-16".to_owned(),
        deleted_at: 5,
        server_cursor: None,
        clock,
    };
    let live = |conn: &Connection| -> bool {
        sync_items::load(conn, "journal", "j2026-04-16")
            .expect("read")
            .is_some_and(|row| row.deleted_at.is_none())
    };
    db.call_blocking(|conn| {
        journal::open_day(conn, "2026-04-16", "device-a", 1)?;
        let first = clock_of([("device-a", 1), ("device-b", 1)]);
        assert_eq!(
            apply_page(conn, vec![delete(Some(first.clone()))], vec![], 2, None)?.deleted,
            1
        );
        journal::open_day(conn, "2026-04-16", "device-a", 3)?;

        let late = apply_page(conn, vec![delete(Some(first))], vec![], 4, None)?;
        assert_eq!((late.deleted, late.skipped), (0, 1));
        assert!(live(conn));

        let clockless = apply_page(conn, vec![delete(None)], vec![], 5, None)?;
        assert_eq!(clockless.deleted, 1);
        assert!(!live(conn));
        Ok(())
    })
    .expect("late tombstone");
}

#[test]
fn a_merge_outcome_maps_onto_the_pull_vocabulary_without_a_silent_skip() {
    assert_eq!(outcome(Inbound::Applied), ApplyOutcome::Applied);
    assert_eq!(
        outcome(Inbound::Merged {
            conflicted_fields: vec!["title".to_owned()],
        }),
        ApplyOutcome::Applied
    );
    assert_eq!(outcome(Inbound::Skipped), ApplyOutcome::Skipped);
    assert_eq!(
        outcome(Inbound::Corrupt {
            reason: "bad".to_owned(),
        }),
        ApplyOutcome::Corrupt {
            reason: "bad".to_owned(),
        }
    );
}

use rusqlite::{Connection, params};

use super::*;
use crate::storage::{open_data, test_support::temp_dir};

const NOW: i64 = 1_760_000_000_000;
const DAY: i64 = 24 * 60 * 60 * 1000;

fn fail(conn: &Connection, id: &str, at: i64) -> SecurityWarning {
    record_failure(
        conn,
        "task",
        id,
        "dev-x",
        "record signature did not verify",
        at,
    )
    .expect("record")
}

fn is_blocked(conn: &Connection, id: &str, at: i64) -> bool {
    blocked(conn, at)
        .expect("blocked")
        .contains(&("task".to_owned(), id.to_owned()))
}

#[test]
fn the_third_failure_is_permanent_and_survives_a_reopen() {
    let dir = temp_dir("quarantine-reopen");
    let path = dir.path().join("data.db");
    let db = open_data(&path).expect("open");
    db.call_blocking(|conn| {
        assert_eq!(fail(conn, "t1", NOW).attempt_count, 1);
        assert!(!fail(conn, "t1", NOW + 1).permanent);
        assert!(!is_blocked(conn, "t1", NOW + 1));
        let third = fail(conn, "t1", NOW + 2);
        assert_eq!((third.attempt_count, third.permanent), (3, true));
        // Keyed by (type, id): a project of the same id is not touched.
        record_failure(conn, "project", "t1", "dev-x", "bad", NOW + 2)?;
        assert!(!blocked(conn, NOW + 2)?.contains(&("project".to_owned(), "t1".to_owned())));
        Ok(())
    })
    .expect("quarantine");
    drop(db);

    let db = open_data(&path).expect("reopen");
    db.call_blocking(|conn| {
        assert!(is_blocked(conn, "t1", NOW + 3));
        let listed = entries(conn, NOW + 3)?;
        assert_eq!(listed.len(), 2);
        assert!(
            listed
                .iter()
                .any(|entry| entry.item_id == "t1" && entry.permanent)
        );
        Ok(())
    })
    .expect("reopened");
}

#[test]
fn a_permanent_entry_expires_seven_days_after_its_last_failure() {
    let dir = temp_dir("quarantine-ttl");
    let db = open_data(&dir.path().join("data.db")).expect("open");
    db.call_blocking(|conn| {
        for at in 0..3 {
            fail(conn, "t1", NOW + at);
        }
        assert!(is_blocked(conn, "t1", NOW + 7 * DAY + 1));
        assert!(!is_blocked(conn, "t1", NOW + 7 * DAY + 2));
        assert!(entries(conn, NOW + 7 * DAY + 2)?.is_empty());
        // An expired entry starts again at one.
        assert_eq!(fail(conn, "t1", NOW + 7 * DAY + 2).attempt_count, 1);
        Ok(())
    })
    .expect("ttl");
}

#[test]
fn the_cap_evicts_the_oldest_partial_entries_and_never_a_permanent_one() {
    let dir = temp_dir("quarantine-cap");
    let db = open_data(&dir.path().join("data.db")).expect("open");
    db.call_blocking(|conn| {
        // The oldest entry is permanent, then MAX_ENTRIES - 1 partial ones.
        for at in 0..3 {
            fail(conn, "permanent", NOW + at);
        }
        let transaction = conn.unchecked_transaction().expect("tx");
        for index in 1..MAX_ENTRIES {
            transaction
                .execute(
                    "INSERT INTO sync_quarantine VALUES ('task', ?1, 'dev-x', ?2, 1, 'bad')",
                    params![format!("partial-{index:05}"), NOW + 10 + index],
                )
                .expect("seed");
        }
        transaction.commit().expect("commit");

        fail(conn, "newest", NOW + 2 * MAX_ENTRIES);
        let listed = entries(conn, NOW + 2 * MAX_ENTRIES)?;
        assert_eq!(listed.len() as i64, MAX_ENTRIES);
        let ids: Vec<&str> = listed.iter().map(|entry| entry.item_id.as_str()).collect();
        assert!(ids.contains(&"permanent"), "a permanent entry was evicted");
        assert!(
            !ids.contains(&"partial-00001"),
            "the oldest partial one stays"
        );
        assert!(ids.contains(&"partial-00002"));
        assert!(ids.contains(&"newest"));
        Ok(())
    })
    .expect("cap");
}

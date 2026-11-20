//! The attachment stores against a real `data.db` file, opened and migrated as
//! the app opens it.

use rusqlite::{Connection, params};

use super::download_failures::{self as failures, FailureReason};
use super::files::{self, COUNTED_EMPTY, StoredFile};
use super::releases::{self, DeletedItem, ItemType, RecordedIds};
use super::upload_queue::{self as queue, DRAIN_BATCH_LIMIT, RETRY_MAX_MS, STUCK_UPLOAD_ATTEMPTS};
use crate::api::errors::StorageError;
use crate::storage::test_support::{TempDir, temp_dir};
use crate::storage::{Db, open_data};

const MINUTE: i64 = 60 * 1000;
const HOUR: i64 = 60 * MINUTE;
const DAY: i64 = 24 * HOUR;

fn vault() -> (TempDir, Db) {
    let dir = temp_dir("attachment-store");
    let db = open_data(&dir.path().join("data.db")).expect("open data.db");
    (dir, db)
}

fn with<T>(db: &Db, f: impl FnOnce(&Connection) -> Result<T, StorageError>) -> T {
    db.call_blocking(|conn| f(conn)).expect("store call")
}

fn sql(conn: &Connection, statement: &str) -> Result<(), StorageError> {
    conn.execute_batch(statement)
        .map_err(|err| StorageError::Failed {
            what: err.to_string(),
        })
}

#[test]
fn a_queued_upload_keeps_one_row_its_attempts_and_its_window() {
    let (_dir, db) = vault();
    with(&db, |conn| {
        queue::enqueue(conn, "n1", "/v/a.png", 1_000)?;
        assert_eq!(queue::mark_failed(conn, "n1", "/v/a.png", "503", 2_000)?, 1);
        // The backfill finds the file again: the failed row keeps its window.
        assert!(!queue::queue_if_absent(conn, "n1", "/v/a.png", 3_000)?);
        // A save queues it again: the attempts stay, the write time moves.
        queue::enqueue(conn, "n1", "/v/a.png", 4_000)?;
        let rows = queue::list_pending(conn, 10)?;
        assert_eq!(rows.len(), 1);
        assert_eq!((rows[0].attempts, rows[0].updated_at), (1, 4_000));

        assert!(queue::queue_if_absent(conn, "n1", "/v/b.png", 5_000)?);
        assert!(queue::has_pending(conn, "n1", "/v/b.png")?);
        assert!(!queue::has_pending(conn, "n2", "/v/b.png")?);
        queue::clear(conn, "n1", "/v/a.png")?;
        queue::clear(conn, "n1", "/v/b.png")?;
        assert!(!queue::owner_has_pending(conn, "n1")?);
        assert!(queue::list_pending(conn, 10)?.is_empty());
        Ok(())
    });
}

#[test]
fn a_failed_upload_waits_one_minute_doubling_to_six_hours_and_is_stuck_at_five() {
    let (_dir, db) = vault();
    with(&db, |conn| {
        queue::enqueue(conn, "n1", "/v/a.png", 0)?;
        assert_eq!(
            queue::list_due(conn, 0)?.len(),
            1,
            "a new row is due at once"
        );

        let mut now = 0;
        for attempt in 1..=12_u32 {
            let attempts = queue::mark_failed(conn, "n1", "/v/a.png", "boom", now)?;
            assert_eq!(attempts, attempt);
            assert_eq!(attempts == STUCK_UPLOAD_ATTEMPTS, attempt == 5);
            let wait = (MINUTE << (attempt - 1)).min(RETRY_MAX_MS);
            assert!(
                queue::list_due(conn, now + wait - 1)?.is_empty(),
                "{attempt}"
            );
            assert_eq!(queue::list_due(conn, now + wait)?.len(), 1, "{attempt}");
            now += wait;
        }
        // A count far past any shift width still waits the cap.
        sql(
            conn,
            &format!(
                "UPDATE attachment_upload_queue SET attempts = 4294967295, updated_at = {now}"
            ),
        )?;
        assert!(queue::list_due(conn, now + RETRY_MAX_MS - 1)?.is_empty());
        assert_eq!(queue::list_due(conn, now + RETRY_MAX_MS)?.len(), 1);
        Ok(())
    });
}

/// Electron's `retryOpensAt` opens a never-failed row at 0, not at its write
/// time, so a row written ahead of this device's clock is still due.
#[test]
fn a_never_failed_upload_is_due_even_when_written_ahead_of_the_clock() {
    let (_dir, db) = vault();
    with(&db, |conn| {
        queue::enqueue(conn, "n1", "/v/a.png", 5_000)?;
        let due = queue::list_due(conn, 1_000)?;
        assert_eq!(due.len(), 1);
        assert_eq!(due[0].retry_opens_at(), 0);
        Ok(())
    });
}

#[test]
fn a_failure_of_a_row_that_went_missing_queues_it_again() {
    let (_dir, db) = vault();
    with(&db, |conn| {
        assert_eq!(queue::mark_failed(conn, "n1", "/v/a.png", "x", 10)?, 1);
        assert!(queue::has_pending(conn, "n1", "/v/a.png")?);
        Ok(())
    });
}

#[test]
fn local_only_rows_stay_queued_and_never_fill_the_batch() {
    let (_dir, db) = vault();
    with(&db, |conn| {
        sql(
            conn,
            "INSERT INTO note_files (note_id, path, local_only, indexed_at)
             VALUES ('private', 'private.md', 1, 0), ('shared', 'shared.md', 0, 0)",
        )?;
        for index in 0..DRAIN_BATCH_LIMIT {
            queue::enqueue(conn, "private", &format!("/v/p{index}.png"), index as i64)?;
        }
        for index in 0..=DRAIN_BATCH_LIMIT {
            let at = 1_000 + index as i64;
            queue::enqueue(conn, "shared", &format!("/v/s{index}.png"), at)?;
        }
        let due = queue::list_due(conn, 10_000)?;
        assert_eq!(due.len(), DRAIN_BATCH_LIMIT);
        assert!(due.iter().all(|row| row.owner_id == "shared"));
        assert_eq!(due[0].disk_path, "/v/s0.png", "oldest first");
        // Every row is still there, the local-only ones included.
        assert_eq!(queue::list_all(conn)?.len(), 2 * DRAIN_BATCH_LIMIT + 1);
        assert_eq!(queue::list_pending(conn, 3)?.len(), 3);
        assert!(queue::list_pending(conn, 0)?.is_empty());
        Ok(())
    });
}

#[test]
fn a_404_is_probed_a_day_apart_three_times_then_never_again() {
    let (_dir, db) = vault();
    with(&db, |conn| {
        assert!(failures::may_attempt(conn, "n1", "a1", 0)?, "no row");
        let mut now = 0;
        for probe in 1..=2 {
            let failure =
                failures::record_failure(conn, "n1", "a1", FailureReason::Missing, "404", now)?;
            assert_eq!(failure.attempts, probe);
            assert_eq!(failure.next_attempt_at, Some(now + DAY));
            assert!(!failures::may_attempt(conn, "n1", "a1", now + DAY - 1)?);
            assert!(failures::may_attempt(conn, "n1", "a1", now + DAY)?);
            now += DAY;
        }
        let last = failures::record_failure(conn, "n1", "a1", FailureReason::Missing, "404", now)?;
        assert_eq!((last.attempts, last.next_attempt_at), (3, None));
        assert!(!failures::may_attempt(conn, "n1", "a1", i64::MAX)?);
        assert!(failures::list_redrivable(conn, i64::MAX, 10)?.is_empty());

        // This device uploads it again: the way back.
        failures::clear(conn, "n1", "a1")?;
        assert!(failures::may_attempt(conn, "n1", "a1", now)?);
        Ok(())
    });
}

#[test]
fn a_transient_failure_backs_off_to_six_hours_and_counts_apart_from_404s() {
    let (_dir, db) = vault();
    with(&db, |conn| {
        failures::record_failure(conn, "n1", "a1", FailureReason::Missing, "404", 0)?;
        for attempt in 1..=12_u32 {
            let failure =
                failures::record_failure(conn, "n1", "a1", FailureReason::Transient, "503", 0)?;
            assert_eq!(
                failure.attempts, attempt,
                "a reason change restarts the count"
            );
            let wait = (MINUTE << (attempt - 1)).min(6 * HOUR);
            assert_eq!(failure.next_attempt_at, Some(wait));
        }
        let back = failures::record_failure(conn, "n1", "a1", FailureReason::Missing, "404", 0)?;
        assert_eq!(back.attempts, 1, "the 503s spent none of the 404 budget");
        Ok(())
    });
}

#[test]
fn a_reason_no_build_writes_restarts_the_count() {
    let (_dir, db) = vault();
    with(&db, |conn| {
        sql(
            conn,
            "INSERT INTO attachment_download_failures
               (id, owner_id, attachment_id, reason, attempts, next_attempt_at, updated_at)
             VALUES ('n1::a1', 'n1', 'a1', 'quota', 7, 0, 0)",
        )?;
        let failure =
            failures::record_failure(conn, "n1", "a1", FailureReason::Transient, "503", 0)?;
        assert_eq!(failure.attempts, 1);
        assert_eq!(failure.next_attempt_at, Some(MINUTE));
        Ok(())
    });
}

#[test]
fn the_redrive_lists_open_windows_oldest_first() {
    let (_dir, db) = vault();
    with(&db, |conn| {
        failures::record_failure(conn, "n1", "late", FailureReason::Transient, "x", 50)?;
        failures::record_failure(conn, "n1", "early", FailureReason::Transient, "x", 10)?;
        failures::record_failure(conn, "c1", "img", FailureReason::Missing, "404", 20)?;
        failures::record_failure(
            conn,
            "n2",
            "future",
            FailureReason::Transient,
            "x",
            10 * DAY,
        )?;
        let open = failures::list_redrivable(conn, 2 * DAY, 10)?;
        let ids: Vec<_> = open.iter().map(|row| row.attachment_id.as_str()).collect();
        assert_eq!(ids, ["early", "img", "late"]);
        assert_eq!(open[1].reason, FailureReason::Missing);
        assert_eq!(failures::list_redrivable(conn, 2 * DAY, 1)?.len(), 1);
        Ok(())
    });
}

fn give_up(conn: &Connection, owner: &str, attachment: &str) -> Result<(), StorageError> {
    for _ in 0..failures::MISSING_PROBE_LIMIT {
        failures::record_failure(conn, owner, attachment, FailureReason::Missing, "404", 0)?;
    }
    Ok(())
}

#[test]
fn a_reference_is_gone_only_on_three_404s_and_no_pending_upload() {
    let (_dir, db) = vault();
    with(&db, |conn| {
        give_up(conn, "n1", "gone")?;
        failures::record_failure(conn, "n1", "once", FailureReason::Missing, "404", 0)?;
        failures::record_failure(conn, "n1", "blip", FailureReason::Transient, "503", 0)?;
        give_up(conn, "n2", "other-owner")?;
        let refs: Vec<String> = ["gone", "once", "blip", "never-probed", "other-owner"]
            .map(String::from)
            .to_vec();
        let gone = failures::proven_gone(conn, "n1", &refs)?;
        assert_eq!(gone.into_iter().collect::<Vec<_>>(), ["gone"]);

        // Bytes of the note are still on their way up: nothing is proven.
        queue::enqueue(conn, "n1", "/v/new.png", 0)?;
        assert!(failures::proven_gone(conn, "n1", &refs)?.is_empty());
        queue::clear(conn, "n1", "/v/new.png")?;

        // A peer's note can name more ids than SQLite binds in one statement.
        let mut many: Vec<String> = (0..40_000).map(|i| format!("ref-{i}")).collect();
        many.push("gone".to_owned());
        assert_eq!(failures::proven_gone(conn, "n1", &many)?.len(), 1);
        assert!(failures::proven_gone(conn, "n1", &[])?.is_empty());
        Ok(())
    });
}

#[test]
fn a_record_counts_known_files_without_overwriting_an_upload() {
    let (_dir, db) = vault();
    with(&db, |conn| {
        files::record(conn, "n1", "attachments/n1/abc123-a.png", "att-a", 10)?;
        files::count_known(
            conn,
            "n1",
            &[
                "attachments/n1/abc123-a.png".to_owned(),
                "sources/b.pdf".to_owned(),
            ],
            20,
        )?;
        files::count_known(conn, "n2", &[], 20)?;
        assert_eq!(
            files::records(conn, "n1")?,
            [
                StoredFile {
                    path: "attachments/n1/abc123-a.png".to_owned(),
                    attachment_id: Some("att-a".to_owned()),
                },
                StoredFile {
                    path: "sources/b.pdf".to_owned(),
                    attachment_id: None,
                },
            ]
        );
        assert_eq!(
            files::records(conn, "n2")?,
            [StoredFile {
                path: COUNTED_EMPTY.to_owned(),
                attachment_id: None,
            }]
        );
        let owners: Vec<_> = files::owners_with_records(conn)?.into_iter().collect();
        assert_eq!(owners, ["n1", "n2"]);

        // A later upload of a counted file names it.
        files::record(conn, "n1", "sources/b.pdf", "att-b", 30)?;
        assert_eq!(
            files::path_of(conn, "n1", "att-b")?.as_deref(),
            Some("sources/b.pdf")
        );
        assert_eq!(files::path_of(conn, "n2", "att-b")?, None);
        Ok(())
    });
}

#[test]
fn a_moved_record_replaces_the_target_and_a_missing_source_drops_the_stale_target() {
    let (_dir, db) = vault();
    with(&db, |conn| {
        files::record(conn, "n1", "attachments/n1/x.txt", "att-x", 10)?;
        files::count_known(conn, "n1", &["sources/x.txt".to_owned()], 10)?;
        files::move_record(conn, "n1", "attachments/n1/x.txt", "sources/x.txt", 20)?;
        assert_eq!(
            files::records(conn, "n1")?,
            [StoredFile {
                path: "sources/x.txt".to_owned(),
                attachment_id: Some("att-x".to_owned()),
            }]
        );
        // The file at the target is the placed one: the row there is stale.
        files::move_record(conn, "n1", "attachments/n1/none.txt", "sources/x.txt", 30)?;
        assert!(files::records(conn, "n1")?.is_empty());
        Ok(())
    });
}

#[test]
fn a_recorded_delete_is_due_at_its_cutoff_and_restarts_when_recorded_again() {
    let (_dir, db) = vault();
    with(&db, |conn| {
        let ids = ["a1".to_owned(), "a2".to_owned()];
        releases::record(conn, ItemType::Note, "n1", Some(&ids), 100)?;
        releases::record(conn, ItemType::Canvas, "c1", None, 50)?;
        releases::record(conn, ItemType::Inbox, "i1", Some(&ids[..1]), 300)?;
        assert!(releases::due(conn, 49)?.is_empty());
        let due = releases::due(conn, 100)?;
        assert_eq!(
            due,
            [
                DeletedItem {
                    item_type: Ok(ItemType::Canvas),
                    item_id: "c1".to_owned(),
                    deleted_at: 50,
                    attachment_ids: RecordedIds::None,
                },
                DeletedItem {
                    item_type: Ok(ItemType::Note),
                    item_id: "n1".to_owned(),
                    deleted_at: 100,
                    attachment_ids: RecordedIds::Ids(ids.to_vec()),
                },
            ]
        );
        // Deleted again after a restore: the grace runs from the new delete.
        releases::record(conn, ItemType::Note, "n1", Some(&ids[1..]), 200)?;
        assert_eq!(releases::due(conn, 100)?.len(), 1);
        let held: Vec<_> = releases::held_by_recent_note_deletes(conn, 100)?
            .into_iter()
            .collect();
        assert_eq!(
            held,
            ["a2"],
            "only a note inside its grace holds, and inbox never"
        );
        assert!(releases::held_by_recent_note_deletes(conn, 200)?.is_empty());

        releases::remove(conn, "canvas", "c1")?;
        let left: Vec<_> = releases::due(conn, i64::MAX)?
            .into_iter()
            .map(|item| item.item_id)
            .collect();
        assert_eq!(left, ["n1", "i1"]);
        Ok(())
    });
}

#[test]
fn an_unreadable_release_record_frees_nothing_and_blocks_the_hold_set() {
    let (_dir, db) = vault();
    with(&db, |conn| {
        conn.execute(
            "INSERT INTO deleted_asset_releases (item_type, item_id, deleted_at, attachment_ids)
             VALUES ('note', 'bad', 10, ?1), ('folder', 'odd', 10, NULL), ('note', 'obj', 10, ?2)",
            params!["[\"a1\",", "{\"ids\":[\"a1\"]}"],
        )
        .map_err(|err| StorageError::Failed {
            what: err.to_string(),
        })?;
        let due = releases::due(conn, 10)?;
        assert_eq!(due.len(), 3);
        let by_id = |id: &str| due.iter().find(|item| item.item_id == id).expect("row");
        assert_eq!(by_id("bad").attachment_ids, RecordedIds::Unreadable);
        assert_eq!(by_id("obj").attachment_ids, RecordedIds::Unreadable);
        assert_eq!(by_id("odd").item_type, Err("folder".to_owned()));
        assert!(releases::held_by_recent_note_deletes(conn, 9).is_err());
        assert!(releases::held_by_recent_note_deletes(conn, 10)?.is_empty());
        Ok(())
    });
}

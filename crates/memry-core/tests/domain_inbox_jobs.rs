//! The Inbox job queue (`jobs.ts`) against real SQLite: one job per capture
//! and type, claim order, retry and final failure, stale finishes, and
//! resume after a quit or crash.

use memry_core::domain::inbox::jobs::{self, InboxJob, InboxJobStatus, InboxJobType};
use memry_core::domain::inbox::states;
use memry_core::domain::inbox::write::{self, Captured};
use memry_core::storage::{Db, open_data};
use rusqlite::{Connection, params};

const NOW: i64 = 1_790_251_200_000;
const DEVICE: &str = "desk";

fn open(label: &str) -> Db {
    let dir = tempfile::Builder::new()
        .prefix(&format!("memry-inbox-jobs-{label}-"))
        .tempdir()
        .expect("the scratch directory")
        .keep();
    open_data(&dir.join("data.db")).expect("open data.db")
}

fn run(job: &InboxJob) -> &str {
    job.run_id.as_deref().expect("a claimed job has a run")
}

fn link(conn: &Connection, url: &str) -> String {
    match write::capture_link(conn, url, Some("inline"), true, DEVICE, NOW).expect("capture") {
        Captured::Created(item) | Captured::Duplicate(item) => item.id,
    }
}

#[test]
fn a_capture_keeps_one_job_per_type_and_requeue_resets_it() {
    let db = open("upsert");
    db.call_blocking(|conn| {
        let item = link(conn, "https://example.com/a");
        let first = jobs::enqueue(conn, &item, InboxJobType::MetadataScrape, NOW)?;
        assert_eq!(first.status, InboxJobStatus::Pending);
        assert_eq!(first.max_attempts, 2);
        assert_eq!(first.next_run_at, NOW);

        let claimed = jobs::claim_next(conn, NOW)?.expect("due");
        jobs::fail(conn, &claimed.id, run(&claimed), "HTTP 403", 5_000, NOW)?;

        let again = jobs::enqueue(conn, &item, InboxJobType::MetadataScrape, NOW + 10)?;
        assert_eq!(again.id, first.id, "the pair keeps its job");
        assert_eq!(again.attempts, 0);
        assert_eq!(again.last_error, None);
        assert_eq!(again.next_run_at, NOW + 10);

        let voice = jobs::enqueue(conn, &item, InboxJobType::Transcription, NOW)?;
        assert_eq!(voice.max_attempts, 1);
        assert_eq!(jobs::list(conn, std::slice::from_ref(&item), &[])?.len(), 2);
        Ok(())
    })
    .expect("queue");
}

#[test]
fn the_earliest_due_job_is_claimed_and_a_future_one_waits() {
    let db = open("claim");
    db.call_blocking(|conn| {
        let a = link(conn, "https://example.com/a");
        let b = link(conn, "https://example.com/b");
        jobs::enqueue(conn, &a, InboxJobType::ArticleExtract, NOW + 100)?;
        jobs::enqueue(conn, &b, InboxJobType::MetadataScrape, NOW)?;
        assert_eq!(jobs::next_due(conn)?, Some(NOW));

        let job = jobs::claim_next(conn, NOW)?.expect("b is due");
        assert_eq!(job.item_id, b);
        assert_eq!(job.status, InboxJobStatus::Running);
        assert_eq!(job.attempts, 1);
        assert_eq!(job.started_at, Some(NOW));
        assert!(
            jobs::claim_next(conn, NOW + 99)?.is_none(),
            "a is not due yet"
        );
        assert_eq!(jobs::next_due(conn)?, Some(NOW + 100));
        assert_eq!(jobs::claim_next(conn, NOW + 100)?.expect("a").item_id, a);
        assert_eq!(jobs::next_due(conn)?, None);
        Ok(())
    })
    .expect("claim");
}

#[test]
fn a_failure_retries_after_the_delay_until_attempts_run_out() {
    let db = open("retry");
    db.call_blocking(|conn| {
        let item = link(conn, "https://example.com/a");
        jobs::enqueue(conn, &item, InboxJobType::MetadataScrape, NOW)?;

        let first = jobs::claim_next(conn, NOW)?.expect("due");
        let retried =
            jobs::fail(conn, &first.id, run(&first), "HTTP 503", 5_000, NOW)?.expect("running");
        assert_eq!(retried.status, InboxJobStatus::Pending);
        assert_eq!(retried.next_run_at, NOW + 5_000);
        assert_eq!(retried.last_error.as_deref(), Some("HTTP 503"));
        assert!(jobs::claim_next(conn, NOW + 4_999)?.is_none());

        let second = jobs::claim_next(conn, NOW + 5_000)?.expect("due again");
        assert_eq!(second.attempts, 2);
        let failed = jobs::fail(
            conn,
            &second.id,
            run(&second),
            "HTTP 503",
            5_000,
            NOW + 6_000,
        )?
        .expect("ran");
        assert_eq!(failed.status, InboxJobStatus::Failed);
        assert_eq!(failed.completed_at, Some(NOW + 6_000));
        assert!(jobs::claim_next(conn, NOW + 60_000)?.is_none());
        assert_eq!(
            jobs::list(conn, &[], &[InboxJobStatus::Failed])?.len(),
            1,
            "the failed job is listed"
        );
        Ok(())
    })
    .expect("retry");
}

#[test]
fn a_finish_after_the_job_was_queued_again_changes_nothing() {
    let db = open("stale");
    db.call_blocking(|conn| {
        let item = link(conn, "https://example.com/a");
        jobs::enqueue(conn, &item, InboxJobType::MetadataScrape, NOW)?;
        let running = jobs::claim_next(conn, NOW)?.expect("due");
        jobs::enqueue(conn, &item, InboxJobType::MetadataScrape, NOW + 1)?;

        assert_eq!(
            jobs::finish(conn, &running.id, run(&running), NOW + 2)?,
            None
        );
        assert_eq!(
            jobs::fail(conn, &running.id, run(&running), "late", 0, NOW + 2)?,
            None
        );
        let job = &jobs::list(conn, &[item], &[])?[0];
        assert_eq!(
            job.status,
            InboxJobStatus::Pending,
            "the new run stays queued"
        );
        assert_eq!((job.attempts, job.run_id.as_deref()), (0, None));

        let next = jobs::claim_next(conn, NOW + 3)?.expect("the new run");
        assert_ne!(next.run_id, running.run_id, "each claim is a new run");
        let done = jobs::finish(conn, &next.id, run(&next), NOW + 4)?.expect("running");
        assert_eq!(done.status, InboxJobStatus::Complete);
        assert_eq!(done.completed_at, Some(NOW + 4));
        assert!(jobs::finish(conn, "missing", run(&next), NOW).is_err());
        Ok(())
    })
    .expect("stale");
}

#[test]
fn resume_requeues_an_interrupted_job_once_and_drops_deleted_captures() {
    let db = open("resume");
    db.call_blocking(|conn| {
        let kept = link(conn, "https://example.com/a");
        let gone = link(conn, "https://example.com/b");
        jobs::enqueue(conn, &kept, InboxJobType::Transcription, NOW)?;
        jobs::enqueue(conn, &gone, InboxJobType::MetadataScrape, NOW + 50)?;
        states::delete_permanent(conn, &gone, DEVICE, NOW)?;

        // A quit mid-transcription (one attempt allowed) still runs it again.
        let job = jobs::claim_next(conn, NOW)?.expect("due");
        assert_eq!(job.item_id, kept);
        let resumed = jobs::resume(conn, NOW + 1)?;
        assert_eq!(
            (resumed.requeued, resumed.exhausted, resumed.dropped),
            (1, 0, 1)
        );
        let job = &jobs::list(conn, &[], &[])?[0];
        assert_eq!((job.status, job.attempts), (InboxJobStatus::Pending, 1));

        // Interrupted again: it fails rather than loop.
        jobs::claim_next(conn, NOW + 2)?.expect("due");
        let resumed = jobs::resume(conn, NOW + 3)?;
        assert_eq!((resumed.requeued, resumed.exhausted), (0, 1));
        assert_eq!(
            jobs::list(conn, &[], &[])?[0].status,
            InboxJobStatus::Failed
        );
        Ok(())
    })
    .expect("resume");
}

#[test]
fn a_row_a_newer_build_wrote_is_neither_listed_nor_claimed() {
    let db = open("newer");
    db.call_blocking(|conn| {
        let item = link(conn, "https://example.com/a");
        conn.execute(
            "INSERT INTO inbox_jobs (id, item_id, type, status, attempts, max_attempts,
                                     next_run_at, created_at, updated_at)
             VALUES ('n1', ?1, 'ocr', 'pending', 0, 1, ?2, ?2, ?2)",
            params![item, NOW],
        )
        .expect("insert");
        assert!(jobs::list(conn, &[], &[])?.is_empty());
        assert!(jobs::claim_next(conn, NOW)?.is_none());
        assert_eq!(jobs::next_due(conn)?, None);
        Ok(())
    })
    .expect("newer");
}

#[test]
fn a_finish_from_a_run_superseded_by_a_second_claim_changes_nothing() {
    let db = open("superseded");
    db.call_blocking(|conn| {
        let item = link(conn, "https://example.com/a");
        jobs::enqueue(conn, &item, InboxJobType::MetadataScrape, NOW)?;
        let run1 = jobs::claim_next(conn, NOW)?.expect("due");
        jobs::enqueue(conn, &item, InboxJobType::MetadataScrape, NOW + 1)?;
        let run2 = jobs::claim_next(conn, NOW + 2)?.expect("queued again");

        assert_eq!(
            jobs::finish(conn, &run1.id, run(&run1), NOW + 3)?,
            None,
            "run1 is stale"
        );
        assert_eq!(
            jobs::fail(conn, &run1.id, run(&run1), "late", 0, NOW + 3)?,
            None
        );
        let job = &jobs::list(conn, &[item], &[])?[0];
        assert_eq!((job.status, job.attempts), (InboxJobStatus::Running, 1));
        assert_eq!(job.run_id, run2.run_id);

        let failed =
            jobs::fail(conn, &run2.id, run(&run2), "HTTP 500", 0, NOW + 4)?.expect("run2 is live");
        assert_eq!(failed.last_error.as_deref(), Some("HTTP 500"));
        Ok(())
    })
    .expect("superseded");
}

#[test]
fn a_job_for_a_deleted_or_unknown_capture_is_refused() {
    let db = open("orphan");
    db.call_blocking(|conn| {
        let gone = link(conn, "https://example.com/a");
        states::delete_permanent(conn, &gone, DEVICE, NOW)?;
        for item in [gone.as_str(), "never-captured"] {
            assert!(matches!(
                jobs::enqueue(conn, item, InboxJobType::MetadataScrape, NOW),
                Err(memry_core::api::errors::StorageError::NotFound { .. })
            ));
        }
        assert!(jobs::list(conn, &[], &[])?.is_empty());
        Ok(())
    })
    .expect("orphan");
}

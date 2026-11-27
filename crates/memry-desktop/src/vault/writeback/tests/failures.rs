//! A failed pass (the "Failure" invariants): told once per run of failures, a failed read or
//! write retried on its own until the delay reaches its cap, a pass that cannot finish not
//! retried. A [`Fake`] runner says what each pass came to.

use std::time::Duration;

use super::super::{Failure, MAX_RETRY_AFTER, RETRY_AFTER, WriteBack, WriteBackFailed};
use super::schedule::{Fake, PANIC, SOON, WAIT, eventually, eventually_retried, start};
use super::*;

#[test]
fn a_failed_write_is_told_once_per_run_of_failures() {
    let fake = Fake::default();
    let failed = || Outcome::Failed("disk full".into());
    fake.with(|s| {
        s.outcomes = [
            failed(),
            failed(),
            Outcome::Kept(Keep::FileChanged),
            failed(),
        ]
        .into()
    });
    let (writeback, mut told) = start(&fake);
    let mut events = Vec::new();
    for _ in 0..4 {
        writeback.schedule("n1");
        assert!(writeback.flush(WAIT));
        events.extend(std::iter::from_fn(|| told.try_recv().ok()));
    }
    let event = WriteBackFailed {
        note_id: "n1".into(),
        title: Some("title of n1".into()),
        reason: Failure::Write,
    };
    assert_eq!(events, vec![event.clone(), event]);
}

/// A failed write is tried again on its own, after [`RETRY_AFTER`], with no other schedule;
/// a pass that kept the file is not. Red while a failed pass waited for the note's next schedule.
#[test]
fn a_failed_write_is_tried_again_without_a_schedule() {
    let fake = Fake::default();
    fake.with(|s| s.outcomes = [Outcome::Failed("disk full".into())].into());
    let (writeback, mut told) = start(&fake);
    writeback.schedule("n1");
    eventually("the first pass", || fake.finished() == 1);
    let failed_at = fake.runs()[0].2.unwrap();
    // Retries are generous with the wall clock: only that one comes, never how soon.
    eventually_retried("the retry", || fake.finished() == 2);
    let retried_at = fake.runs()[1].1;
    assert!(
        retried_at - failed_at >= RETRY_AFTER,
        "retried before its delay"
    );
    assert_eq!(
        told.try_recv().unwrap().note_id,
        "n1",
        "the failure is told"
    );
    // The retry came to `Unchanged`: nothing more is due.
    std::thread::sleep(SOON);
    assert_eq!(fake.count(), 2);
}

/// A failed note's retry is not a scheduled pass: a flush does not run it again or wait for it,
/// and a stop ends with it pending (the next open's reconcile lists the note again).
#[test]
fn a_failed_write_retry_does_not_hold_a_flush_or_a_stop() {
    let fake = Fake::default();
    let failed = || Outcome::Failed("disk full".into());
    fake.with(|s| {
        s.outcomes = [failed(), failed()].into();
    });
    let (writeback, _told) = start(&fake);
    writeback.schedule("n1");
    assert!(
        writeback.flush(WAIT),
        "the flush ends with the note failing"
    );
    assert_eq!(fake.count(), 1, "the flush ran the pass once");
    writeback.schedule("n2");
    writeback.stop();
    assert_eq!(
        fake.count(),
        2,
        "the stop ran the scheduled pass once and ended"
    );
}

/// The retry clock of [`fast`]: a tenth of a second for the first retry.
const FAST_RETRY: Duration = Duration::from_millis(100);

/// A write-back whose retries come [`FAST_RETRY`] after a failure, doubling, and end once the
/// delay would reach [`MAX_RETRY_AFTER`] scaled as [`FAST_RETRY`] is.
fn fast(fake: &Fake) -> (WriteBack, broadcast::Receiver<WriteBackFailed>) {
    let (tx, rx) = broadcast::channel(16);
    (
        WriteBack::start_retrying_after(fake.clone(), tx, FAST_RETRY).unwrap(),
        rx,
    )
}

/// A write that keeps failing is retried until the delay would reach its cap, the seventh failed
/// pass in a row, and then no more on its own: a read-only folder or a full disk does not take
/// the writer every few minutes for ever. Its next schedule runs it again. Red while the retries
/// never ended.
#[test]
fn failed_write_retries_end_once_the_delay_reaches_its_cap() {
    let fake = Fake::default();
    fake.with(|s| {
        s.outcomes = std::iter::repeat_with(|| Outcome::Failed("read-only".into()))
            .take(20)
            .collect()
    });
    let (writeback, mut told) = fast(&fake);
    writeback.schedule("n1");
    eventually_retried("seven failed passes", || fake.finished() == 7);
    // Past the cap's delay three times over: a pass the retries did not end would have come.
    let cap = FAST_RETRY * (MAX_RETRY_AFTER.as_millis() / RETRY_AFTER.as_millis()) as u32;
    std::thread::sleep(cap * 3);
    assert_eq!(fake.count(), 7, "no retry after the cap");
    assert_eq!(told.try_recv().unwrap().note_id, "n1");
    assert!(told.try_recv().is_err(), "the run of failures is told once");
    writeback.schedule("n1");
    assert!(writeback.flush(WAIT));
    assert_eq!(fake.count(), 8, "a schedule runs the note again");
}

/// A pass that cannot finish (a body that does not read, a file that does not serialize) or that
/// panicked fails the same way when run again: it is told and not retried on its own.
#[test]
fn a_pass_that_cannot_finish_is_not_retried() {
    let fake = Fake::default();
    fake.with(|s| {
        s.outcomes = [
            Outcome::Broken("the body does not read".into()),
            Outcome::Failed(PANIC.into()),
        ]
        .into()
    });
    let (writeback, mut told) = fast(&fake);
    for id in ["n1", "n2"] {
        writeback.schedule(id);
        assert!(writeback.flush(WAIT));
    }
    // Well past the first retry's delay.
    std::thread::sleep(FAST_RETRY * 10);
    assert_eq!(fake.count(), 2, "no retry");
    let told: Vec<String> = std::iter::from_fn(|| told.try_recv().ok())
        .map(|failed| failed.note_id)
        .collect();
    assert_eq!(told, ["n1", "n2"]);
}

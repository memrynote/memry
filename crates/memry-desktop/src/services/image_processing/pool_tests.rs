use std::sync::mpsc;

use futures_util::FutureExt as _;

use super::*;
use crate::services::image_processing::{QUEUE_CAP, REQUEST_TIMEOUT};

/// A job that holds its worker until the returned sender sends or drops.
fn gated() -> (mpsc::Sender<()>, impl FnOnce() + Send + 'static) {
    let (open, gate) = mpsc::channel::<()>();
    (open, move || {
        let _ = gate.recv();
    })
}

async fn until_waiting(pool: &Pool, count: usize) {
    while pool.waiting.load(Ordering::SeqCst) < count {
        tokio::task::yield_now().await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_request_past_256_queued_is_busy_and_the_queue_drains() {
    let pool = Arc::new(Pool::new(1, QUEUE_CAP, REQUEST_TIMEOUT));
    let (open, job) = gated();
    let running = tokio::spawn({
        let pool = Arc::clone(&pool);
        async move { pool.run(job).await }
    });
    while pool.running.available_permits() > 0 {
        tokio::task::yield_now().await;
    }
    let queued: Vec<_> = (0..QUEUE_CAP)
        .map(|n| {
            let pool = Arc::clone(&pool);
            tokio::spawn(async move { pool.run(move || n).await })
        })
        .collect();
    until_waiting(&pool, QUEUE_CAP).await;

    let refused = pool.run(|| 0).now_or_never();
    assert!(
        matches!(refused, Some(Err(ImageError::Busy))),
        "request {} was not refused",
        QUEUE_CAP + 1
    );

    drop(open);
    running.await.expect("join").expect("ran");
    for (n, request) in queued.into_iter().enumerate() {
        assert_eq!(request.await.expect("join").expect("ran"), n);
    }
    assert_eq!(pool.waiting.load(Ordering::SeqCst), 0);
    assert!(pool.run(|| 1).await.is_ok(), "the queue reopens");
}

/// Time is Tokio's paused clock, moved past the deadline while the job blocks (a running
/// `spawn_blocking` task stops it from moving on its own).
#[tokio::test(start_paused = true)]
async fn a_request_running_past_60_s_times_out_and_keeps_its_slot_until_it_returns() {
    let pool = Arc::new(Pool::new(1, QUEUE_CAP, REQUEST_TIMEOUT));
    let (open, job) = gated();
    let request = tokio::spawn({
        let pool = Arc::clone(&pool);
        async move { pool.run(job).await }
    });
    // The request takes its slot and arms its deadline in the same poll.
    while pool.running.available_permits() > 0 {
        tokio::task::yield_now().await;
    }
    tokio::time::advance(REQUEST_TIMEOUT - Duration::from_millis(1)).await;
    assert!(!request.is_finished(), "timed out early");
    tokio::time::advance(Duration::from_millis(1)).await;
    tokio::task::yield_now().await;
    assert!(request.is_finished(), "no timeout at the deadline");
    let outcome = request.await.expect("join");
    assert!(matches!(outcome, Err(ImageError::TimedOut)), "{outcome:?}");
    assert_eq!(pool.running.available_permits(), 0);

    drop(open);
    assert_eq!(pool.run(|| 7).await.expect("ran"), 7);
}

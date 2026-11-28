//! `drain`: a refused body is discarded as it arrives, never collected.

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use axum::body::{Body, Bytes};
use futures_util::stream;
use tokio::time::Instant;

use super::drain;
use crate::services::capture::BODY_LIMIT;

const FRAME: usize = 1024 * 1024;

/// A frame's bytes, counted in `alive` until dropped.
struct Counted(Vec<u8>, Arc<AtomicUsize>);

impl AsRef<[u8]> for Counted {
    fn as_ref(&self) -> &[u8] {
        &self.0
    }
}

impl Drop for Counted {
    fn drop(&mut self) {
        self.1.fetch_sub(1, Ordering::SeqCst);
    }
}

#[tokio::test]
async fn a_refused_body_is_dropped_frame_by_frame_and_read_only_to_the_limit() {
    let alive = Arc::new(AtomicUsize::new(0));
    let most_alive = Arc::new(AtomicUsize::new(0));
    let sent = Arc::new(AtomicUsize::new(0));
    let (counter, most, total) = (alive.clone(), most_alive.clone(), sent.clone());
    // An endless body: only the limit ends the drain.
    let frames = stream::repeat_with(move || {
        let now = counter.fetch_add(1, Ordering::SeqCst) + 1;
        most.fetch_max(now, Ordering::SeqCst);
        total.fetch_add(FRAME, Ordering::SeqCst);
        let bytes = Bytes::from_owner(Counted(vec![0; FRAME], counter.clone()));
        Ok::<_, std::io::Error>(bytes)
    });
    let deadline = Instant::now() + Duration::from_secs(600);
    drain(Body::from_stream(frames), deadline).await;
    assert_eq!(
        most_alive.load(Ordering::SeqCst),
        1,
        "an earlier frame was still held when the next one was read"
    );
    let sent = sent.load(Ordering::SeqCst);
    assert!(
        sent > BODY_LIMIT && sent <= BODY_LIMIT + FRAME,
        "read {sent} bytes"
    );
}

//! A pause cuts the first sync's 429 waits (#5423), as it cuts a retry's
//! sleep: the driver's sleeper ends at the pause and the next request answers
//! it. Before, the wait slept through the pause for up to a minute.

use std::sync::Arc;
use std::time::Duration;

use memry_core::sync::body_pull::MAX_RATE_LIMIT_PAUSE_S;
use memry_core::sync::driver::progress::SilentInitialSync;
use serde_json::json;

use crate::driver_fakes::Desktop;

const NOTE: &str = "note00000001";

/// The 429 a probe waits out ends at the pause.
#[tokio::test]
async fn a_pause_cuts_a_probe_429_wait() {
    first_sync_paused_in_a_wait_on("/sync/crdt/updates/batch").await;
}

/// The 429 a document pull waits out ends at the pause.
#[tokio::test]
async fn a_pause_cuts_a_document_pull_429_wait() {
    first_sync_paused_in_a_wait_on("/sync/crdt/snapshot/").await;
}

/// A first sync whose `route` asks for the longest wait the pass takes, paused
/// once that wait has begun.
async fn first_sync_paused_in_a_wait_on(route: &'static str) {
    let desktop = Desktop::open(&["note"], |_| Ok(())).await;
    desktop.server.put("note", NOTE, json!({"title": "one"}));
    desktop.server.page(&[NOTE], "1");
    desktop.server.rate_limit(route, MAX_RATE_LIMIT_PAUSE_S);
    let refused = || {
        desktop
            .server
            .urls()
            .iter()
            .filter(|url| url.contains(route))
            .count()
    };

    let pause = async {
        while refused() == 0 {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        // The 429 is answered and its wait begun.
        tokio::time::sleep(Duration::from_millis(200)).await;
        desktop.driver.pause();
    };
    // timing-bound: a watchdog well under the minute an uncut wait sleeps.
    let (ran, ()) = tokio::time::timeout(Duration::from_secs(30), async {
        tokio::join!(
            desktop.driver.first_sync(Arc::new(SilentInitialSync)),
            pause
        )
    })
    .await
    .expect("the pause cut the 429 wait");

    assert!(ran.is_err(), "the cut run resumes later: {ran:?}");
    assert_eq!(refused(), 1, "nothing was asked again after the pause");
}

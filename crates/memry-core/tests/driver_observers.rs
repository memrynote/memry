//! What the desktop driver's observers hear from its open on (REVIEW-4892
//! item 3, #3534), on `driver_fakes`'s server.

use std::sync::{Arc, Mutex};

use memry_core::api::errors::StorageError;
use memry_core::protocol::account::UNKNOWN_SIGNER;
use memry_core::protocol::types::Declaration;
use memry_core::sync::driver::{AppliedRecord, ApplyObserver};
use serde_json::json;

use crate::driver_fakes::Desktop;

#[derive(Default)]
struct Heard(Mutex<Vec<String>>);

impl ApplyObserver for Heard {
    fn name(&self) -> &str {
        "heard"
    }
    fn records_applied(&self, batch: &[AppliedRecord]) {
        let mut heard = self.0.lock().unwrap();
        heard.extend(batch.iter().map(|record| record.item_id.clone()));
    }
}

/// A row an earlier driver stored corrupt for a signer missing from its
/// directory is re-pulled when the next driver opens, and its observers hear
/// it: the shell writes the record's file from that call.
#[tokio::test]
async fn a_row_re_pulled_at_open_is_told_to_the_observers() {
    let desktop = Desktop::open_with(Declaration::desktop(), |_| Ok(())).await;
    desktop.server.put("task", "t1", json!({"title": "one"}));
    desktop
        .db
        .call_blocking(|conn| {
            conn.execute(
                "INSERT INTO sync_items (item_type, item_id, payload, payload_state, clock, \
                 updated_at, corrupt_reason, corrupt_at) \
                 VALUES ('task', 't1', NULL, 'full', '{}', 1, ?1, 1)",
                [format!("signer device `ghost`{UNKNOWN_SIGNER}")],
            )
            .map(drop)
            .map_err(|error| StorageError::Failed {
                what: error.to_string(),
            })
        })
        .unwrap();

    let heard = Arc::new(Heard::default());
    let observer: Arc<dyn ApplyObserver> = heard.clone();
    let _desktop = desktop
        .reopen_observed(Declaration::desktop(), vec![observer])
        .await;

    assert_eq!(*heard.0.lock().unwrap(), vec!["t1".to_owned()]);
}

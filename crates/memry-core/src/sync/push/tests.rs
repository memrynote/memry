//! Unit tests of the push wave's pure helpers.

use super::*;
use crate::sync::outbox::RecordOp;

#[test]
fn only_the_three_internal_error_statuses_halve() {
    let status = |status| ApiError::Status {
        status,
        code: None,
        message: String::new(),
    };
    for retryable in [500, 502, 503] {
        assert!(is_retryable_5xx(&status(retryable)));
    }
    // §0.6.1: a 501 is a deployment gap, not a transient fault.
    for other in [400, 402, 404, 429, 501, 504] {
        assert!(!is_retryable_5xx(&status(other)));
    }
}

#[test]
fn the_retry_ladder_is_base_times_two_to_the_attempt_with_no_jitter() {
    assert_eq!(retry_at(0, 0), DEFAULT_BASE_DELAY_MS as i64);
    assert_eq!(retry_at(0, 1), 2 * DEFAULT_BASE_DELAY_MS as i64);
    assert_eq!(retry_at(0, 2), 4 * DEFAULT_BASE_DELAY_MS as i64);
    assert!(retry_at(100, 40) > 100, "the shift is clamped, not wrapped");
}

#[test]
fn an_upsert_is_an_update_on_the_wire() {
    let row = |op: RecordOp| OutboxRow {
        id: 1,
        item_type: "task".to_owned(),
        item_id: "t1".to_owned(),
        op: op.as_str().to_owned(),
        payload: None,
        enqueued_at: 0,
        attempt_count: 0,
        last_error: None,
        next_attempt_at: None,
    };
    assert_eq!(
        operation_of(&row(RecordOp::Upsert)),
        Some(SyncOperation::Update)
    );
    assert_eq!(
        operation_of(&row(RecordOp::Delete)),
        Some(SyncOperation::Delete)
    );
    assert_eq!(
        operation_of(&row(RecordOp::Create)),
        Some(SyncOperation::Create)
    );
}

#[test]
fn a_rejection_reason_is_read_per_item() {
    let body = json!({
        "accepted": ["a"],
        "rejected": [{"id": "b", "reason": REASON_REPLAY_DETECTED}],
    });
    assert_eq!(string_set(&body, "accepted"), vec!["a".to_owned()]);
    assert_eq!(rejection_reason(&body, "b"), REASON_REPLAY_DETECTED);
    assert_eq!(rejection_reason(&body, "c"), "rejected without a reason");
}

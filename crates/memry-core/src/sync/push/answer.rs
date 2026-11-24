//! What a push answer says: which statuses halve the batch, which ids the
//! server took or refused and why, and when a refused row is tried again.

use serde_json::Value as Json;

use crate::api::errors::ApiError;
use crate::protocol::http::DEFAULT_BASE_DELAY_MS;

/// Chapter 00 §0.5's `INTERNAL_ERROR` row: 500, 502 and 503 are the only
/// statuses the table calls retryable, and they are the ones §5.6's ladder
/// answers. A `501` is a deployment gap (§0.6.1) and halving cannot help it.
pub(super) fn is_retryable_5xx(error: &ApiError) -> bool {
    matches!(error, ApiError::Status { status, .. } if matches!(status, 500 | 502 | 503))
}

pub(super) fn string_set(body: &Json, key: &str) -> Vec<String> {
    body.get(key)
        .and_then(Json::as_array)
        .map(|values| {
            values
                .iter()
                .filter_map(Json::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

/// §5.11.1: `rejected` is `[{ id, reason }]`, per item, so a partially
/// accepted batch is normal and a client must read it rather than infer
/// success from the status code.
pub(super) fn rejection_reason(body: &Json, id: &str) -> String {
    body.get("rejected")
        .and_then(Json::as_array)
        .and_then(|rows| {
            rows.iter()
                .find(|row| row.get("id").and_then(Json::as_str) == Some(id))
        })
        .and_then(|row| row.get("reason"))
        .and_then(Json::as_str)
        .unwrap_or("rejected without a reason")
        .to_owned()
}

/// Chapter 00 §0.6.1's ladder: `baseDelayMs * 2 ^ attempt`, zero-based, **no
/// jitter** — the client population is one device per account, so the
/// thundering-herd problem jitter solves does not arise and a deterministic
/// ladder is testable against a paused clock.
///
/// A rejected row must also leave the current wave: deferring it to *now*
/// makes it claimable again on the next iteration and burns the whole
/// 50-iteration budget re-sending an item the server has already refused.
pub(super) fn retry_at(now_ms: i64, attempt_count: i64) -> i64 {
    let attempt = attempt_count.clamp(0, 16) as u32;
    now_ms + (DEFAULT_BASE_DELAY_MS as i64).saturating_mul(1i64 << attempt)
}

//! A board's banner rules: the wash refs a board takes and the framing a cover
//! keeps (`home/cover-service.ts` `setHomeCover` and `setHomeCoverFraming`,
//! with the clamps of `packages/shared/src/cover-image.ts`).
//!
//! The cover rides in the `home_page` payload, so a framing change keeps every
//! key the stored cover has, unknown ones included, and only sets the four
//! framing keys (`{ ...board.cover, focus, focusX, zoom, height }`).

use rusqlite::Connection;
use serde_json::{Map, Value};

use super::{HomePage, HomePagePatch, get, update};
use crate::api::errors::StorageError;

/// `COVER_WASHES`' ids: the cover picker's colour washes.
pub const WASH_IDS: [&str; 12] = [
    "sage", "sand", "lilac", "clay", "ash", "fog", "wheat", "moss", "slate", "bark", "mist", "plum",
];

/// `coverWashRef`: the ref of wash `id`, or `None` for an id that is not one
/// (`isCoverWashId`).
pub fn wash_ref(id: &str) -> Option<String> {
    WASH_IDS.contains(&id).then(|| format!("wash:{id}"))
}

/// The framing fields a caller changes; `None` keeps the stored value.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct FramingChanges {
    pub focus_x: Option<f64>,
    pub focus_y: Option<f64>,
    pub zoom: Option<f64>,
    pub height: Option<f64>,
}

/// `Math.round`: halves go up, `-0.5` to `-0`.
fn js_round(x: f64) -> f64 {
    let floor = x.floor();
    if x - floor >= 0.5 { floor + 1.0 } else { floor }
}

/// `clampCoverFocus`: 0..100, a whole percent, 50 for a value that is not finite.
pub fn clamp_focus(value: f64) -> f64 {
    if !value.is_finite() {
        return 50.0;
    }
    js_round(value).clamp(0.0, 100.0)
}

/// `clampCoverZoom`: 1..3, two decimals, 1 for a value that is not finite.
pub fn clamp_zoom(value: f64) -> f64 {
    if !value.is_finite() {
        return 1.0;
    }
    (js_round(value * 100.0) / 100.0).clamp(1.0, 3.0)
}

/// `clampCoverHeight`: 120..480 px, a whole pixel, 200 for a value that is not finite.
pub fn clamp_height(value: f64) -> f64 {
    if !value.is_finite() {
        return 200.0;
    }
    js_round(value).clamp(120.0, 480.0)
}

/// A number as `JSON.stringify` writes it: integral values without a fraction.
fn js_number(x: f64) -> Value {
    if x.fract() == 0.0 && x.abs() < 9_007_199_254_740_992.0 {
        // Exact: integral and below 2^53.
        #[allow(clippy::cast_possible_truncation, reason = "integral and below 2^53")]
        return Value::from(x as i64);
    }
    Value::from(x)
}

/// The cover with `changes` applied over its framing, each field read as its
/// default when absent and every field clamped.
pub fn framed(cover: &Map<String, Value>, changes: FramingChanges) -> Map<String, Value> {
    let read = |key: &str, default: f64| cover.get(key).and_then(Value::as_f64).unwrap_or(default);
    let focus_x = changes.focus_x.unwrap_or_else(|| read("focusX", 50.0));
    let focus_y = changes.focus_y.unwrap_or_else(|| read("focus", 50.0));
    let zoom = changes.zoom.unwrap_or_else(|| read("zoom", 1.0));
    let height = changes.height.unwrap_or_else(|| read("height", 200.0));
    let mut next = cover.clone();
    next.insert("focus".to_owned(), js_number(clamp_focus(focus_y)));
    next.insert("focusX".to_owned(), js_number(clamp_focus(focus_x)));
    next.insert("zoom".to_owned(), js_number(clamp_zoom(zoom)));
    next.insert("height".to_owned(), js_number(clamp_height(height)));
    next
}

/// `setHomeCoverFraming`: saves the framing of the board's cover. A board with
/// no cover is answered unchanged, with nothing written or queued.
pub fn set_framing(
    conn: &Connection,
    id: &str,
    changes: FramingChanges,
    device_id: &str,
    now_ms: i64,
) -> Result<HomePage, StorageError> {
    let board = get(conn, id)?.ok_or_else(|| StorageError::NotFound {
        what: format!("no home board {id}"),
    })?;
    let Some(text) = board.cover.as_deref() else {
        return Ok(board);
    };
    let Ok(Value::Object(cover)) = serde_json::from_str::<Value>(text) else {
        return Err(StorageError::Failed {
            what: format!("home board {id} holds a cover that is not a JSON object"),
        });
    };
    let next = Value::Object(framed(&cover, changes));
    let patch = HomePagePatch {
        cover: Some(Some(&next)),
        ..HomePagePatch::default()
    };
    update(conn, id, &patch, device_id, now_ms)
}

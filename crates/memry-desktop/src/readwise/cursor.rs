//! `nextCursor` of `sync-service.ts` and `reader-sync.ts`: the newest server time a run saw,
//! minus one second, in Readwise's time. It never moves back, and stays put when the run saw
//! nothing; with no cursor and nothing seen it starts a margin before the run (clock skew).

use super::run_types::{RunError, failed};
use super::text::parse_ms;
use crate::web::extract::utils::date::iso_string;

/// A cursor with nothing to anchor on starts this far before the run.
const EMPTY_CURSOR_MARGIN_MS: i64 = 5 * 60 * 1000;

/// `started` and the result are epoch milliseconds on this device's clock, as ISO text.
pub fn iso(ms: i64) -> Result<String, RunError> {
    iso_string(Some(ms as f64)).map_err(failed)
}

/// `times` are the server's ISO times the run saw; one that does not parse is skipped.
pub fn next_cursor<'a>(
    times: impl IntoIterator<Item = Option<&'a str>>,
    previous: Option<&str>,
    started: i64,
) -> Result<String, RunError> {
    let newest = (times.into_iter())
        .filter_map(parse_ms)
        .fold(f64::NEG_INFINITY, f64::max);
    let kept = parse_ms(previous);
    let at = match (newest.is_finite(), kept) {
        (false, Some(kept)) => kept,
        (false, None) => (started - EMPTY_CURSOR_MARGIN_MS) as f64,
        (true, Some(kept)) => kept.max(newest - 1000.0),
        (true, None) => newest - 1000.0,
    };
    iso_string(Some(at)).map_err(failed)
}

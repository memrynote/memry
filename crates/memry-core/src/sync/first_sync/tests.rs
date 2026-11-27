use super::*;

#[test]
fn the_window_is_thirty_days_and_the_body_cap_fits_sc_007() {
    assert_eq!(RECENT_WINDOW_MS, 2_592_000_000);
    // §10.6.1: 600 `crdt_pull` per minute unelevated, so the cap has to
    // stay under a minute of body pulling on its own or SC-007's two
    // minutes are gone before the refs and metadata passes are counted.
    assert_eq!(RECENT_BODY_LIMIT.min(600), RECENT_BODY_LIMIT);
}

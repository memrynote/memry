use super::*;

#[test]
fn a_document_id_follows_the_crdt_route_s_own_grammar() {
    assert!(valid_document_id("dzxnhc9p3gk3").is_ok());
    assert!(valid_document_id("j2026-04-16").is_ok());
    assert!(valid_document_id("").is_err());
    assert!(valid_document_id("has space").is_err());
    assert!(valid_document_id("slash/es").is_err());
    assert!(valid_document_id(&"a".repeat(MAX_DOCUMENT_ID_LEN + 1)).is_err());
}

#[test]
fn the_first_local_edit_ticks_this_device_to_one() {
    let clock = next_clock(&Object::new(), "device-a").expect("a clock");
    assert_eq!(clock, json!({"device-a": 1}));
}

#[test]
fn an_existing_tick_advances_and_every_other_device_is_kept() {
    let stored = object(json!({"clock": {"device-a": 2, "device-b": 9}}));
    assert_eq!(
        next_clock(&stored, "device-a").expect("a clock"),
        json!({"device-a": 3, "device-b": 9})
    );
}

#[test]
fn a_clock_that_will_not_parse_is_an_error_and_never_an_empty_clock() {
    let stored = object(json!({"clock": {"device-a": "two"}}));
    assert!(next_clock(&stored, "device-a").is_err());
}

#[test]
fn the_reserved_offline_id_is_refused_before_it_can_reach_a_payload() {
    assert!(next_clock(&Object::new(), OFFLINE_CLOCK_DEVICE_ID).is_err());
    assert!(next_clock(&Object::new(), "").is_err());
}

//! What a feed read allocates, measured by an allocator that counts the calling thread's live
//! and total bytes (the read is synchronous on the caller's thread). Each feed here is a few
//! hundred KiB whose values would each copy one long field: the read must allocate in
//! proportion to the feed, not to values x field length. Own test binary because it installs a
//! global allocator.

use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;
use std::collections::HashMap;

use memry_core::api::calendar_records::CalendarZone;
use memry_core::domain::calendar_items::ical::{FeedError, IcalZones, parse_feed};
use memry_core::domain::calendar_items::ics;

struct Counting;

thread_local! {
    static LIVE: Cell<i64> = const { Cell::new(0) };
    static PEAK: Cell<i64> = const { Cell::new(0) };
    static TOTAL: Cell<i64> = const { Cell::new(0) };
}

fn add(bytes: i64) {
    // `try_with` because the allocator also runs while thread-locals are torn down.
    let _ = LIVE.try_with(|live| {
        let now = live.get() + bytes;
        live.set(now);
        let _ = PEAK.try_with(|peak| peak.set(peak.get().max(now)));
    });
    if bytes > 0 {
        let _ = TOTAL.try_with(|total| total.set(total.get() + bytes));
    }
}

// SAFETY: forwards every call to `System` unchanged and only counts sizes.
unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        add(layout.size() as i64);
        unsafe { System.alloc(layout) }
    }
    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        add(layout.size() as i64);
        unsafe { System.alloc_zeroed(layout) }
    }
    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        add(-(layout.size() as i64));
        unsafe { System.dealloc(ptr, layout) }
    }
    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        add(new_size as i64);
        let moved = unsafe { System.realloc(ptr, layout, new_size) };
        add(-(layout.size() as i64));
        moved
    }
}

#[global_allocator]
static ALLOCATOR: Counting = Counting;

const NOW: i64 = 1_773_000_000_000; // 2026-03-08
const BOUND: i64 = 64 * 1024 * 1024;

fn zone(id: &str) -> CalendarZone {
    CalendarZone {
        identifier: id.into(),
        base_offset_ms: 3_600_000,
        transitions: Vec::new(),
    }
}

/// `named` is not empty, so every lookup of a TZID hashes it.
fn zones() -> IcalZones {
    IcalZones {
        named: HashMap::from([("Europe/Berlin".to_owned(), zone("Europe/Berlin"))]),
        local: zone("UTC"),
    }
}

fn calendar(body: &str) -> String {
    format!(
        "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nX-WR-TIMEZONE:Europe/Berlin\r\n{body}END:VCALENDAR\r\n"
    )
}

/// The most bytes and the total bytes the read of `text` allocated, beyond what was live before.
fn read_allocations(text: &str) -> (Result<usize, FeedError>, i64, i64) {
    let before = LIVE.with(Cell::get);
    let total_before = TOTAL.with(Cell::get);
    PEAK.with(|peak| peak.set(before));
    let outcome = parse_feed(text, ics::window(NOW), &zones()).map(|feed| feed.events.len());
    (
        outcome,
        PEAK.with(Cell::get) - before,
        TOTAL.with(Cell::get) - total_before,
    )
}

fn assert_bounded(what: &str, text: &str) {
    let (outcome, peak, total) = read_allocations(text);
    assert!(outcome.is_ok(), "{what}: {outcome:?}");
    assert!(
        peak < BOUND && total < BOUND,
        "{what}: {} KiB feed, peak {} MiB, total {} MiB allocated",
        text.len() / 1024,
        peak >> 20,
        total >> 20
    );
}

#[test]
fn a_long_tzid_on_a_date_list_is_not_copied_per_value() {
    // 20 000 values naming one 64 KiB TZID: 1.3 GB if each value copies it.
    let tzid = "Z".repeat(64 * 1024);
    let values = vec!["20000101T090000"; 20_000].join(",");
    let event = |extra: &str| {
        format!(
            "BEGIN:VEVENT\r\nUID:a\r\nDTSTART:20260301T090000Z\r\nDTEND:20260301T100000Z\r\n\
             RRULE:FREQ=WEEKLY;COUNT=3\r\nSUMMARY:a\r\n{extra}END:VEVENT\r\n"
        )
    };
    let observance = format!(
        "BEGIN:VTIMEZONE\r\nTZID:Bomb\r\nBEGIN:STANDARD\r\nDTSTART:19700101T000000\r\n\
         TZOFFSETFROM:+0100\r\nTZOFFSETTO:+0000\r\nRDATE;TZID={tzid}:{values}\r\n\
         END:STANDARD\r\nEND:VTIMEZONE\r\n"
    );
    for (what, body) in [
        ("RDATE", event(&format!("RDATE;TZID={tzid}:{values}\r\n"))),
        ("EXDATE", event(&format!("EXDATE;TZID={tzid}:{values}\r\n"))),
        ("VTIMEZONE RDATE", observance + &event("")),
    ] {
        assert_bounded(what, &calendar(&body));
    }
}

#[test]
fn a_long_tzid_on_a_series_start_is_not_copied_per_occurrence() {
    // A daily series from 1900 in a 1 MiB TZID: 46 000 occurrences, each of which
    // would clone and hash the TZID.
    let tzid = "Z".repeat(1024 * 1024);
    let body = format!(
        "BEGIN:VEVENT\r\nUID:a\r\nDTSTART;TZID={tzid}:19000101T090000\r\nDURATION:PT1H\r\n\
         RRULE:FREQ=DAILY\r\nSUMMARY:a\r\nEND:VEVENT\r\n"
    );
    assert_bounded("DTSTART TZID", &calendar(&body));
}

#[test]
fn per_instance_text_is_read_once_per_event() {
    // A 1 MiB STATUS read again (unescaped, upper-cased) by each of 5 000 hourly instances.
    let body = format!(
        "BEGIN:VEVENT\r\nUID:a\r\nDTSTART:20260301T090000Z\r\nDURATION:PT30M\r\n\
         RRULE:FREQ=HOURLY\r\nSUMMARY:a\r\nSTATUS:{}\r\nEND:VEVENT\r\n",
        "S".repeat(1024 * 1024)
    );
    assert_bounded("STATUS", &calendar(&body));
}

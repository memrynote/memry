//! Stage 36d1: an imported push must not create a second provider event. Electron and the core
//! both find an item's remote event only through its binding (`findProviderBinding`,
//! `bindings::find`); neither stamps a client id on a Google insert or adopts a remote event by
//! `memrySourceId`. So a queued change to an event Electron already wrote reaches the provider
//! as an update only when its binding comes across with it.

use memry_core::api::calendar_providers::CalendarFeedZones;
use memry_core::api::calendar_records::CalendarZone;
use memry_core::api::vault::Vault as CoreVault;

use super::inbox_calendar::seed_calendar;
use super::queue::queue;
use super::{Vault, device_key, import};

#[test]
fn a_queued_event_electron_already_wrote_to_google_updates_that_event() {
    let vault = Vault::new();
    let conn = vault.data_conn();
    conn.pragma_update(None, "foreign_keys", false).unwrap();
    // `ev-1` is on Google as `g-1` (binding `bd-1`), with a local edit not yet synced.
    seed_calendar(&conn);
    queue(
        &conn,
        "calendar_event",
        "ev-1",
        "update",
        "{}",
        1_767_000_000,
    );
    drop(conn);
    import(&vault);

    let core =
        CoreVault::open("vault".into(), vault.core().to_string_lossy().into_owned()).unwrap();
    let calendar = core.calendar(device_key::with_device_key()).unwrap();
    let queued: Vec<String> = calendar
        .push_queue()
        .unwrap()
        .into_iter()
        .map(|item| format!("{}:{}", item.source_type, item.source_id))
        .collect();
    assert_eq!(queued, vec!["event:ev-1"]);

    let utc = CalendarZone {
        identifier: "UTC".into(),
        base_offset_ms: 0,
        transitions: Vec::new(),
    };
    let zones = CalendarFeedZones {
        named: Vec::new(),
        local: utc,
    };
    let plan = calendar
        .push_plan(
            "event".into(),
            "ev-1".into(),
            vec!["google".into()],
            zones,
            None,
        )
        .unwrap();
    assert_eq!(
        (
            plan.action.as_str(),
            plan.provider.as_str(),
            plan.calendar_id.as_str(),
            plan.remote_event_id.as_deref(),
        ),
        ("upsert", "google", "primary", Some("g-1")),
        "a plan without remote_event_id is a POST: a second Google event"
    );
}

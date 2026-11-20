//! The macOS Calendar bridge (#3546 29h) against a fake helper: a shell script that speaks the
//! helper's line protocol and records each start and request, so the bridge runs on every Unix
//! leg without EventKit or a permission prompt. The real helper's prompt is a live check on a
//! signed build.
#![cfg(unix)]

use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::time::Duration;

use memry_desktop::calendar_providers::eventkit::{
    AccessError, AuthorizationStatus, Bridge, BridgeError, EventKit, Load, REQUEST_TIMEOUT,
};

struct Fake {
    dir: tempfile::TempDir,
    helper: PathBuf,
}

impl Fake {
    /// A helper whose `case "$method"` arms are `cases`; `$id` is the request id.
    fn new(cases: &str) -> Self {
        let dir = tempfile::tempdir().expect("temp dir");
        let helper = dir.path().join("memry-eventkit");
        let script = format!(
            r#"#!/bin/sh
dir="$(dirname "$0")"
echo start >> "$dir/starts"
printf '%s\n' '{{"event":"ready","protocol":1}}'
while IFS= read -r line; do
  printf '%s\n' "$line" >> "$dir/requests"
  id=$(printf '%s' "$line" | sed -n 's/^{{"id":\([0-9]*\),.*/\1/p')
  method=$(printf '%s' "$line" | sed -n 's/.*"method":"\([A-Za-z]*\)".*/\1/p')
  case "$method" in
{cases}
  esac
done
"#
        );
        std::fs::write(&helper, script).expect("write the fake helper");
        std::fs::set_permissions(&helper, std::fs::Permissions::from_mode(0o755)).expect("chmod");
        Self { dir, helper }
    }

    fn bridge(&self) -> Bridge {
        Bridge::new(self.helper.clone(), REQUEST_TIMEOUT)
    }

    fn read(&self, name: &str) -> Vec<String> {
        std::fs::read_to_string(self.dir.path().join(name))
            .unwrap_or_default()
            .lines()
            .map(str::to_owned)
            .collect()
    }

    fn starts(&self) -> usize {
        self.read("starts").len()
    }
}

fn answer(method: &str, json: &str) -> String {
    format!("    {method}) printf '{{\"id\":%s,{json}}}\\n' \"$id\" ;;\n")
}

#[tokio::test]
async fn statuses_parse_and_an_unknown_answer_reads_as_denied() {
    for (raw, status) in [
        ("not_determined", AuthorizationStatus::NotDetermined),
        ("restricted", AuthorizationStatus::Restricted),
        ("denied", AuthorizationStatus::Denied),
        ("write_only", AuthorizationStatus::WriteOnly),
        ("full_access", AuthorizationStatus::FullAccess),
        ("authorized_someday", AuthorizationStatus::Denied),
    ] {
        let fake = Fake::new(&answer(
            "authorizationStatus",
            &format!(r#""result":"{raw}""#),
        ));
        assert_eq!(
            fake.bridge().authorization_status().await,
            Ok(status),
            "{raw}"
        );
    }
}

#[tokio::test]
async fn requests_carry_id_method_and_params_one_line_each() {
    let fake = Fake::new(
        &(answer("authorizationStatus", r#""result":"full_access""#)
            + &answer("listEvents", r#""result":[]"#)),
    );
    let bridge = fake.bridge();
    bridge.authorization_status().await.unwrap();
    let ids = ["cal-1".to_owned()];
    let events = bridge
        .list_events(&ids, "2026-01-01T00:00:00.000Z", "2026-02-01T00:00:00.000Z")
        .await
        .unwrap();
    assert!(events.is_empty());
    assert_eq!(
        fake.read("requests"),
        [
            r#"{"id":1,"method":"authorizationStatus","params":{}}"#,
            r#"{"id":2,"method":"listEvents","params":{"calendarIds":["cal-1"],"start":"2026-01-01T00:00:00.000Z","end":"2026-02-01T00:00:00.000Z"}}"#,
        ]
    );
}

#[tokio::test]
async fn no_calendar_ids_ask_the_helper_nothing() {
    let fake = Fake::new("");
    assert_eq!(
        fake.bridge().list_events(&[], "a", "b").await,
        Ok(Vec::new())
    );
    assert_eq!(fake.starts(), 0);
}

#[tokio::test]
async fn calendars_and_events_map_like_electron() {
    let calendars = r##""result":[{"id":"c1","title":"Work","color":"#ff0000","type":"caldav","allowsModifications":true,"sourceId":"s1","sourceTitle":"iCloud","sourceType":"caldav"},{"id":"c2","title":""},{"title":"no id"},"junk"]"##;
    let events = r#""result":[{"calendarId":"c1","eventId":"e1","title":"Standup","isAllDay":false,"start":"2026-01-05T09:00:00.000Z","end":"2026-01-05T09:15:00.000Z","timeZone":"Europe/Istanbul","status":"tentative","isRecurring":true,"alarmMinutes":[10,"x",-5],"attendees":[{"name":"A","email":"a@example.com","status":"accepted","role":"required","type":"person","isCurrentUser":true},7],"organizer":{"name":"B"},"recurrenceRule":"FREQ=DAILY"},{"calendarId":"c1","status":"weird"},{"title":"orphan"}]"#;
    let fake = Fake::new(&(answer("listCalendars", calendars) + &answer("listEvents", events)));
    let bridge = fake.bridge();

    let calendars = bridge.list_calendars().await.unwrap();
    assert_eq!(calendars.len(), 2, "an entry without an id is dropped");
    assert_eq!(calendars[0].title, "Work");
    assert_eq!(calendars[0].color.as_deref(), Some("#ff0000"));
    assert!(calendars[0].allows_modifications);
    assert_eq!(
        calendars[1].title, "c2",
        "an empty title falls back to the id"
    );
    assert_eq!(calendars[1].r#type, "unknown");
    assert!(!calendars[1].allows_modifications);

    let events = bridge
        .list_events(&["c1".to_owned()], "a", "b")
        .await
        .unwrap();
    assert_eq!(events.len(), 2, "an event without a calendar id is dropped");
    let standup = &events[0];
    assert_eq!(standup.title, "Standup");
    assert_eq!(standup.status, "tentative");
    assert!(standup.is_recurring);
    assert_eq!(standup.alarm_minutes, [10.0, -5.0]);
    assert_eq!(standup.attendees.len(), 1);
    assert_eq!(standup.attendees[0].email.as_deref(), Some("a@example.com"));
    assert!(standup.attendees[0].is_current_user);
    let organizer = standup.organizer.as_ref().unwrap();
    assert_eq!(organizer.name.as_deref(), Some("B"));
    assert_eq!(
        (organizer.status.as_str(), organizer.role.as_str()),
        ("pending", "unknown")
    );
    assert_eq!(standup.recurrence_rule.as_deref(), Some("FREQ=DAILY"));
    let bare = &events[1];
    assert_eq!(
        (
            bare.title.as_str(),
            bare.status.as_str(),
            bare.availability.as_str()
        ),
        ("", "none", "not_supported")
    );
    assert!(bare.organizer.is_none());
}

#[tokio::test]
async fn a_helper_error_keeps_its_code_and_message() {
    let fake = Fake::new(
        &(answer(
            "listCalendars",
            r#""error":{"code":"not_authorized","message":"denied"}"#,
        ) + &answer("listEvents", r#""error":{"message":"odd"}"#)),
    );
    let bridge = fake.bridge();
    let error = bridge.list_calendars().await.unwrap_err();
    assert_eq!(
        (error.code.as_str(), error.message.as_str()),
        ("not_authorized", "denied")
    );
    let error = bridge
        .list_events(&["c".to_owned()], "a", "b")
        .await
        .unwrap_err();
    assert_eq!(error.code, "helper_error");
}

#[tokio::test]
async fn unreadable_lines_are_skipped_and_changed_reaches_subscribers() {
    let fake = Fake::new(
        "    authorizationStatus) echo 'not json'; echo '{\"event\":\"changed\"}'; printf '{\"id\":%s,\"result\":\"full_access\"}\\n' \"$id\" ;;\n",
    );
    let bridge = fake.bridge();
    let mut changed = bridge.subscribe_changed().await;
    assert_eq!(
        fake_starts_after(&fake, &bridge).await,
        1,
        "subscribing started the helper"
    );
    // Lines are read in order, so the change was delivered before the reply.
    assert!(changed.try_recv().is_ok());
}

async fn fake_starts_after(fake: &Fake, bridge: &Bridge) -> usize {
    assert_eq!(
        bridge.authorization_status().await,
        Ok(AuthorizationStatus::FullAccess)
    );
    fake.starts()
}

#[tokio::test]
async fn an_exit_fails_the_call_in_flight_and_the_next_call_respawns() {
    let fake = Fake::new(
        &("    listCalendars) exit 3 ;;\n".to_owned()
            + &answer("authorizationStatus", r#""result":"denied""#)),
    );
    let bridge = fake.bridge();
    let error = bridge.list_calendars().await.unwrap_err();
    assert_eq!(
        (error.code.as_str(), error.message.as_str()),
        ("helper_exited", "code 3")
    );
    assert_eq!(
        bridge.authorization_status().await,
        Ok(AuthorizationStatus::Denied)
    );
    assert_eq!(fake.starts(), 2);
}

#[tokio::test]
async fn only_the_permission_request_outlasts_the_timeout() {
    let fake = Fake::new(
        "    authorizationStatus) sleep 1; printf '{\"id\":%s,\"result\":\"denied\"}\\n' \"$id\" ;;\n    requestFullAccess) sleep 1; printf '{\"id\":%s,\"result\":\"full_access\"}\\n' \"$id\" ;;\n",
    );
    let bridge = Bridge::new(fake.helper.clone(), Duration::from_millis(100));
    let error = bridge.authorization_status().await.unwrap_err();
    assert_eq!(
        error,
        BridgeError {
            code: "timeout".to_owned(),
            message: "authorizationStatus".to_owned()
        }
    );
    // The user may leave the dialog open for as long as they like.
    assert_eq!(
        bridge.request_full_access().await,
        Ok(AuthorizationStatus::FullAccess)
    );
}

#[tokio::test]
async fn a_missing_helper_is_unavailable_and_a_disposed_bridge_refuses() {
    let fake = Fake::new(&answer("authorizationStatus", r#""result":"denied""#));
    let missing = Bridge::new(fake.dir.path().join("nope"), REQUEST_TIMEOUT);
    assert_eq!(
        missing.authorization_status().await.unwrap_err().code,
        "helper_unavailable"
    );

    let bridge = fake.bridge();
    bridge.authorization_status().await.unwrap();
    bridge.dispose().await;
    assert_eq!(
        bridge.authorization_status().await.unwrap_err().code,
        "disposed"
    );
    assert_eq!(fake.starts(), 1);
}

#[tokio::test]
async fn off_macos_nothing_is_spawned_and_access_is_unsupported_platform() {
    let fake = Fake::new(&answer("authorizationStatus", r#""result":"full_access""#));
    for os in ["windows", "linux"] {
        let eventkit = EventKit::new(os, fake.helper.clone());
        assert!(matches!(eventkit.load().await, Load::UnsupportedPlatform));
        assert_eq!(
            eventkit.request_access().await,
            Err(AccessError::UnsupportedPlatform)
        );
        assert_eq!(
            AccessError::UnsupportedPlatform.as_str(),
            "unsupported_platform"
        );
    }
    assert_eq!(fake.starts(), 0);
}

#[tokio::test]
async fn a_missing_helper_on_macos_is_unavailable_until_it_appears() {
    let fake = Fake::new(&answer("authorizationStatus", r#""result":"full_access""#));
    let later = fake.dir.path().join("bin").join("memry-eventkit");
    let eventkit = EventKit::new("macos", later.clone());
    assert_eq!(
        eventkit.request_access().await,
        Err(AccessError::Unavailable)
    );
    std::fs::create_dir_all(later.parent().unwrap()).unwrap();
    std::fs::copy(&fake.helper, &later).unwrap();
    assert_eq!(
        eventkit.request_access().await,
        Ok(AuthorizationStatus::FullAccess)
    );
}

#[tokio::test]
async fn access_prompts_only_when_never_answered() {
    let undecided = Fake::new(
        &(answer("authorizationStatus", r#""result":"not_determined""#)
            + &answer("requestFullAccess", r#""result":"denied""#)),
    );
    let eventkit = EventKit::new("macos", undecided.helper.clone());
    assert_eq!(
        eventkit.request_access().await,
        Ok(AuthorizationStatus::Denied)
    );
    assert_eq!(
        methods(&undecided),
        ["authorizationStatus", "requestFullAccess"]
    );

    for answered in ["denied", "restricted", "write_only", "full_access"] {
        let fake = Fake::new(&answer(
            "authorizationStatus",
            &format!(r#""result":"{answered}""#),
        ));
        let eventkit = EventKit::new("macos", fake.helper.clone());
        assert!(eventkit.request_access().await.is_ok());
        assert_eq!(methods(&fake), ["authorizationStatus"], "{answered}");
    }
}

#[tokio::test]
async fn access_failures_map_to_the_panel_codes() {
    let refused = Fake::new(&answer(
        "authorizationStatus",
        r#""error":{"code":"not_authorized","message":"x"}"#,
    ));
    let eventkit = EventKit::new("macos", refused.helper.clone());
    assert_eq!(
        eventkit.request_access().await,
        Err(AccessError::PermissionDenied)
    );

    let crashed = Fake::new("    authorizationStatus) exit 1 ;;\n");
    let eventkit = EventKit::new("macos", crashed.helper.clone());
    assert_eq!(
        eventkit.request_access().await,
        Err(AccessError::Unavailable)
    );

    let odd = Fake::new(&answer(
        "authorizationStatus",
        r#""error":{"code":"internal","message":"x"}"#,
    ));
    let eventkit = EventKit::new("macos", odd.helper.clone());
    assert_eq!(eventkit.request_access().await, Err(AccessError::Failed));
    assert_eq!(AccessError::Failed.as_str(), "sync_failed");
}

fn methods(fake: &Fake) -> Vec<String> {
    fake.read("requests")
        .iter()
        .map(|line| {
            let value: serde_json::Value = serde_json::from_str(line).unwrap();
            value["method"].as_str().unwrap().to_owned()
        })
        .collect()
}

#[test]
fn the_helper_sits_beside_the_app_binary() {
    assert_eq!(
        EventKit::beside(std::path::Path::new(
            "/Applications/MemryNote.app/Contents/MacOS/MemryNote"
        )),
        PathBuf::from("/Applications/MemryNote.app/Contents/MacOS/memry-eventkit")
    );
}

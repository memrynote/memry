//! Chapter 06 §6.5.2 P3 between two core vaults and one relay server: a
//! concurrent merge re-queues the merged row, so both devices and the
//! server's row end on one value (`crates/memry-core/src/sync/hardening/requeue.rs`).
//!
//! | Test                                         | Rule                       |
//! | -------------------------------------------- | -------------------------- |
//! | a 3c tie beside a field this device won      | §6.5.1 3c, §6.5.2 P3       |
//! | a 3d tie against an Electron peer's row      | §6.5.1 3d, §6.5.2 P3       |
//! | both devices merge the same pair (mirrored)  | §6.6.2, P3 and P4, no ping-pong |
//!
//! Each fails with the requeue removed: the merging device then holds a value
//! it never pushes.

use crate::desktop_relay::{Device, NOW, Relay, failed};

use memry_core::domain::tasks::{self, NewTask};
use serde_json::{Value as Json, json};

const TASK: &str = "task-1";

fn create(device: &Device) {
    let who = device.id;
    device
        .db()
        .call_blocking(move |conn| {
            let task = NewTask {
                id: TASK,
                title: "Ship",
                project_id: "proj-1",
                due_date: None,
                due_time: None,
                priority: 1,
                repeat_config: None,
                tags: &[],
            };
            tasks::create(conn, &task, who, NOW)
                .map(drop)
                .map_err(failed)
        })
        .expect("create");
}

fn retitle(device: &Device, title: &'static str, at: i64) {
    let who = device.id;
    device
        .db()
        .call_blocking(move |conn| {
            tasks::set_title(conn, TASK, title, who, at)
                .map(drop)
                .map_err(failed)
        })
        .expect("retitle");
}

fn reprioritise(device: &Device, priority: i64, at: i64) {
    let who = device.id;
    device
        .db()
        .call_blocking(move |conn| {
            tasks::set_priority(conn, TASK, priority, who, at)
                .map(drop)
                .map_err(failed)
        })
        .expect("reprioritise");
}

/// `(title, priority, clock)` of a task payload.
fn view(payload: &str) -> (Json, Json, Json) {
    let payload: Json = serde_json::from_str(payload).expect("json");
    (
        payload["title"].clone(),
        payload["priority"].clone(),
        payload["clock"].clone(),
    )
}

fn on(device: &Device) -> (Json, Json, Json) {
    view(&device.stored("task", TASK))
}

fn on_server(relay: &Relay) -> (Json, Json, Json) {
    view(&relay.held("task", TASK).expect("the server holds the task"))
}

/// §6.5.1 3c: A's `title` at `{a:2}` and B's at `{a:1,b:1}` tie at total 2
/// with no `_offline`, and the remote wins the tie at A. A also won
/// `priority`, so A's merge is a row nobody else holds until it is pushed.
#[tokio::test]
async fn a_3c_tie_merged_beside_a_field_this_device_won_reaches_the_peer_and_the_server() {
    let (a, b, relay) = (Device::bare("a"), Device::bare("b"), Relay::default());
    create(&a);
    relay.sync(&a).await;
    relay.sync(&b).await;

    retitle(&a, "From a", NOW + 1);
    reprioritise(&a, 3, NOW + 2);
    retitle(&b, "From b", NOW + 3);
    relay.push(&a).await;
    let sent = relay.push(&b).await;
    assert_eq!(sent[0].rejected, None, "b is ahead on its own component");

    relay.pull(&a).await;
    relay.sync(&a).await;
    relay.sync(&b).await;

    let expected = (json!("From b"), json!(3), json!({"a": 3, "b": 1}));
    assert_eq!(on(&a), expected, "on a");
    assert_eq!(on(&b), expected, "on b");
    assert_eq!(on_server(&relay), expected, "on the server");
}

/// §6.5.1 3d: both `title` clocks carry `_offline` and tie at total 2. The
/// other side is an Electron peer whose row only the server holds.
#[tokio::test]
async fn a_3d_tie_against_an_electron_peer_converges_on_both_devices_and_the_server() {
    let (a, b, relay) = (Device::bare("a"), Device::bare("b"), Relay::default());
    let peer = |title: &str, offline: u64| {
        json!({
            "title": title, "projectId": "proj-1", "priority": 1,
            "clock": {"_offline": offline},
            "fieldClocks": {"title": {"_offline": offline}, "priority": {"_offline": 1}},
        })
        .to_string()
    };
    relay.put("task", TASK, &peer("Ship", 1));
    relay.sync(&a).await;
    relay.sync(&b).await;

    retitle(&a, "From a", NOW + 1);
    reprioritise(&a, 3, NOW + 2);
    relay.push(&a).await;
    relay.put("task", TASK, &peer("From the peer", 2));

    relay.pull(&a).await;
    relay.sync(&a).await;
    relay.sync(&b).await;

    let expected = (
        json!("From the peer"),
        json!(3),
        json!({"_offline": 2, "a": 2}),
    );
    assert_eq!(on(&a), expected, "on a");
    assert_eq!(on(&b), expected, "on b");
    assert_eq!(on_server(&relay), expected, "on the server");
}

/// §6.6.2's mirrored state: each device merges the other's row of the same
/// concurrent pair (B's page was read before its own push landed) and ends on
/// the other's title under one union clock. Each pushes the union once: the
/// first lands, the second is a replay of an identical clock and is acked,
/// and the equal-clock pull settles B (P4). Then both go quiet.
#[tokio::test]
async fn two_devices_that_merged_the_same_pair_push_once_each_and_go_quiet() {
    let (a, b, relay) = (Device::bare("a"), Device::bare("b"), Relay::default());
    create(&a);
    relay.sync(&a).await;
    relay.sync(&b).await;

    retitle(&a, "From a", NOW + 1);
    retitle(&b, "From b", NOW + 2);
    relay.push(&a).await;
    let before_b_landed = relay.snapshot();
    relay.push(&b).await;
    relay.pull(&a).await;
    relay.pull_from(&b, before_b_landed).await;

    let union = json!({"a": 2, "b": 1});
    assert_eq!(on(&a), (json!("From b"), json!(1), union.clone()));
    assert_eq!(on(&b), (json!("From a"), json!(1), union.clone()));

    let first = relay.push(&a).await;
    let second = relay.push(&b).await;
    assert_eq!(first.len(), 1);
    assert_eq!(first[0].rejected, None);
    assert_eq!(second.len(), 1);
    assert_eq!(second[0].rejected, Some("SYNC_REPLAY_DETECTED"));

    for round in 0..3 {
        relay.pull(&a).await;
        relay.pull(&b).await;
        assert!(relay.push(&a).await.is_empty(), "a is quiet, round {round}");
        assert!(relay.push(&b).await.is_empty(), "b is quiet, round {round}");
    }
    let expected = (json!("From b"), json!(1), union);
    assert_eq!(on(&a), expected, "on a");
    assert_eq!(on(&b), expected, "on b");
    assert_eq!(on_server(&relay), expected, "on the server");
}

//! Concurrent task edits across two devices (Step 21d, #3538): a field one
//! device lost in a merge is written once as a `superseded` activity row, under
//! the same id on both devices (Electron's `task-handler.ts` and
//! `activity-log.ts` `recordTaskSuperseded`).
//!
//! | Test                                              | Rule                                    |
//! | ------------------------------------------------- | --------------------------------------- |
//! | a tied edit is superseded on the losing device    | ch. 06 §6.3 step 6, one row, synced     |
//! | both devices lose the mirrored merge              | §6.6.2: one id, insert-if-absent        |
//! | an edit that loses on clock totals                | §6.5.4: no row                          |
//! | a tie this device won under `_offline`            | §6.3's `_offline` tie-break: no row     |
//! | a local delete meets a concurrent edit            | no row for a task deleted here          |
//! | the desktop driver records it                     | the driver registers the observer       |
//! | the driver announces a written row                | `task-activity:created` after the write |
//! | a peer's activity row alone on a page             | `task-activity-handler.ts:76`           |

use std::sync::{Arc, Mutex};

use crate::desktop_relay::{Device, NOW, Relay, failed};
use crate::driver_fakes::Desktop;

use memry_core::domain::task_activity;
use memry_core::domain::task_activity::superseded::{SupersededObserver, superseded_id};
use memry_core::domain::tasks::{self, NewTask};
use memry_core::protocol::types::Declaration;
use memry_core::storage::Db;
use memry_core::sync::driver::observer::{ApplyObserver, Observers};
use rusqlite::Connection;
use serde_json::{Value as Json, json};

const TASK: &str = "task-1";

fn new_task() -> NewTask<'static> {
    NewTask {
        id: TASK,
        title: "Ship",
        project_id: "proj-1",
        due_date: None,
        due_time: None,
        priority: 1,
        repeat_config: None,
        tags: &[],
    }
}

fn create(device: &Device) {
    let who = device.id;
    device
        .db()
        .call_blocking(move |conn| {
            tasks::create(conn, &new_task(), who, NOW)
                .map(drop)
                .map_err(failed)
        })
        .expect("create");
}

fn retitle(device: &Device, title: &'static str) {
    let who = device.id;
    device
        .db()
        .call_blocking(move |conn| {
            tasks::set_title(conn, TASK, title, who, NOW + 1)
                .map(drop)
                .map_err(failed)
        })
        .expect("retitle");
}

fn delete(device: &Device) {
    let who = device.id;
    device
        .db()
        .call_blocking(move |conn| {
            tasks::delete(conn, TASK, who, NOW + 2)
                .map(drop)
                .map_err(failed)
        })
        .expect("delete");
}

/// The device's observers: the ones the desktop driver registers for tasks.
fn observers(device: &Device) -> Arc<Observers> {
    observers_telling(device, Vec::new())
}

fn observers_telling(device: &Device, listeners: Vec<Arc<dyn ApplyObserver>>) -> Arc<Observers> {
    let observers = Arc::new(Observers::default());
    observers.register(SupersededObserver::new(
        device.db(),
        device.id.to_owned(),
        listeners,
    ));
    observers
}

/// The renderer's `task-activity:created` listener: on each call it refetches, reading the
/// task's activity rows there and then.
struct Refetch {
    db: std::sync::OnceLock<Db>,
    /// `(task ids told, the told tasks' activity row ids read in the call)`.
    heard: Mutex<Vec<(Vec<String>, Vec<String>)>>,
}

impl Refetch {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            db: std::sync::OnceLock::new(),
            heard: Mutex::default(),
        })
    }

    fn over(db: Db) -> Arc<Self> {
        let refetch = Self::new();
        refetch.bind(db);
        refetch
    }

    fn bind(&self, db: Db) {
        assert!(self.db.set(db).is_ok(), "bound once");
    }

    fn heard(&self) -> Vec<(Vec<String>, Vec<String>)> {
        self.heard.lock().unwrap().clone()
    }
}

impl ApplyObserver for Refetch {
    fn name(&self) -> &str {
        "refetch"
    }

    fn task_activity_created(&self, task_ids: &[String]) {
        let ids = task_ids.to_vec();
        let rows = self
            .db
            .get()
            .expect("the refetch's vault")
            .call_blocking(move |conn| {
                let mut statement = conn
                    .prepare("SELECT id FROM task_activity WHERE task_id = ?1 ORDER BY id")
                    .map_err(failed)?;
                let mut rows = Vec::new();
                for task_id in &ids {
                    for id in statement
                        .query_map([task_id], |row| row.get::<_, String>(0))
                        .map_err(failed)?
                    {
                        rows.push(id.map_err(failed)?);
                    }
                }
                Ok(rows)
            })
            .expect("the refetch");
        self.heard.lock().unwrap().push((task_ids.to_vec(), rows));
    }
}

fn now_ms() -> i64 {
    let elapsed = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("after the epoch");
    i64::try_from(elapsed.as_millis()).expect("fits")
}

/// Pulls everything the relay holds, the task observer listening.
async fn pull(relay: &Relay, device: &Device) {
    relay
        .pull_observed(device, relay.snapshot(), observers(device))
        .await;
}

/// A pass: the observed pull, then the push.
async fn sync(relay: &Relay, device: &Device) {
    pull(relay, device).await;
    relay.push(device).await;
}

/// `(id, field, oldValue, newValue, actor)` of every `superseded` row.
type Row = (String, String, Option<String>, Option<String>, String);

fn superseded_rows(db: &Db) -> Vec<Row> {
    db.call_blocking(|conn| superseded_in(conn).map_err(failed))
        .expect("the superseded rows")
}

fn superseded_in(conn: &Connection) -> rusqlite::Result<Vec<Row>> {
    let mut statement = conn.prepare(
        "SELECT id, field, old_value, new_value, actor FROM task_activity
          WHERE action = 'superseded' ORDER BY id",
    )?;
    statement
        .query_map([], |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
            ))
        })?
        .collect()
}

fn title(device: &Device) -> Json {
    let payload: Json = serde_json::from_str(&device.stored("task", TASK)).expect("json");
    payload["title"].clone()
}

/// Both devices start from the same task, synced.
async fn shared(relay: &Relay) -> (Device, Device) {
    let (a, b) = (Device::bare("a"), Device::bare("b"));
    create(&a);
    sync(relay, &a).await;
    sync(relay, &b).await;
    (a, b)
}

/// A's `title` at `{a:2}` and B's at `{a:1,b:1}` tie at total 2; the remote
/// wins the tie, so the device that pulls first loses its edit.
#[tokio::test]
async fn a_tied_edit_is_superseded_once_on_the_losing_device_and_synced_to_the_other() {
    let relay = Relay::default();
    let (a, b) = shared(&relay).await;
    retitle(&a, "From a");
    retitle(&b, "From b");
    relay.push(&a).await;

    sync(&relay, &b).await;
    sync(&relay, &a).await;

    let id = superseded_id(TASK, "title", &json!({"a": 2, "b": 1}));
    let row: Row = (
        id,
        "title".to_owned(),
        Some(r#""From b""#.to_owned()),
        Some(r#""From a""#.to_owned()),
        "sync".to_owned(),
    );
    assert_eq!(
        superseded_rows(&b.db()),
        std::slice::from_ref(&row),
        "on b, the loser"
    );
    assert_eq!(superseded_rows(&a.db()), [row], "on a, through sync");
    assert_eq!((title(&a), title(&b)), (json!("From a"), json!("From a")));
}

/// §6.6.2: each device pulls the other's row before either pushes its merge,
/// so both lose. Both mint the id from the same merged clock, and each ends
/// with one row.
#[tokio::test]
async fn both_devices_lose_the_mirrored_merge_and_keep_one_row_under_one_id() {
    let relay = Relay::default();
    let (a, b) = shared(&relay).await;
    retitle(&a, "From a");
    retitle(&b, "From b");
    relay.push(&a).await;
    let a_row = relay.snapshot();
    relay.push(&b).await;
    let b_row = relay.snapshot();

    relay.pull_observed(&b, a_row, observers(&b)).await;
    relay.pull_observed(&a, b_row, observers(&a)).await;
    let id = superseded_id(TASK, "title", &json!({"a": 2, "b": 1}));
    let ids = |device: &Device| -> Vec<String> {
        superseded_rows(&device.db())
            .into_iter()
            .map(|row| row.0)
            .collect()
    };
    assert_eq!(ids(&a), [id.as_str()], "a lost too");
    assert_eq!(ids(&b), [id.as_str()], "b lost too");

    sync(&relay, &a).await;
    sync(&relay, &b).await;
    sync(&relay, &a).await;
    assert_eq!(ids(&a), [id.as_str()], "on a after sync");
    assert_eq!(ids(&b), [id.as_str()], "on b after sync");
    assert_eq!(title(&a), title(&b), "the task converged");
}

/// §6.5.4: A edited twice, so its total wins outright and B's edit is not a
/// conflict. Desktop writes no row for it, and neither does the core.
#[tokio::test]
async fn an_edit_that_loses_on_clock_totals_writes_no_row() {
    let relay = Relay::default();
    let (a, b) = shared(&relay).await;
    retitle(&a, "From a");
    retitle(&a, "From a again");
    retitle(&b, "From b");
    relay.push(&a).await;

    sync(&relay, &b).await;
    sync(&relay, &a).await;

    assert_eq!(superseded_rows(&a.db()), []);
    assert_eq!(superseded_rows(&b.db()), []);
    assert_eq!(title(&b), json!("From a again"));
}

/// An older Electron peer's offline retitle reaches A at `{a:1,_offline:1}`
/// (this core never mints `_offline`, chapter 06 §6.6.1), and B's retitle at
/// `{a:1,b:1}` ties it. §6.3's `_offline` tie-break keeps A's value: A pulls a
/// conflict it won, and B then takes A's merge outright, so neither device
/// lost an edit and neither writes a row.
#[tokio::test]
async fn a_tie_this_device_won_under_offline_writes_no_row() {
    let relay = Relay::default();
    let (a, b) = shared(&relay).await;
    let mut offline: Json = serde_json::from_str(&a.stored("task", TASK)).expect("json");
    let clock = json!({"a": 1, "_offline": 1});
    offline["title"] = json!("From e");
    offline["clock"] = clock.clone();
    offline["fieldClocks"]["title"] = clock;
    relay.put("task", TASK, &offline.to_string());
    pull(&relay, &a).await;
    retitle(&b, "From b");
    relay.push(&b).await;

    sync(&relay, &a).await;
    sync(&relay, &b).await;

    assert_eq!(superseded_rows(&a.db()), [], "a won the tie");
    assert_eq!(superseded_rows(&b.db()), [], "b took a's merge outright");
    assert_eq!((title(&a), title(&b)), (json!("From e"), json!("From e")));
}

/// A edits and then deletes the task; B's tied edit reaches A first. Desktop
/// has no row to merge into (the delete removed it), so A writes nothing, and
/// the delete still reaches B.
#[tokio::test]
async fn a_local_delete_meets_a_concurrent_edit_and_writes_no_row() {
    let relay = Relay::default();
    let (a, b) = shared(&relay).await;
    retitle(&a, "From a");
    retitle(&b, "From b");
    delete(&a);
    relay.push(&b).await;

    sync(&relay, &a).await;
    sync(&relay, &b).await;

    let deleted = "SELECT COUNT(*) FROM sync_items WHERE item_type = 'task' \
                   AND deleted_at IS NOT NULL";
    assert_eq!(
        (a.count(deleted), b.count(deleted)),
        (1, 1),
        "deleted on both"
    );
    assert_eq!(superseded_rows(&a.db()), []);
    assert_eq!(superseded_rows(&b.db()), []);
}

/// The desktop driver hears its own pulls: a pass that merges a tied peer
/// edit writes the row with no observer registered by the caller.
#[tokio::test]
async fn the_desktop_driver_records_a_lost_edit() {
    let desktop = Desktop::open(&["task", "task_activity"], |conn| {
        tasks::create(conn, &new_task(), "desk", NOW).map(drop)
    })
    .await;
    desktop.server.put(
        "task",
        TASK,
        json!({
            "title": "From the peer", "projectId": "proj-1", "priority": 1,
            "clock": {"peer": 1}, "fieldClocks": {"title": {"peer": 1}},
            "createdAt": "2025-10-09T08:53:20.000Z", "modifiedAt": "2025-10-09T08:53:20.000Z",
        }),
    );
    desktop.server.page(&[TASK], "1");
    desktop.pass().await;

    let id = superseded_id(TASK, "title", &json!({"desk": 1, "peer": 1}));
    let rows = superseded_rows(&desktop.db);
    assert_eq!(
        rows,
        [(
            id,
            "title".to_owned(),
            Some(r#""Ship""#.to_owned()),
            Some(r#""From the peer""#.to_owned()),
            "sync".to_owned(),
        )]
    );
}

/// The renderer's refetch at `task-activity:created` sees the `superseded` row it announces: the
/// driver tells its listeners after the write commits, never before.
#[tokio::test]
async fn the_desktop_driver_announces_a_lost_edit_after_its_row_is_written() {
    let refetch = Refetch::new();
    let desktop = Desktop::open_observed(
        Declaration::declare(&["task", "task_activity"]).expect("recognised"),
        |conn| tasks::create(conn, &new_task(), "desk", NOW).map(drop),
        vec![Arc::clone(&refetch) as Arc<dyn ApplyObserver>],
    )
    .await;
    refetch.bind(desktop.db.clone());
    desktop.server.put(
        "task",
        TASK,
        json!({
            "title": "From the peer", "projectId": "proj-1", "priority": 1,
            "clock": {"peer": 1}, "fieldClocks": {"title": {"peer": 1}},
            "createdAt": "2025-10-09T08:53:20.000Z", "modifiedAt": "2025-10-09T08:53:20.000Z",
        }),
    );
    desktop.server.page(&[TASK], "1");
    desktop.pass().await;

    let id = superseded_id(TASK, "title", &json!({"desk": 1, "peer": 1}));
    assert_eq!(refetch.heard(), [(vec![TASK.to_owned()], vec![id])]);
}

/// A peer's activity row pulled on a page with no task update still reaches the open feed
/// (Electron's `task-activity-handler.ts:76`), and the refetch then sees it.
#[tokio::test]
async fn a_peer_activity_row_alone_on_a_page_tells_its_task_once_it_landed() {
    let relay = Relay::default();
    let (a, b) = shared(&relay).await;
    let who = a.id;
    let written = a
        .db()
        .call_blocking(move |conn| {
            task_activity::record_field_change(
                conn,
                TASK,
                "priority",
                &json!(1),
                &json!(3),
                who,
                now_ms(),
            )
        })
        .expect("the peer's row");
    relay.push(&a).await;
    let page = relay
        .snapshot()
        .into_iter()
        .filter(|(_, sent)| sent.item_type == task_activity::ITEM_TYPE)
        .collect();

    let refetch = Refetch::over(b.db());
    relay
        .pull_observed(
            &b,
            page,
            observers_telling(&b, vec![Arc::clone(&refetch) as Arc<dyn ApplyObserver>]),
        )
        .await;

    let heard = refetch.heard();
    assert_eq!(heard.len(), 1, "one call for the page: {heard:?}");
    assert_eq!(heard[0].0, [TASK]);
    assert!(
        written.iter().all(|id| heard[0].1.contains(id)),
        "the refetch saw {:?}, not {written:?}",
        heard[0].1
    );
}

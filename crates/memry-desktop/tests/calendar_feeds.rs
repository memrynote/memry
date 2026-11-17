//! Subscribed calendars over a real vault (`ics-subscriptions.test.ts`, `ics-runner.ts`):
//! `IcsFeeds` and the session-owned `CalendarRunner`, fetching from a local TLS server through
//! the app's HTTP builder and writing through the core's `VaultCalendar::feed_*`.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use memry_desktop::calendar_providers::feeds::{FeedChange, FeedsError, IcsFeeds};
use memry_desktop::calendar_providers::ics_fetch::{IcsFeedCode, IcsFetcher, TIMEOUT};
use memry_desktop::calendar_providers::runner::{CalendarRunner, STOP_WAIT};
use memry_desktop::registry::{AppConfig, VaultRegistry};
use memry_desktop::session::{OpenSource, OpenVault, Session};
use memry_desktop::shell::shutdown::{
    ShutdownContext, ShutdownReason, ShutdownRegistry, run_shutdown_sequence,
};
use tokio::runtime::Handle;
use tokio_util::sync::CancellationToken;

use memry_core::seams::secure_store::{SecureStore, SecureStoreKey};

use crate::device_key::{with_device_key, without_device_key};
use crate::unsplash_server::{Harness, Reply, Seen, serve, serve_plain};

const URL: &str = "webcal://feeds.example/team.ics";
const SOURCE_PATH: &str = "/team.ics";
const OTHER_URL: &str = "https://feeds.example/other.ics";

fn feed() -> String {
    let day = chrono::Utc::now().format("%Y%m%d");
    format!(
        "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nX-WR-CALNAME:Team\r\nBEGIN:VEVENT\r\nUID:standup\r\n\
         DTSTART:{day}T090000Z\r\nDTEND:{day}T091500Z\r\nSUMMARY:Standup\r\nEND:VEVENT\r\n\
         END:VCALENDAR\r\n"
    )
}

/// What the server answers for the feed path, switchable mid-test.
#[derive(Clone, Copy, PartialEq)]
enum Mode {
    Feed,
    NotModified,
    Missing,
    NotACalendar,
    Stall,
    /// Answers the feed once the test notifies `Rig::release`.
    Held,
}

struct Rig {
    _dir: tempfile::TempDir,
    vault: std::path::PathBuf,
    session: Session,
    harness: Harness,
    mode: Arc<Mutex<Mode>>,
    changes: Arc<Mutex<Vec<FeedChange>>>,
    feeds: Arc<IcsFeeds>,
    release: Arc<tokio::sync::Notify>,
}

impl Rig {
    async fn new() -> Self {
        Self::with_store(with_device_key()).await
    }

    async fn with_store(store: Arc<dyn SecureStore>) -> Self {
        let mode = Arc::new(Mutex::new(Mode::Feed));
        let answer = Arc::clone(&mode);
        let release = Arc::new(tokio::sync::Notify::new());
        let gate = Arc::clone(&release);
        let harness = serve(move |seen: &Seen| {
            if seen.target != SOURCE_PATH && seen.target != "/other.ics" {
                return Reply::status(404);
            }
            let ok = || Reply::Ok {
                status: 200,
                headers: vec![("etag", "\"v1\"".to_owned())],
                body: feed().into_bytes(),
            };
            match *answer.lock().unwrap() {
                Mode::Feed => ok(),
                Mode::Held => Reply::Gated {
                    gate: Arc::clone(&gate),
                    then: Box::new(ok()),
                },
                Mode::NotModified => Reply::status(304),
                Mode::Missing => Reply::status(404),
                Mode::NotACalendar => Reply::Ok {
                    status: 200,
                    headers: Vec::new(),
                    body: b"<html>not a calendar</html>".to_vec(),
                },
                Mode::Stall => Reply::Stall,
            }
        })
        .await;
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("app")).unwrap();
        let vault = dir.path().join("vault");
        std::fs::create_dir_all(&vault).unwrap();
        let config = AppConfig::load(dir.path().join("app").join("memry-config.json"));
        let session = Session::new(VaultRegistry::new(Arc::new(config)));
        let changes = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&changes);
        let feeds = Arc::new(IcsFeeds::new(
            IcsFetcher::new(harness.builder(), TIMEOUT).unwrap(),
            store,
            Arc::new(move |change| sink.lock().unwrap().push(change)),
        ));
        Self {
            _dir: dir,
            vault,
            session,
            harness,
            mode,
            changes,
            feeds,
            release,
        }
    }

    fn take_changes(&self) -> Vec<FeedChange> {
        std::mem::take(&mut *self.changes.lock().unwrap())
    }

    fn set(&self, mode: Mode) {
        *self.mode.lock().unwrap() = mode;
    }

    fn feed_requests(&self) -> usize {
        self.harness
            .seen()
            .iter()
            .filter(|s| s.target == SOURCE_PATH)
            .count()
    }

    async fn open(&self) -> OpenVault {
        let (session, vault) = (self.session.clone(), self.vault.clone());
        tokio::task::spawn_blocking(move || session.open(&vault, OpenSource::Select).unwrap().vault)
            .await
            .unwrap()
    }

    async fn close(&self) {
        let session = self.session.clone();
        tokio::task::spawn_blocking(move || session.close())
            .await
            .unwrap();
    }

    /// Forgets this device's fetch state, as on a device the source synced to and that never
    /// fetched it: the next runner pass finds it due.
    fn forget_fetch_state(&self) {
        let db = rusqlite::Connection::open(self.vault.join(".memry/core/data.db")).unwrap();
        db.execute("DELETE FROM calendar_source_states", [])
            .unwrap();
    }

    fn runner(&self, tick: Duration) -> Arc<CalendarRunner> {
        let runner = CalendarRunner::new(self.feeds.clone(), Handle::current(), tick);
        runner.register(&self.session);
        runner
    }
}

async fn eventually(what: &str, check: impl Fn() -> bool) {
    for _ in 0..400 {
        if check() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    panic!("never happened: {what}");
}

fn state(
    open: &OpenVault,
    id: &str,
) -> Option<memry_core::api::calendar_providers::CalendarFeedState> {
    open.vault
        .calendar(with_device_key())
        .unwrap()
        .feed_states()
        .unwrap()
        .into_iter()
        .find(|s| s.source_id == id)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn subscribe_mirrors_the_feed_and_a_second_subscribe_does_not_fetch() {
    let rig = Rig::new().await;
    let open = rig.open().await;
    let subscribed = rig
        .feeds
        .subscribe(&rig.session, &open, URL, None)
        .await
        .unwrap();
    assert!(subscribed.source_id.starts_with("ics-calendar:"));
    assert_eq!(subscribed.summary.event_count, 1);
    let seen = rig.harness.seen();
    assert_eq!(seen.len(), 1);
    assert_eq!(
        seen[0].host, "feeds.example",
        "webcal is fetched over https"
    );

    let again = rig
        .feeds
        .subscribe(
            &rig.session,
            &open,
            "https://feeds.example/team.ics#frag",
            Some("Other"),
        )
        .await
        .unwrap();
    assert_eq!(again, subscribed);
    assert_eq!(
        rig.feed_requests(),
        1,
        "an existing subscription is returned as is"
    );

    let sources = open
        .vault
        .calendar(with_device_key())
        .unwrap()
        .sources()
        .unwrap();
    let source = sources
        .iter()
        .find(|s| s.id == subscribed.source_id)
        .unwrap();
    assert_eq!(source.title, "Team");
    assert_eq!(source.remote_id, "https://feeds.example/team.ics");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_link_that_is_not_a_calendar_saves_nothing() {
    let rig = Rig::new().await;
    let open = rig.open().await;
    rig.set(Mode::NotACalendar);
    assert!(matches!(
        rig.feeds.subscribe(&rig.session, &open, URL, None).await,
        Err(FeedsError::Feed(IcsFeedCode::NotACalendar))
    ));
    rig.set(Mode::Missing);
    assert!(matches!(
        rig.feeds.subscribe(&rig.session, &open, URL, None).await,
        Err(FeedsError::Feed(IcsFeedCode::NotFound))
    ));
    assert!(matches!(
        rig.feeds
            .subscribe(&rig.session, &open, "ftp://feeds.example/team.ics", None)
            .await,
        Err(FeedsError::Feed(IcsFeedCode::InvalidUrl))
    ));
    assert!(matches!(
        rig.feeds.subscribe(&rig.session, &open, "  ", None).await,
        Err(FeedsError::Invalid(_))
    ));
    assert_eq!(rig.feed_requests(), 2, "the ftp link was never requested");
    let calendar = open.vault.calendar(with_device_key()).unwrap();
    assert!(calendar.sources().unwrap().is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn refresh_is_conditional_and_records_a_failure_on_the_source() {
    let rig = Rig::new().await;
    let open = rig.open().await;
    let id = rig
        .feeds
        .subscribe(&rig.session, &open, URL, None)
        .await
        .unwrap()
        .source_id;

    rig.set(Mode::NotModified);
    rig.feeds.refresh(&rig.session, &open, &id).await.unwrap();
    let seen = rig.harness.seen();
    assert_eq!(
        seen.last().unwrap().if_none_match.as_deref(),
        Some("\"v1\"")
    );
    assert_eq!(state(&open, &id).unwrap().sync_status, "ok");

    rig.set(Mode::Missing);
    assert!(matches!(
        rig.feeds.refresh(&rig.session, &open, &id).await,
        Err(FeedsError::Feed(IcsFeedCode::NotFound))
    ));
    let failed = state(&open, &id).unwrap();
    assert_eq!(failed.sync_status, "error");
    assert_eq!(failed.last_error.as_deref(), Some("not_found"));
    assert_eq!(failed.event_count, 1, "a failed fetch keeps the mirror");

    assert!(matches!(
        rig.feeds
            .refresh(&rig.session, &open, "ics-calendar:nope")
            .await,
        Err(FeedsError::NotFound(_))
    ));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn unsubscribe_drops_the_source_and_its_mirror() {
    let rig = Rig::new().await;
    let open = rig.open().await;
    let id = rig
        .feeds
        .subscribe(&rig.session, &open, URL, None)
        .await
        .unwrap()
        .source_id;
    rig.feeds.unsubscribe(&open, &id).await.unwrap();
    assert!(state(&open, &id).is_none());
    let calendar = open.vault.calendar(with_device_key()).unwrap();
    assert!(calendar.sources().unwrap().iter().all(|s| s.id != id));
    assert!(matches!(
        rig.feeds.unsubscribe(&open, &id).await,
        Err(FeedsError::NotFound(_))
    ));
}

/// Subscribes in a first open, then forgets the fetch state, so the feed is due.
async fn due_feed(rig: &Rig) -> String {
    let open = rig.open().await;
    let id = rig
        .feeds
        .subscribe(&rig.session, &open, URL, None)
        .await
        .unwrap()
        .source_id;
    drop(open);
    rig.close().await;
    rig.forget_fetch_state();
    id
}

/// Electron subscribes and refreshes without an account (`accountId: null`).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_device_that_never_signed_in_subscribes_and_its_feed_refreshes() {
    let store = without_device_key();
    let rig = Rig::with_store(store.clone()).await;
    let id = due_feed(&rig).await;
    assert!(
        store
            .get(SecureStoreKey::DeviceSigningKey)
            .unwrap()
            .is_some(),
        "the subscribe minted this device's key"
    );

    let runner = rig.runner(Duration::from_millis(20));
    let open = rig.open().await;
    eventually("the runner fetched the due feed", || {
        rig.feed_requests() == 2
    })
    .await;
    rig.feeds.refresh(&rig.session, &open, &id).await.unwrap();
    assert_eq!(rig.feed_requests(), 3);
    drop(open);
    rig.close().await;
    assert!(!runner.is_running());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_runner_refreshes_due_feeds_on_open_and_stops_with_the_close() {
    let rig = Rig::new().await;
    let id = due_feed(&rig).await;
    let runner = rig.runner(Duration::from_millis(20));
    let open = rig.open().await;
    eventually("the runner fetched the due feed", || {
        rig.feed_requests() == 2
    })
    .await;
    assert!(runner.is_running());
    eventually("the fetch is recorded", || {
        state(&open, &id).is_some_and(|s| s.sync_status == "ok")
    })
    .await;
    drop(open);

    rig.close().await;
    assert!(!runner.is_running(), "the close hook stopped the task");
    rig.forget_fetch_state();
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(rig.feed_requests(), 2, "no pass runs after the close");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_close_drops_a_fetch_in_flight() {
    let rig = Rig::new().await;
    due_feed(&rig).await;
    rig.set(Mode::Stall);
    let runner = rig.runner(Duration::from_secs(60));
    rig.open().await;
    eventually("the runner is fetching", || rig.feed_requests() == 2).await;
    let stopped = tokio::task::spawn_blocking({
        let runner = runner.clone();
        move || runner.stop(STOP_WAIT)
    })
    .await
    .unwrap();
    assert!(stopped, "the stalled fetch let go of the vault");
    rig.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn stop_schedulers_halts_the_runner_for_good() {
    let rig = Rig::new().await;
    due_feed(&rig).await;
    let runner = rig.runner(Duration::from_millis(20));
    let steps = ShutdownRegistry::default();
    steps
        .register("stop-schedulers", runner.shutdown_step())
        .unwrap();
    let ctx = ShutdownContext {
        installing_update: false,
        reason: ShutdownReason::Quit,
    };
    run_shutdown_sequence(&steps.steps(), ctx, Duration::from_secs(8), &|_| {})
        .await
        .expect("the sequence runs");

    rig.open().await;
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(!runner.is_running());
    assert_eq!(rig.feed_requests(), 1, "only the subscribe fetched");
    rig.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn each_change_is_reported_where_electron_emits_it() {
    let rig = Rig::new().await;
    let open = rig.open().await;
    let id = rig
        .feeds
        .subscribe(&rig.session, &open, URL, None)
        .await
        .unwrap()
        .source_id;
    let (source, projection) = (
        FeedChange::Source(id.clone()),
        FeedChange::Projection(id.clone()),
    );
    assert_eq!(rig.take_changes(), [projection.clone(), source.clone()]);

    rig.feeds
        .subscribe(&rig.session, &open, URL, None)
        .await
        .unwrap();
    assert_eq!(
        rig.take_changes(),
        [],
        "an existing subscription changes nothing"
    );

    rig.set(Mode::NotModified);
    rig.feeds.refresh(&rig.session, &open, &id).await.unwrap();
    assert_eq!(rig.take_changes(), std::slice::from_ref(&source));

    rig.set(Mode::Feed);
    rig.feeds.refresh(&rig.session, &open, &id).await.unwrap();
    assert_eq!(
        rig.take_changes(),
        std::slice::from_ref(&source),
        "the same events leave the mirror as is"
    );

    rig.set(Mode::Missing);
    rig.feeds
        .refresh(&rig.session, &open, &id)
        .await
        .unwrap_err();
    assert_eq!(
        rig.take_changes(),
        std::slice::from_ref(&source),
        "the failure is on the source"
    );

    rig.feeds.unsubscribe(&open, &id).await.unwrap();
    assert_eq!(rig.take_changes(), [projection, source]);

    rig.feeds
        .refresh(&rig.session, &open, &id)
        .await
        .unwrap_err();
    assert_eq!(rig.take_changes(), [], "nothing changed for a removed feed");
}

/// Electron subscribes to `http:` links (`ics-feed.ts:50`); one synced from it keeps working.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_http_feed_subscribes_as_on_electron() {
    let rig = Rig::new().await;
    let plain = serve_plain(|_| Reply::Ok {
        status: 200,
        headers: Vec::new(),
        body: feed().into_bytes(),
    })
    .await;
    let open = rig.open().await;
    let url = plain.url("/team.ics");
    let subscribed = rig
        .feeds
        .subscribe(&rig.session, &open, &url, None)
        .await
        .unwrap();
    assert_eq!(subscribed.summary.event_count, 1);
    assert_eq!(plain.seen().len(), 1);
    let sources = open
        .vault
        .calendar(with_device_key())
        .unwrap()
        .sources()
        .unwrap();
    assert!(
        sources
            .iter()
            .any(|s| s.id == subscribed.source_id && s.remote_id == url)
    );
}

/// `refreshDueIcsCalendars` catches per feed (`ics-subscriptions.ts:445-451`): a feed whose
/// outcome cannot be written is logged and the next one is still fetched and recorded.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_feed_that_fails_to_record_does_not_hold_up_the_next() {
    let rig = Rig::new().await;
    let open = rig.open().await;
    for url in [URL, OTHER_URL] {
        rig.feeds
            .subscribe(&rig.session, &open, url, None)
            .await
            .unwrap();
    }
    rig.forget_fetch_state();
    let calendar = open.vault.calendar(with_device_key()).unwrap();
    let due: Vec<String> = calendar
        .feeds_due(false)
        .unwrap()
        .into_iter()
        .map(|d| d.source_id)
        .collect();
    assert_eq!(due.len(), 2);
    let db = rusqlite::Connection::open(rig.vault.join(".memry/core/data.db")).unwrap();
    db.execute_batch(&format!(
        "CREATE TRIGGER refuse_first BEFORE INSERT ON calendar_source_states \
         WHEN NEW.source_id = '{}' BEGIN SELECT RAISE(ABORT, 'refused'); END;",
        due[0]
    ))
    .unwrap();
    let before = rig.harness.seen().len();
    rig.feeds
        .refresh_due(&open, &CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(
        rig.harness.seen().len(),
        before + 2,
        "both feeds were fetched"
    );
    assert_eq!(state(&open, &due[1]).unwrap().sync_status, "ok");
}

/// A subscribe whose fetch outlasts the vault writes nothing into it.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_subscribe_that_outlives_its_vault_writes_nothing() {
    let rig = Rig::new().await;
    let open = rig.open().await;
    rig.set(Mode::Held);
    let subscribe = tokio::spawn({
        let (feeds, session, open) = (rig.feeds.clone(), rig.session.clone(), open.clone());
        async move { feeds.subscribe(&session, &open, URL, None).await }
    });
    eventually("the feed is requested", || rig.feed_requests() == 1).await;
    drop(open);
    rig.close().await;
    rig.release.notify_one();
    let outcome = subscribe.await.unwrap();
    assert!(matches!(outcome, Err(FeedsError::Closed)), "{outcome:?}");

    let open = rig.open().await;
    let calendar = open.vault.calendar(with_device_key()).unwrap();
    assert!(calendar.sources().unwrap().is_empty());
    assert!(calendar.feed_states().unwrap().is_empty());
}

//! The Inbox job runner on a real session and vault against a local web server: a link's preview
//! and article land on the capture and in the outbox, a failing page retries then marks the link
//! failed, only http(s) heroes are downloaded, links an older build left unfetched are fetched at
//! open, and a close or `stop-schedulers` stops the runner with the job resumed at the next open.

use std::net::SocketAddr;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc::{Receiver, channel};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use axum::http::{StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use memry_core::api::errors::SecureStoreError;
use memry_core::api::inbox::Inbox;
use memry_core::api::inbox_records::InboxItemRecord;
use memry_core::domain::inbox::jobs::{InboxJobStatus, InboxJobType};
use memry_core::seams::secure_store::{SecureStore, SecureStoreKey};
use memry_core::storage::repositories::sync_items;
use memry_desktop::registry::{AppConfig, VaultRegistry};
use memry_desktop::services::inbox_jobs::{
    InboxJobNotice, InboxJobs, ItemChanges, PARSE_DEADLINE, PARSE_TIMED_OUT,
};
use memry_desktop::services::web_fetch::{Limits, WebFetch};
use memry_desktop::session::{OpenSource, OpenVault, Session};
use serde_json::Value;

use crate::device_key::with_device_key;

/// How long a test waits for the runner before it fails instead of hanging.
const PATIENCE: Duration = Duration::from_secs(120);

const PNG: &[u8] = b"\x89PNG\r\n\x1a\nnot really an image";

fn page(base: &str, hero: &str) -> String {
    let prose =
        "<p>Small teams ship product by writing down what they decided and why. </p>".repeat(12);
    format!(
        "<html><head><title>Linear Method</title>\
         <meta property=\"og:title\" content=\"Linear Method\">\
         <meta property=\"og:description\" content=\"How small teams build.\">\
         <meta property=\"og:site_name\" content=\"Linear\">\
         <meta property=\"og:image\" content=\"{hero}\">\
         <link rel=\"canonical\" href=\"{base}/post\">\
         </head><body><article><h1>Linear Method</h1>{prose}</article></body></html>"
    )
}

struct Server {
    addr: SocketAddr,
    seen: Arc<Mutex<Vec<String>>>,
}

impl Server {
    fn url(&self, path: &str) -> String {
        format!("http://news.example.com:{}{path}", self.addr.port())
    }

    fn hits(&self, path: &str) -> usize {
        self.seen
            .lock()
            .unwrap()
            .iter()
            .filter(|p| *p == path)
            .count()
    }
}

async fn start() -> Server {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let slow_calls = Arc::new(AtomicUsize::new(0));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let base = format!("http://news.example.com:{}", addr.port());
    let record = seen.clone();
    let app = axum::Router::new().fallback(move |uri: Uri| {
        let (record, slow_calls, base) = (record.clone(), slow_calls.clone(), base.clone());
        async move {
            let path = uri.path().to_owned();
            record.lock().unwrap().push(path.clone());
            route(&path, &base, &slow_calls).await
        }
    });
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    Server { addr, seen }
}

async fn route(path: &str, base: &str, slow_calls: &AtomicUsize) -> Response {
    let html = |hero: &str| ([("content-type", "text/html")], page(base, hero)).into_response();
    match path {
        "/post" => html(&format!("{base}/hero.png")),
        "/hero.png" => ([("content-type", "image/png")], PNG).into_response(),
        "/data-hero" => html("data:image/png;base64,iVBORw0KGgo="),
        "/ftp-hero" => html("ftp://news.example.com/hero.png"),
        "/down" => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
        "/slow" => {
            if slow_calls.fetch_add(1, Ordering::SeqCst) == 0 {
                tokio::time::sleep(Duration::from_secs(600)).await;
            }
            html(&format!("{base}/hero.png"))
        }
        _ => StatusCode::NOT_FOUND.into_response(),
    }
}

struct World {
    _dir: tempfile::TempDir,
    vault_dir: std::path::PathBuf,
    _runtime: tokio::runtime::Runtime,
    server: Server,
    session: Session,
    jobs: Arc<InboxJobs>,
    notices: Receiver<InboxJobNotice>,
}

fn world() -> World {
    world_with(PARSE_DEADLINE, with_device_key())
}

fn world_with(parse_deadline: Duration, store: Arc<dyn SecureStore>) -> World {
    let dir = tempfile::tempdir().expect("tmp");
    let app = dir.path().join("app");
    let vault_dir = dir.path().join("vault");
    std::fs::create_dir_all(&app).expect("app dir");
    std::fs::create_dir_all(&vault_dir).expect("vault dir");
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .expect("runtime");
    let server = runtime.block_on(start());
    let web =
        WebFetch::for_tests(Limits::default(), &[("news.example.com", server.addr)]).expect("web");
    let config = Arc::new(AppConfig::load(app.join("memry-config.json")));
    let session = Session::new(VaultRegistry::new(config));
    let (sent, notices) = channel();
    let sent = Mutex::new(sent);
    let jobs = InboxJobs::with_parse_deadline(
        web,
        runtime.handle().clone(),
        store,
        Box::new(move |notice| {
            let _ = sent.lock().unwrap().send(notice);
        }),
        parse_deadline,
    );
    jobs.register(&session);
    World {
        _dir: dir,
        vault_dir,
        _runtime: runtime,
        server,
        session,
        jobs,
        notices,
    }
}

impl Drop for World {
    /// The runner blocks on the test's runtime, so it stops before the runtime goes.
    fn drop(&mut self) {
        self.session.close();
    }
}

impl World {
    fn open(&self) -> OpenVault {
        self.session
            .open(&self.vault_dir, OpenSource::Select)
            .expect("open")
            .vault
    }

    fn inbox(&self, open: &OpenVault) -> Arc<Inbox> {
        open.vault.inbox(with_device_key()).expect("inbox")
    }

    fn capture(&self, open: &OpenVault, path: &str) -> String {
        self.inbox(open)
            .capture_link(self.server.url(path), None, false)
            .expect("capture")
            .item
            .id
    }

    /// The next notice, failing the test rather than hanging it.
    fn next(&self) -> InboxJobNotice {
        self.notices.recv_timeout(PATIENCE).expect("a notice")
    }

    fn item(&self, open: &OpenVault, id: &str) -> InboxItemRecord {
        self.inbox(open)
            .get(id.to_owned())
            .expect("get")
            .expect("item")
    }
}

fn metadata(item: &InboxItemRecord) -> Value {
    serde_json::from_str(item.metadata_json.as_deref().expect("metadata")).expect("json")
}

fn pushed(open: &OpenVault, id: &str) -> Value {
    let id = id.to_owned();
    let raw = open
        .vault
        .db_handle()
        .call_blocking(move |conn| {
            Ok(sync_items::push_payload(conn, "inbox", &id)?.expect("payload"))
        })
        .expect("payload");
    serde_json::from_str(&raw).expect("json")
}

/// Polls `done` until it holds, failing the test rather than hanging it.
fn until(what: &str, mut done: impl FnMut() -> bool) {
    let step = Duration::from_millis(50);
    for _ in 0..PATIENCE.as_millis() / step.as_millis() {
        if done() {
            return;
        }
        std::thread::sleep(step);
    }
    panic!("{what}");
}

fn statuses(inbox: &Inbox, id: &str) -> Vec<(InboxJobType, InboxJobStatus)> {
    inbox
        .jobs(vec![id.to_owned()], Vec::new())
        .expect("jobs")
        .into_iter()
        .map(|job| (job.job_type, job.status))
        .collect()
}

#[test]
fn a_links_preview_and_article_land_on_the_capture_and_in_the_outbox() {
    let w = world();
    let open = w.open();
    let id = w.capture(&open, "/post");
    w.jobs
        .enqueue(&open, &id, InboxJobType::MetadataScrape)
        .expect("enqueue");
    let thumbnail = format!("attachments/inbox/{id}/thumbnail.png");
    assert_eq!(
        w.next(),
        InboxJobNotice::Updated {
            item_id: id.clone(),
            changes: ItemChanges {
                processing_status: Some("complete".into()),
                thumbnail_path: Some(thumbnail.clone()),
                ..ItemChanges::default()
            },
        }
    );
    assert!(matches!(
        w.next(),
        InboxJobNotice::MetadataComplete { title: Some(ref t), .. } if t == "Linear Method"
    ));
    let InboxJobNotice::Updated { changes, .. } = w.next() else {
        panic!("the article's update");
    };
    assert!(
        changes
            .content
            .expect("content")
            .contains("Small teams ship product")
    );

    let item = w.item(&open, &id);
    assert_eq!(item.title, "Linear Method");
    assert_eq!(item.processing_status.as_deref(), Some("complete"));
    assert_eq!(item.thumbnail_path.as_deref(), Some(thumbnail.as_str()));
    assert_eq!(
        std::fs::read(w.vault_dir.join(&thumbnail)).expect("hero"),
        PNG
    );
    let meta = metadata(&item);
    assert_eq!(meta["fetchStatus"], "complete");
    assert_eq!(meta["siteName"], "Linear");
    assert_eq!(meta["extractionStatus"], "full");
    let body = pushed(&open, &id);
    assert_eq!(body["processingStatus"], "complete");
    assert_eq!(body["thumbnailPath"], Value::from(thumbnail));
    assert!(
        body["content"]
            .as_str()
            .expect("content")
            .contains("Small teams")
    );
    // The article's `Updated` reports the capture write; the runner records the job complete
    // after it, as `jobs.ts` does, so wait for the job to leave the queue.
    let inbox = w.inbox(&open);
    until("the article job settles", || {
        statuses(&inbox, &id)
            .iter()
            .all(|(_, status)| !matches!(status, InboxJobStatus::Pending | InboxJobStatus::Running))
    });
    assert_eq!(
        statuses(&inbox, &id),
        vec![
            (InboxJobType::MetadataScrape, InboxJobStatus::Complete),
            (InboxJobType::ArticleExtract, InboxJobStatus::Complete),
        ]
    );
}

#[test]
fn a_failing_page_is_retried_then_marks_the_link_failed() {
    let w = world();
    let open = w.open();
    let id = w.capture(&open, "/down");
    w.jobs
        .enqueue(&open, &id, InboxJobType::MetadataScrape)
        .expect("enqueue");
    let InboxJobNotice::Updated { changes, .. } = w.next() else {
        panic!("the failure's update");
    };
    assert_eq!(changes.processing_status.as_deref(), Some("failed"));
    assert_eq!(
        w.next(),
        InboxJobNotice::ProcessingError {
            item_id: id.clone(),
            operation: "metadata",
            error: "HTTP 500".into(),
        }
    );
    assert_eq!(w.server.hits("/down"), 2, "two attempts");
    let item = w.item(&open, &id);
    assert_eq!(item.processing_status.as_deref(), Some("failed"));
    let meta = metadata(&item);
    assert_eq!(
        (meta["fetchStatus"].as_str(), meta["error"].as_str()),
        (Some("failed"), Some("HTTP 500"))
    );
    assert_eq!(pushed(&open, &id)["processingStatus"], "failed");
    w.session.close();
    assert_eq!(
        statuses(&w.inbox(&open), &id),
        vec![(InboxJobType::MetadataScrape, InboxJobStatus::Failed)],
        "no article job"
    );
}

#[test]
fn only_http_heroes_are_downloaded() {
    let w = world();
    let open = w.open();
    for path in ["/data-hero", "/ftp-hero"] {
        let id = w.capture(&open, path);
        w.jobs
            .enqueue(&open, &id, InboxJobType::MetadataScrape)
            .expect("enqueue");
        let InboxJobNotice::Updated { changes, .. } = w.next() else {
            panic!("the preview's update");
        };
        assert_eq!(changes.thumbnail_path, None, "{path}");
        assert!(matches!(w.next(), InboxJobNotice::MetadataComplete { .. }));
        assert!(
            matches!(w.next(), InboxJobNotice::Updated { .. }),
            "the article"
        );
        let item = w.item(&open, &id);
        assert_eq!(item.thumbnail_path, None, "{path}");
        assert!(
            !w.vault_dir.join("attachments/inbox").join(&id).exists(),
            "{path}"
        );
    }
    assert_eq!(w.server.hits("/hero.png"), 0);
}

/// A capture id from a peer is not checked when it syncs in. One that is not a plain name gets
/// no hero, so nothing is written outside `attachments/inbox/<id>/`.
#[test]
fn a_capture_whose_id_is_not_plain_gets_no_hero() {
    let w = world();
    let open = w.open();
    let captured = w.capture(&open, "/post");
    let id = "../escape";
    open.vault
        .db_handle()
        .call_blocking(move |conn| {
            conn.execute_batch(&format!(
                "UPDATE inbox_items SET id = '{id}' WHERE id = '{captured}';
                 UPDATE sync_items SET item_id = '{id}' WHERE item_id = '{captured}';"
            ))
            .expect("rename");
            Ok(())
        })
        .expect("rename");
    w.jobs
        .enqueue(&open, id, InboxJobType::MetadataScrape)
        .expect("enqueue");
    let inbox = w.inbox(&open);
    until("both jobs complete", || {
        statuses(&inbox, id)
            == vec![
                (InboxJobType::MetadataScrape, InboxJobStatus::Complete),
                (InboxJobType::ArticleExtract, InboxJobStatus::Complete),
            ]
    });
    assert_eq!(w.item(&open, id).thumbnail_path, None);
    assert_eq!(w.server.hits("/hero.png"), 0);
    assert!(!w.vault_dir.join("attachments/escape").exists());
}

/// Transcription is `VoiceService`'s, so a memo Electron queued waits for it: the runner neither
/// claims nor fails its job. The link queued after it proves the runner went past it.
#[test]
fn the_runner_leaves_transcription_jobs_pending() {
    let w = world();
    let open = w.open();
    let memo = w
        .inbox(&open)
        .capture_text("a memo".into(), None, None, false)
        .expect("capture")
        .item
        .id;
    w.inbox(&open)
        .enqueue_job(memo.clone(), InboxJobType::Transcription)
        .expect("enqueue");
    w.session.close();
    drop(open);
    let open = w.open();
    let link = w.capture(&open, "/post");
    w.jobs
        .enqueue(&open, &link, InboxJobType::MetadataScrape)
        .expect("enqueue");
    let inbox = w.inbox(&open);
    until("the link's jobs complete", || {
        statuses(&inbox, &link)
            == vec![
                (InboxJobType::MetadataScrape, InboxJobStatus::Complete),
                (InboxJobType::ArticleExtract, InboxJobStatus::Complete),
            ]
    });
    assert_eq!(
        statuses(&inbox, &memo),
        vec![(InboxJobType::Transcription, InboxJobStatus::Pending)]
    );
}

#[test]
fn links_left_unfetched_are_fetched_when_the_vault_opens() {
    let w = world();
    let open = w.open();
    let id = w.capture(&open, "/post");
    w.session.close();
    assert_eq!(
        w.item(&open, &id).processing_status.as_deref(),
        Some("pending")
    );
    drop(open);
    let open = w.open();
    assert!(matches!(w.next(), InboxJobNotice::Updated { .. }));
    assert!(matches!(w.next(), InboxJobNotice::MetadataComplete { .. }));
    assert_eq!(w.item(&open, &id).title, "Linear Method");
}

/// The first `/slow` request never answers. The close stops the runner (the reopen would be
/// refused while a thread still held the vault), and the reopen resumes the job.
#[test]
fn a_close_stops_the_runner_mid_fetch_and_the_next_open_resumes_the_job() {
    let w = world();
    let open = w.open();
    let id = w.capture(&open, "/slow");
    w.jobs
        .enqueue(&open, &id, InboxJobType::MetadataScrape)
        .expect("enqueue");
    while w.server.hits("/slow") == 0 {
        std::thread::sleep(Duration::from_millis(10));
    }
    w.session.close();
    let inbox = w.inbox(&open);
    assert_eq!(
        statuses(&inbox, &id),
        vec![(InboxJobType::MetadataScrape, InboxJobStatus::Running)]
    );
    assert_eq!(
        w.item(&open, &id).processing_status.as_deref(),
        Some("pending")
    );
    drop((inbox, open));
    let open = w.open();
    assert!(matches!(w.next(), InboxJobNotice::Updated { .. }));
    assert_eq!(w.item(&open, &id).title, "Linear Method");
}

/// The vault stays open for five runner polls after the enqueue, so a runner that ignored the
/// stop would have fetched the page.
#[test]
fn stop_schedulers_leaves_queued_jobs_for_the_next_launch() {
    let w = world();
    w.jobs.stop();
    let open = w.open();
    let id = w.capture(&open, "/post");
    w.jobs
        .enqueue(&open, &id, InboxJobType::MetadataScrape)
        .expect("enqueue");
    std::thread::sleep(Duration::from_millis(500));
    assert_eq!(w.server.hits("/post"), 0);
    assert_eq!(
        statuses(&w.inbox(&open), &id),
        vec![(InboxJobType::MetadataScrape, InboxJobStatus::Pending)]
    );
    w.session.close();
}

/// A crash between queuing the article and finishing the metadata job leaves a complete link
/// whose metadata job reruns. When that rerun fails for good, the link keeps its preview.
#[test]
fn a_failed_rerun_leaves_a_complete_link_complete() {
    let w = world();
    let open = w.open();
    let id = w.capture(&open, "/down");
    let inbox = w.inbox(&open);
    let preview = serde_json::json!({ "url": w.server.url("/down"), "fetchStatus": "complete" });
    inbox
        .complete_link_with_thumbnail(
            id.clone(),
            Some("Linear Method".into()),
            None,
            preview.to_string(),
            None,
        )
        .expect("complete");
    w.jobs
        .enqueue(&open, &id, InboxJobType::MetadataScrape)
        .expect("enqueue");
    until("the job never failed", || {
        statuses(&inbox, &id) == vec![(InboxJobType::MetadataScrape, InboxJobStatus::Failed)]
    });
    assert_eq!(w.server.hits("/down"), 2, "two attempts");
    let item = w.item(&open, &id);
    assert_eq!(item.processing_status.as_deref(), Some("complete"));
    assert_eq!(item.title, "Linear Method");
    assert_eq!(metadata(&item)["fetchStatus"], "complete");
    assert!(w.notices.try_recv().is_err(), "no failure notice");
}

/// A parse still running at the deadline fails its job instead of holding the queue. The
/// deadline here is zero, so the first check after the parse thread starts is past it.
#[test]
fn a_parse_past_the_deadline_fails_its_job() {
    let w = world_with(Duration::ZERO, with_device_key());
    let open = w.open();
    let id = w.capture(&open, "/post");
    w.jobs
        .enqueue(&open, &id, InboxJobType::ArticleExtract)
        .expect("enqueue");
    let inbox = w.inbox(&open);
    let article = || {
        inbox
            .jobs(vec![id.clone()], Vec::new())
            .expect("jobs")
            .into_iter()
            .find(|job| job.job_type == InboxJobType::ArticleExtract)
            .expect("the article job")
    };
    until("the article job never ran", || {
        let job = article();
        job.last_error.is_some() || job.status == InboxJobStatus::Complete
    });
    let job = article();
    assert_eq!(job.last_error.as_deref(), Some(PARSE_TIMED_OUT));
    assert_ne!(job.status, InboxJobStatus::Complete);
    assert_eq!(
        w.item(&open, &id).processing_status.as_deref(),
        Some("pending"),
        "nothing written"
    );
}

/// Holds the runner's background thread (`open-inbox-jobs`, named by the session) at its first
/// key read while armed, so whatever an open does before it returns is all that has run.
struct HeldRunner {
    inner: Arc<dyn SecureStore>,
    armed: Mutex<bool>,
    released: Condvar,
}

impl HeldRunner {
    fn set(&self, armed: bool) {
        *self.armed.lock().unwrap() = armed;
        self.released.notify_all();
    }
}

impl SecureStore for HeldRunner {
    fn get(&self, key: SecureStoreKey) -> Result<Option<Vec<u8>>, SecureStoreError> {
        if std::thread::current().name() == Some("open-inbox-jobs") {
            let armed = self.armed.lock().unwrap();
            drop(self.released.wait_while(armed, |armed| *armed).unwrap());
        }
        self.inner.get(key)
    }

    fn set(&self, key: SecureStoreKey, value: Vec<u8>) -> Result<(), SecureStoreError> {
        self.inner.set(key, value)
    }

    fn delete(&self, key: SecureStoreKey) -> Result<(), SecureStoreError> {
        self.inner.delete(key)
    }

    fn clear(&self) -> Result<(), SecureStoreError> {
        self.inner.clear()
    }
}

/// Lets the held runner go before the world closes the vault, which joins it.
struct Release(Arc<HeldRunner>);

impl Drop for Release {
    fn drop(&mut self) {
        self.0.set(false);
    }
}

/// The open resumes jobs and queues unfetched links before it returns, however late the runner
/// thread starts. When that pass ran on the runner thread, it could claim a link captured right
/// after the open, and the capture's own enqueue then requeued the running job, which ran twice.
#[test]
fn the_startup_pass_finishes_before_the_open_returns() {
    let held = Arc::new(HeldRunner {
        inner: with_device_key(),
        armed: Mutex::new(false),
        released: Condvar::new(),
    });
    let w = world_with(PARSE_DEADLINE, held.clone());
    let release = Release(held.clone());
    let open = w.open();
    let id = w.capture(&open, "/post");
    w.session.close();
    assert_eq!(
        statuses(&w.inbox(&open), &id),
        Vec::new(),
        "nothing queued it"
    );
    drop(open);

    held.set(true);
    let open = w.open();
    assert_eq!(
        statuses(&w.inbox(&open), &id),
        vec![(InboxJobType::MetadataScrape, InboxJobStatus::Pending)],
        "queued inside the open"
    );
    drop(release);
    assert!(matches!(w.next(), InboxJobNotice::Updated { .. }));
    assert!(matches!(w.next(), InboxJobNotice::MetadataComplete { .. }));
    assert!(
        matches!(w.next(), InboxJobNotice::Updated { .. }),
        "the article"
    );
    assert_eq!(w.server.hits("/post"), 2, "one preview, one article");
}

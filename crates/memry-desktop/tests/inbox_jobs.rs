//! The Inbox job runner on a real session and vault against a local web server: a link's preview
//! and article land on the capture and in the outbox, a failing page retries then marks the link
//! failed, only http(s) heroes are downloaded, links an older build left unfetched are fetched at
//! open, and a close or `stop-schedulers` stops the runner with the job resumed at the next open.

use std::net::SocketAddr;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc::{Receiver, channel};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::http::{StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use memry_core::api::inbox::Inbox;
use memry_core::api::inbox_records::InboxItemRecord;
use memry_core::domain::inbox::jobs::{InboxJobStatus, InboxJobType};
use memry_core::storage::repositories::sync_items;
use memry_desktop::registry::{AppConfig, VaultRegistry};
use memry_desktop::services::inbox_jobs::{InboxJobNotice, InboxJobs, ItemChanges};
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
        format!("http://news.test:{}{path}", self.addr.port())
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
    let base = format!("http://news.test:{}", addr.port());
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
        "/ftp-hero" => html("ftp://news.test/hero.png"),
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
    runtime: tokio::runtime::Runtime,
    server: Server,
    session: Session,
    jobs: Arc<InboxJobs>,
    notices: Receiver<InboxJobNotice>,
}

fn world() -> World {
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
    let web = WebFetch::for_tests(Limits::default(), &[("news.test", server.addr)]).expect("web");
    let config = Arc::new(AppConfig::load(app.join("memry-config.json")));
    let session = Session::new(VaultRegistry::new(config));
    let (sent, notices) = channel();
    let sent = Mutex::new(sent);
    let jobs = InboxJobs::new(
        web,
        runtime.handle().clone(),
        with_device_key(),
        Box::new(move |notice| {
            let _ = sent.lock().unwrap().send(notice);
        }),
    );
    jobs.register(&session);
    World {
        _dir: dir,
        vault_dir,
        runtime,
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
    assert_eq!(
        statuses(&w.inbox(&open), &id),
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

#[test]
fn stop_schedulers_leaves_queued_jobs_for_the_next_launch() {
    let w = world();
    w.jobs.stop();
    let open = w.open();
    let id = w.capture(&open, "/post");
    w.jobs
        .enqueue(&open, &id, InboxJobType::MetadataScrape)
        .expect("enqueue");
    w.session.close();
    assert_eq!(w.server.hits("/post"), 0);
    assert_eq!(
        statuses(&w.inbox(&open), &id),
        vec![(InboxJobType::MetadataScrape, InboxJobStatus::Pending)]
    );
}

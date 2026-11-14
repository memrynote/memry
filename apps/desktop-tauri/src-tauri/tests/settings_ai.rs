//! `settings_set_ai` through the IPC a renderer calls (`writeAISettings`, ai-settings.ts:64-120,
//! #3539): with no vault open it refuses with the localized message, an empty patch announces
//! `ai` with no fields and tracks nothing, a patch tracks one `setting_changed` per field, and
//! the AI switch drives the embedding model and its catch-up pass (#3540).

#[allow(dead_code, reason = "only the open and invoke of the harness are used")]
mod support;

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use memry_desktop::embedding::download::Abort;
use memry_desktop::embedding::service::{
    EmbeddingService, Engine, ModelLoader, ModelProgress, Timing,
};
use memry_desktop::i18n::{self, Args};
use memry_desktop::registry::AppConfig;
use memry_desktop::seams::transport::NativeTransport;
use memry_desktop::session::OpenSource;
use memry_desktop::session::projection::{CancelToken, ProjectionEvent, Projector};
use memry_desktop::settings::SettingsService;
use memry_desktop::telemetry::Service;
use memry_desktop::telemetry::service::{Context, Sender};
use memry_tauri::events::SettingsChangedEvent;
use serde_json::{Value, json};
use support::{MemoryStore, Mocked};
use tauri::test::MockRuntime;
use tauri::{Listener, Manager};
use tauri_specta::{Event, collect_commands};

struct Fixture {
    mocked: Mocked,
    _app_dir: tempfile::TempDir,
    telemetry: Arc<Service>,
    heard: Arc<Mutex<Vec<Value>>>,
}

fn opened() -> Fixture {
    let commands = tauri_specta::Builder::<MockRuntime>::new()
        .error_handling(tauri_specta::ErrorHandlingMode::Throw)
        .commands(collect_commands![
            memry_tauri::commands::settings::settings_set_ai::<MockRuntime>,
        ]);
    let mocked = Mocked::open(&[], commands);
    let app_dir = tempfile::tempdir().unwrap();
    let config = Arc::new(AppConfig::load(app_dir.path().join("memry-config.json")));
    let app = mocked.webview.app_handle().clone();
    app.manage(SettingsService::new(
        Arc::new(MemoryStore::default()),
        config,
    ));
    let context = Context {
        install_id: "i".into(),
        session_id: "s".into(),
        app_version: "1.0.0".into(),
        build_channel: "production".into(),
        platform: "linux".into(),
        arch: "x64".into(),
        locale: "en".into(),
        timezone_offset_minutes: 0,
    };
    let sender = Sender::new("http://127.0.0.1:1/x", NativeTransport::loopback());
    let telemetry = Arc::new(Service::start(app_dir.path(), context, sender, true));
    app.manage(telemetry.clone());
    let heard = Arc::new(Mutex::new(Vec::new()));
    let sink = heard.clone();
    app.listen_any(SettingsChangedEvent::NAME, move |event| {
        sink.lock()
            .unwrap()
            .push(serde_json::from_str(event.payload()).unwrap());
    });
    Fixture {
        mocked,
        _app_dir: app_dir,
        telemetry,
        heard,
    }
}

impl Fixture {
    fn tracked(&self) -> Vec<String> {
        self.telemetry
            .queued()
            .into_iter()
            .filter(|event| event.name == "setting_changed")
            .filter_map(|event| event.dimensions?.get("setting").cloned())
            .collect()
    }

    fn heard(&self) -> Vec<Value> {
        std::mem::take(&mut *self.heard.lock().unwrap())
    }
}

#[test]
fn an_empty_patch_announces_ai_and_tracks_nothing() {
    let f = opened();
    f.mocked
        .invoke("settings_set_ai", json!({ "patch": {} }))
        .expect("saved");
    assert_eq!(f.heard(), [json!({ "key": "ai", "fields": [] })]);
    assert_eq!(f.tracked(), Vec::<String>::new());

    f.mocked
        .invoke(
            "settings_set_ai",
            json!({ "patch": { "summarizeLongNotes": true } }),
        )
        .expect("saved");
    assert_eq!(
        f.heard(),
        [json!({ "key": "ai", "fields": ["summarizeLongNotes"] })]
    );
    assert_eq!(f.tracked(), ["ai.summarizeLongNotes"]);
}

#[test]
fn a_save_with_no_vault_open_says_so_in_the_users_language() {
    let f = opened();
    f.mocked.session().close();
    let error = f
        .mocked
        .invoke(
            "settings_set_ai",
            json!({ "patch": { "summarizeLongNotes": true } }),
        )
        .expect_err("refused");
    assert_eq!(error["code"], json!("no_vault_open"));
    assert_eq!(
        error["message"],
        json!(i18n::t("en", "errors:ipc.noVaultOpen", &Args::new()))
    );
    assert_eq!(f.heard(), Vec::<Value>::new());
}

/// A hang guard, never a bound on how fast the code is.
const HANG: Duration = Duration::from_secs(60);

/// A model whose download fails at once, or, with `hold`, runs until it is cancelled.
#[derive(Default)]
struct Loader {
    loads: AtomicUsize,
    hold: Option<Mutex<mpsc::Sender<()>>>,
    cancelled: AtomicUsize,
}

impl ModelLoader for Loader {
    fn load(
        &self,
        abort: &Abort,
        _: &(dyn Fn(ModelProgress) + Sync),
    ) -> Result<Box<dyn Engine>, String> {
        self.loads.fetch_add(1, Ordering::SeqCst);
        if let Some(started) = &self.hold {
            let _ = started.lock().unwrap().send(());
            while !abort.cancel.is_cancelled() {
                std::thread::sleep(Duration::from_millis(5));
            }
            self.cancelled.fetch_add(1, Ordering::SeqCst);
        }
        Err("offline".to_owned())
    }
}

fn embedding(f: &Fixture, loader: Arc<Loader>) -> Arc<EmbeddingService> {
    let service = EmbeddingService::new(loader, Arc::new(|_| {}), Timing::default());
    f.mocked.webview.app_handle().manage(service.clone());
    service
}

/// Counts the passes a projector named like the embedding projector runs.
#[derive(Default)]
struct Counted(AtomicUsize);

impl Projector for Counted {
    fn name(&self) -> &str {
        "embedding"
    }
    fn handles(&self, _: &ProjectionEvent) -> bool {
        false
    }
    fn project(&self, _: &ProjectionEvent, _: &CancelToken) -> Result<(), String> {
        Ok(())
    }
    fn rebuild(&self, _: &CancelToken) -> Result<(), String> {
        Ok(())
    }
    fn reconcile(&self, _: &CancelToken) -> Result<(), String> {
        self.0.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }
}

fn until(what: &str, done: impl Fn() -> bool) {
    let start = std::time::Instant::now();
    while !done() {
        assert!(start.elapsed() < HANG, "{what} never happened");
        std::thread::sleep(Duration::from_millis(5));
    }
}

#[test]
fn turning_ai_on_clears_the_model_backoff_and_runs_the_embedding_catch_up() {
    let f = opened();
    let loader = Arc::new(Loader::default());
    let service = embedding(&f, loader.clone());
    let projector = Arc::new(Counted::default());
    f.mocked.session().register_projector(projector.clone());
    f.mocked.session().close();
    f.mocked
        .session()
        .open(&f.mocked.vault, OpenSource::Select)
        .unwrap();
    until("the open's reconcile", || {
        projector.0.load(Ordering::SeqCst) == 1
    });

    assert!(!service.load());
    assert!(!service.load(), "backing off");
    assert_eq!(loader.loads.load(Ordering::SeqCst), 1);

    let set = |on: bool| {
        f.mocked
            .invoke("settings_set_ai", json!({ "patch": { "enabled": on } }))
            .expect("saved");
    };
    set(false);
    set(true);
    until("the catch-up pass", || {
        projector.0.load(Ordering::SeqCst) == 2
    });
    assert!(!service.load());
    assert_eq!(
        loader.loads.load(Ordering::SeqCst),
        2,
        "the backoff was cleared"
    );

    // Already on: the backoff clears again, and no second pass runs.
    set(true);
    assert!(!service.load());
    assert_eq!(loader.loads.load(Ordering::SeqCst), 3);
    assert_eq!(projector.0.load(Ordering::SeqCst), 2);
}

#[test]
fn turning_ai_off_stops_the_model_and_its_download() {
    let f = opened();
    let (started, reached) = mpsc::channel();
    let loader = Arc::new(Loader {
        hold: Some(Mutex::new(started)),
        ..Loader::default()
    });
    let service = embedding(&f, loader.clone());
    let (done, loaded) = mpsc::channel();
    let loading = service.clone();
    std::thread::spawn(move || {
        let _ = done.send(loading.load());
    });
    reached.recv_timeout(HANG).expect("the download started");

    f.mocked
        .invoke("settings_set_ai", json!({ "patch": { "enabled": false } }))
        .expect("saved");
    assert!(!loaded.recv_timeout(HANG).expect("the load hung"));
    until("the download seeing the cancel", || {
        loader.cancelled.load(Ordering::SeqCst) == 1
    });
}

//! `settings_set_ai` through the IPC a renderer calls (`writeAISettings`, ai-settings.ts:64-99,
//! #3539): with no vault open it refuses with the localized message, an empty patch announces
//! `ai` with no fields and tracks nothing, and a patch tracks one `setting_changed` per field.

#[allow(dead_code, reason = "only the open and invoke of the harness are used")]
mod support;

use std::sync::{Arc, Mutex};

use memry_desktop::i18n::{self, Args};
use memry_desktop::registry::AppConfig;
use memry_desktop::seams::transport::NativeTransport;
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

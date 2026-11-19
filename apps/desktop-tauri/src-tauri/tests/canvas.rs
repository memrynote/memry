//! The canvas and canvas folder commands on a mock app over a real temp vault (#3547 30e1):
//! Electron's event payloads, a refused save's wording, a folder refusal's code and
//! `errors:canvasFolder.*` key, the update input's absent-versus-`null` fields, and (30e3) the
//! asset and live-canvas commands. Deletes go to
//! the OS trash, so they are proved in `memry-desktop/tests/canvas_*.rs` with a stand-in trash.

use std::fs;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use memry_core::crypto::sodium;
use memry_core::seams::secure_store::{SecureStore, SecureStoreKey};
use memry_desktop::canvas::live::LiveCanvases;
use memry_desktop::canvas::service::{CanvasCreateInput, CanvasUpdateInput};
use memry_desktop::locale::LocaleService;
use memry_desktop::registry::{AppConfig, VaultRegistry};
use memry_desktop::seams::secure_store::{DeviceIdentityStore, KeyringStore, Store, StoreFactory};
use memry_desktop::session::{OpenSource, Session};
use memry_tauri::commands::canvas::{
    canvas_can_upload_asset, canvas_create, canvas_get, canvas_get_asset, canvas_list_assets,
    canvas_live_closed, canvas_live_opened, canvas_update, canvas_upload_asset,
};
use memry_tauri::commands::canvas_folders::{canvas_folder_create, canvas_folder_rename};
use memry_tauri::events::{CanvasCreatedEvent, CanvasFolderUpdatedEvent, CanvasUpdatedEvent};
use serde_json::{Value, json};
use tauri::test::{MockRuntime, mock_app};
use tauri::{App, Listener, Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_specta::Event;

const WAIT: Duration = Duration::from_secs(25);

struct Keychain(Store);

impl StoreFactory for Keychain {
    fn build(&self) -> keyring_core::Result<Store> {
        Ok(self.0.clone())
    }
}

struct Fixture {
    dir: tempfile::TempDir,
    app: App<MockRuntime>,
    heard: Arc<Mutex<Vec<(String, Value)>>>,
}

fn opened() -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let vault = dir.path().join("vault");
    fs::create_dir_all(&vault).unwrap();
    fs::create_dir_all(dir.path().join("app")).unwrap();
    let keychain = Keychain(keyring_core::mock::Store::new().unwrap());
    let keyring = Arc::new(KeyringStore::with_factory(keychain, None, WAIT));
    let store = Arc::new(DeviceIdentityStore::with_probe(
        &keyring,
        dir.path(),
        || false,
    ));
    let (_, secret) = sodium::sign_seed_keypair(&[7u8; 32]).unwrap();
    store
        .set(SecureStoreKey::DeviceSigningKey, secret.to_vec())
        .unwrap();
    let config = AppConfig::load(dir.path().join("app/memry-config.json"));
    let session = Session::new(VaultRegistry::new(Arc::new(config)));
    session.open(&vault, OpenSource::Select).unwrap();

    let app = mock_app();
    app.manage(session);
    app.manage(store);
    app.manage(Arc::new(LocaleService::new("en")));
    let heard = Arc::new(Mutex::new(Vec::new()));
    for name in [
        CanvasCreatedEvent::NAME,
        CanvasUpdatedEvent::NAME,
        CanvasFolderUpdatedEvent::NAME,
    ] {
        let sink = Arc::clone(&heard);
        app.listen_any(name, move |event| {
            let payload = serde_json::from_str(event.payload()).unwrap();
            sink.lock().unwrap().push((name.to_owned(), payload));
        });
    }
    Fixture { dir, app, heard }
}

impl Fixture {
    fn heard(&self) -> Vec<(String, Value)> {
        std::mem::take(&mut *self.heard.lock().unwrap())
    }
}

#[test]
fn a_canvas_written_through_its_commands_is_announced_with_electrons_payloads() {
    let f = opened();
    let app = || f.app.handle().clone();
    let input = CanvasCreateInput {
        title: Some("Plan".into()),
        ..CanvasCreateInput::default()
    };
    let created = tauri::async_runtime::block_on(canvas_create(app(), input)).unwrap();
    let id = created.summary.id.clone();
    assert!(
        f.dir
            .path()
            .join("vault/canvases/Plan.excalidraw")
            .is_file()
    );
    let heard = f.heard();
    assert_eq!(heard.len(), 1);
    assert_eq!(heard[0].0, CanvasCreatedEvent::NAME);
    assert_eq!(heard[0].1["canvas"]["id"], json!(id));
    assert_eq!(heard[0].1["canvas"]["title"], json!("Plan"));
    assert!(heard[0].1["canvas"].get("scene").is_none());

    let read = tauri::async_runtime::block_on(canvas_get(app(), id.clone()))
        .unwrap()
        .unwrap();
    assert_eq!(read.sha256, created.sha256);
    assert!(serde_json::to_value(&read).unwrap()["sha256"].is_string());
    let stale: CanvasUpdateInput = serde_json::from_value(json!({
        "id": id,
        "scene": read.scene,
        "expectedUpdatedAt": read.summary.updated_at - 1,
    }))
    .unwrap();
    let refused = tauri::async_runtime::block_on(canvas_update(app(), stale)).unwrap_err();
    assert_eq!(refused.code, "canvas_conflict");
    assert_eq!(
        refused.message,
        "Canvas was modified by someone else since it was read"
    );
    assert!(f.heard().is_empty());

    // `null` clears, absent leaves: the icon goes, the title stays.
    let edit: CanvasUpdateInput =
        serde_json::from_value(json!({ "id": id, "icon": null })).unwrap();
    assert_eq!(edit.icon, Some(None));
    assert_eq!(edit.title, None);
    let saved = tauri::async_runtime::block_on(canvas_update(app(), edit)).unwrap();
    assert_eq!(saved.summary.title.as_deref(), Some("Plan"));
    assert!(!saved.too_large);
    let heard = f.heard();
    assert_eq!(heard[0].0, CanvasUpdatedEvent::NAME);
    assert_eq!(heard[0].1["canvas"]["id"], json!(id));
}

#[test]
fn a_folder_refusal_reaches_the_renderer_as_its_code_and_key() {
    let f = opened();
    let app = || f.app.handle().clone();
    tauri::async_runtime::block_on(canvas_folder_create(app(), None, "Work".into())).unwrap();
    fs::create_dir_all(f.dir.path().join("vault/canvases/Archive")).unwrap();
    let refused = tauri::async_runtime::block_on(canvas_folder_rename(
        app(),
        "Work".into(),
        "Archive".into(),
    ))
    .unwrap_err();
    assert_eq!(refused.code, "CANVAS_FOLDER_EXISTS");
    assert_eq!(refused.message, "errors:canvasFolder.exists");

    // A canvas command refuses a folder in the same words as the folder commands.
    let deep = CanvasCreateInput {
        folder: Some("A/B/C/D/E/F/G/H/I".into()),
        ..CanvasCreateInput::default()
    };
    let refused = tauri::async_runtime::block_on(canvas_create(app(), deep)).unwrap_err();
    assert_eq!(refused.code, "CANVAS_FOLDER_DEPTH");
    assert_eq!(refused.message, "errors:canvasFolder.depth");

    let renamed =
        tauri::async_runtime::block_on(canvas_folder_rename(app(), "work".into(), "Plans".into()))
            .unwrap();
    assert_eq!(renamed.folder.unwrap().path, "Plans");
    let updated: Vec<_> = f
        .heard()
        .into_iter()
        .filter(|(name, _)| name == CanvasFolderUpdatedEvent::NAME)
        .collect();
    assert_eq!(updated.len(), 1);
    assert_eq!(updated[0].1["previousPath"], json!("work"));
    assert_eq!(updated[0].1["folder"]["path"], json!("Plans"));
}

#[test]
fn the_asset_commands_answer_as_electron_does_with_no_sync() {
    let f = opened();
    let app = || f.app.handle().clone();
    let id = tauri::async_runtime::block_on(canvas_create(app(), CanvasCreateInput::default()))
        .unwrap()
        .summary
        .id;

    let can = tauri::async_runtime::block_on(canvas_can_upload_asset()).unwrap();
    assert_eq!(
        serde_json::to_value(can).unwrap(),
        json!({ "canUpload": false })
    );
    let listed = tauri::async_runtime::block_on(canvas_list_assets(app(), id.clone())).unwrap();
    assert_eq!(
        serde_json::to_value(listed).unwrap(),
        json!({ "assets": [] })
    );
    let got =
        tauri::async_runtime::block_on(canvas_get_asset(app(), id.clone(), "f1".into())).unwrap();
    assert_eq!(serde_json::to_value(got).unwrap(), json!({ "ref": null }));

    let input = serde_json::from_value(json!({
        "canvasId": id, "fileId": "f1", "mimeType": "image/png", "data": [1, 2, 3]
    }))
    .unwrap();
    let refused = tauri::async_runtime::block_on(canvas_upload_asset(app(), input)).unwrap_err();
    assert_eq!(refused.code, "canvas_asset_upload_unavailable");
    assert!(
        !f.dir
            .path()
            .join("vault/attachments/canvas-assets")
            .exists()
    );
}

#[test]
fn a_window_owns_the_canvas_it_opened_until_it_closes_it() {
    let f = opened();
    let app = || f.app.handle().clone();
    let main = WebviewWindowBuilder::new(&f.app, "main", WebviewUrl::default())
        .build()
        .unwrap();
    let window = || main.as_ref().window();
    let opened =
        tauri::async_runtime::block_on(canvas_live_opened(app(), window(), "c1".into())).unwrap();
    assert!(opened.ok);
    assert_eq!(
        f.app.state::<LiveCanvases>().window_of("c1").as_deref(),
        Some("main")
    );
    let empty =
        tauri::async_runtime::block_on(canvas_live_opened(app(), window(), String::new())).unwrap();
    assert!(!empty.ok);

    let closed =
        tauri::async_runtime::block_on(canvas_live_closed(app(), window(), "c1".into())).unwrap();
    assert!(closed.ok);
    assert_eq!(f.app.state::<LiveCanvases>().window_of("c1"), None);
}

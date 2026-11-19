//! Canvas writes on a real temp vault: `data.db` through the core and the `.excalidraw` documents
//! on disk (Electron's `canvas/store.ts`, `store.test.ts`).
//!
//! | Test                                                          | Electron                        |
//! | ------------------------------------------------------------- | ------------------------------- |
//! | a new canvas is a document named for its title, its id inside | `store.ts:150-215`              |
//! | a reserved folder name is stored as its disk spelling         | `store.ts:165-171`              |
//! | a save never overwrites an edit made on disk since it was read | departure: Electron overwrites |
//! | an out-of-date save is refused and writes nothing             | `store.ts:316-318`              |
//! | a move renames the document and the title follows its number  | `store.ts:338-399`              |
//! | a document moved outside the app is found by its id           | departure: Electron unreadable  |
//! | a document linking outside the vault is never read or written | `store.ts:128-137`              |
//! | a copy carries the document's scene and a numbered title      | `store.ts:241-274`              |
//! | a delete trashes the document, or unlinks it                  | `store.ts:436-479`              |

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use memry_core::api::auth::ensure_device_identity;
use memry_core::api::errors::SecureStoreError;
use memry_core::api::vault::Vault;
use memry_core::domain::canvas::file_format::{FileMeta, read_file_meta, with_file_meta};
use memry_core::seams::secure_store::{SecureStore, SecureStoreKey};
use memry_desktop::canvas::service::{
    CanvasCreateInput, CanvasService, CanvasUpdateInput, Trash, Update, Written,
};

pub(crate) const NOW: i64 = 1_760_000_000_000;

#[derive(Default)]
struct MemoryStore(Mutex<HashMap<SecureStoreKey, Vec<u8>>>);

impl SecureStore for MemoryStore {
    fn get(&self, key: SecureStoreKey) -> Result<Option<Vec<u8>>, SecureStoreError> {
        Ok(self.0.lock().unwrap().get(&key).cloned())
    }
    fn set(&self, key: SecureStoreKey, value: Vec<u8>) -> Result<(), SecureStoreError> {
        self.0.lock().unwrap().insert(key, value);
        Ok(())
    }
    fn delete(&self, key: SecureStoreKey) -> Result<(), SecureStoreError> {
        self.0.lock().unwrap().remove(&key);
        Ok(())
    }
    fn clear(&self) -> Result<(), SecureStoreError> {
        self.0.lock().unwrap().clear();
        Ok(())
    }
}

pub(crate) struct World {
    _dir: tempfile::TempDir,
    pub vault: PathBuf,
    pub canvases: CanvasService,
}

/// A stand-in OS trash: `<vault>/.trash`, which no canvas listing walks.
pub(crate) fn side_trash(path: &Path) -> Result<(), String> {
    let canvases = path
        .ancestors()
        .find(|dir| dir.file_name().is_some_and(|name| name == "canvases"))
        .ok_or("not under canvases")?;
    let bin = canvases.parent().unwrap().join(".trash");
    fs::create_dir_all(&bin).map_err(|e| e.to_string())?;
    fs::rename(path, bin.join(path.file_name().unwrap())).map_err(|e| e.to_string())
}

pub(crate) fn refusing_trash(_: &Path) -> Result<(), String> {
    Err("trash unavailable".to_owned())
}

pub(crate) fn world_with(trash: Trash) -> World {
    let dir = tempfile::Builder::new()
        .prefix("memry-canvas-")
        .tempdir()
        .unwrap();
    let vault = dir.path().join("vault");
    let core = vault.join(".memry").join("core");
    fs::create_dir_all(&core).unwrap();
    let store: Arc<dyn SecureStore> = Arc::new(MemoryStore::default());
    ensure_device_identity(store.clone()).unwrap();
    let opened = Vault::open("vault".into(), core.to_string_lossy().into_owned()).unwrap();
    let index = opened.search().unwrap().index_handle();
    let canvases = CanvasService::new(vault.clone(), opened.canvases(store).unwrap(), index, trash);
    World {
        _dir: dir,
        vault,
        canvases,
    }
}

pub(crate) fn world() -> World {
    world_with(side_trash)
}

pub(crate) fn scene(label: &str) -> String {
    format!(
        r#"{{"type":"excalidraw","version":2,"source":"memry","elements":[{{"id":"{label}","type":"rectangle"}}],"appState":{{}},"files":{{}}}}"#
    )
}

impl World {
    pub fn file(&self, rel: &str) -> String {
        fs::read_to_string(self.vault.join(rel)).unwrap()
    }

    pub fn create(&self, title: &str, folder: Option<&str>, label: &str) -> Written {
        let input = CanvasCreateInput {
            title: Some(title.to_owned()),
            scene: Some(scene(label)),
            folder: folder.map(str::to_owned),
            ..CanvasCreateInput::default()
        };
        self.canvases.create(&input, NOW).unwrap()
    }

    pub fn save(&self, id: &str, label: &str) -> Update {
        let input = CanvasUpdateInput {
            id: id.to_owned(),
            scene: Some(scene(label)),
            ..CanvasUpdateInput::default()
        };
        self.canvases.update(&input, NOW + 10).unwrap()
    }

    pub fn scene_of(&self, id: &str) -> String {
        self.canvases.get(id, NOW).unwrap().unwrap().scene
    }
}

#[test]
fn a_new_canvas_is_a_document_named_for_its_title_with_its_id_inside() {
    let w = world();
    let plan = w.create("Plan", None, "a");
    let text = w.file("canvases/Plan.excalidraw");
    assert_eq!(read_file_meta(&text, 0).unwrap().id, plan.canvas.summary.id);
    assert!(plan.canvas.scene.contains(r#""id":"a""#));
    assert_eq!(w.scene_of(&plan.canvas.summary.id), plan.canvas.scene);

    // Case-insensitive per folder; the title is kept as typed.
    let second = w.create("plan", None, "b");
    assert_eq!(second.canvas.summary.title.as_deref(), Some("plan"));
    assert!(w.vault.join("canvases/plan 2.excalidraw").is_file());
    assert_eq!(w.canvases.list().unwrap().len(), 2);
}

#[test]
fn a_reserved_folder_name_is_stored_as_its_disk_spelling() {
    let w = world();
    let canvas = w.create("Plan", Some("CON"), "a");
    assert_eq!(canvas.canvas.summary.folder.as_deref(), Some("CON canvas"));
    assert!(
        w.vault
            .join("canvases/CON canvas/Plan.excalidraw")
            .is_file()
    );
}

#[test]
fn a_save_never_overwrites_an_edit_made_on_disk_since_it_was_read() {
    let w = world();
    let plan = w.create("Plan", None, "a");
    let id = plan.canvas.summary.id.clone();
    w.scene_of(&id);
    let meta = FileMeta {
        id: id.clone(),
        created_at: NOW,
        updated_at: NOW,
    };
    let edited = scene("edited-on-disk");
    fs::write(
        w.vault.join("canvases/Plan.excalidraw"),
        with_file_meta(&edited, &meta),
    )
    .unwrap();

    let Update::Saved { conflict_copy, .. } = w.save(&id, "from-app") else {
        panic!("the save lands");
    };
    let copy = conflict_copy.expect("the edit on disk is kept as a copy");
    assert_eq!(
        copy.canvas.summary.title.as_deref(),
        Some("Plan (conflict copy)")
    );
    assert!(
        w.scene_of(&copy.canvas.summary.id)
            .contains("edited-on-disk")
    );
    assert!(w.scene_of(&id).contains("from-app"));
    assert!(w.file("canvases/Plan.excalidraw").contains("from-app"));

    // Saved over what it read, the next save makes no copy.
    let Update::Saved { conflict_copy, .. } = w.save(&id, "again") else {
        panic!("the save lands");
    };
    assert!(conflict_copy.is_none());
}

#[test]
fn an_out_of_date_save_is_refused_and_writes_nothing() {
    let w = world();
    let plan = w.create("Plan", None, "a");
    let before = w.file("canvases/Plan.excalidraw");
    let input = CanvasUpdateInput {
        id: plan.canvas.summary.id.clone(),
        scene: Some(scene("late")),
        expected_updated_at: Some(plan.canvas.summary.updated_at - 1),
        ..CanvasUpdateInput::default()
    };
    assert_eq!(
        w.canvases.update(&input, NOW + 5).unwrap(),
        Update::Conflict
    );
    assert_eq!(w.file("canvases/Plan.excalidraw"), before);
    let gone = CanvasUpdateInput {
        id: "missing".to_owned(),
        ..CanvasUpdateInput::default()
    };
    assert_eq!(w.canvases.update(&gone, NOW).unwrap(), Update::NotFound);
}

#[test]
fn a_move_renames_the_document_and_the_title_follows_its_number() {
    let w = world();
    w.canvases.create_folder(None, "Work", NOW).unwrap();
    w.create("Plan", Some("Work"), "in-work");
    let plan = w.create("Plan", None, "root");
    let id = plan.canvas.summary.id.clone();
    let input = CanvasUpdateInput {
        id: id.clone(),
        folder: Some(Some("work".to_owned())),
        ..CanvasUpdateInput::default()
    };
    let Update::Saved { summary, .. } = w.canvases.update(&input, NOW + 1).unwrap() else {
        panic!("moved");
    };
    assert_eq!(summary.folder.as_deref(), Some("Work"));
    assert_eq!(summary.title.as_deref(), Some("Plan 2"));
    assert!(!w.vault.join("canvases/Plan.excalidraw").exists());
    let moved = w.file("canvases/Work/Plan 2.excalidraw");
    assert_eq!(read_file_meta(&moved, 0).unwrap().id, id);
    assert!(w.scene_of(&id).contains("root"));

    let retitle = CanvasUpdateInput {
        id: id.clone(),
        title: Some(Some("Roadmap".to_owned())),
        ..CanvasUpdateInput::default()
    };
    w.canvases.update(&retitle, NOW + 2).unwrap();
    assert!(w.vault.join("canvases/Work/Roadmap.excalidraw").is_file());
}

#[test]
fn a_document_moved_outside_the_app_is_found_by_its_id() {
    let w = world();
    let plan = w.create("Plan", None, "a");
    let id = plan.canvas.summary.id.clone();
    fs::create_dir_all(w.vault.join("canvases/Elsewhere")).unwrap();
    fs::rename(
        w.vault.join("canvases/Plan.excalidraw"),
        w.vault.join("canvases/Elsewhere/Renamed.excalidraw"),
    )
    .unwrap();
    assert!(w.scene_of(&id).contains(r#""id":"a""#));
    w.save(&id, "ink-b");
    assert!(
        w.file("canvases/Elsewhere/Renamed.excalidraw")
            .contains("ink-b")
    );
    assert!(!w.vault.join("canvases/Plan.excalidraw").exists());
}

#[cfg(unix)]
#[test]
fn a_document_linking_outside_the_vault_is_never_read_or_written() {
    let w = world();
    let plan = w.create("Plan", None, "a");
    let id = plan.canvas.summary.id.clone();
    let outside = w.vault.parent().unwrap().join("outside.excalidraw");
    fs::write(&outside, "keep me").unwrap();
    fs::remove_file(w.vault.join("canvases/Plan.excalidraw")).unwrap();
    std::os::unix::fs::symlink(&outside, w.vault.join("canvases/Plan.excalidraw")).unwrap();

    let read = w.canvases.get(&id, NOW).unwrap().unwrap();
    assert_eq!(read.unreadable, Some(true));
    assert_eq!(read.scene, "");
    let input = CanvasUpdateInput {
        id: id.clone(),
        scene: Some(scene("b")),
        ..CanvasUpdateInput::default()
    };
    assert!(w.canvases.update(&input, NOW + 1).is_err());
    assert!(w.canvases.duplicate(&id, NOW + 1).unwrap().is_none());
    assert_eq!(fs::read_to_string(&outside).unwrap(), "keep me");
}

#[test]
fn a_copy_carries_the_documents_scene_and_a_numbered_title() {
    let w = world();
    let plan = w.create("Plan", Some("Work"), "a");
    let id = plan.canvas.summary.id.clone();
    let meta = FileMeta {
        id: id.clone(),
        created_at: NOW,
        updated_at: NOW,
    };
    fs::write(
        w.vault.join("canvases/Work/Plan.excalidraw"),
        with_file_meta(&scene("on-disk"), &meta),
    )
    .unwrap();
    let copy = w.canvases.duplicate(&id, NOW + 1).unwrap().unwrap();
    assert_eq!(copy.canvas.summary.title.as_deref(), Some("Plan 2"));
    assert_eq!(copy.canvas.summary.folder.as_deref(), Some("Work"));
    assert!(copy.canvas.scene.contains("on-disk"));
    let text = w.file("canvases/Work/Plan 2.excalidraw");
    assert_eq!(read_file_meta(&text, 0).unwrap().id, copy.canvas.summary.id);
}

#[test]
fn a_delete_trashes_the_document_or_unlinks_it() {
    let w = world();
    let plan = w.create("Plan", None, "a");
    let id = plan.canvas.summary.id.clone();
    assert!(w.canvases.delete(&id, NOW + 1).unwrap());
    assert!(!w.vault.join("canvases/Plan.excalidraw").exists());
    assert!(w.vault.join(".trash/Plan.excalidraw").is_file());
    assert!(w.canvases.get(&id, NOW).unwrap().is_none());
    assert!(!w.canvases.delete(&id, NOW + 2).unwrap());

    let w = world_with(refusing_trash);
    let plan = w.create("Plan", None, "a");
    assert!(w.canvases.delete(&plan.canvas.summary.id, NOW + 1).unwrap());
    assert!(!w.vault.join("canvases/Plan.excalidraw").exists());
}

//! The vault-open canvas reconcile on a real temp vault (Electron's `canvas/reconcile.ts`,
//! `reconcile.test.ts`), and the emptied-folder removals of `canvas/scene-file.ts`.
//!
//! | Test                                                              | Electron                       |
//! | ----------------------------------------------------------------- | ------------------------------ |
//! | a document dropped in is adopted once, its folder with it         | `reconcile.ts:497-588`         |
//! | a document moved outside the app keeps its canvas                 | `reconcile.ts:526-543`         |
//! | a copied document becomes a second canvas under a new id          | `reconcile.ts:545-551`         |
//! | a deleted canvas's document put back is a new canvas              | `reconcile.ts:477-496`         |
//! | a canvas whose document is gone is kept and nothing is written    | `reconcile.ts:757-779`         |
//! | an edit made on disk reaches the record                           | departure: one copy in Electron |
//! | a record change the document missed reaches the document          | departure: one copy in Electron |
//! | both changed: the on-disk drawing is kept as a conflict copy      | departure: one copy in Electron |
//! | opening a canvas carries an edit made on disk into the record     | departure: one copy in Electron |
//! | opening a canvas after a synced edit serves and writes that edit  | `canvas-handler.ts:300`        |
//! | a save from a read before a synced edit keeps that edit           | departure: Electron overwrites |
//! | directories are adopted, renamed portable, and restored           | `reconcile.ts:127-320,600-712` |
//! | a deleted folder's emptied directory goes, any other stays        | `reconcile.ts:322-332,640-668` |
//! | the removals take only empty directories, never the root          | `scene-file.ts:340-465`        |
//! | a title or icon change never marks an edit on disk as seen        | departure: one copy in Electron |
//! | a document that is not a drawing is left alone on every open      | departure: one copy in Electron |
//! | a synced edit survives a move outside the app, an edit with it    | departure: one copy in Electron |
//! | a document adopted while the listing ran is not adopted again     | `reconcile.ts:497-588`         |

use std::fs;

use memry_core::domain::canvas::file_format::{FileMeta, read_file_meta, with_file_meta};
use memry_desktop::canvas::dirs::{
    remove_canvas_folder_dir_if_empty, remove_empty_canvas_folder_dirs,
};
use memry_desktop::canvas::reconcile::Reconciled;

use memry_desktop::canvas::service::{CanvasUpdateInput, Update};

use crate::canvas_service::{NOW, World, scene, world};

impl World {
    fn reconcile(&self) -> Reconciled {
        self.canvases.reconcile(NOW + 100, &|| false).unwrap()
    }

    fn put(&self, rel: &str, text: &str) {
        let path = self.vault.join(rel);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
    }

    fn sidecar_id(&self, rel: &str) -> String {
        read_file_meta(&self.file(rel), 0).unwrap().id
    }

    fn titles(&self) -> Vec<(String, Option<String>)> {
        let mut all: Vec<_> = self
            .canvases
            .list()
            .unwrap()
            .into_iter()
            .map(|c| (c.title.unwrap_or_default(), c.folder))
            .collect();
        all.sort();
        all
    }

    fn folder_paths(&self) -> Vec<String> {
        let mut all: Vec<_> = self
            .canvases
            .list_folders()
            .unwrap()
            .into_iter()
            .map(|f| f.path)
            .collect();
        all.sort();
        all
    }
}

fn on_disk(id: &str, label: &str) -> String {
    let meta = FileMeta {
        id: id.to_owned(),
        created_at: NOW,
        updated_at: NOW + 50,
    };
    with_file_meta(&scene(label), &meta)
}

#[test]
fn a_document_dropped_in_is_adopted_once_its_folder_with_it() {
    let w = world();
    w.put("canvases/Work/Plan.excalidraw", &scene("dropped"));

    let first = w.reconcile();
    assert_eq!((first.adopted, first.folders_adopted), (1, 1));
    assert_eq!(w.titles(), [("Plan".to_owned(), Some("Work".to_owned()))]);
    assert_eq!(w.folder_paths(), ["Work"]);
    let id = w.canvases.list().unwrap()[0].id.clone();
    assert_eq!(w.sidecar_id("canvases/Work/Plan.excalidraw"), id);
    assert!(w.scene_of(&id).contains("dropped"));

    assert_eq!(w.reconcile(), Reconciled::default());
    assert_eq!(w.titles().len(), 1);
}

#[test]
fn a_document_moved_outside_the_app_keeps_its_canvas() {
    let w = world();
    let id = w.create("Plan", None, "ink").canvas.summary.id;
    fs::create_dir_all(w.vault.join("canvases/Work")).unwrap();
    fs::rename(
        w.vault.join("canvases/Plan.excalidraw"),
        w.vault.join("canvases/Work/Moved.excalidraw"),
    )
    .unwrap();

    let done = w.reconcile();
    assert_eq!((done.adopted, done.repointed), (0, 1));
    assert_eq!(w.titles(), [("Plan".to_owned(), Some("Work".to_owned()))]);
    assert!(w.scene_of(&id).contains("ink"));
    assert_eq!(w.sidecar_id("canvases/Work/Moved.excalidraw"), id);
}

#[test]
fn a_copied_document_becomes_a_second_canvas_under_a_new_id() {
    let w = world();
    let id = w.create("Plan", None, "ink").canvas.summary.id;
    fs::copy(
        w.vault.join("canvases/Plan.excalidraw"),
        w.vault.join("canvases/Plan copy.excalidraw"),
    )
    .unwrap();

    assert_eq!(w.reconcile().adopted, 1);
    let copy = w.sidecar_id("canvases/Plan copy.excalidraw");
    assert_ne!(copy, id);
    assert_eq!(w.sidecar_id("canvases/Plan.excalidraw"), id);
    assert!(w.scene_of(&copy).contains("ink"));
    assert!(w.scene_of(&id).contains("ink"));
}

#[test]
fn a_deleted_canvas_document_put_back_is_a_new_canvas() {
    let w = world();
    let id = w.create("Plan", None, "ink").canvas.summary.id;
    assert!(w.canvases.delete(&id, NOW + 10).unwrap());
    fs::rename(
        w.vault.join(".trash/Plan.excalidraw"),
        w.vault.join("canvases/Plan.excalidraw"),
    )
    .unwrap();

    assert_eq!(w.reconcile().adopted, 1);
    assert!(w.canvases.get(&id).unwrap().is_none());
    let back = w.sidecar_id("canvases/Plan.excalidraw");
    assert_ne!(back, id);
    assert!(w.scene_of(&back).contains("ink"));
}

#[test]
fn a_canvas_whose_document_is_gone_is_kept_and_nothing_is_written() {
    let w = world();
    w.create("Plan", None, "ink");
    fs::remove_file(w.vault.join("canvases/Plan.excalidraw")).unwrap();

    assert_eq!(w.reconcile().missing_files, 1);
    assert_eq!(w.titles().len(), 1);
    assert!(!w.vault.join("canvases/Plan.excalidraw").exists());
}

#[test]
fn an_edit_made_on_disk_reaches_the_record() {
    let w = world();
    let id = w.create("Plan", None, "ink").canvas.summary.id;
    w.put("canvases/Plan.excalidraw", &on_disk(&id, "edited"));

    assert_eq!(w.reconcile().settled, 1);
    let record = w.core.canvas(id.clone()).unwrap().unwrap();
    assert!(record.scene.contains("edited"));
    assert_eq!(w.reconcile(), Reconciled::default());
}

#[test]
fn a_record_change_the_document_missed_reaches_the_document() {
    let w = world();
    let id = w.create("Plan", None, "ink").canvas.summary.id;
    w.core.set_scene(id.clone(), scene("remote")).unwrap();

    assert_eq!(w.reconcile().settled, 1);
    assert!(w.file("canvases/Plan.excalidraw").contains("remote"));
    assert_eq!(w.sidecar_id("canvases/Plan.excalidraw"), id);
}

#[test]
fn both_changed_keeps_the_on_disk_drawing_as_a_conflict_copy() {
    let w = world();
    let id = w.create("Plan", None, "ink").canvas.summary.id;
    w.core.set_scene(id.clone(), scene("remote")).unwrap();
    w.put("canvases/Plan.excalidraw", &on_disk(&id, "edited"));

    assert_eq!(w.reconcile().conflict_copies, 1);
    assert!(w.file("canvases/Plan.excalidraw").contains("remote"));
    let copy = w
        .canvases
        .list()
        .unwrap()
        .into_iter()
        .find(|c| c.title.as_deref() == Some("Plan (conflict copy)"))
        .unwrap();
    assert!(w.scene_of(&copy.id).contains("edited"));
    assert!(w.core.canvas(id).unwrap().unwrap().scene.contains("remote"));
}

#[test]
fn directories_are_adopted_renamed_portable_and_restored() {
    let w = world();
    w.canvases.create_folder(None, "Kept", NOW).unwrap();
    fs::remove_dir(w.vault.join("canvases/Kept")).unwrap();
    fs::create_dir_all(w.vault.join("canvases/Empty/Inner")).unwrap();
    fs::create_dir_all(w.vault.join("canvases/con")).unwrap();
    fs::create_dir_all(w.vault.join("canvases/.staging")).unwrap();

    let done = w.reconcile();
    assert_eq!((done.folders_adopted, done.folders_restored), (3, 1));
    assert_eq!(
        w.folder_paths(),
        ["Empty", "Empty/Inner", "Kept", "con canvas"]
    );
    assert!(w.vault.join("canvases/Kept").is_dir());
    assert!(w.vault.join("canvases/con canvas").is_dir());
    assert!(w.vault.join("canvases/.staging").is_dir());
}

#[test]
fn a_deleted_folder_emptied_directory_goes_any_other_stays() {
    let w = world();
    for name in ["Litter", "Hidden", "Inked"] {
        w.canvases.create_folder(None, name, NOW).unwrap();
        w.canvases.delete_folder(name, NOW + 1).unwrap();
        fs::create_dir_all(w.vault.join("canvases").join(name)).unwrap();
    }
    w.put("canvases/Hidden/.DS_Store", "");
    w.put("canvases/Inked/Plan.excalidraw", &scene("ink"));

    let done = w.reconcile();
    assert_eq!(done.folders_pruned, 1);
    assert!(!w.vault.join("canvases/Litter").exists());
    assert!(w.vault.join("canvases/Hidden/.DS_Store").exists());
    assert_eq!(w.folder_paths(), ["Inked"]);
    assert_eq!(w.titles(), [("Plan".to_owned(), Some("Inked".to_owned()))]);
}

#[test]
fn the_removals_take_only_empty_directories_never_the_root() {
    let w = world();
    let canvases = w.vault.join("canvases");
    fs::create_dir_all(canvases.join("A/B/C")).unwrap();
    fs::create_dir_all(canvases.join("D/E")).unwrap();
    w.put("canvases/D/E/.keep", "");
    w.put("outside/F/.none", "");
    fs::remove_file(w.vault.join("outside/F/.none")).unwrap();

    assert!(!remove_canvas_folder_dir_if_empty(&w.vault, "A"));
    assert!(canvases.join("A/B/C").is_dir());
    assert!(remove_empty_canvas_folder_dirs(&w.vault, "A"));
    assert!(!canvases.join("A").exists());

    assert!(!remove_empty_canvas_folder_dirs(&w.vault, "D"));
    assert!(canvases.join("D/E/.keep").exists());

    assert!(!remove_empty_canvas_folder_dirs(&w.vault, ""));
    assert!(!remove_empty_canvas_folder_dirs(&w.vault, "../outside/F"));
    assert!(!remove_canvas_folder_dir_if_empty(&w.vault, "../outside/F"));
    assert!(canvases.is_dir());
    assert!(w.vault.join("outside/F").is_dir());
    assert!(remove_canvas_folder_dir_if_empty(&w.vault, "Gone"));
}

#[test]
fn opening_a_canvas_carries_an_edit_made_on_disk_into_the_record() {
    let w = world();
    let id = w.create("Plan", None, "ink").canvas.summary.id;
    w.put("canvases/Plan.excalidraw", &on_disk(&id, "edited"));

    assert!(w.scene_of(&id).contains("edited"));
    assert!(w.core.canvas(id).unwrap().unwrap().scene.contains("edited"));
}

#[test]
fn opening_a_canvas_after_a_synced_edit_serves_and_writes_that_edit() {
    let w = world();
    let id = w.create("Plan", None, "ink").canvas.summary.id;
    w.core.set_scene(id.clone(), scene("synced")).unwrap();

    assert!(w.scene_of(&id).contains("synced"));
    assert!(w.file("canvases/Plan.excalidraw").contains("synced"));
}

#[test]
fn a_save_from_a_read_before_a_synced_edit_keeps_that_edit() {
    let w = world();
    let id = w.create("Plan", None, "ink").canvas.summary.id;
    let read = w.canvases.get(&id).unwrap().unwrap();
    assert!(read.scene.contains("ink"));
    w.core.set_scene(id.clone(), scene("synced")).unwrap();

    let Update::Saved { conflict_copy, .. } = w.save_over(&id, "local", read.sha256) else {
        panic!("the save was not made");
    };
    assert!(w.file("canvases/Plan.excalidraw").contains("local"));
    let copy = conflict_copy.expect("the synced edit is kept as a copy");
    assert!(copy.canvas.scene.contains("synced"));
    assert!(w.scene_of(&copy.canvas.summary.id).contains("synced"));
}

fn retitle(w: &World, id: &str, title: Option<&str>, icon: Option<&str>) {
    let input = CanvasUpdateInput {
        id: id.to_owned(),
        title: title.map(|title| Some(title.to_owned())),
        icon: icon.map(|icon| Some(icon.to_owned())),
        ..CanvasUpdateInput::default()
    };
    assert!(matches!(
        w.canvases.update(&input, NOW + 20).unwrap(),
        Update::Saved { .. }
    ));
}

fn conflict_copy_of(w: &World, title: &str) -> Option<String> {
    w.canvases
        .list()
        .unwrap()
        .into_iter()
        .find(|c| c.title.as_deref() == Some(title))
        .map(|c| w.scene_of(&c.id))
}

#[test]
fn an_icon_change_never_marks_an_edit_made_on_disk_as_seen() {
    let w = world();
    let id = w.create("Plan", None, "ink").canvas.summary.id;
    w.put("canvases/Plan.excalidraw", &on_disk(&id, "edited"));
    retitle(&w, &id, None, Some("🎨"));

    assert!(w.scene_of(&id).contains("edited"));
    assert!(w.file("canvases/Plan.excalidraw").contains("edited"));
    assert!(w.core.canvas(id).unwrap().unwrap().scene.contains("edited"));
}

#[test]
fn a_document_that_is_not_a_drawing_is_left_alone_on_every_open() {
    let w = world();
    let id = w.create("Plan", None, "ink").canvas.summary.id;
    w.put("canvases/Plan.excalidraw", "{ half written");

    w.scene_of(&id);
    w.scene_of(&id);
    w.reconcile();
    assert_eq!(w.file("canvases/Plan.excalidraw"), "{ half written");
    assert!(w.core.canvas(id).unwrap().unwrap().scene.contains("ink"));
}

#[test]
fn a_synced_edit_then_a_move_outside_the_app_keeps_the_synced_edit() {
    let w = world();
    let id = w.create("Plan", None, "ink").canvas.summary.id;
    w.core.set_scene(id.clone(), scene("synced")).unwrap();
    fs::create_dir_all(w.vault.join("canvases/Work")).unwrap();
    fs::rename(
        w.vault.join("canvases/Plan.excalidraw"),
        w.vault.join("canvases/Work/Moved.excalidraw"),
    )
    .unwrap();

    assert_eq!(w.reconcile().repointed, 1);
    assert!(
        w.core
            .canvas(id.clone())
            .unwrap()
            .unwrap()
            .scene
            .contains("synced")
    );
    assert!(w.file("canvases/Work/Moved.excalidraw").contains("synced"));
    assert_eq!(w.titles(), [("Plan".to_owned(), Some("Work".to_owned()))]);
}

#[test]
fn a_synced_edit_then_a_move_and_an_edit_outside_the_app_keeps_both() {
    let w = world();
    let id = w.create("Plan", None, "ink").canvas.summary.id;
    w.core.set_scene(id.clone(), scene("synced")).unwrap();
    fs::remove_file(w.vault.join("canvases/Plan.excalidraw")).unwrap();
    w.put("canvases/Moved.excalidraw", &on_disk(&id, "edited"));

    // Found by its id on open, before any reconcile re-points it.
    assert!(w.scene_of(&id).contains("synced"));
    assert!(w.file("canvases/Moved.excalidraw").contains("synced"));
    let copy = conflict_copy_of(&w, "Plan (conflict copy)").expect("the disk edit is kept");
    assert!(copy.contains("edited"));
}

#[test]
fn a_synced_edit_then_a_title_change_then_an_edit_on_disk_keeps_both() {
    let w = world();
    let id = w.create("Plan", None, "ink").canvas.summary.id;
    w.core.set_scene(id.clone(), scene("synced")).unwrap();
    retitle(&w, &id, Some("Renamed"), None);
    w.put("canvases/Renamed.excalidraw", &on_disk(&id, "edited"));

    assert_eq!(w.reconcile().conflict_copies, 1);
    assert!(w.core.canvas(id).unwrap().unwrap().scene.contains("synced"));
    assert!(w.file("canvases/Renamed.excalidraw").contains("synced"));
    let copy = conflict_copy_of(&w, "Renamed (conflict copy)").expect("the disk edit is kept");
    assert!(copy.contains("edited"));
}

#[test]
fn a_document_adopted_while_the_listing_ran_is_not_adopted_again() {
    let w = world();
    w.put("canvases/Plan.excalidraw", &scene("dropped"));
    let raced = std::cell::Cell::new(false);
    let done = w
        .canvases
        .reconcile(NOW + 100, &|| {
            if !raced.replace(true) {
                // Another adopter (an earlier open's reconcile, the watcher) takes it first.
                assert_eq!(w.reconcile().adopted, 1);
            }
            false
        })
        .unwrap();

    assert_eq!(done.adopted, 0);
    let all = w.canvases.list().unwrap();
    assert_eq!(all.len(), 1);
    assert_eq!(w.sidecar_id("canvases/Plan.excalidraw"), all[0].id);
}

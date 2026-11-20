//! A canvas document removed outside the app becomes a canvas delete (Electron's
//! `canvas/delete.ts::trackExternalCanvasRemoval`, `vault/watcher.ts:1199-1210,515-560`), on a
//! real temp vault: the canvas service's decision, the vault watcher's report, the open's
//! replay of removals missed while the app was closed, and the whole path through the tier.
//!
//! | Test                                                              | Electron                     |
//! | ----------------------------------------------------------------- | ---------------------------- |
//! | a document unlinked outside the app deletes its canvas            | `delete.ts:60-95`            |
//! | a document moved outside the app keeps its canvas                 | `delete.ts:113-150`          |
//! | an unowned document that cannot be read keeps the canvas         | `delete.ts:130-146`          |
//! | a document still on disk keeps its canvas                         | `watcher.ts:1316-1322`       |
//! | the app's own delete finds nothing to delete again                | `delete.ts:68-70`            |
//! | a removed folder deletes the canvases in it                       | chokidar unlinks each file   |
//! | a save racing the removal keeps the canvas; a save after it fails | `delete.ts:82-85`            |
//! | a document removed while the app was closed is deleted at open    | `watcher.ts:503-560`         |
//! | a canvas with no document on this device is kept at open          | `watcher.ts:552-553`         |
//! | too many documents missing at open deletes none                   | `watcher.ts` rescan withhold |
//! | the watcher reports a canvas removal once its window is over      | `rename-tracker.ts` window   |
//! | an unlink outside the app reaches the canvas through the tier     | `watcher.ts:1199-1210`       |

use std::fs;
use std::sync::mpsc::channel;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use memry_core::api::vault::Vault;
use memry_core::storage::OpenOptions;
use memry_desktop::canvas::service::{CanvasService, Update};
use memry_desktop::canvas::watch::gone_hook;
use memry_desktop::notes::identity::NotesIdentity;
use memry_desktop::vault::watch::reconcile::Reconciler;
use memry_desktop::vault::watch::rename::RENAME_WINDOW;
use memry_desktop::vault::watch::{EchoGuard, VaultEvent};

use crate::canvas_service::{NOW, scene, world};
use crate::vault_env::env;

const LATER: i64 = NOW + 1_000;

#[test]
fn a_document_unlinked_outside_the_app_deletes_its_canvas() {
    let w = world();
    let id = w.create("Plan", None, "ink").canvas.summary.id;
    fs::remove_file(w.vault.join("canvases/Plan.excalidraw")).unwrap();

    let deleted = w
        .canvases
        .removed_outside("canvases/Plan.excalidraw", LATER)
        .unwrap();

    assert_eq!(deleted, vec![id.clone()]);
    assert!(w.canvases.get(&id, LATER).unwrap().is_none());
    assert!(w.core.canvas(id).unwrap().is_none(), "tombstoned for sync");
}

#[test]
fn a_document_moved_outside_the_app_keeps_its_canvas() {
    let w = world();
    let id = w.create("Plan", None, "ink").canvas.summary.id;
    fs::create_dir_all(w.vault.join("canvases/Moved")).unwrap();
    fs::rename(
        w.vault.join("canvases/Plan.excalidraw"),
        w.vault.join("canvases/Moved/Renamed.excalidraw"),
    )
    .unwrap();

    let deleted = w
        .canvases
        .removed_outside("canvases/Plan.excalidraw", LATER)
        .unwrap();

    assert!(deleted.is_empty());
    assert!(w.canvases.get(&id, LATER).unwrap().is_some());
}

#[test]
fn an_unowned_document_that_cannot_be_read_keeps_the_canvas() {
    let w = world();
    let id = w.create("Plan", None, "ink").canvas.summary.id;
    fs::remove_file(w.vault.join("canvases/Plan.excalidraw")).unwrap();
    fs::write(w.vault.join("canvases/Half.excalidraw"), "{ not json").unwrap();

    let deleted = w
        .canvases
        .removed_outside("canvases/Plan.excalidraw", LATER)
        .unwrap();

    assert!(deleted.is_empty(), "it may be this canvas, half written");
    assert!(w.core.canvas(id).unwrap().is_some());
}

#[test]
fn a_document_still_on_disk_keeps_its_canvas() {
    let w = world();
    let id = w.create("Plan", None, "ink").canvas.summary.id;

    let deleted = w
        .canvases
        .removed_outside("canvases/Plan.excalidraw", LATER)
        .unwrap();

    assert!(deleted.is_empty());
    assert!(w.core.canvas(id).unwrap().is_some());
}

#[test]
fn the_apps_own_delete_finds_nothing_to_delete_again() {
    let w = world();
    let id = w.create("Plan", None, "ink").canvas.summary.id;
    assert!(w.canvases.delete(&id, LATER).unwrap());

    let deleted = w
        .canvases
        .removed_outside("canvases/Plan.excalidraw", LATER)
        .unwrap();

    assert!(deleted.is_empty());
}

#[test]
fn a_removed_folder_deletes_the_canvases_in_it() {
    let w = world();
    let a = w.create("A", Some("Trip"), "a").canvas.summary.id;
    let b = w.create("B", Some("Trip/Day"), "b").canvas.summary.id;
    let kept = w.create("C", None, "c").canvas.summary.id;
    fs::remove_dir_all(w.vault.join("canvases/Trip")).unwrap();

    let mut deleted = w.canvases.removed_outside("canvases/Trip", LATER).unwrap();
    deleted.sort();
    let mut expected = vec![a, b];
    expected.sort();

    assert_eq!(deleted, expected);
    assert!(w.core.canvas(kept).unwrap().is_some());
}

#[test]
fn a_save_racing_the_removal_keeps_the_canvas_and_a_save_after_it_writes_nothing() {
    let w = world();
    let id = w.create("Plan", None, "ink").canvas.summary.id;
    fs::remove_file(w.vault.join("canvases/Plan.excalidraw")).unwrap();
    // The save lands inside the rename window: the document is back when the removal settles.
    assert!(matches!(w.save(&id, "saved"), Update::Saved { .. }));
    let path = w.canvases.document_path(&id).unwrap().unwrap();
    let rel = path.strip_prefix(&w.vault).unwrap().to_string_lossy();

    assert!(w.canvases.removed_outside(&rel, LATER).unwrap().is_empty());
    assert!(w.scene_of(&id).contains("saved"));

    // The removal settled first: the canvas is deleted, and a late save brings nothing back.
    fs::remove_file(&path).unwrap();
    assert_eq!(
        w.canvases.removed_outside(&rel, LATER).unwrap(),
        vec![id.clone()]
    );
    assert!(matches!(w.save(&id, "late"), Update::NotFound));
    assert!(!path.exists());
}

#[test]
fn a_document_removed_while_the_app_was_closed_is_deleted_at_open() {
    let w = world();
    let id = w.create("Plan", None, "ink").canvas.summary.id;
    let kept = w.create("Kept", None, "k").canvas.summary.id;
    fs::remove_file(w.vault.join("canvases/Plan.excalidraw")).unwrap();

    let done = w.canvases.reconcile(LATER, &|| false).unwrap();

    assert_eq!(done.removed, 1);
    assert!(w.core.canvas(id).unwrap().is_none());
    assert!(w.core.canvas(kept).unwrap().is_some());
}

#[test]
fn a_canvas_with_no_document_on_this_device_is_kept_at_open() {
    let w = world();
    // Another device's canvas, synced here before its document was ever written.
    let id = w
        .core
        .create(Some("Remote".into()), None, Some(scene("r")))
        .unwrap()
        .id;

    let done = w.canvases.reconcile(LATER, &|| false).unwrap();

    assert_eq!(done.removed, 0);
    assert!(w.core.canvas(id).unwrap().is_some());
}

#[test]
fn too_many_documents_missing_at_open_deletes_none() {
    let w = world();
    let ids: Vec<String> = (0..25)
        .map(|n| w.create(&format!("C{n}"), None, "x").canvas.summary.id)
        .collect();
    for n in 0..25 {
        fs::remove_file(w.vault.join(format!("canvases/C{n}.excalidraw"))).unwrap();
    }

    let done = w.canvases.reconcile(LATER, &|| false).unwrap();

    assert_eq!(done.removed, 0);
    assert!(done.removals_withheld);
    for id in ids {
        assert!(w.core.canvas(id).unwrap().is_some());
    }
}

#[test]
fn the_watcher_reports_a_canvas_removal_once_its_window_is_over() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("vault");
    let core = root.join(".memry/core");
    fs::create_dir_all(&core).unwrap();
    fs::create_dir_all(root.join("canvases")).unwrap();
    let vault =
        Vault::open_with(core.to_string_lossy().into_owned(), OpenOptions::default()).unwrap();
    fs::write(root.join("canvases/gone.excalidraw"), "{}").unwrap();
    fs::write(root.join("canvases/back.excalidraw"), "{}").unwrap();
    let log = Arc::new(Mutex::new(Vec::new()));
    let sink_log = log.clone();
    let mut r = Reconciler::new(
        root.clone(),
        vec![],
        vault.note_files(),
        Arc::new(EchoGuard::default()),
        Arc::new(move |event| sink_log.lock().unwrap().push(event)),
    );

    fs::remove_file(root.join("canvases/gone.excalidraw")).unwrap();
    fs::remove_file(root.join("canvases/back.excalidraw")).unwrap();
    let t0 = Instant::now();
    r.batch(
        vec![
            "canvases/gone.excalidraw".into(),
            "canvases/back.excalidraw".into(),
        ],
        t0,
    );
    r.settle_expired(t0);
    assert!(log.lock().unwrap().is_empty(), "inside the window");
    // Put back inside the window: a save, or the second half of a move.
    fs::write(root.join("canvases/back.excalidraw"), "{}").unwrap();
    r.settle_expired(t0 + RENAME_WINDOW + Duration::from_secs(1));

    assert_eq!(
        *log.lock().unwrap(),
        vec![VaultEvent::CanvasGone {
            path: "canvases/gone.excalidraw".into()
        }]
    );
}

#[test]
fn an_unlink_outside_the_app_reaches_the_canvas_through_the_tier() {
    let mut e = env(|store| Some(NotesIdentity::new(store)));
    let (tx, rx) = channel();
    let tx = Mutex::new(tx);
    e.tier.set_canvas_gone(gone_hook(
        e.tier.store(),
        Arc::new(move |id: String| drop(tx.lock().unwrap().send(id))),
    ));
    e.open();
    let canvases = CanvasService::open(&e.session.current().unwrap(), e.tier.store()).unwrap();
    let input = memry_desktop::canvas::service::CanvasCreateInput {
        title: Some("Plan".into()),
        scene: Some(scene("ink")),
        ..Default::default()
    };
    let id = canvases.create(&input, NOW).unwrap().canvas.summary.id;
    e.watcher_live();

    fs::remove_file(e.vault.join("canvases/Plan.excalidraw")).unwrap();

    assert_eq!(rx.recv_timeout(Duration::from_secs(20)).unwrap(), id);
    assert!(canvases.get(&id, LATER).unwrap().is_none());
}

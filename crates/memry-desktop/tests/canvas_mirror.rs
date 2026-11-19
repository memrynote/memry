//! A synced canvas record followed on disk (Electron's `canvas-handler.ts:155-410` and
//! `canvas-folder-handler.ts:135-170`), on a real temp vault: each record goes through core's
//! real apply, then through the mirror.
//!
//! | Test                                                              | Electron                       |
//! | ----------------------------------------------------------------- | ------------------------------ |
//! | a remote create writes the document                               | `canvas-handler.ts:186-197`    |
//! | a remote update with no disk edit rewrites the document           | `canvas-handler.ts:300`        |
//! | a remote update over a disk edit keeps that edit as a copy        | departure: Electron overwrites |
//! | a remote move moves the document, and the watcher sees no delete  | `canvas-handler.ts:262-297`    |
//! | a remote tombstone trashes the document, and no open adopts it    | `canvas-handler.ts:390-400`    |
//! | a remote tombstone over a disk edit keeps that edit as a copy     | departure: Electron unlinks    |
//! | a save after a remote tombstone writes nothing                    | `delete.ts:82-85`              |
//! | a remote folder delete removes its emptied directory              | `canvas-folder-handler.ts:165` |
//! | an echo of this device's own write changes nothing                | `canvas-handler.ts:226-230`    |
//! | a remote update tells the renderer `canvas:updated`               | `canvas-handler.ts:336`        |
//! | a remote tombstone tells the renderer `canvas:deleted`            | `canvas-handler.ts:387`        |
//! | an echo tells the renderer nothing                                | `canvas-handler.ts:231-234`    |

use std::fs;

use memry_core::domain::canvas::ITEM_TYPE;
use memry_core::domain::canvas_folder;
use memry_core::storage::repositories::sync_items::{ApplyOutcome, InboundRecord};
use memry_core::sync::apply::apply_inbound;
use memry_core::sync::driver::{AppliedOutcome, AppliedRecord};
use memry_desktop::canvas::mirror::CanvasSynced;
use memry_desktop::canvas::service::Update;
use serde_json::{Value, json};

use crate::canvas_service::{NOW, World, scene, world};

const LATER: i64 = NOW + 1_000;
const ID: &str = "cnv_remote";

fn record(item_type: &str, item_id: &str, payload: Value, deleted: bool) -> InboundRecord {
    InboundRecord {
        item_type: item_type.to_owned(),
        item_id: item_id.to_owned(),
        payload_json: payload.to_string(),
        server_cursor: Some(1),
        signer_device_id: Some("peer".to_owned()),
        updated_at: NOW,
        deleted_at: deleted.then_some(NOW),
    }
}

impl World {
    /// Applies another device's `canvas` record at `tick` of its clock, then mirrors it.
    fn remote(
        &self,
        tick: u64,
        title: &str,
        folder: Option<&str>,
        label: &str,
    ) -> Vec<CanvasSynced> {
        let payload = json!({
            "id": ID, "vaultId": self.core.vault_id(), "title": title, "folder": folder,
            "icon": null, "ownerNoteId": null, "scene": scene(label),
            "clock": { "peer": tick }, "deletedAt": null,
        });
        self.pull(
            record(ITEM_TYPE, ID, payload, false),
            AppliedOutcome::Updated,
        )
    }

    fn remote_tombstone(&self, tick: u64) -> Vec<CanvasSynced> {
        let payload = json!({ "id": ID, "clock": { "peer": tick }, "deletedAt": NOW });
        self.pull(
            record(ITEM_TYPE, ID, payload, true),
            AppliedOutcome::Deleted,
        )
    }

    /// Applies `inbound` through core, then mirrors it as `outcome`, or as `Skipped` when core
    /// changed nothing (the applied feed's rule). Returns what the renderer is told.
    fn pull(&self, inbound: InboundRecord, outcome: AppliedOutcome) -> Vec<CanvasSynced> {
        let (item_type, item_id) = (inbound.item_type.clone(), inbound.item_id.clone());
        let applied = self
            .core
            .db()
            .call_blocking(move |conn| apply_inbound(conn, &inbound, NOW))
            .unwrap();
        let outcome = match applied {
            ApplyOutcome::Skipped => AppliedOutcome::Skipped,
            _ => outcome,
        };
        let applied = AppliedRecord {
            item_type,
            item_id,
            outcome,
            conflicts: Vec::new(),
        };
        self.canvases.mirror_applied(&[applied], LATER)
    }

    fn mirrored(&self) -> Vec<Option<String>> {
        let mut titles: Vec<_> = self
            .canvases
            .list()
            .unwrap()
            .into_iter()
            .map(|canvas| canvas.title)
            .collect();
        titles.sort();
        titles
    }

    /// Replaces the ink label in a document, as an edit outside the app.
    fn edit_ink(&self, rel: &str, from: &str, to: &str) {
        let text = self.file(rel).replace(from, to);
        fs::write(self.vault.join(rel), text).unwrap();
    }
}

#[test]
fn a_remote_create_writes_the_document() {
    let w = world();
    w.remote(1, "Plan", None, "remote");

    let text = w.file("canvases/Plan.excalidraw");
    assert!(text.contains("remote"));
    assert!(text.contains(ID), "the sidecar carries the canvas id");
    let read = w.canvases.get(ID).unwrap().unwrap();
    assert!(read.scene.contains("remote"));
    assert_eq!(w.mirrored(), vec![Some("Plan".to_owned())]);
}

#[test]
fn a_remote_update_with_no_disk_edit_rewrites_the_document() {
    let w = world();
    w.remote(1, "Plan", None, "first");
    w.remote(2, "Plan", None, "second");

    let text = w.file("canvases/Plan.excalidraw");
    assert!(text.contains("second") && !text.contains("first"));
    assert_eq!(w.mirrored(), vec![Some("Plan".to_owned())], "no copy");
}

#[test]
fn a_remote_update_over_a_disk_edit_keeps_that_edit_as_a_copy() {
    let w = world();
    w.remote(1, "Plan", None, "first");
    w.edit_ink("canvases/Plan.excalidraw", "first", "mine");

    w.remote(2, "Plan", None, "second");

    assert!(w.file("canvases/Plan.excalidraw").contains("second"));
    assert_eq!(
        w.mirrored(),
        vec![
            Some("Plan".to_owned()),
            Some("Plan (conflict copy)".to_owned())
        ]
    );
    assert!(
        w.file("canvases/Plan (conflict copy).excalidraw")
            .contains("mine")
    );
}

#[test]
fn a_remote_move_moves_the_document_and_the_watcher_sees_no_delete() {
    let w = world();
    w.remote(1, "Plan", None, "ink");
    w.remote(2, "Plan", Some("Work"), "ink");

    assert!(!w.vault.join("canvases/Plan.excalidraw").exists());
    assert!(w.file("canvases/Work/Plan.excalidraw").contains("ink"));
    let gone = w
        .canvases
        .removed_outside("canvases/Plan.excalidraw", LATER)
        .unwrap();
    assert!(gone.is_empty(), "the mirror's own move is not a delete");
    let read = w.canvases.get(ID).unwrap().unwrap();
    assert_eq!(read.summary.folder.as_deref(), Some("Work"));
}

#[test]
fn a_remote_tombstone_trashes_the_document_and_no_open_adopts_it_back() {
    let w = world();
    w.remote(1, "Plan", None, "ink");
    w.remote_tombstone(2);

    assert!(!w.vault.join("canvases/Plan.excalidraw").exists());
    assert!(w.vault.join(".trash/Plan.excalidraw").exists(), "trashed");
    let gone = w
        .canvases
        .removed_outside("canvases/Plan.excalidraw", LATER)
        .unwrap();
    assert!(
        gone.is_empty(),
        "the mirror's own trash is not a delete again"
    );
    w.canvases.reconcile(LATER, &|| false).unwrap();
    assert!(w.mirrored().is_empty(), "nothing adopted back");
}

#[test]
fn a_remote_tombstone_over_a_disk_edit_keeps_that_edit_as_a_copy() {
    let w = world();
    w.remote(1, "Plan", None, "first");
    w.edit_ink("canvases/Plan.excalidraw", "first", "mine");

    w.remote_tombstone(2);

    assert!(w.canvases.get(ID).unwrap().is_none());
    assert_eq!(w.mirrored(), vec![Some("Plan (conflict copy)".to_owned())]);
    assert!(
        w.file("canvases/Plan (conflict copy).excalidraw")
            .contains("mine")
    );
    assert!(!w.vault.join("canvases/Plan.excalidraw").exists());
}

#[test]
fn a_save_after_a_remote_tombstone_writes_nothing() {
    let w = world();
    w.remote(1, "Plan", None, "ink");
    let read = w.canvases.get(ID).unwrap().unwrap();
    w.remote_tombstone(2);

    assert_eq!(w.save_over(ID, "late", read.sha256), Update::NotFound);
    assert!(!w.vault.join("canvases/Plan.excalidraw").exists());
}

#[test]
fn a_remote_folder_delete_removes_its_emptied_directory() {
    let w = world();
    w.remote(1, "Plan", Some("Work"), "ink");
    let folder = canvas_folder::sync_id("Work");
    let path = |tick: u64, deleted: bool| {
        json!({ "id": folder, "path": "Work", "icon": null, "clock": { "peer": tick },
                "deletedAt": deleted.then_some(NOW) })
    };
    w.pull(
        record(canvas_folder::ITEM_TYPE, &folder, path(1, false), false),
        AppliedOutcome::Created,
    );
    w.remote_tombstone(2);
    assert!(
        w.vault.join("canvases/Work").is_dir(),
        "a folder delete has not come yet"
    );

    w.pull(
        record(canvas_folder::ITEM_TYPE, &folder, path(2, true), true),
        AppliedOutcome::Deleted,
    );

    assert!(!w.vault.join("canvases/Work").exists());
}

#[test]
fn an_echo_of_this_devices_own_write_changes_nothing() {
    let w = world();
    w.remote(1, "Plan", None, "ink");
    let path = w.vault.join("canvases/Plan.excalidraw");
    let before = (
        fs::read(&path).unwrap(),
        fs::metadata(&path).unwrap().modified().unwrap(),
    );

    w.remote(1, "Plan", None, "ink");
    let replay = AppliedRecord {
        item_type: ITEM_TYPE.to_owned(),
        item_id: ID.to_owned(),
        outcome: AppliedOutcome::Updated,
        conflicts: Vec::new(),
    };
    w.canvases.mirror_applied(&[replay], LATER);

    let after = (
        fs::read(&path).unwrap(),
        fs::metadata(&path).unwrap().modified().unwrap(),
    );
    assert_eq!(before, after, "no write");
    assert_eq!(w.mirrored(), vec![Some("Plan".to_owned())]);
}

#[test]
fn a_remote_update_tells_the_renderer_canvas_updated() {
    let w = world();
    w.remote(1, "Plan", None, "first");

    let told = w.remote(2, "Renamed", None, "second");

    let [CanvasSynced::Updated(canvas)] = told.as_slice() else {
        panic!("one canvas:updated, got {told:?}");
    };
    assert_eq!(canvas.id, ID);
    assert_eq!(canvas.title.as_deref(), Some("Renamed"));
    let read = w.canvases.get(ID).unwrap().unwrap();
    assert!(
        read.scene.contains("second"),
        "the document holds the remote scene when told"
    );
}

#[test]
fn a_remote_tombstone_tells_the_renderer_canvas_deleted() {
    let w = world();
    w.remote(1, "Plan", None, "ink");

    let told = w.remote_tombstone(2);

    assert_eq!(told, vec![CanvasSynced::Deleted(ID.to_owned())]);
}

#[test]
fn an_echo_tells_the_renderer_nothing() {
    let w = world();
    w.remote(1, "Plan", None, "ink");

    let told = w.remote(1, "Plan", None, "ink");

    assert!(told.is_empty(), "an echo is not news: {told:?}");
}

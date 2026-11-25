//! Canvases across devices that share one account vault but hold different local vault ids
//! (#5505). A device that downloaded the vault binds `sync.server_vault_id` over a freshly minted
//! `vault.id`; Electron adopts the server uuid as its local one (`vault-adoption.ts:49-80`), so
//! every canvas states the account vault's id (§13.7.21) and every device lists it.
//!
//! | Test                                                             | Rule                       |
//! | ---------------------------------------------------------------- | -------------------------- |
//! | a canvas pulled under the server id lists on a downloaded vault  | §13.7.21 `vaultId`          |
//! | a canvas made on a downloaded vault lists on the first device    | §13.7.21 `vaultId`          |
//! | canvases stamped with the local id or none still list           | rows of builds before #5505 |
//! | a folder rename, move and delete carry synced canvases           | `folder-store.ts:395-741`   |
//! | a pulled update keeps the stored vault id                        | §13.7.21 rule 4             |

use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use std::collections::HashMap;

use memry_core::api::auth::ensure_device_identity;
use memry_core::api::errors::SecureStoreError;
use memry_core::api::vault::Vault;
use memry_core::seams::secure_store::{SecureStore, SecureStoreKey};
use memry_core::storage::repositories::sync_items::InboundRecord;
use memry_core::storage::{Db, OpenOptions, open_data};
use memry_core::sync::apply::apply_inbound;
use memry_desktop::canvas::service::{CanvasCreateInput, CanvasService};
use serde_json::{Value, json};

use crate::canvas_service::{NOW, scene, side_trash};

const SERVER: &str = "14a713fd-3dec-468b-ba72-be5a3622f15f";

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

struct Device {
    _dir: tempfile::TempDir,
    vault: Vault,
    db: Db,
    canvases: CanvasService,
}

/// A device whose vault is open; nothing is bound yet.
fn device() -> Device {
    let dir = tempfile::Builder::new()
        .prefix("memry-canvas-vault-")
        .tempdir()
        .unwrap();
    let root: PathBuf = dir.path().join("vault");
    let core = root.join(".memry").join("core");
    fs::create_dir_all(&core).unwrap();
    let store: Arc<dyn SecureStore> = Arc::new(MemoryStore::default());
    ensure_device_identity(store.clone()).unwrap();
    let vault =
        Vault::open_with(core.to_string_lossy().into_owned(), OpenOptions::default()).unwrap();
    let index = vault.search(None).unwrap().index_handle();
    let canvases = CanvasService::new(root, vault.canvases(store).unwrap(), index, side_trash);
    let db = open_data(&core.join("data.db")).unwrap();
    Device {
        _dir: dir,
        vault,
        db,
        canvases,
    }
}

/// Device A: its vault became the account vault, so the server id is its own id
/// (`account/binding.rs`, `local_vault_uuid`).
fn first_device() -> Device {
    let a = device();
    a.vault.bind_server_vault(&a.vault.id()).unwrap();
    a
}

/// Device B: downloaded the account vault, which binds the server id over a fresh local id
/// (`session/provision.rs`, `provision_in`).
fn downloading_device(server: &str) -> Device {
    let b = device();
    assert_ne!(b.vault.id(), server);
    b.vault.bind_server_vault(server).unwrap();
    b
}

impl Device {
    fn pull(&self, id: &str, payload: Value) {
        let record = InboundRecord {
            item_type: "canvas".into(),
            item_id: id.into(),
            payload_json: payload.to_string(),
            server_cursor: None,
            signer_device_id: Some("peer".into()),
            updated_at: NOW,
            deleted_at: None,
        };
        self.db
            .call_blocking(move |conn| apply_inbound(conn, &record, NOW))
            .unwrap();
    }

    /// What this device pushes for `id`.
    fn pushed(&self, id: &str) -> Value {
        let id = id.to_owned();
        let text: String = self
            .db
            .read_blocking(move |conn| {
                Ok(conn
                    .query_row(
                        "SELECT payload FROM sync_items WHERE item_type = 'canvas' AND item_id = ?1",
                        [id],
                        |row| row.get(0),
                    )
                    .unwrap())
            })
            .unwrap();
        serde_json::from_str(&text).unwrap()
    }

    fn stored_vault_id(&self, id: &str) -> String {
        let id = id.to_owned();
        self.db
            .read_blocking(move |conn| {
                Ok(conn
                    .query_row("SELECT vault_id FROM canvases WHERE id = ?1", [id], |row| {
                        row.get(0)
                    })
                    .unwrap())
            })
            .unwrap()
    }

    fn titles(&self) -> Vec<String> {
        let mut titles: Vec<String> = self
            .canvases
            .list()
            .unwrap()
            .into_iter()
            .map(|canvas| canvas.title.unwrap_or_default())
            .collect();
        titles.sort();
        titles
    }

    fn create(&self, title: &str) -> String {
        let input = CanvasCreateInput {
            title: Some(title.to_owned()),
            scene: Some(scene(title)),
            ..CanvasCreateInput::default()
        };
        self.canvases.create(&input, NOW).unwrap().canvas.summary.id
    }
}

fn canvas(vault_id: &str, title: &str, folder: Option<&str>, tick: u64) -> Value {
    json!({
        "id": title,
        "vaultId": vault_id,
        "title": title,
        "scene": scene(title),
        "folder": folder,
        "icon": null,
        "ownerNoteId": null,
        "clock": { "peer": tick },
        "deletedAt": null,
    })
}

#[test]
fn a_canvas_pulled_under_the_server_id_lists_on_a_downloaded_vault() {
    let b = downloading_device(SERVER);
    b.pull("LM", canvas(SERVER, "LM", None, 1));
    assert_eq!(b.titles(), ["LM"]);
}

#[test]
fn a_canvas_made_on_a_downloaded_vault_lists_on_the_first_device() {
    let a = first_device();
    let b = downloading_device(&a.vault.id());
    let id = b.create("Made on B");
    let payload = b.pushed(&id);
    assert_eq!(payload["vaultId"], json!(a.vault.id()));

    a.pull(&id, payload);
    assert_eq!(a.titles(), ["Made on B"]);
}

#[test]
fn canvases_stamped_with_the_local_id_or_none_still_list() {
    let b = device();
    // Made here before the bind: stamped with the local id, as every build before #5505 did.
    b.create("Before bind");
    b.vault.bind_server_vault(SERVER).unwrap();
    b.pull("Unnamed", canvas("", "Unnamed", None, 1));
    b.pull(
        "Other vault",
        canvas("another-vault", "Other vault", None, 1),
    );
    assert_eq!(b.titles(), ["Before bind", "Unnamed"]);
}

#[test]
fn a_folder_rename_move_and_delete_carry_synced_canvases() {
    let b = downloading_device(SERVER);
    b.canvases.create_folder(None, "Work", NOW).unwrap();
    b.canvases.create_folder(None, "Home", NOW).unwrap();
    b.pull("Synced", canvas(SERVER, "Synced", Some("Work"), 1));
    let folder_of = |id: &str| b.canvases.get(id).unwrap().unwrap().summary.folder;

    b.canvases
        .rename_folder("Work", "Archive", NOW + 1)
        .unwrap()
        .unwrap();
    assert_eq!(folder_of("Synced").as_deref(), Some("Archive"));

    b.canvases
        .move_folder("Archive", Some("Home"), NOW + 2)
        .unwrap()
        .unwrap();
    assert_eq!(folder_of("Synced").as_deref(), Some("Home/Archive"));

    let deleted = b.canvases.delete_folder("Home", NOW + 3).unwrap();
    assert_eq!(deleted, ["Synced"]);
    assert!(b.canvases.get("Synced").unwrap().is_none());
}

#[test]
fn a_pulled_update_keeps_the_stored_vault_id() {
    let b = downloading_device(SERVER);
    b.pull("Kept", canvas("", "Kept", None, 1));
    b.pull("Kept", canvas("some-other-vault", "Kept", None, 2));
    assert_eq!(b.stored_vault_id("Kept"), "");
    assert_eq!(b.titles(), ["Kept"]);
}

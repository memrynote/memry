//! A note's `fullWidth` override (#4376): desktop's frontmatter key, read and
//! written through the property path, over real SQLite.
//!
//! | Test                                                  | Rule                          |
//! | ----------------------------------------------------- | ----------------------------- |
//! | a desktop note's override reads back                  | desktop `typeof === boolean`  |
//! | a toggle writes only `fullWidth`                      | other keys untouched, queued  |
//! | a value that is not a boolean follows the global width | desktop `typeof === boolean`  |

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use memry_core::api::errors::{SecureStoreError, StorageError};
use memry_core::api::vault::Vault;
use memry_core::seams::secure_store::{SecureStore, SecureStoreKey};
use memry_core::storage::repositories::sync_items;
use memry_core::storage::{Db, open_data};
use rusqlite::Connection;
use serde_json::{Value, json};

static SCRATCH: AtomicU64 = AtomicU64::new(0);
const NOW: i64 = 1_760_000_000_000;

struct MemoryStore(Mutex<HashMap<String, Vec<u8>>>);

impl SecureStore for MemoryStore {
    fn get(&self, key: SecureStoreKey) -> Result<Option<Vec<u8>>, SecureStoreError> {
        Ok(self.0.lock().unwrap().get(&format!("{key:?}")).cloned())
    }
    fn set(&self, key: SecureStoreKey, value: Vec<u8>) -> Result<(), SecureStoreError> {
        self.0.lock().unwrap().insert(format!("{key:?}"), value);
        Ok(())
    }
    fn delete(&self, key: SecureStoreKey) -> Result<(), SecureStoreError> {
        self.0.lock().unwrap().remove(&format!("{key:?}"));
        Ok(())
    }
    fn clear(&self) -> Result<(), SecureStoreError> {
        self.0.lock().unwrap().clear();
        Ok(())
    }
}

fn registered() -> Arc<dyn SecureStore> {
    let mut secret = vec![7u8; 32];
    secret.extend_from_slice(&[9u8; 32]);
    let store = MemoryStore(Mutex::new(HashMap::new()));
    store
        .set(SecureStoreKey::DeviceSigningKey, secret)
        .expect("seed");
    Arc::new(store)
}

fn vault(label: &str) -> (PathBuf, Vault) {
    let unique = SCRATCH.fetch_add(1, Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!(
        "memry-full-width-{label}-{}-{unique}",
        std::process::id()
    ));
    std::fs::create_dir_all(&dir).expect("the scratch directory");
    let opened = Vault::open("vault-1".to_string(), dir.display().to_string()).expect("open");
    (dir, opened)
}

fn behind(dir: &Path) -> Db {
    open_data(&dir.join("data.db")).expect("second open")
}

/// A note as a desktop pushes it: user properties around `fullWidth`, and keys
/// this build does not know.
fn desktop_note(properties: Value) -> Value {
    json!({
        "title": "Wide", "content": "", "tags": ["plan"], "aliases": ["W"],
        "properties": properties, "pinnedTags": [], "emoji": null, "fileType": "markdown",
        "folderPath": null, "clock": {"device-b": 4},
        "createdAt": "2099-06-15T08:00:00.000Z", "modifiedAt": "2099-06-15T08:00:00.000Z",
        "futureField": {"kept": true}
    })
}

fn seed(dir: &Path, id: &str, payload: &Value) {
    behind(dir)
        .call_blocking(|conn: &mut Connection| {
            let record = sync_items::InboundRecord {
                item_type: "note".to_owned(),
                item_id: id.to_owned(),
                payload_json: payload.to_string(),
                server_cursor: Some(9),
                signer_device_id: Some("device-b".to_owned()),
                updated_at: NOW,
                deleted_at: None,
            };
            sync_items::apply_remote(conn, &record, NOW)?;
            Ok(())
        })
        .expect("seed the note");
}

fn stored(dir: &Path, id: &str) -> Value {
    let raw = behind(dir)
        .call_blocking(|conn: &mut Connection| {
            sync_items::push_payload(conn, "note", id).map_err(|error| StorageError::Failed {
                what: error.to_string(),
            })
        })
        .expect("read")
        .expect("a payload");
    serde_json::from_str(&raw).expect("JSON")
}

fn queued(dir: &Path) -> i64 {
    behind(dir)
        .call_blocking(|conn: &mut Connection| {
            conn.query_row("SELECT count(*) FROM outbox", [], |row| row.get(0))
                .map_err(|error| StorageError::Failed {
                    what: error.to_string(),
                })
        })
        .expect("count")
}

#[test]
fn a_desktop_notes_override_reads_back() {
    let (dir, vault) = vault("read");
    seed(&dir, "on", &desktop_note(json!({"fullWidth": true})));
    seed(&dir, "off", &desktop_note(json!({"fullWidth": false})));
    seed(&dir, "none", &desktop_note(json!({"status": "draft"})));

    let notes = vault.notes();
    assert_eq!(notes.full_width("on".into()).expect("on"), Some(true));
    assert_eq!(notes.full_width("off".into()).expect("off"), Some(false));
    assert_eq!(notes.full_width("none".into()).expect("none"), None);
    assert_eq!(notes.full_width("missing".into()).expect("missing"), None);
}

#[test]
fn a_toggle_writes_only_full_width() {
    let (dir, vault) = vault("write");
    let before = desktop_note(json!({"status": "draft", "due": "2099-07-01", "rank": 3}));
    seed(&dir, "n1", &before);
    let writer = vault.notes_writer(registered()).expect("writer");

    writer.set_full_width("n1".into(), true).expect("set on");
    assert_eq!(
        vault.notes().full_width("n1".into()).expect("read"),
        Some(true)
    );
    let after = stored(&dir, "n1");
    // Other properties keep their values and their order; `fullWidth` is added
    // at the end, as desktop's property write-back appends a new key.
    assert_eq!(
        serde_json::to_string(&after["properties"]).expect("text"),
        r#"{"status":"draft","due":"2099-07-01","rank":3,"fullWidth":true}"#
    );
    for (key, value) in before.as_object().expect("object") {
        if !["properties", "clock", "modifiedAt"].contains(&key.as_str()) {
            assert_eq!(&after[key], value, "`{key}` must not change");
        }
    }
    assert_eq!(queued(&dir), 1, "the write must reach the outbox");

    // Off pins normal width rather than clearing the key, as desktop's toggle does.
    writer.set_full_width("n1".into(), false).expect("set off");
    assert_eq!(
        vault.notes().full_width("n1".into()).expect("read"),
        Some(false)
    );
    assert_eq!(
        serde_json::to_string(&stored(&dir, "n1")["properties"]).expect("text"),
        r#"{"status":"draft","due":"2099-07-01","rank":3,"fullWidth":false}"#
    );

    // Writing the stored value again queues nothing new.
    let rows = queued(&dir);
    writer
        .set_full_width("n1".into(), false)
        .expect("same value");
    assert_eq!(queued(&dir), rows);
}

#[test]
fn a_value_that_is_not_a_boolean_follows_the_global_width() {
    let (dir, vault) = vault("odd");
    seed(&dir, "null", &desktop_note(json!({"fullWidth": null})));
    seed(&dir, "text", &desktop_note(json!({"fullWidth": "yes"})));

    assert_eq!(vault.notes().full_width("null".into()).expect("null"), None);
    assert_eq!(vault.notes().full_width("text".into()).expect("text"), None);

    // A cleared override takes a boolean again.
    let writer = vault.notes_writer(registered()).expect("writer");
    writer.set_full_width("null".into(), true).expect("set");
    assert_eq!(
        vault.notes().full_width("null".into()).expect("read"),
        Some(true)
    );
}

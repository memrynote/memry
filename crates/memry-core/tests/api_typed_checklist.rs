//! A checklist line the iOS editor converts as it is typed
//! (`Tasks::convert_typed_checklist_item`), held to desktop's
//! `convertChecklistsToTasks` setting.

mod http_fakes;

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use http_fakes::FakeSecureStore;
use memry_core::api::tasks::Tasks;
use memry_core::api::vault::Vault;
use memry_core::crdt::body_edit::BlockEdit;
use memry_core::crypto::sodium;
use memry_core::seams::secure_store::{SecureStore, SecureStoreKey};

static SCRATCH: AtomicU64 = AtomicU64::new(0);
const NOW: &str = "2026-01-14T12:00:00";

struct Fixture {
    vault: Vault,
    store: Arc<dyn SecureStore>,
    tasks: Arc<Tasks>,
    note: String,
}

fn fixture() -> Fixture {
    let unique = SCRATCH.fetch_add(1, Ordering::Relaxed);
    let dir: PathBuf = std::env::temp_dir().join(format!(
        "memry-typed-checklist-{}-{unique}",
        std::process::id()
    ));
    std::fs::create_dir_all(&dir).expect("the scratch directory");
    let vault = Vault::open("vault-1".to_string(), dir.display().to_string()).expect("open");
    let (_public, secret) = sodium::sign_seed_keypair(&[3u8; 32]).expect("a keypair");
    let store: Arc<dyn SecureStore> = FakeSecureStore::new();
    store
        .set(SecureStoreKey::DeviceSigningKey, secret.to_vec())
        .expect("plant the signing key");
    let tasks = vault.tasks(store.clone()).expect("the task surface");
    tasks.ensure_inbox().expect("the Inbox");
    let note = vault
        .notes_writer(store.clone())
        .expect("the note writer")
        .create("Groceries".to_string(), None)
        .expect("the note");
    Fixture {
        vault,
        store,
        tasks,
        note,
    }
}

impl Fixture {
    fn edit(&self, edit: BlockEdit) {
        let landed = self
            .vault
            .notes_writer(self.store.clone())
            .expect("the note writer")
            .edit_block(self.note.clone(), edit)
            .expect("the edit");
        assert!(landed, "the note is live");
    }

    fn checklist(&self, id: &str, after: Option<&str>, text: &str) {
        self.edit(BlockEdit::InsertBlock {
            kind: "checkListItem".to_string(),
            after_block_id: after.map(str::to_string),
            text: text.to_string(),
            new_block_id: id.to_string(),
        });
    }

    fn turn_off_conversion(&self) {
        self.vault
            .settings(self.store.clone())
            .expect("the settings")
            .set(
                "editor.convertChecklistsToTasks".to_string(),
                "false".to_string(),
            )
            .expect("the setting");
    }

    fn convert_typed(&self, block: &str) -> Option<String> {
        self.tasks
            .convert_typed_checklist_item(self.note.clone(), block.to_string(), NOW.to_string())
            .expect("the conversion")
    }

    fn kind(&self, block: &str) -> String {
        self.vault
            .notes()
            .blocks(self.note.clone())
            .expect("the blocks")
            .expect("the note")
            .into_iter()
            .find(|candidate| candidate.id.as_deref() == Some(block))
            .expect("the block")
            .kind
    }
}

#[test]
fn a_typed_line_becomes_a_task_by_default() {
    let fixture = fixture();
    fixture.checklist("c1", None, "Buy milk");

    let id = fixture.convert_typed("c1").expect("a task");

    let task = fixture.tasks.get(id).expect("the read").expect("the task");
    assert_eq!(task.title, "Buy milk");
    assert_eq!(fixture.kind("c1"), "taskBlock");
}

#[test]
fn with_conversion_off_a_top_level_line_stays_a_checkbox() {
    let fixture = fixture();
    fixture.turn_off_conversion();
    fixture.checklist("c1", None, "Buy milk");

    assert_eq!(fixture.convert_typed("c1"), None);
    assert_eq!(fixture.kind("c1"), "checkListItem");
}

#[test]
fn with_conversion_off_a_line_under_a_task_becomes_its_subtask() {
    let fixture = fixture();
    fixture.checklist("parent", None, "Trip");
    let parent = fixture
        .tasks
        .convert_checklist_item(fixture.note.clone(), "parent".to_string(), NOW.to_string())
        .expect("the conversion")
        .expect("the parent task");
    fixture.turn_off_conversion();
    fixture.checklist("child", Some("parent"), "Pack");
    fixture.edit(BlockEdit::Indent {
        block_id: "child".to_string(),
    });

    let id = fixture.convert_typed("child").expect("a subtask");

    let task = fixture.tasks.get(id).expect("the read").expect("the task");
    assert_eq!(task.parent_id.as_deref(), Some(parent.as_str()));
}

#[test]
fn a_plain_checkbox_never_converts() {
    let fixture = fixture();
    fixture.checklist("c1", None, "Keep me");
    fixture.edit(BlockEdit::SetProp {
        block_id: "c1".to_string(),
        name: "plain".to_string(),
        value: "true".to_string(),
    });

    assert_eq!(fixture.convert_typed("c1"), None);
    assert_eq!(fixture.kind("c1"), "checkListItem");
}

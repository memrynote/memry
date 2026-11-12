//! `Tasks::location_options` over a real vault: the Location filter's folders
//! and notes come from the vault's notes and every live task, as desktop's
//! `buildTaskLocationOptions` lists them (the `task-filtering` vectors pin the
//! rules; this pins the wiring).

#[allow(unused_imports)]
use crate::http_fakes;

use std::sync::Arc;

use http_fakes::FakeSecureStore;
use memry_core::api::projects::ProjectDraft;
use memry_core::api::tasks::Tasks;
use memry_core::api::tasks_write::NewTaskInput;
use memry_core::api::vault::Vault;
use memry_core::crypto::sodium;
use memry_core::seams::secure_store::{SecureStore as _, SecureStoreKey};
use memry_core::storage::repositories::sync_items::{self, InboundRecord};
use serde_json::{Value, json};

fn vault() -> Vault {
    let dir = std::env::temp_dir().join(format!("memry-api-location-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("the scratch directory");
    Vault::open("vault-1".to_string(), dir.display().to_string()).expect("open")
}

fn tasks(vault: &Vault) -> Arc<Tasks> {
    let (_public, secret) = sodium::sign_seed_keypair(&[3u8; 32]).expect("a keypair");
    let store = FakeSecureStore::new();
    store
        .set(SecureStoreKey::DeviceSigningKey, secret.to_vec())
        .expect("plant the signing key");
    vault.tasks(store).expect("the task surface")
}

/// Applies a note record as a pull would, from a peer.
fn note(vault: &Vault, id: &str, payload: Value) {
    let payload = payload.to_string();
    let id = id.to_string();
    vault
        .db_handle()
        .call_blocking(move |conn| {
            sync_items::apply_remote(
                conn,
                &InboundRecord {
                    item_type: "note".to_string(),
                    item_id: id,
                    payload_json: payload,
                    server_cursor: None,
                    signer_device_id: None,
                    updated_at: 1,
                    deleted_at: None,
                },
                1,
            )?;
            Ok(())
        })
        .expect("apply");
}

fn input(title: &str, project: &str) -> NewTaskInput {
    NewTaskInput {
        title: title.to_string(),
        project_id: project.to_string(),
        status_id: None,
        parent_id: None,
        priority: 0,
        description: None,
        due_date: None,
        due_time: None,
        start_date: None,
        repeat: None,
        repeat_from: None,
        tags: Vec::new(),
        linked_note_ids: Vec::new(),
        linked_canvas_ids: Vec::new(),
        source_note_id: None,
        position: None,
    }
}

fn rows(tasks: &Tasks, folders: &[&str], notes: &[&str], query: &str) -> Vec<String> {
    let owned = |list: &[&str]| list.iter().map(|s| s.to_string()).collect();
    tasks
        .location_options(owned(folders), owned(notes), query.to_string())
        .expect("location options")
        .into_iter()
        .map(|row| {
            format!(
                "{}{}:{}={} ({})",
                "  ".repeat(row.depth as usize),
                row.kind,
                row.label,
                row.count,
                row.context
            )
        })
        .collect()
}

#[test]
fn location_options_list_the_vaults_folders_and_notes_with_task_counts() {
    let vault = vault();
    let tasks = tasks(&vault);
    let work = tasks
        .create_project(ProjectDraft {
            name: "Agent Test Location".to_string(),
            description: None,
            color: None,
            icon: None,
            statuses: None,
        })
        .expect("create project");
    note(
        &vault,
        "n-roof",
        json!({"title": "Roof", "folderPath": "Infra/House"}),
    );
    note(
        &vault,
        "n-brief",
        json!({"title": "Brief", "folderPath": "Infra"}),
    );
    note(
        &vault,
        "n-inbox",
        json!({"title": "Inbox", "folderPath": ""}),
    );
    note(
        &vault,
        "n-idle",
        json!({"title": "Idle", "folderPath": "Infra"}),
    );

    let create = |title: &str, source: Option<&str>, linked: &[&str], parent: Option<&str>| {
        let mut new = input(title, &work);
        new.source_note_id = source.map(str::to_string);
        new.linked_note_ids = linked.iter().map(|s| s.to_string()).collect();
        new.parent_id = parent.map(str::to_string);
        tasks.create(new).expect("create").created[0].clone()
    };
    create("[agent] roof one", Some("n-roof"), &[], None);
    let brief = create("[agent] brief", Some("n-brief"), &["n-roof"], None);
    create("[agent] brief sub", Some("n-inbox"), &[], Some(&brief));
    create("[agent] linked only", None, &["n-inbox"], None);

    assert_eq!(
        rows(&tasks, &[], &[], ""),
        [
            "note:Inbox=1 ()",
            "folder:Infra=2 ()",
            "  note:Brief=1 (Infra)",
            "  folder:House=2 (Infra)",
            "    note:Roof=2 (Infra/House)",
        ]
    );
    assert_eq!(
        rows(&tasks, &["Gone"], &["n-idle"], ""),
        [
            "note:Inbox=1 ()",
            "folder:Gone=0 ()",
            "folder:Infra=2 ()",
            "  note:Brief=1 (Infra)",
            "  note:Idle=0 (Infra)",
            "  folder:House=2 (Infra)",
            "    note:Roof=2 (Infra/House)",
        ]
    );
    assert_eq!(
        rows(&tasks, &[], &[], " ROO "),
        ["note:Roof=2 (Infra/House)"]
    );
}

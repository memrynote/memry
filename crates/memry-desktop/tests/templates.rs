//! Templates on a real vault (`data.db` through the core, `.memry/templates` on disk), after
//! Electron's `vault/templates.ts` and `ipc/templates-handlers.ts`.
//!
//! | Test                                                        | Rule                                  |
//! | ----------------------------------------------------------- | ------------------------------------- |
//! | create, update, duplicate, delete round trip                | `templates.e2e.ts` of Electron        |
//! | task block suffixes never reach a body written or read      | `stripTaskBlockSuffixes`              |
//! | a name is 1 to 200 units and a property needs a name        | `TemplateCreateSchema`                |
//! | built-ins read with the fixed timestamp and copy as custom  | `BUILT_IN_TIMESTAMP`, duplicate       |
//! | a delete removes the template's legacy file, and only that  | `deleteTemplate`                      |
//! | a legacy file reached through a link is left alone           | no write outside the path named       |
//! | a refused delete keeps the legacy file                       | file goes only after the tombstone    |

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use memry_core::api::auth::ensure_device_identity;
use memry_core::api::errors::{SecureStoreError, StorageError};
use memry_core::api::vault::Vault;
use memry_core::seams::secure_store::{SecureStore, SecureStoreKey};
use memry_desktop::templates::{
    BUILT_IN_TIMESTAMP, TemplateCreateInput, TemplateProperty, TemplatePropertyType,
    TemplateUpdateInput, Templates,
};
use serde_json::json;

const NOW: i64 = 1_760_000_000_000;

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

struct Lib {
    _dir: tempfile::TempDir,
    vault: PathBuf,
    templates: Templates,
}

fn library() -> Lib {
    let dir = tempfile::Builder::new()
        .prefix("memry-templates-")
        .tempdir()
        .expect("tmp");
    let vault = dir.path().join("vault");
    let core = vault.join(".memry").join("core");
    std::fs::create_dir_all(&core).expect("vault dirs");
    let store: Arc<dyn SecureStore> = Arc::new(MemoryStore::default());
    ensure_device_identity(store.clone()).expect("device identity");
    let core =
        Vault::open("vault".into(), core.to_string_lossy().into_owned()).expect("open data.db");
    Lib {
        templates: Templates::new(vault.clone(), core.templates(store).expect("store")),
        _dir: dir,
        vault,
    }
}

fn stage() -> TemplateProperty {
    TemplateProperty {
        name: "Stage".into(),
        kind: TemplatePropertyType::Select,
        value: json!("Draft"),
        options: Some(vec!["Draft".into(), "Final".into()]),
    }
}

fn input(name: &str) -> TemplateCreateInput {
    TemplateCreateInput {
        name: name.into(),
        description: Some("Template coverage".into()),
        icon: Some("T".into()),
        tags: vec!["e2e-template".into()],
        properties: vec![stage()],
        content: "# Template heading\n\nBody".into(),
    }
}

fn legacy(lib: &Lib, id: &str) -> PathBuf {
    lib.vault
        .join(".memry")
        .join("templates")
        .join(format!("{id}.md"))
}

fn write_legacy(lib: &Lib, id: &str) -> PathBuf {
    let path = legacy(lib, id);
    std::fs::create_dir_all(path.parent().unwrap()).expect("templates dir");
    std::fs::write(&path, format!("---\nid: {id}\nname: Old\n---\nold body\n")).expect("legacy");
    path
}

#[test]
fn create_update_duplicate_and_delete_round_trip() {
    let lib = library();
    let created = lib.templates.create(&input("Weekly"), NOW).expect("create");
    assert_eq!(created.tags, vec!["e2e-template"]);
    assert_eq!(
        created.properties,
        vec![
            json!({ "name": "Stage", "type": "select", "value": "Draft", "options": ["Draft", "Final"] })
        ]
    );
    assert_eq!(created.icon.as_deref(), Some("T"));

    let updated = lib
        .templates
        .update(
            &TemplateUpdateInput {
                id: created.id.clone(),
                name: Some("Weekly Updated".into()),
                tags: Some(vec!["e2e-template".into(), "updated".into()]),
                icon: Some(None),
                content: Some("# Updated\n\nBody".into()),
                ..TemplateUpdateInput::default()
            },
            NOW + 1,
        )
        .expect("update");
    assert_eq!(updated.name, "Weekly Updated");
    assert_eq!(updated.tags, vec!["e2e-template", "updated"]);
    assert_eq!(updated.icon, None, "icon: null clears the icon");
    assert_eq!(updated.description.as_deref(), Some("Template coverage"));
    assert_eq!(
        updated.properties, created.properties,
        "an absent field stays"
    );

    let copy = lib
        .templates
        .duplicate(&created.id, "Weekly Copy", NOW + 2)
        .expect("duplicate");
    assert_ne!(copy.id, created.id);
    assert_eq!(
        (copy.content.as_str(), &copy.tags),
        (updated.content.as_str(), &updated.tags)
    );

    let names: Vec<String> = lib
        .templates
        .list()
        .expect("list")
        .into_iter()
        .filter(|t| !t.is_built_in)
        .map(|t| t.name)
        .collect();
    assert_eq!(names, ["Weekly Copy", "Weekly Updated"]);

    lib.templates.delete(&copy.id, NOW + 3).expect("delete");
    lib.templates.delete(&created.id, NOW + 3).expect("delete");
    assert!(
        lib.templates
            .list()
            .expect("list")
            .iter()
            .all(|t| t.is_built_in)
    );
    assert_eq!(lib.templates.get(&created.id).expect("get"), None);
}

#[test]
fn task_block_suffixes_never_reach_a_body_written_or_read() {
    let lib = library();
    let body = "- [ ] call Ana {task:t1abc}\n- [x] done {task:}\nplain {task:t2}";
    let created = lib
        .templates
        .create(
            &TemplateCreateInput {
                content: body.into(),
                ..input("Tasks")
            },
            NOW,
        )
        .expect("create");
    assert_eq!(
        created.content,
        "- [ ] call Ana\n- [x] done\nplain {task:t2}"
    );
    let updated = lib
        .templates
        .update(
            &TemplateUpdateInput {
                id: created.id.clone(),
                content: Some("- [ ] again {task:t9}".into()),
                ..TemplateUpdateInput::default()
            },
            NOW + 1,
        )
        .expect("update");
    assert_eq!(updated.content, "- [ ] again");
}

#[test]
fn a_name_is_1_to_200_units_and_a_property_needs_a_name() {
    let lib = library();
    let refused = |result: Result<_, StorageError>| {
        assert!(
            matches!(result, Err(StorageError::Invalid { .. })),
            "{result:?}"
        )
    };
    refused(lib.templates.create(&input(""), NOW));
    refused(lib.templates.create(&input(&"é".repeat(201)), NOW));
    lib.templates
        .create(&input(&"é".repeat(200)), NOW)
        .expect("200 units");
    let mut unnamed = input("ok");
    unnamed.properties[0].name.clear();
    refused(lib.templates.create(&unnamed, NOW));
    refused(lib.templates.duplicate("blank", "", NOW));
}

#[test]
fn built_ins_read_with_the_fixed_timestamp_and_copy_as_custom_templates() {
    let lib = library();
    let built_ins: Vec<_> = lib
        .templates
        .list()
        .expect("list")
        .into_iter()
        .filter(|t| t.is_built_in)
        .collect();
    assert_eq!(built_ins.len(), 8);
    assert_eq!(built_ins[0].name, "Blank Note", "built-ins by name");
    let weekly = lib
        .templates
        .get("weekly-review")
        .expect("get")
        .expect("built-in");
    assert_eq!(
        (weekly.created_at.as_str(), weekly.modified_at.as_str()),
        (BUILT_IN_TIMESTAMP, BUILT_IN_TIMESTAMP)
    );
    let copy = lib
        .templates
        .duplicate("weekly-review", "My week", NOW)
        .expect("duplicate");
    assert!(!copy.is_built_in);
    assert_eq!(copy.properties, weekly.properties);
    assert_eq!(copy.created_at, "2025-10-09T08:53:20.000Z");
}

#[test]
fn a_delete_removes_the_templates_legacy_file_and_only_that() {
    let lib = library();
    let created = lib.templates.create(&input("Mine"), NOW).expect("create");
    let own = write_legacy(&lib, &created.id);
    let other = write_legacy(&lib, "someone-else");
    lib.templates.delete(&created.id, NOW + 1).expect("delete");
    assert!(!own.exists(), "the deleted template's file goes");
    assert!(other.exists(), "every other legacy file stays");
}

#[cfg(unix)]
#[test]
fn a_legacy_file_reached_through_a_link_is_left_alone() {
    let lib = library();
    let created = lib.templates.create(&input("Linked"), NOW).expect("create");
    let elsewhere = lib.vault.join("notes");
    std::fs::create_dir_all(&elsewhere).expect("notes");
    let target = elsewhere.join(format!("{}.md", created.id));
    std::fs::write(&target, "a note").expect("note");
    std::fs::create_dir_all(lib.vault.join(".memry")).expect(".memry");
    std::os::unix::fs::symlink(&elsewhere, lib.vault.join(".memry").join("templates"))
        .expect("link");
    lib.templates.delete(&created.id, NOW + 1).expect("delete");
    assert!(
        target.exists(),
        "a file behind a linked folder is never removed"
    );
}

#[test]
fn a_refused_delete_keeps_the_legacy_file() {
    let lib = library();
    let file = write_legacy(&lib, "blank");
    assert!(lib.templates.delete("blank", NOW).is_err());
    let missing = write_legacy(&lib, "never-was");
    assert!(lib.templates.delete("never-was", NOW).is_err());
    assert!(file.exists() && missing.exists());
}

//! A tag field renamed across the vault (`rename-field`, #3530 13j-3d-2) under the running vault
//! tier with `NotesIdentity` and the note index: Electron's `tags/schema/field-rename.test.ts`
//! (a run stopped after its first note finishes at the next open without writing anything twice,
//! a refusal writes nothing, a kept note holds the job, a case-only rename keeps the key's place),
//! plus journal days, local-only notes, the outbox row per changed item and an outside edit made
//! while the job runs.

#[allow(unused_imports)]
use crate::vault_env;

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use crate::index_support::until;
use crate::notes_tag_rename::{clear_outbox, path_of, upserts};
use memry_core::api::projects::ProjectDraft;
use memry_core::api::tasks_write::NewTaskInput;
use memry_core::seams::secure_store::SecureStore;
use memry_core::sync::versioned;
use memry_desktop::notes::identity::NotesIdentity;
use memry_desktop::notes::index::NoteIndex;
use memry_desktop::notes::local_only;
use memry_desktop::notes::property_definitions::PropertyDefinitions;
use memry_desktop::notes::service::NotesService;
use memry_desktop::session::OpenVault;
use memry_desktop::tags::schema::rename::{FieldRenameJob, FieldRenameView, register_resume};
use memry_desktop::tags::schema::view::{FieldType, NewFieldSpec, TagSchemaCommand};
use memry_desktop::tags::schema::{SchemaError, Schemas};
use serde_json::{Value, json};
use vault_env::{Env, QUIET, env, indexed};

const AHMET: &str = "---\ntags: [person]\nRole: PM\nPhone: '111'\n---\nA\n";
const ELIF: &str = "---\ntags: [person]\nPhone: '222'\nEmail: e@x.io\n---\nE\n";
const CAN: &str = "---\ntags: [person]\nPhone: '333'\nmobile: '999'\n---\nC\n";
const DAY: &str = "---\nPhone: '555'\n---\nA day\n";
const SECRET: &str = "---\nPhone: '666'\n---\nLocal\n";

struct Vault {
    e: Env,
    notes: Arc<NotesService>,
    store: Arc<dyn SecureStore>,
}

impl Vault {
    fn open(&self) -> OpenVault {
        self.e.session.current().expect("open")
    }

    fn schemas(&self) -> Schemas {
        Schemas::open(&self.open(), &self.notes, "en").expect("schemas")
    }

    fn id(&self, path: &str) -> String {
        let row = self.e.core().note_files().by_path(path).unwrap();
        row.expect(path).note_id
    }

    /// The note's record's `properties`.
    fn record(&self, id: &str) -> Value {
        let id = id.to_owned();
        self.e
            .core()
            .db_handle()
            .call_blocking(move |conn| {
                let raw: String = conn
                    .query_row(
                        "SELECT json_extract(payload, '$.properties') FROM sync_items \
                         WHERE item_id = ?1 AND item_type IN ('note', 'journal')",
                        [id],
                        |row| row.get(0),
                    )
                    .unwrap();
                Ok(serde_json::from_str(&raw).unwrap())
            })
            .unwrap()
    }

    fn job(&self) -> bool {
        self.e.core().field_rename_recorded().unwrap().is_some()
    }

    fn holders(&self, name: &str) -> usize {
        self.open()
            .search
            .notes_holding_properties(vec![name.to_owned()])
            .unwrap()
            .len()
    }
}

/// An open vault holding `files`, its first walk done and every `Phone` read by the index, with
/// `person` listing Phone (a text definition) and the field rename resumed at every open.
fn opened(files: &[(&str, &str)]) -> Vault {
    let store: Mutex<Option<Arc<dyn SecureStore>>> = Mutex::default();
    let mut e = env(|s| {
        *store.lock().unwrap() = Some(s.clone());
        Some(NotesIdentity::new(s))
    });
    for (path, text) in files {
        e.write(path, text);
    }
    NoteIndex::new(e.tier.clone(), |_| {}, |_| {}, |_| {}).register(&e.session);
    let store = store.into_inner().unwrap().unwrap();
    let notes = NotesService::new(e.tier.clone(), store.clone());
    register_resume(&notes, &e.session, Arc::new(|| {}));
    e.open();
    e.facts_until(indexed);
    let vault = Vault { e, notes, store };
    let holding = files.iter().filter(|(_, t)| t.contains("Phone:")).count();
    until("the index read every Phone", || {
        vault.holders("Phone") == holding
    });
    add_field(&vault.schemas(), "Phone");
    vault
}

fn add_field(schemas: &Schemas, name: &str) {
    let field = NewFieldSpec {
        name: name.to_owned(),
        type_name: FieldType::Text,
        options: None,
        relation: None,
    };
    let command = TagSchemaCommand::AddField {
        tag: "person".to_owned(),
        field,
        index: None,
    };
    schemas.run(command, &mut |_, _, _| {}).expect("add-field");
}

fn job(from: &str, to: &str) -> FieldRenameJob {
    FieldRenameJob {
        from: from.into(),
        to: to.into(),
        run_id: "r1".into(),
    }
}

fn rename(vault: &Vault, from: &str, to: &str) -> Result<FieldRenameView, SchemaError> {
    vault
        .schemas()
        .rename_field_until(job(from, to), &mut |_, _, _| {}, &|| false)
}

/// A task tagged `person` holding `Phone`, and `also` when given.
fn task_with_phone(vault: &Vault, value: &str, also: Option<(&str, &str)>) -> String {
    let tasks = vault.open().vault.tasks(vault.store.clone()).unwrap();
    let project = tasks
        .create_project(ProjectDraft {
            name: "Inbox".into(),
            description: None,
            color: None,
            icon: None,
            statuses: None,
        })
        .unwrap();
    let id = tasks
        .create(NewTaskInput {
            title: "Call back".into(),
            project_id: project,
            status_id: None,
            parent_id: None,
            priority: 0,
            description: None,
            due_date: None,
            due_time: None,
            start_date: None,
            repeat: None,
            repeat_from: None,
            tags: vec!["person".into()],
            linked_note_ids: Vec::new(),
            linked_canvas_ids: Vec::new(),
            source_note_id: None,
            position: None,
        })
        .unwrap()
        .created[0]
        .clone();
    let value = Some(json!(value).to_string());
    tasks
        .set_field_value(id.clone(), "Phone".into(), value)
        .unwrap();
    if let Some((name, value)) = also {
        let value = Some(json!(value).to_string());
        tasks
            .set_field_value(id.clone(), name.into(), value)
            .unwrap();
    }
    id
}

fn task_fields(vault: &Vault, id: &str) -> serde_json::Map<String, Value> {
    let id = id.to_owned();
    let raw: String = vault
        .e
        .core()
        .db_handle()
        .call_blocking(move |conn| {
            Ok(conn
                .query_row(
                    "SELECT payload FROM sync_items WHERE item_type = 'task' AND item_id = ?1",
                    [id],
                    |row| row.get(0),
                )
                .unwrap())
        })
        .unwrap();
    let payload: Value = serde_json::from_str(&raw).unwrap();
    versioned::plain(payload.get("fields"))
}

fn schema_fields(vault: &Vault) -> Value {
    vault.e.core().tag_schema_definitions().unwrap()["person"]
        .schema
        .as_ref()
        .and_then(|schema| schema.readable().cloned())
        .map(|schema| schema["fields"].clone())
        .unwrap_or_default()
}

/// The keys of the file's frontmatter, in order.
fn keys(vault: &Vault, path: &str) -> Vec<String> {
    let text = vault.e.read(path);
    let header = text.split("---\n").nth(1).unwrap_or_default();
    header
        .lines()
        .filter(|line| !line.starts_with(' ') && line.contains(':'))
        .map(|line| line.split(':').next().unwrap().to_owned())
        .collect()
}

#[test]
fn a_rename_stopped_after_its_first_note_is_finished_by_the_next_open_writing_nothing_twice() {
    let mut vault = opened(&[
        ("Ahmet.md", AHMET),
        ("Elif.md", ELIF),
        ("Can.md", CAN),
        ("journal/2026-01-01.md", DAY),
        ("Secret.md", SECRET),
    ]);
    let secret = vault.id("Secret.md");
    local_only::set(&vault.open(), &secret, true, None).unwrap();
    let task = task_with_phone(&vault, "444", None);
    let ids = ["Ahmet.md", "Elif.md", "Can.md", "journal/2026-01-01.md"].map(|p| vault.id(p));
    clear_outbox(&vault.e);

    // Stopped once a note's file took the rename (Can, which keeps both names, may come first).
    let all = [&ids[..], std::slice::from_ref(&secret)].concat();
    let paths: Vec<String> = all.iter().map(|id| path_of(&vault.e, id)).collect();
    let originals: Vec<String> = paths.iter().map(|path| vault.e.read(path)).collect();
    let written = || {
        let texts: Vec<String> = paths.iter().map(|path| vault.e.read(path)).collect();
        let changed: Vec<usize> = (0..texts.len())
            .filter(|at| texts[*at] != originals[*at])
            .collect();
        (texts, changed)
    };
    let stopped =
        vault
            .schemas()
            .rename_field_until(job("Phone", "Mobile"), &mut |_, _, _| {}, &|| {
                !written().1.is_empty()
            });
    assert!(matches!(stopped, Err(SchemaError::Stopped)), "{stopped:?}");
    assert!(vault.job(), "the job stays recorded");
    let (texts, changed) = written();
    let [first] = changed[..] else {
        panic!("one note written before the stop: {changed:?}");
    };

    std::thread::sleep(QUIET);
    vault.e.close();
    vault.e.drain();
    vault.e.open();
    until("the next open finished the rename", || !vault.job());

    let text = |path: &str| vault.e.read(path);
    assert_eq!(keys(&vault, "Ahmet.md"), ["tags", "Role", "Mobile"]);
    assert!(
        text("Ahmet.md").contains("Mobile: '111'"),
        "{}",
        text("Ahmet.md")
    );
    assert_eq!(keys(&vault, "Elif.md"), ["tags", "Email", "Mobile"]);
    assert_eq!(
        text("Can.md"),
        CAN,
        "a note holding the new name keeps both"
    );
    assert_eq!(keys(&vault, "journal/2026-01-01.md"), ["Mobile"]);
    assert_eq!(keys(&vault, "Secret.md"), ["Mobile"]);
    assert_eq!(
        vault.e.read(&paths[first]),
        texts[first],
        "the first note was written once"
    );
    assert_eq!(vault.record(&ids[0])["Mobile"], json!("111"));
    assert!(vault.record(&ids[0]).get("Phone").is_none());

    assert_eq!(
        task_fields(&vault, &task),
        json!({"Mobile": "444"}).as_object().unwrap().clone()
    );
    assert_eq!(schema_fields(&vault), json!([{"name": "Mobile"}]));
    let definitions = PropertyDefinitions::open(&vault.open(), vault.store.clone()).unwrap();
    let names: Vec<String> = definitions
        .list()
        .unwrap()
        .into_iter()
        .map(|d| d.name)
        .collect();
    assert!(names.contains(&"Mobile".to_owned()) && !names.contains(&"Phone".to_owned()));

    // One record push per changed item across both runs; none for the local-only note.
    for id in [&ids[0], &ids[1], &ids[3], &task] {
        assert_eq!(upserts(&vault.e, id), 1, "{id}");
    }
    assert_eq!(
        upserts(&vault.e, &ids[2]),
        0,
        "a skipped note is not pushed"
    );
    assert_eq!(
        upserts(&vault.e, &secret),
        0,
        "a local-only note is not pushed"
    );
    assert_eq!(upserts(&vault.e, "person"), 1);
}

#[test]
fn a_rename_onto_a_field_the_tag_lists_is_refused_and_writes_nothing() {
    let vault = opened(&[("Ahmet.md", AHMET)]);
    add_field(&vault.schemas(), "Mobile");
    let refused = rename(&vault, "Phone", "mobile");
    assert!(
        matches!(&refused, Err(SchemaError::Refused { message, .. }) if message.contains("already has a field named \"mobile\"")),
        "{refused:?}"
    );
    assert_eq!(vault.e.read("Ahmet.md"), AHMET);
    assert!(!vault.job());
    let same = rename(&vault, "Phone", " Phone ");
    assert!(same.is_err(), "{same:?}");
}

/// A task whose payload does not read may hold the field or not: the rename does not start.
#[test]
fn a_task_that_does_not_read_refuses_the_rename_before_any_write() {
    let vault = opened(&[("Ahmet.md", AHMET)]);
    let task = task_with_phone(&vault, "444", None);
    vault
        .e
        .core()
        .db_handle()
        .call_blocking(move |conn| {
            conn.execute(
                "UPDATE sync_items SET payload = '[1]' WHERE item_type = 'task' AND item_id = ?1",
                [task],
            )
            .unwrap();
            Ok(())
        })
        .unwrap();
    let schema = schema_fields(&vault);
    let refused = rename(&vault, "Phone", "Mobile");
    assert!(
        matches!(&refused, Err(SchemaError::Storage(_))),
        "{refused:?}"
    );
    assert_eq!(vault.e.read("Ahmet.md"), AHMET);
    assert_eq!(schema_fields(&vault), schema);
    assert!(!vault.job());
}

#[test]
fn a_note_still_kept_holds_the_job_until_the_rename_runs_again() {
    let vault = opened(&[("Ahmet.md", AHMET), ("Elif.md", ELIF)]);
    let elif = vault.id("Elif.md");
    vault.notes.keep_in_field_rename(Some(&elif));

    let renamed = rename(&vault, "Phone", "Mobile").unwrap();
    assert_eq!((renamed.notes, renamed.kept), (1, 1));
    assert!(vault.e.read("Ahmet.md").contains("Mobile: '111'"));
    assert_eq!(vault.e.read("Elif.md"), ELIF);
    assert!(vault.job());
    let other = rename(&vault, "Role", "Title");
    assert!(
        matches!(&other, Err(SchemaError::Refused { message, .. }) if message.contains("(Phone to Mobile)")),
        "{other:?}"
    );

    vault.notes.keep_in_field_rename(None);
    let resumed = vault.schemas().resume_field_rename(&|| false).unwrap();
    assert_eq!(resumed.map(|r| (r.notes, r.kept)), Some((1, 0)));
    assert_eq!(keys(&vault, "Elif.md"), ["tags", "Email", "Mobile"]);
    assert!(!vault.job());
}

#[test]
fn a_rename_to_another_spelling_of_the_name_keeps_the_keys_place() {
    let vault = opened(&[("Ahmet.md", AHMET)]);
    let renamed = rename(&vault, "Phone", "phone").unwrap();
    assert_eq!((renamed.notes, renamed.skipped_existing), (1, 0));
    assert_eq!(keys(&vault, "Ahmet.md"), ["tags", "Role", "phone"]);
    assert_eq!(schema_fields(&vault), json!([{"name": "phone"}]));
}

/// An edit outside the app to a note the job has not reached yet is kept with the rename, and
/// the record's baseline follows the file: a later outside edit does not bring `Phone` back.
#[test]
fn an_outside_edit_made_while_the_rename_runs_is_kept() {
    let vault = opened(&[("Ahmet.md", AHMET), ("Elif.md", ELIF)]);
    let ids = [vault.id("Ahmet.md"), vault.id("Elif.md")];
    let outside = |path: &str| match path {
        "Ahmet.md" => "---\ntags: [person]\nRole: CTO\nPhone: '111'\n---\nA outside\n",
        _ => "---\ntags: [person]\nPhone: '222'\nEmail: new@x.io\n---\nE outside\n",
    };
    let written = Mutex::new(false);
    let vault_dir = vault.e.vault.clone();
    let renamed = vault.schemas().rename_field_until(
        job("Phone", "Mobile"),
        &mut |_, done, _| {
            // After the first note, the other one is edited outside.
            let mut written = written.lock().unwrap();
            if done == 1 && !*written {
                *written = true;
                for path in ["Ahmet.md", "Elif.md"] {
                    let text = std::fs::read_to_string(vault_dir.join(path)).unwrap();
                    if text.contains("Phone:") {
                        std::fs::write(vault_dir.join(path), outside(path)).unwrap();
                    }
                }
            }
        },
        &|| false,
    );
    let renamed = renamed.unwrap();
    if renamed.kept > 0 {
        assert!(vault.job(), "a kept note holds the job");
        std::thread::sleep(QUIET);
        vault.schemas().resume_field_rename(&|| false).unwrap();
    }
    assert!(!vault.job());
    for (id, path) in ids.iter().zip(["Ahmet.md", "Elif.md"]) {
        let text = vault.e.read(path);
        assert!(
            text.contains("Mobile:") && !text.contains("Phone:"),
            "{text}"
        );
        until("the record took the file", || {
            vault.record(id).get("Mobile").is_some() && vault.record(id).get("Phone").is_none()
        });
    }
    let edited = ["Ahmet.md", "Elif.md"]
        .into_iter()
        .find(|path| vault.e.read(path).contains("outside"))
        .expect("the outside edit was kept");
    assert!(vault.e.read(edited).contains(if edited == "Ahmet.md" {
        "CTO"
    } else {
        "new@x.io"
    }));

    // #3966: a later outside edit of another key leaves the renamed key as the file has it.
    let later = vault.e.read("Ahmet.md").replace("Role: ", "Role: Chief ");
    vault.e.write("Ahmet.md", &later);
    until("the record took the later edit", || {
        vault.record(&ids[0])["Role"]
            .as_str()
            .is_some_and(|r| r.starts_with("Chief"))
    });
    assert_eq!(vault.record(&ids[0])["Mobile"], json!("111"));
    assert!(vault.record(&ids[0]).get("Phone").is_none());
}

/// The end state the test reads: each file, the task's fields, the schema, the definitions.
fn end_state(vault: &Vault, task: &str) -> (Vec<String>, Value, Value, Vec<String>) {
    let files = ["Ahmet.md", "Elif.md", "Can.md", "journal/2026-01-01.md"]
        .map(|path| vault.e.read(path))
        .to_vec();
    let definitions = PropertyDefinitions::open(&vault.open(), vault.store.clone()).unwrap();
    let names = definitions.list().unwrap().into_iter().map(|d| d.name);
    (
        files,
        Value::Object(task_fields(vault, task)),
        schema_fields(vault),
        names.collect(),
    )
}

/// A quit before any step, note or task of the job: the resumed run comes to the end an
/// uninterrupted one comes to, and pushes each changed item once.
#[test]
fn a_rename_stopped_at_any_step_comes_to_the_same_end_when_resumed() {
    // Two steps before the notes, four notes, two tasks; the last never stops.
    const CHECKS: usize = 2 + 4 + 2;
    let mut reference = None;
    for stop_at in std::iter::once(CHECKS).chain(0..CHECKS) {
        let vault = opened(&[
            ("Ahmet.md", AHMET),
            ("Elif.md", ELIF),
            ("Can.md", CAN),
            ("journal/2026-01-01.md", DAY),
        ]);
        let task = task_with_phone(&vault, "444", None);
        let both = task_with_phone(&vault, "555", Some(("mobile", "999")));
        clear_outbox(&vault.e);
        let calls = AtomicUsize::new(0);
        let ran =
            vault
                .schemas()
                .rename_field_until(job("Phone", "Mobile"), &mut |_, _, _| {}, &|| {
                    calls.fetch_add(1, Ordering::SeqCst) == stop_at
                });
        if stop_at < CHECKS {
            assert!(
                matches!(ran, Err(SchemaError::Stopped)),
                "{stop_at}: {ran:?}"
            );
            assert!(vault.job(), "{stop_at}");
            let resumed = vault.schemas().resume_field_rename(&|| false).unwrap();
            assert_eq!(resumed.map(|r| r.kept), Some(0), "{stop_at}");
        } else {
            let ran = ran.unwrap();
            assert_eq!((ran.notes, ran.tasks, ran.skipped_existing), (3, 1, 2));
        }
        assert!(!vault.job(), "{stop_at}");
        let end = end_state(&vault, &task);
        let reference = reference.get_or_insert_with(|| end.clone());
        assert_eq!(&end, reference, "stopped at check {stop_at}");
        for path in ["Ahmet.md", "Elif.md", "journal/2026-01-01.md"] {
            assert_eq!(upserts(&vault.e, &vault.id(path)), 1, "{stop_at}: {path}");
        }
        assert_eq!(upserts(&vault.e, &task), 1, "{stop_at}");
        assert_eq!(
            upserts(&vault.e, &both),
            0,
            "{stop_at}: a task holding both is left"
        );
        assert_eq!(
            Value::Object(task_fields(&vault, &both)),
            json!({"Phone": "555", "mobile": "999"})
        );
        assert_eq!(upserts(&vault.e, "person"), 1, "{stop_at}");
    }
    let (files, task, schema, names) = reference.expect("ran");
    assert!(
        files[..2]
            .iter()
            .chain(&files[3..])
            .all(|t| t.contains("Mobile:") && !t.contains("Phone:"))
    );
    assert_eq!(files[2], CAN);
    assert_eq!(task, json!({"Mobile": "444"}));
    assert_eq!(schema, json!([{"name": "Mobile"}]));
    assert!(names.contains(&"Mobile".to_owned()) && !names.contains(&"Phone".to_owned()));
}

//! Folder views and a tag's table (#3547 30b) over a real session, tier, watcher and index task,
//! the oracle being Electron's `folder-view-handlers.ts`: a folder's rows, columns and saved views,
//! whose edits land in its `.folder.md`, and a tag's, whose views live on its definition.

#[allow(unused_imports)]
use crate::device_key;
#[allow(unused_imports)]
use crate::index_support;
#[allow(unused_imports)]
use crate::vault_env;

use std::sync::Arc;
use std::time::Duration;

use index_support::until;
use memry_core::seams::secure_store::SecureStore;
use memry_core::storage::repositories::sync_items::{self, InboundRecord};
use memry_desktop::error::CoreError;
use memry_desktop::folder_view::view::{ListInput, ViewScope};
use memry_desktop::folder_view::{self, FolderViewError};
use memry_desktop::notes::identity::NotesIdentity;
use memry_desktop::notes::index::NoteIndex;
use memry_desktop::notes::service::NotesService;
use memry_desktop::session::OpenVault;
use memry_desktop::tags::schema::Schemas;
use memry_desktop::tags::schema::view::{FieldType, NewFieldSpec, TagSchemaCommand};
use serde_json::{Value, json};
use vault_env::{Env, env, indexed};

struct Fixture {
    e: Env,
    store: Arc<dyn SecureStore>,
    _index: Arc<NoteIndex>,
}

fn opened(files: &[(&str, &str)]) -> Fixture {
    let mut kept: Option<Arc<dyn SecureStore>> = None;
    let mut e = env(|store| {
        kept = Some(store.clone());
        Some(NotesIdentity::new(store))
    });
    for (rel, text) in files {
        e.write(rel, text);
    }
    let index = NoteIndex::new(e.tier.clone(), |_| {}, |_| {}, |_| {});
    index.register(&e.session);
    e.open();
    e.facts_until(indexed);
    let f = Fixture {
        e,
        store: kept.expect("the store"),
        _index: index,
    };
    until("every file read", || index_support::all_indexed(&f.e));
    f
}

fn folder(path: &str) -> ViewScope {
    ViewScope::Folder {
        path: path.to_owned(),
    }
}

fn tag(name: &str, and_tags: &[&str]) -> ViewScope {
    ViewScope::Tag {
        tag: name.to_owned(),
        and_tags: (!and_tags.is_empty())
            .then(|| and_tags.iter().map(|t| (*t).to_owned()).collect()),
    }
}

impl Fixture {
    fn open(&self) -> OpenVault {
        self.e.session.current().expect("open")
    }

    fn schemas(&self) -> Schemas {
        let notes = NotesService::new(self.e.tier.clone(), self.store.clone());
        Schemas::open(&self.open(), &notes, "en").expect("schemas")
    }

    fn rows(&self, scope: ViewScope) -> Value {
        let resolved = self.schemas().resolved_tags().unwrap();
        let input = ListInput {
            scope,
            properties: None,
            limit: None,
            offset: None,
            rows: None,
        };
        serde_json::to_value(folder_view::list(&self.open(), &input, Some(&resolved)).unwrap())
            .unwrap()
    }

    fn views(&self, scope: &ViewScope) -> Value {
        let resolved = self.schemas().resolved_tags().unwrap();
        serde_json::to_value(folder_view::views(&self.open(), scope, Some(&resolved)).unwrap())
            .unwrap()
    }

    fn set_view(
        &self,
        scope: &ViewScope,
        view: Value,
        previous: Option<&str>,
    ) -> Result<(), FolderViewError> {
        folder_view::edit_views(&self.open(), scope, self.store.clone(), |views| {
            folder_view::with_view(views, view, previous)
        })
    }

    fn delete_view(&self, scope: &ViewScope, name: &str) {
        folder_view::edit_views(&self.open(), scope, self.store.clone(), |views| {
            Ok(folder_view::without_view(views, name))
        })
        .unwrap();
    }
}

fn titles(rows: &Value) -> Vec<String> {
    let mut titles: Vec<String> = rows["notes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|row| row["title"].as_str().unwrap().to_owned())
        .collect();
    titles.sort();
    titles
}

fn view_names(views: &Value) -> Vec<(String, bool)> {
    views["views"]
        .as_array()
        .map(|views| {
            views
                .iter()
                .map(|v| {
                    (
                        v["name"].as_str().unwrap().to_owned(),
                        v["default"] == json!(true),
                    )
                })
                .collect()
        })
        .unwrap_or_default()
}

/// A folder lists its notes at any depth and its own note beside it, never a folder that only
/// shares its prefix; its saved views, formulas and the edits to them live in its `.folder.md`.
#[test]
fn a_folder_lists_its_rows_and_keeps_its_views_in_its_folder_file() {
    let mut f = opened(&[
        ("Projects/Alpha.md", "---\nstatus: open\n---\nAlpha body\n"),
        (
            "Projects/2024/Beta.md",
            "---\nstatus: done\nowner: Ada\n---\n",
        ),
        ("Projects.md", "The folder's own page\n"),
        ("Projectsx/Gamma.md", "Not in the folder\n"),
    ]);
    let scope = folder("Projects");

    let rows = f.rows(scope.clone());
    assert_eq!(titles(&rows), ["Alpha", "Beta", "Projects"]);
    assert_eq!(rows["total"], json!(3));
    let beta = rows["notes"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["title"] == json!("Beta"))
        .unwrap();
    assert_eq!(beta["folder"], json!("/2024"));
    assert_eq!(beta["properties"]["owner"], json!("Ada"));
    assert!(beta["modified"].as_str().unwrap().ends_with('Z'));

    let columns = folder_view::available_properties(&f.open(), &scope, None).unwrap();
    let built_in: Vec<&str> = columns.built_in.iter().map(|c| c.id.as_str()).collect();
    assert_eq!(
        built_in,
        [
            "title",
            "folder",
            "tags",
            "created",
            "modified",
            "wordCount"
        ]
    );
    let used: Vec<(&str, u32)> = columns
        .properties
        .iter()
        .map(|p| (p.name.as_str(), p.usage_count))
        .collect();
    assert_eq!(used, [("status", 2), ("owner", 1)]);

    assert_eq!(f.views(&scope)["views"], Value::Null);
    f.set_view(
        &scope,
        json!({"name": "Board", "type": "table", "default": true}),
        None,
    )
    .unwrap();
    f.set_view(
        &scope,
        json!({"name": "Table", "type": "table", "default": true}),
        None,
    )
    .unwrap();
    assert_eq!(
        view_names(&f.views(&scope)),
        [("Board".to_owned(), false), ("Table".to_owned(), true)]
    );
    let clash = f
        .set_view(
            &scope,
            json!({"name": "Board", "type": "table"}),
            Some("Table"),
        )
        .unwrap_err();
    assert_eq!(clash.kind_and_code().1, "view_name_conflict");
    f.set_view(
        &scope,
        json!({"name": "Kanban", "type": "table"}),
        Some("Board"),
    )
    .unwrap();
    assert_eq!(f.views(&scope)["defaultIndex"], json!(1));
    f.delete_view(&scope, "Table");
    assert_eq!(view_names(&f.views(&scope)), [("Kanban".to_owned(), true)]);
    assert!(f.e.read("Projects/.folder.md").contains("Kanban"));

    let config = json!({"formulas": {"double": "prop(\"n\") * 2"}});
    folder_view::set_config(&f.open(), "Projects", config.as_object().unwrap()).unwrap();
    let wrong = json!({"views": "not a list"});
    assert!(folder_view::set_config(&f.open(), "Projects", wrong.as_object().unwrap()).is_err());
    let columns = folder_view::available_properties(&f.open(), &scope, None).unwrap();
    assert_eq!(columns.formulas.len(), 1);
    assert_eq!(columns.formulas[0].id, "double");
    assert_eq!(view_names(&f.views(&scope)), [("Kanban".to_owned(), true)]);

    assert!(folder_view::folder_exists(&f.open(), "Projects/2024"));
    assert!(folder_view::folder_exists(&f.open(), ""));
    assert!(!folder_view::folder_exists(&f.open(), "Nope"));
    assert!(!folder_view::folder_exists(&f.open(), "../outside"));
    f.e.close();
}

/// What a hand-written `.folder.md` holds survives an edit: an unquoted date in a view is read as
/// its ISO string and written back as the date (Electron's js-yaml round trip), a `null` in a
/// config removes its key, and the default view is counted among the views the renderer gets.
#[test]
fn a_folder_file_edit_keeps_what_the_file_holds() {
    let dated = "---\nviews:\n  - name: Mine\n    filters:\n      - property: due\n        value: 2024-01-15\n  - name: Other\nformulas:\n  double: x\n---\n";
    let odd = "---\nviews:\n  - just text\n  - name: A\n  - name: B\n    default: true\n---\n";
    let mut f = opened(&[
        ("Work/.folder.md", dated),
        ("Work/Note.md", "Body\n"),
        ("Odd/.folder.md", odd),
        (
            "Junk/.folder.md",
            "---\nviews:\n  - 1\n  - type: table\n---\n",
        ),
    ]);
    let scope = folder("Work");
    let date = "value: 2024-01-15T00:00:00.000Z\n";
    assert_eq!(
        f.views(&scope)["views"][0]["filters"][0]["value"],
        json!("2024-01-15T00:00:00.000Z")
    );

    f.set_view(&scope, json!({"name": "New"}), None).unwrap();
    let names = |f: &Fixture| -> Vec<String> {
        view_names(&f.views(&scope))
            .into_iter()
            .map(|(name, _)| name)
            .collect()
    };
    assert_eq!(names(&f), ["Mine", "Other", "New"]);
    assert!(f.e.read("Work/.folder.md").contains(date));
    f.delete_view(&scope, "Other");
    assert_eq!(names(&f), ["Mine", "New"]);
    assert!(f.e.read("Work/.folder.md").contains(date));

    // The renderer writes the config back as it read it; `undefined` reaches Rust as `null`.
    let config = json!({"views": f.views(&scope)["views"], "formulas": null});
    folder_view::set_config(&f.open(), "Work", config.as_object().unwrap()).unwrap();
    let written = f.e.read("Work/.folder.md");
    assert!(written.contains(date), "{written}");
    assert!(!written.contains("formulas"), "{written}");

    let odd = f.views(&folder("Odd"));
    assert_eq!(
        view_names(&odd),
        [("A".to_owned(), false), ("B".to_owned(), true)]
    );
    assert_eq!(odd["defaultIndex"], json!(1));
    assert_eq!(f.views(&folder("Junk"))["views"], Value::Null);
    f.e.close();
}

/// A list that lost an item is written as the renderer sent it: a date's ISO string kept as a
/// string stays quoted, never matched against the date that sat at its place before.
#[test]
fn a_list_that_lost_an_item_keeps_its_strings() {
    let dated = "---\nviews:\n  - name: Mine\n    dates:\n      - 2024-01-15\n      - '2024-01-15T00:00:00.000Z'\n---\n";
    let mut f = opened(&[("Work/.folder.md", dated)]);
    folder_view::edit_views(&f.open(), &folder("Work"), f.store.clone(), |mut views| {
        views[0]["dates"].as_array_mut().unwrap().remove(0);
        Ok(views)
    })
    .unwrap();
    let written = f.e.read("Work/.folder.md");
    assert!(
        written.contains("- '2024-01-15T00:00:00.000Z'"),
        "{written}"
    );
    f.e.close();
}

/// A write that would lose what the file holds is refused and leaves its bytes as they are: a
/// value JSON cannot hold (a NaN, bytes), a rename onto a taken name, a key of the wrong type.
#[test]
fn a_refused_folder_file_edit_leaves_the_file_as_it_is() {
    let lossy = "---\nviews:\n  - name: Mine\n    filters:\n      - value: .nan\n  - name: Other\nformulas:\n  big: !!binary aGk=\n---\n";
    let hand = "---\nviews:\n  - {name: A}\n  - {name: B}\n---\n";
    let mut f = opened(&[
        ("Lossy/.folder.md", lossy),
        ("Hand/.folder.md", hand),
        ("Hand/Note.md", "Body\n"),
    ]);
    let unreadable = |error: FolderViewError| {
        assert_eq!(error.kind_and_code().1, "folder_file_unreadable", "{error}");
    };
    let scope = folder("Lossy");
    unreadable(
        f.set_view(&scope, json!({"name": "New"}), None)
            .unwrap_err(),
    );
    unreadable(
        folder_view::edit_views(&f.open(), &scope, f.store.clone(), |views| {
            Ok(folder_view::without_view(views, "Other"))
        })
        .unwrap_err(),
    );
    let config = json!({"formulas": null});
    unreadable(
        folder_view::set_config(&f.open(), "Lossy", config.as_object().unwrap()).unwrap_err(),
    );
    assert_eq!(f.e.read("Lossy/.folder.md"), lossy);

    let scope = folder("Hand");
    let clash = f
        .set_view(&scope, json!({"name": "B"}), Some("A"))
        .unwrap_err();
    assert_eq!(clash.kind_and_code().1, "view_name_conflict");
    let wrong = json!({"views": "not a list"});
    assert!(folder_view::set_config(&f.open(), "Hand", wrong.as_object().unwrap()).is_err());
    assert_eq!(f.e.read("Hand/.folder.md"), hand);
    f.e.close();
}

/// A tag lists what carries it or a tag under it, narrowed by AND tags; a tag with fields
/// offers them as columns before a note holds them, and a tag's views live on its definition.
#[test]
fn a_tag_table_lists_its_items_and_keeps_its_views_on_its_definition() {
    let mut f = opened(&[
        ("Both.md", "---\ntags: [alpha, beta]\n---\n"),
        ("Only alpha.md", "---\ntags: [alpha]\n---\n"),
        ("Nested.md", "---\ntags: [alpha/design]\n---\n"),
        ("Other.md", "---\ntags: [beta]\n---\n"),
    ]);

    assert_eq!(
        titles(&f.rows(tag("alpha", &[]))),
        ["Both", "Nested", "Only alpha"]
    );
    assert_eq!(titles(&f.rows(tag("alpha", &["beta"]))), ["Both"]);
    let blank = folder_view::views(&f.open(), &tag("", &[]), None).unwrap_err();
    assert_eq!(blank.kind_and_code().1, "invalid");

    let scope = tag("alpha", &[]);
    let resolved = f.schemas().resolved_tags().unwrap();
    let columns = folder_view::available_properties(&f.open(), &scope, Some(&resolved)).unwrap();
    assert!(columns.built_in.iter().any(|c| c.id == "kind"));

    f.schemas()
        .run(
            TagSchemaCommand::AddField {
                tag: "alpha".to_owned(),
                field: NewFieldSpec {
                    name: "Stage".to_owned(),
                    type_name: FieldType::Text,
                    options: None,
                    relation: None,
                },
                index: None,
            },
            &mut |_, _, _| {},
        )
        .unwrap();
    let saved = f.views(&scope);
    assert_eq!(saved["views"], Value::Null);
    assert_eq!(saved["fieldColumns"], json!(["Stage"]));
    let resolved = f.schemas().resolved_tags().unwrap();
    let columns = folder_view::available_properties(&f.open(), &scope, Some(&resolved)).unwrap();
    let stage = columns
        .properties
        .iter()
        .find(|p| p.name == "Stage")
        .unwrap();
    assert_eq!(stage.usage_count, 0);

    f.set_view(
        &scope,
        json!({"name": "Mine", "type": "table", "default": true}),
        None,
    )
    .unwrap();
    assert_eq!(
        view_names(&f.views(&tag("Alpha", &[]))),
        [("Mine".to_owned(), true)]
    );
    f.delete_view(&scope, "Mine");
    assert_eq!(f.views(&scope)["views"], Value::Null);
    f.e.close();
}

/// A sync apply that reaches the tag's definition while an edit of its views runs waits for the
/// edit to commit, so the peer's views are never written over by views read before it landed.
#[test]
fn a_tag_view_edit_never_writes_over_a_sync_apply_it_raced() {
    let mut f = opened(&[("Note.md", "---\ntags: [alpha]\n---\n")]);
    let scope = tag("alpha", &[]);
    f.set_view(&scope, json!({"name": "Mine"}), None).unwrap();
    let db = f.open().vault.db_handle();
    let peer = std::cell::RefCell::new(None);
    folder_view::edit_views(&f.open(), &scope, f.store.clone(), |views| {
        let (done, applied) = std::sync::mpsc::channel();
        let db = db.clone();
        *peer.borrow_mut() = Some(std::thread::spawn(move || {
            let record = InboundRecord {
                item_type: "tag_definition".to_owned(),
                item_id: "alpha".to_owned(),
                payload_json: json!({
                    "name": "alpha", "color": "blue", "views": [{"name": "Remote"}],
                    "clock": {"peer": 9},
                })
                .to_string(),
                server_cursor: Some(1),
                signer_device_id: Some("peer".to_owned()),
                updated_at: 1_760_000_000_000,
                deleted_at: None,
            };
            db.call_blocking(move |data| {
                sync_items::apply_remote(data, &record, 1_760_000_000_000)
            })
            .unwrap();
            let _ = done.send(());
        }));
        // An edit that does not hold the write lock lets the apply land here; the fixed one
        // keeps it waiting, and this wait ends without it.
        let _ = applied.recv_timeout(Duration::from_secs(2));
        folder_view::with_view(views, json!({"name": "Second"}), None)
    })
    .unwrap();
    peer.into_inner().unwrap().join().unwrap();
    let names: Vec<String> = view_names(&f.views(&scope))
        .into_iter()
        .map(|(name, _)| name)
        .collect();
    assert_eq!(names, ["Remote"]);
    f.e.close();
}

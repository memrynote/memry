//! Who writes a note's `criticMarkupMarks` root (#4425). While an editor window holds the note,
//! the window writes its comment marks into the document as the user resolves, deletes or undoes
//! them, so its save (`notes:update`) of the same note must leave the root alone: a save that
//! lands after a later edit of the marks (it was serialized before it) would bring a resolved
//! comment back, and its write racing the window's own write of one mark would leave two. A
//! save of a note no window holds, and an outside edit of an open one, still set the marks from
//! the file's text.

use std::sync::Arc;

use memry_core::api::editor::Editor;
use memry_core::markdown::pm::model::{any_to_json, json_to_any};
use memry_core::markdown::shared::critic_markup::{CriticMarkupMark, serialize_critic_markup};
use memry_core::seams::secure_store::SecureStore;
use memry_desktop::notes::identity::NotesIdentity;
use memry_desktop::notes::service::NotesService;
use memry_desktop::notes::update::NoteUpdateInput;
use serde_json::{Value, json};
use yrs::updates::decoder::Decode;
use yrs::{Any, Array as _, Doc, ReadTxn as _, Transact as _, Update};

use crate::index_support::until;
use crate::vault_env::{Env, env, indexed};

const WINDOW: &str = "main";
const EDITOR: &str = "editor-1";
const MARKS: &str = "criticMarkupMarks";
const PLAIN: &str = "Alpha and beta.\n";

fn opened(files: &[(&str, &str)]) -> (Env, Arc<NotesService>, Arc<dyn SecureStore>) {
    let mut kept: Option<Arc<dyn SecureStore>> = None;
    let mut e = env(|store| {
        kept = Some(store.clone());
        Some(NotesIdentity::new(store))
    });
    for (rel, text) in files {
        e.write(rel, text);
    }
    e.open();
    e.facts_until(indexed);
    let store = kept.expect("the store");
    let notes = NotesService::new(e.tier.clone(), store.clone());
    (e, notes, store)
}

fn id_at(e: &Env, rel: &str) -> String {
    e.rows()
        .into_iter()
        .find_map(|(id, path)| (path == rel).then_some(id))
        .expect("a row")
}

/// A comment on `visible`, which starts at `start` of [`PLAIN`].
fn comment(id: &str, visible: &str, start: i64) -> Value {
    json!({
        "id": id,
        "kind": "comment",
        "visibleText": visible,
        "body": format!("about {visible}"),
        "start": start,
        "end": start + visible.len() as i64,
    })
}

fn c1() -> Value {
    comment("c1", "Alpha", 0)
}

fn c2() -> Value {
    comment("c2", "beta", 10)
}

/// [`PLAIN`] with `marks` written in as CriticMarkup, as the editor's save sends it.
fn text_with(marks: &[Value]) -> String {
    let marks: Vec<CriticMarkupMark> = marks
        .iter()
        .map(|mark| serde_json::from_value(mark.clone()).unwrap())
        .collect();
    serialize_critic_markup(PLAIN, &marks)
}

fn save(id: &str, content: &str) -> NoteUpdateInput {
    NoteUpdateInput {
        id: id.to_owned(),
        content: Some(content.to_owned()),
        editor: Some(EDITOR.to_owned()),
        ..NoteUpdateInput::default()
    }
}

/// The window's copy of the document as the host sent it.
fn window_copy(state: &[u8]) -> Doc {
    let doc = Doc::new();
    doc.transact_mut()
        .apply_update(Update::decode_v1(state).unwrap())
        .unwrap();
    doc
}

/// What the window authors writing `marks` over its copy (`writeCriticMarkupMarksToYDoc`:
/// the whole array deleted, then the marks pushed).
fn window_writes_marks(copy: &Doc, marks: &[Value]) -> Vec<u8> {
    let before = copy.transact().state_vector();
    let array = copy.get_or_insert_array(MARKS);
    {
        let mut txn = copy.transact_mut();
        let length = array.len(&txn);
        if length > 0 {
            array.remove_range(&mut txn, 0, length);
        }
        array.insert_range(
            &mut txn,
            0,
            marks.iter().map(json_to_any).collect::<Vec<Any>>(),
        );
    }
    copy.transact().encode_diff_v1(&before)
}

/// The marks the document holds, as stored.
fn marks_of(editor: &Editor, id: &str) -> Vec<Value> {
    let doc = window_copy(&editor.open(id, WINDOW).unwrap().state);
    let txn = doc.transact();
    let Some(array) = txn.get_array(MARKS) else {
        return Vec::new();
    };
    array
        .iter(&txn)
        .map(|item| match item {
            yrs::Out::Any(any) => any_to_json(&any).unwrap(),
            other => panic!("a mark that is not a plain value: {other:?}"),
        })
        .collect()
}

fn ids(marks: &[Value]) -> Vec<&str> {
    marks
        .iter()
        .filter_map(|mark| mark["id"].as_str())
        .collect()
}

/// The window resolves c1, and a save it serialized before that, still holding c1, lands after
/// the window's edit. The document keeps the window's marks (a field a newer build added to a
/// mark included), and the file follows the document once the write-back runs. An outside edit
/// of the open note still sets the marks from the file.
#[test]
fn a_late_editor_save_leaves_the_marks_of_an_open_note_to_its_window() {
    let both = text_with(&[c1(), c2()]);
    let (e, notes, store) = opened(&[("Plan.md", &both)]);
    let open = e.session.current().unwrap();
    let id = id_at(&e, "Plan.md");
    let editor = open.vault.editor(store).unwrap();
    let copy = window_copy(&editor.open(&id, WINDOW).unwrap().state);
    assert_eq!(ids(&marks_of(&editor, &id)), ["c1", "c2"]);

    let mut newer = c2();
    newer["addedByANewerBuild"] = json!(7);
    let resolve = window_writes_marks(&copy, std::slice::from_ref(&newer));
    editor.apply_update(&id, &resolve, WINDOW).unwrap();
    assert_eq!(marks_of(&editor, &id), [newer.clone()]);
    // The editor host schedules the write-back after a window's edit.
    e.tier.schedule(&id);
    let resolved = text_with(&[c2()]);
    until("the write-back wrote the resolve", || {
        e.read("Plan.md") == resolved
    });

    notes.update(&open, save(&id, &both)).unwrap();

    assert_eq!(
        marks_of(&editor, &id),
        [newer],
        "the late save rewrote the marks"
    );
    until("the file follows the document", || {
        e.read("Plan.md") == resolved
    });

    let outside = text_with(&[c1()]);
    e.write("Plan.md", &outside);
    until("the outside edit sets the marks", || {
        ids(&marks_of(&editor, &id)) == ["c1"]
    });
}

/// The window undoes a resolve, writing one mark into its copy, while its save holding the same
/// mark is fed. The document holds the mark once.
#[test]
fn an_editor_save_racing_the_window_write_of_a_mark_leaves_one_copy() {
    let (e, notes, store) = opened(&[("Plan.md", PLAIN)]);
    let open = e.session.current().unwrap();
    let id = id_at(&e, "Plan.md");
    let editor = open.vault.editor(store).unwrap();
    let copy = window_copy(&editor.open(&id, WINDOW).unwrap().state);
    assert_eq!(marks_of(&editor, &id), Vec::<Value>::new());

    let undo = window_writes_marks(&copy, &[c1()]);
    notes.update(&open, save(&id, &text_with(&[c1()]))).unwrap();
    editor.apply_update(&id, &undo, WINDOW).unwrap();

    assert_eq!(ids(&marks_of(&editor, &id)), ["c1"], "the mark doubled");
}

/// A save of a note no window holds sets the marks from its text.
#[test]
fn a_save_of_a_note_no_window_holds_sets_its_marks() {
    let (e, notes, store) = opened(&[("Plan.md", &text_with(&[c1(), c2()]))]);
    let open = e.session.current().unwrap();
    let id = id_at(&e, "Plan.md");

    notes.update(&open, save(&id, &text_with(&[c2()]))).unwrap();

    let editor = open.vault.editor(store).unwrap();
    assert_eq!(ids(&marks_of(&editor, &id)), ["c2"]);
}

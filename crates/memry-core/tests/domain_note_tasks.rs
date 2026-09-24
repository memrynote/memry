//! Note ↔ task (FR-058, spec 004 TP026) over real CRDT bodies in real SQLite.
//!
//! Every body is authored the way BlockNote authors one (a `blockGroup` under
//! the fragment, `blockContainer > block [blockGroup]`) and lands through the
//! server namespace of the update log, so the reads and writes here run over
//! the same document a pull would have written.
//!
//! | Test                                                | Desktop reference                     |
//! | --------------------------------------------------- | ------------------------------------- |
//! | task lines: both stored forms, nesting, drafts      | `normalizeTaskBlocks`, task-block.ts  |
//! | a completed task ticks its line, once               | task-block-renderer props sync        |
//! | a legacy suffix checkbox is ticked too              | `scanTaskCheckboxStates`              |
//! | a checkbox flip is detected before the edit         | `reconcileTaskCheckboxesFromMarkdown` |
//! | a delete removes only the task's own line           | remove-task-line-from-note.ts         |
//! | a checkbox becomes a taskBlock                      | `convertCheckboxToTask`               |
//! | a Tab-nested checkbox becomes a subtask, one level  | `analyzeTaskIntents` subtask arm      |
//! | Tab / Shift+Tab re-parent an existing task line     | demoted / unindented arms             |
//! | project chain: parent → token → note → settings →   | `resolveNoteTaskProjectId`            |
//! | inbox → first                                       |                                       |

use std::sync::atomic::{AtomicU64, Ordering};

use memry_core::crdt::blocks::Block;
use memry_core::crdt::body_edit::BlockEdit;
use memry_core::crdt::update_log;
use memry_core::domain::body_write;
use memry_core::domain::note_tasks::{
    self, NoteTaskProjectInput, TaskCheckboxFlip, TaskLineForm, TaskParentChange,
};
use memry_core::domain::notes::{self, NewNote};
use memry_core::domain::projects::{self, Project};
use memry_core::domain::reads;
use memry_core::storage::repositories::sync_items::{self, InboundRecord};
use memry_core::storage::{Db, open_data};
use memry_core::sync::outbox::OP_CRDT_UPDATE;
use rusqlite::{Connection, params};
use serde_json::{Value, json};
use yrs::{Any, Doc, ReadTxn as _, Transact as _, Xml as _, XmlElementPrelim, XmlElementRef};
use yrs::{XmlFragment as _, XmlTextPrelim};

const NOW: i64 = 1_760_000_000_000;
const DEVICE: &str = "device-a";
const NOTE: &str = "note-1";

static SCRATCH: AtomicU64 = AtomicU64::new(0);

fn open(label: &str) -> Db {
    let unique = SCRATCH.fetch_add(1, Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!(
        "memry-note-tasks-{label}-{}-{unique}",
        std::process::id()
    ));
    std::fs::create_dir_all(&dir).expect("the scratch directory");
    open_data(&dir.join("data.db")).expect("open data.db")
}

// MARK: - Bodies

/// One block of a fixture body, with its nested children.
struct Spec {
    id: &'static str,
    kind: &'static str,
    props: Vec<(&'static str, Any)>,
    text: &'static str,
    children: Vec<Spec>,
}

fn task(id: &'static str, task_id: &'static str, title: &'static str, checked: bool) -> Spec {
    Spec {
        id,
        kind: "taskBlock",
        props: vec![
            ("checked", Any::Bool(checked)),
            ("parentTaskId", Any::String("".into())),
            ("taskId", Any::String(task_id.into())),
            ("title", Any::String(title.into())),
        ],
        text: "",
        children: Vec::new(),
    }
}

fn subtask(id: &'static str, task_id: &'static str, parent: &'static str) -> Spec {
    let mut spec = task(id, task_id, task_id, false);
    spec.props[1] = ("parentTaskId", Any::String(parent.into()));
    spec
}

fn checkbox(id: &'static str, text: &'static str, checked: bool) -> Spec {
    Spec {
        id,
        kind: "checkListItem",
        props: vec![
            ("backgroundColor", Any::String("default".into())),
            ("checked", Any::Bool(checked)),
            ("textAlignment", Any::String("left".into())),
            ("textColor", Any::String("default".into())),
        ],
        text,
        children: Vec::new(),
    }
}

fn paragraph(id: &'static str, text: &'static str) -> Spec {
    Spec {
        id,
        kind: "paragraph",
        props: Vec::new(),
        text,
        children: Vec::new(),
    }
}

fn with(mut spec: Spec, children: Vec<Spec>) -> Spec {
    spec.children = children;
    spec
}

fn place(txn: &mut yrs::TransactionMut<'_>, group: &XmlElementRef, specs: &[Spec]) {
    for (index, spec) in specs.iter().enumerate() {
        let container = group.insert(txn, index as u32, XmlElementPrelim::empty("blockContainer"));
        container.insert_attribute(txn, "id", spec.id);
        let block = container.insert(txn, 0, XmlElementPrelim::empty(spec.kind));
        for (name, value) in &spec.props {
            block.insert_attribute(txn, *name, value.clone());
        }
        if !spec.text.is_empty() {
            block.insert(txn, 0, XmlTextPrelim::new(spec.text));
        }
        if !spec.children.is_empty() {
            let nested = container.insert(txn, 1, XmlElementPrelim::empty("blockGroup"));
            place(txn, &nested, &spec.children);
        }
    }
}

fn body(specs: &[Spec]) -> Vec<u8> {
    let doc = Doc::new();
    let fragment = doc.get_or_insert_xml_fragment("prosemirror");
    let mut txn = doc.transact_mut();
    let group = fragment.push_back(&mut txn, XmlElementPrelim::empty("blockGroup"));
    place(&mut txn, &group, specs);
    txn.encode_state_as_update_v1(&yrs::StateVector::default())
}

/// A live note whose body is `specs`, pulled rather than authored here.
fn seed_note(conn: &Connection, specs: &[Spec]) {
    notes::create(
        conn,
        &NewNote {
            id: NOTE,
            title: "Groceries",
            folder_path: None,
            content: "",
            tags: &[],
            properties: None,
        },
        DEVICE,
        NOW,
    )
    .expect("create the note");
    update_log::append_server_update(conn, NOTE, 1, &body(specs), NOW).expect("seed the body");
}

fn blocks(conn: &Connection) -> Vec<Block> {
    reads::note_blocks(conn, NOTE)
        .expect("read the body")
        .expect("the note is here")
}

fn block<'a>(blocks: &'a [Block], id: &str) -> &'a Block {
    blocks
        .iter()
        .find(|block| block.id.as_deref() == Some(id))
        .unwrap_or_else(|| panic!("no block {id}"))
}

fn prop(block: &Block, name: &str) -> Option<String> {
    block
        .props
        .iter()
        .find(|prop| prop.name == name)
        .map(|prop| prop.value.clone())
}

fn body_rows(conn: &Connection) -> i64 {
    conn.query_row(
        "SELECT count(*) FROM outbox WHERE item_id = ?1 AND op = ?2",
        params![NOTE, OP_CRDT_UPDATE],
        |row| row.get(0),
    )
    .expect("count the queue")
}

fn local_updates(conn: &Connection) -> usize {
    update_log::updates_after(conn, update_log::Namespace::Local, NOTE, 0)
        .expect("the local log")
        .len()
}

// MARK: - Reading

#[test]
fn task_lines_read_both_stored_forms_their_nesting_and_skip_drafts() {
    let db = open("read");
    db.call_blocking(|conn| {
        seed_note(
            conn,
            &[
                paragraph("p", "Shopping"),
                with(
                    task("b1", "t1", "Buy milk", false),
                    vec![subtask("b2", "t2", "t1")],
                ),
                checkbox("b3", "Legacy line {task:t3}", true),
                checkbox("b4", "plain", false),
                task("b5", "", "draft", false),
            ],
        );
        let lines = note_tasks::read_task_lines(conn, NOTE)
            .expect("the body op")
            .expect("the note is here");
        let summary: Vec<_> = lines
            .iter()
            .map(|line| {
                (
                    line.block_id.as_str(),
                    line.task_id.as_str(),
                    line.title.as_str(),
                    line.checked,
                    line.form,
                    line.parent_task_id.as_deref(),
                    line.stored_parent_task_id.as_deref(),
                    line.depth,
                )
            })
            .collect();
        assert_eq!(
            summary,
            vec![
                (
                    "b1",
                    "t1",
                    "Buy milk",
                    false,
                    TaskLineForm::TaskBlock,
                    None,
                    None,
                    0
                ),
                (
                    "b2",
                    "t2",
                    "t2",
                    false,
                    TaskLineForm::TaskBlock,
                    Some("t1"),
                    Some("t1"),
                    1
                ),
                (
                    "b3",
                    "t3",
                    "Legacy line",
                    true,
                    TaskLineForm::ChecklistSuffix,
                    None,
                    None,
                    0
                ),
            ]
        );
        assert_eq!(
            note_tasks::read_task_lines(conn, "no-such-note").expect("the body op"),
            None
        );
        Ok(())
    })
    .expect("read");
}

// MARK: - Ticking a line

#[test]
fn a_completed_task_ticks_its_line_in_one_update_and_a_repeat_writes_nothing() {
    let db = open("tick");
    db.call_blocking(|conn| {
        seed_note(
            conn,
            &[
                task("b1", "t1", "Buy milk", false),
                task("b2", "t2", "Eggs", false),
            ],
        );
        let before = body_rows(conn);

        let changed =
            note_tasks::set_task_checked(conn, NOTE, "t1", true, DEVICE, NOW).expect("tick");
        assert_eq!(changed, Some(1));
        let after = blocks(conn);
        assert_eq!(
            prop(block(&after, "b1"), "checked").as_deref(),
            Some("true")
        );
        assert_eq!(
            prop(block(&after, "b2"), "checked").as_deref(),
            Some("false")
        );
        assert_eq!(body_rows(conn), before + 1, "one outbox row");
        assert_eq!(local_updates(conn), 1, "one local update row");

        let again =
            note_tasks::set_task_checked(conn, NOTE, "t1", true, DEVICE, NOW).expect("tick again");
        assert_eq!(again, Some(0));
        assert_eq!(body_rows(conn), before + 1, "no clock for a no-op");

        note_tasks::set_task_checked(conn, NOTE, "t1", false, DEVICE, NOW).expect("reopen");
        assert_eq!(
            prop(block(&blocks(conn), "b1"), "checked").as_deref(),
            Some("false")
        );
        assert_eq!(
            note_tasks::set_task_checked(conn, "no-such-note", "t1", true, DEVICE, NOW)
                .expect("absent"),
            None
        );
        Ok(())
    })
    .expect("tick");
}

#[test]
fn a_legacy_suffix_checkbox_is_ticked_as_a_task_line() {
    let db = open("tick-legacy");
    db.call_blocking(|conn| {
        seed_note(conn, &[checkbox("b1", "Call mum {task:t9}", false)]);
        let changed =
            note_tasks::set_task_checked(conn, NOTE, "t9", true, DEVICE, NOW).expect("tick");
        assert_eq!(changed, Some(1));
        let after = blocks(conn);
        let line = block(&after, "b1");
        assert_eq!(line.kind, "checkListItem", "the stored form is kept");
        assert_eq!(prop(line, "checked").as_deref(), Some("true"));
        Ok(())
    })
    .expect("tick legacy");
}

// MARK: - A checkbox flipped in the note

#[test]
fn a_checkbox_flip_is_detected_before_the_edit_and_only_when_it_changes_state() {
    let db = open("flip");
    db.call_blocking(|conn| {
        seed_note(
            conn,
            &[
                task("b1", "t1", "Buy milk", false),
                task("b2", "t2", "Done already", true),
                checkbox("b3", "not a task", false),
            ],
        );
        let set = |block_id: &str, name: &str, value: &str| BlockEdit::SetProp {
            block_id: block_id.to_owned(),
            name: name.to_owned(),
            value: value.to_owned(),
        };

        let tick = set("b1", "checked", "true");
        assert_eq!(
            note_tasks::detect_checkbox_flip(conn, NOTE, &tick).expect("the body op"),
            Some(TaskCheckboxFlip {
                task_id: "t1".to_owned(),
                block_id: "b1".to_owned(),
                checked: true,
            })
        );
        assert_eq!(
            note_tasks::detect_checkbox_flip(conn, NOTE, &set("b2", "checked", "false"))
                .expect("the body op"),
            Some(TaskCheckboxFlip {
                task_id: "t2".to_owned(),
                block_id: "b2".to_owned(),
                checked: false,
            })
        );
        assert_eq!(
            note_tasks::detect_checkbox_flip(conn, NOTE, &set("b2", "checked", "true"))
                .expect("the body op"),
            None,
            "re-ticking a ticked line is no flip"
        );
        assert_eq!(
            note_tasks::detect_checkbox_flip(conn, NOTE, &set("b3", "checked", "true"))
                .expect("the body op"),
            None,
            "a plain checkbox has no task"
        );
        assert_eq!(
            note_tasks::detect_checkbox_flip(conn, NOTE, &set("b1", "title", "x"))
                .expect("the body op"),
            None
        );

        // After the edit lands, the same edit is no longer a flip.
        body_write::edit_block(conn, NOTE, &tick, DEVICE, NOW).expect("the body op");
        assert_eq!(
            note_tasks::detect_checkbox_flip(conn, NOTE, &tick).expect("the body op"),
            None
        );
        Ok(())
    })
    .expect("flip");
}

// MARK: - Removing a deleted task's line

#[test]
fn a_delete_removes_only_the_tasks_own_line_and_lifts_what_was_nested_under_it() {
    let db = open("remove");
    db.call_blocking(|conn| {
        seed_note(
            conn,
            &[
                paragraph("p0", "Before"),
                with(
                    task("b1", "t1", "Parent", false),
                    vec![
                        subtask("b2", "t2", "t1"),
                        paragraph("p1", "A note under it"),
                    ],
                ),
                paragraph("p2", "After"),
            ],
        );
        let before = body_rows(conn);

        let removal = note_tasks::remove_task_lines(conn, NOTE, "t1", DEVICE, NOW)
            .expect("remove")
            .expect("the note is here");
        assert_eq!(removal.removed, 1);
        assert_eq!(
            removal.reparented,
            vec![TaskParentChange {
                block_id: "b2".to_owned(),
                task_id: "t2".to_owned(),
                parent_task_id: None,
            }]
        );

        let after = blocks(conn);
        let layout: Vec<_> = after
            .iter()
            .map(|block| (block.id.as_deref().unwrap_or(""), block.depth))
            .collect();
        assert_eq!(layout, vec![("p0", 0), ("b2", 0), ("p1", 0), ("p2", 0)]);
        assert_eq!(
            prop(block(&after, "b2"), "parentTaskId").as_deref(),
            Some("")
        );
        assert_eq!(
            block(&after, "p1")
                .inline
                .first()
                .map(|run| run.text.as_str()),
            Some("A note under it")
        );
        assert_eq!(
            body_rows(conn),
            before + 1,
            "the whole removal is one update"
        );
        assert_eq!(local_updates(conn), 1);

        let again = note_tasks::remove_task_lines(conn, NOTE, "t1", DEVICE, NOW)
            .expect("remove again")
            .expect("the note is here");
        assert_eq!(again.removed, 0);
        assert_eq!(
            body_rows(conn),
            before + 1,
            "a repeat delete writes nothing"
        );
        Ok(())
    })
    .expect("remove");
}

#[test]
fn every_line_of_the_task_goes_including_the_legacy_form() {
    let db = open("remove-every");
    db.call_blocking(|conn| {
        seed_note(
            conn,
            &[
                task("b1", "t1", "Buy milk", false),
                paragraph("p", "keep"),
                checkbox("b2", "Buy milk {task:t1}", false),
                task("b3", "t2", "Other", false),
            ],
        );
        let removal = note_tasks::remove_task_lines(conn, NOTE, "t1", DEVICE, NOW)
            .expect("remove")
            .expect("the note is here");
        assert_eq!(removal.removed, 2);
        let ids: Vec<_> = blocks(conn)
            .into_iter()
            .filter_map(|block| block.id)
            .collect();
        assert_eq!(ids, vec!["p", "b3"]);
        Ok(())
    })
    .expect("remove every");
}

// MARK: - A checkbox becomes a task

#[test]
fn a_checkbox_becomes_a_task_block_the_way_desktops_editor_writes_one() {
    let db = open("convert");
    db.call_blocking(|conn| {
        seed_note(
            conn,
            &[paragraph("p", "x"), checkbox("c1", "  Buy bread  ", true)],
        );
        let candidates = note_tasks::read_conversion_candidates(conn, NOTE)
            .expect("the body op")
            .expect("here");
        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0].text, "Buy bread");
        assert!(candidates[0].checked, "a ticked checkbox is a done task");
        assert_eq!(candidates[0].parent_task_id, None);
        let before = body_rows(conn);

        let line = note_tasks::convert_checklist_to_task(conn, NOTE, "c1", "Vx3_k9", DEVICE, NOW)
            .expect("the body op")
            .expect("the note is here");
        assert_eq!(line.task_id, "Vx3_k9");
        assert_eq!(line.form, TaskLineForm::TaskBlock);
        assert!(line.checked);

        let after = blocks(conn);
        let converted = block(&after, "c1");
        assert_eq!(converted.kind, "taskBlock", "the container id survives");
        assert!(
            converted.inline.is_empty(),
            "a taskBlock holds no inline content"
        );
        assert_eq!(prop(converted, "taskId").as_deref(), Some("Vx3_k9"));
        assert_eq!(prop(converted, "title").as_deref(), Some("Buy bread"));
        assert_eq!(prop(converted, "checked").as_deref(), Some("true"));
        assert_eq!(prop(converted, "parentTaskId").as_deref(), Some(""));
        assert_eq!(
            body_rows(conn),
            before + 1,
            "one update for the whole conversion"
        );
        assert!(
            note_tasks::read_conversion_candidates(conn, NOTE)
                .expect("the body op")
                .expect("here")
                .is_empty()
        );
        Ok(())
    })
    .expect("convert");
}

#[test]
fn a_checkbox_tab_nested_under_a_task_becomes_its_subtask_one_level_deep() {
    let db = open("convert-subtask");
    db.call_blocking(|conn| {
        seed_note(
            conn,
            &[with(
                task("b1", "t1", "Trip", false),
                vec![
                    checkbox("c1", "Pack", false),
                    with(
                        subtask("b2", "t2", "t1"),
                        vec![checkbox("c2", "Too deep", false)],
                    ),
                ],
            )],
        );
        let body_blocks = blocks(conn);
        let nested = note_tasks::checklist_conversion(&body_blocks, "c1").expect("a candidate");
        assert_eq!(nested.parent_task_id.as_deref(), Some("t1"));
        let deeper = note_tasks::checklist_conversion(&body_blocks, "c2").expect("a candidate");
        assert_eq!(deeper.parent_task_id, None, "desktop's one-level limit");

        note_tasks::convert_checklist_to_task(conn, NOTE, "c1", "t3", DEVICE, NOW)
            .expect("the body op");
        let after = blocks(conn);
        assert_eq!(
            prop(block(&after, "c1"), "parentTaskId").as_deref(),
            Some("t1")
        );
        let line = note_tasks::read_task_lines(conn, NOTE)
            .expect("the body op")
            .expect("here")
            .into_iter()
            .find(|line| line.task_id == "t3")
            .expect("the new line");
        assert_eq!(line.parent_task_id.as_deref(), Some("t1"));
        Ok(())
    })
    .expect("convert subtask");
}

#[test]
fn what_desktop_would_not_convert_is_refused_and_writes_nothing() {
    let db = open("convert-refused");
    db.call_blocking(|conn| {
        seed_note(
            conn,
            &[
                checkbox("c1", "   ", false),
                checkbox("c2", "Persisted {task:t1}", false),
                paragraph("p", "not a checkbox"),
                checkbox("c3", "fine", false),
            ],
        );
        let before = body_rows(conn);
        for block_id in ["c1", "c2", "p", "missing"] {
            assert!(
                note_tasks::convert_checklist_to_task(conn, NOTE, block_id, "tx", DEVICE, NOW)
                    .is_err(),
                "{block_id} must be refused"
            );
        }
        for bad_id in ["", "a}b"] {
            assert!(
                note_tasks::convert_checklist_to_task(conn, NOTE, "c3", bad_id, DEVICE, NOW)
                    .is_err(),
                "task id {bad_id:?} must be refused"
            );
        }
        assert_eq!(body_rows(conn), before);
        assert_eq!(block(&blocks(conn), "c3").kind, "checkListItem");
        Ok(())
    })
    .expect("refused");
}

// MARK: - Tab / Shift+Tab on an existing task line

#[test]
fn tab_and_shift_tab_rewire_a_task_lines_parent() {
    let db = open("rewire");
    db.call_blocking(|conn| {
        seed_note(
            conn,
            &[
                task("b1", "t1", "Parent", false),
                task("b2", "t2", "Child", false),
            ],
        );
        assert_eq!(
            note_tasks::rewire_task_parents(conn, NOTE, DEVICE, NOW).expect("the body op"),
            Some(Vec::new())
        );

        let indent = BlockEdit::Indent {
            block_id: "b2".to_owned(),
        };
        body_write::edit_block(conn, NOTE, &indent, DEVICE, NOW).expect("the body op");
        let demoted = note_tasks::rewire_task_parents(conn, NOTE, DEVICE, NOW)
            .expect("the body op")
            .expect("here");
        assert_eq!(
            demoted,
            vec![TaskParentChange {
                block_id: "b2".to_owned(),
                task_id: "t2".to_owned(),
                parent_task_id: Some("t1".to_owned()),
            }]
        );
        assert_eq!(
            prop(block(&blocks(conn), "b2"), "parentTaskId").as_deref(),
            Some("t1")
        );
        assert_eq!(
            note_tasks::rewire_task_parents(conn, NOTE, DEVICE, NOW).expect("the body op"),
            Some(Vec::new())
        );

        let outdent = BlockEdit::Outdent {
            block_id: "b2".to_owned(),
        };
        body_write::edit_block(conn, NOTE, &outdent, DEVICE, NOW).expect("the body op");
        let promoted = note_tasks::rewire_task_parents(conn, NOTE, DEVICE, NOW)
            .expect("the body op")
            .expect("here");
        assert_eq!(promoted[0].parent_task_id, None);
        assert_eq!(
            prop(block(&blocks(conn), "b2"), "parentTaskId").as_deref(),
            Some("")
        );
        Ok(())
    })
    .expect("rewire");
}

// MARK: - Default project

fn project(id: &str, is_inbox: bool, archived: bool) -> Project {
    Project {
        id: id.to_owned(),
        name: id.to_owned(),
        description: None,
        color: "#888".to_owned(),
        icon: None,
        position: 0,
        is_inbox,
        archived_at: archived.then(|| "2026-01-01T00:00:00.000Z".to_owned()),
        home_note_id: None,
    }
}

#[test]
fn the_project_chain_is_parent_token_note_settings_inbox_first() {
    let projects = vec![
        project("first", false, false),
        project("archived", false, true),
        project("inbox", true, false),
        project("work", false, false),
    ];
    let notes_projects = vec!["archived".to_owned(), "work".to_owned()];
    let full = NoteTaskProjectInput {
        parent_task_project_id: Some("archived"),
        quick_add_project_id: Some("first"),
        note_project_ids: &notes_projects,
        settings_default_project_id: Some("first"),
        projects: &projects,
    };
    let resolve = |input: NoteTaskProjectInput<'_>| note_tasks::resolve_note_task_project(&input);

    assert_eq!(
        resolve(full).as_deref(),
        Some("archived"),
        "a parent wins, archived or not"
    );
    let no_parent = NoteTaskProjectInput {
        parent_task_project_id: Some(""),
        ..full
    };
    assert_eq!(
        resolve(no_parent).as_deref(),
        Some("first"),
        "then the +token"
    );
    let no_token = NoteTaskProjectInput {
        quick_add_project_id: None,
        ..no_parent
    };
    assert_eq!(
        resolve(no_token).as_deref(),
        Some("work"),
        "then the note's first live project"
    );
    let no_note = NoteTaskProjectInput {
        note_project_ids: &[],
        ..no_token
    };
    assert_eq!(
        resolve(no_note).as_deref(),
        Some("first"),
        "then the settings default"
    );
    let archived_default = NoteTaskProjectInput {
        settings_default_project_id: Some("archived"),
        ..no_note
    };
    assert_eq!(
        resolve(archived_default).as_deref(),
        Some("inbox"),
        "then the inbox"
    );
    let no_inbox_projects = vec![
        project("archived", false, true),
        project("work", false, false),
    ];
    let no_inbox = NoteTaskProjectInput {
        settings_default_project_id: None,
        projects: &no_inbox_projects,
        ..no_note
    };
    assert_eq!(
        resolve(no_inbox).as_deref(),
        Some("archived"),
        "then the first project"
    );
    let nothing = NoteTaskProjectInput {
        projects: &[],
        ..no_inbox
    };
    assert_eq!(resolve(nothing), None, "no project at all: do not create");
}

fn apply_remote(conn: &Connection, item_type: &str, item_id: &str, payload: Value) {
    let outcome = sync_items::apply_remote(
        conn,
        &InboundRecord {
            item_type: item_type.to_owned(),
            item_id: item_id.to_owned(),
            payload_json: serde_json::to_string(&payload).expect("serialise"),
            server_cursor: None,
            signer_device_id: None,
            updated_at: NOW,
            deleted_at: None,
        },
        NOW,
    )
    .expect("apply");
    assert_eq!(outcome, sync_items::ApplyOutcome::Applied, "{item_id}");
}

fn linked_project(conn: &Connection, id: &str, link_created_at: &str) {
    apply_remote(
        conn,
        "project",
        id,
        json!({
            "name": id,
            "color": "#0ea5e9",
            "statuses": [],
            "links": [
                {"id": format!("link-{id}"), "projectId": id, "itemType": "note",
                 "itemId": NOTE, "position": 0, "createdAt": link_created_at},
                {"id": format!("other-{id}"), "projectId": id, "itemType": "note",
                 "itemId": "another-note", "position": 1, "createdAt": link_created_at}
            ],
            "clock": {"device-b": 1}
        }),
    );
}

#[test]
fn a_notes_projects_are_read_oldest_link_first_and_feed_the_chain() {
    let db = open("note-projects");
    db.call_blocking(|conn| {
        linked_project(conn, "later", "2026-03-01T00:00:00.000Z");
        linked_project(conn, "earlier", "2026-01-01T00:00:00.000Z");
        let ids = note_tasks::note_project_ids(conn, NOTE)?;
        assert_eq!(ids, vec!["earlier", "later"]);

        let all = projects::list(conn, true)?;
        let resolved = note_tasks::resolve_note_task_project(&NoteTaskProjectInput {
            parent_task_project_id: None,
            quick_add_project_id: None,
            note_project_ids: &ids,
            settings_default_project_id: None,
            projects: &all,
        });
        assert_eq!(resolved.as_deref(), Some("earlier"));
        Ok(())
    })
    .expect("note projects");
}

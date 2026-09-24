//! Body writes for task lines: tick, remove, convert, re-parent.
//!
//! **One operation, one update, one outbox row.** Removing a line with
//! subtasks under it is several block edits — lift each child, delete the
//! line, fix the lifted children's `parentTaskId` — and a note that received
//! only the first half would show a task twice. So every edit of one operation
//! is applied to the same document, the updates it authored are merged into
//! one v1 update (`yrs::merge_updates_v1`), and that update commits with its
//! outbox row through [`outbox::commit`], exactly as
//! [`crate::domain::body_write::edit_block`] commits a single edit.
//!
//! **Plans read the document they write.** Each operation reads its blocks
//! from the document it is about to edit, not from an earlier read, so a line
//! that moved since the shell last looked is still found by its id.

use std::sync::{Arc, Mutex, PoisonError};

use rusqlite::Connection;

use crate::crdt::blocks::extract_blocks;
use crate::crdt::body_edit::{self, BlockEdit};
use crate::crdt::errors::CrdtError;
use crate::crdt::registry::{Document, UpdateSink};
use crate::crdt::{DocumentRegistry, update_log};
use crate::domain::notes::ITEM_TYPE;
use crate::domain::reads;
use crate::sync::outbox;

use super::{
    NoteTaskLine, SUFFIX_OPEN, TASK_BLOCK, TaskLineForm, TaskParentChange, checklist_conversion,
    task_lines, task_parent_changes,
};

/// What [`remove_task_lines`] did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskLineRemoval {
    /// Lines removed: every line carrying the id, as desktop removes every one.
    pub removed: u32,
    /// Subtask lines that were lifted out from under a removed line and whose
    /// `parentTaskId` prop was rewritten to where they now sit. The caller
    /// mirrors these onto the task rows when it keeps the subtasks.
    pub reparented: Vec<TaskParentChange>,
}

/// Ticks or unticks every line of `task_id` in one note, for a task completed
/// or reopened somewhere other than the note.
///
/// - Returns: `None` when this vault holds no live note by that id, otherwise
///   the number of lines changed. A line already in that state is left alone,
///   so re-completing a completed task writes nothing and queues nothing.
pub fn set_task_checked(
    conn: &Connection,
    note_id: &str,
    task_id: &str,
    checked: bool,
    device_id: &str,
    now_ms: i64,
) -> Result<Option<u32>, CrdtError> {
    write_body(conn, note_id, device_id, now_ms, |document| {
        let blocks = extract_blocks(document)?;
        let mut changed = 0;
        for line in task_lines(&blocks) {
            if line.task_id != task_id || line.checked == checked {
                continue;
            }
            body_edit::apply(
                document,
                &BlockEdit::SetProp {
                    block_id: line.block_id,
                    name: "checked".to_owned(),
                    value: checked.to_string(),
                },
            )?;
            changed += 1;
        }
        Ok(changed)
    })
}

/// Removes every line of `task_id` from one note, and **only** those lines
/// (`remove-task-line-from-note.ts`).
///
/// Whatever was nested under a removed line — a subtask line, a paragraph — is
/// lifted one level to the removed line's place rather than deleted with it:
/// desktop's rule is that losing content the delete never asked about is far
/// worse than a bullet one level shallower. A lifted `taskBlock` gets the
/// `parentTaskId` its new position implies, and is reported.
///
/// - Returns: `None` when the note is not here; `removed == 0` when it holds
///   no such line, in which case nothing is written.
pub fn remove_task_lines(
    conn: &Connection,
    note_id: &str,
    task_id: &str,
    device_id: &str,
    now_ms: i64,
) -> Result<Option<TaskLineRemoval>, CrdtError> {
    write_body(conn, note_id, device_id, now_ms, |document| {
        let mut removed = 0u32;
        let mut lifted: Vec<String> = Vec::new();
        loop {
            // Re-read after every removal: a lift rebuilds the children it
            // moves, and the next line of the same task may be one of them.
            let blocks = extract_blocks(document)?;
            let Some(line) = task_lines(&blocks)
                .into_iter()
                .find(|line| line.task_id == task_id)
            else {
                break;
            };
            for child in direct_children(&blocks, &line.block_id).into_iter().rev() {
                // Last child first: each outdent lands right after the line,
                // so lifting in reverse keeps the children in their order.
                body_edit::apply(
                    document,
                    &BlockEdit::Outdent {
                        block_id: child.clone(),
                    },
                )?;
                lifted.push(child);
            }
            body_edit::apply(
                document,
                &BlockEdit::Delete {
                    block_id: line.block_id,
                },
            )?;
            removed += 1;
        }

        let blocks = extract_blocks(document)?;
        let mut reparented = Vec::new();
        for line in task_lines(&blocks) {
            if line.form != TaskLineForm::TaskBlock
                || !lifted.contains(&line.block_id)
                || line.stored_parent_task_id == line.parent_task_id
            {
                continue;
            }
            write_parent(document, &line.block_id, line.parent_task_id.as_deref())?;
            reparented.push(TaskParentChange {
                block_id: line.block_id,
                task_id: line.task_id,
                parent_task_id: line.parent_task_id,
            });
        }
        Ok(TaskLineRemoval {
            removed,
            reparented,
        })
    })
}

/// Turns one checkbox into the line of an already-created task, the way
/// desktop's editor does once `tasks:create` returned
/// (`convertCheckboxToTask` / `convertCheckboxToSubtask`).
///
/// The block becomes a `taskBlock` carrying `taskId`, the trimmed checkbox
/// text as `title`, the checkbox's `checked`, and — when it sits under a
/// top-level task line — that task as `parentTaskId`. The container and its
/// id survive, and so does anything nested under it.
///
/// The caller creates the task first, from [`super::checklist_conversion`]'s
/// answer read off the same body: its text, its parent, and whether it is
/// already done.
///
/// - Returns: `None` when the note is not here, else the line as written.
/// - Throws: a refusal when the block is not a convertible checkbox, or when
///   `task_id` is empty or would break the `{task:<id>}` suffix it serialises
///   to on desktop.
pub fn convert_checklist_to_task(
    conn: &Connection,
    note_id: &str,
    block_id: &str,
    task_id: &str,
    device_id: &str,
    now_ms: i64,
) -> Result<Option<NoteTaskLine>, CrdtError> {
    if task_id.is_empty() || task_id.contains('}') || task_id.contains(SUFFIX_OPEN) {
        return Err(refused(
            block_id,
            "a task line needs a task id its suffix can carry",
        ));
    }
    write_body(conn, note_id, device_id, now_ms, |document| {
        let blocks = extract_blocks(document)?;
        let conversion = checklist_conversion(&blocks, block_id)
            .ok_or_else(|| refused(block_id, "this block is not a checkbox desktop converts"))?;

        body_edit::apply(
            document,
            &BlockEdit::TurnInto {
                block_id: block_id.to_owned(),
                kind: TASK_BLOCK.to_owned(),
            },
        )?;
        let mut props = vec![
            ("taskId", task_id.to_owned()),
            ("title", conversion.text.clone()),
        ];
        if conversion.checked {
            props.push(("checked", "true".to_owned()));
        }
        if let Some(parent) = &conversion.parent_task_id {
            props.push(("parentTaskId", parent.clone()));
        }
        for (name, value) in props {
            body_edit::apply(
                document,
                &BlockEdit::SetProp {
                    block_id: block_id.to_owned(),
                    name: name.to_owned(),
                    value,
                },
            )?;
        }

        let blocks = extract_blocks(document)?;
        task_lines(&blocks)
            .into_iter()
            .find(|line| line.block_id == block_id)
            .ok_or_else(|| refused(block_id, "the converted line did not read back"))
    })
}

/// Rewrites `parentTaskId` on every task line whose place in the note no
/// longer matches it — after a Tab or Shift+Tab — and reports the changes so
/// the caller moves the task rows to match (desktop's demoted and unindented
/// arms of `applyTaskIntents`).
///
/// - Returns: `None` when the note is not here; an empty list writes nothing.
pub fn rewire_task_parents(
    conn: &Connection,
    note_id: &str,
    device_id: &str,
    now_ms: i64,
) -> Result<Option<Vec<TaskParentChange>>, CrdtError> {
    write_body(conn, note_id, device_id, now_ms, |document| {
        let changes = task_parent_changes(&extract_blocks(document)?);
        for change in &changes {
            write_parent(document, &change.block_id, change.parent_task_id.as_deref())?;
        }
        Ok(changes)
    })
}

fn write_parent(
    document: &Document,
    block_id: &str,
    parent: Option<&str>,
) -> Result<(), CrdtError> {
    body_edit::apply(
        document,
        &BlockEdit::SetProp {
            block_id: block_id.to_owned(),
            name: "parentTaskId".to_owned(),
            // Desktop clears the prop to `''`, the schema default, not away.
            value: parent.unwrap_or_default().to_owned(),
        },
    )
}

/// The ids of the blocks nested directly under `block_id`.
fn direct_children(blocks: &[crate::crdt::blocks::Block], block_id: &str) -> Vec<String> {
    let Some(start) = blocks
        .iter()
        .position(|block| block.id.as_deref() == Some(block_id))
    else {
        return Vec::new();
    };
    let Some(depth) = blocks.get(start).map(|block| block.depth) else {
        return Vec::new();
    };
    blocks
        .iter()
        .skip(start + 1)
        .take_while(|block| block.depth > depth)
        .filter(|block| block.depth == depth + 1)
        .filter_map(|block| block.id.clone())
        .collect()
}

fn refused(block_id: &str, what: &str) -> CrdtError {
    CrdtError::Undecodable {
        doc_id: block_id.to_owned(),
        what: what.to_owned(),
    }
}

/// Loads a note's body, runs `plan` against it, and commits what it authored.
///
/// `None` when this vault holds no live note by that id — the same answer
/// [`crate::domain::body_write::edit_block`] gives. A plan that authored
/// nothing commits nothing: an edit that changed nothing must not ship a clock.
fn write_body<R, P>(
    conn: &Connection,
    note_id: &str,
    device_id: &str,
    now_ms: i64,
    plan: P,
) -> Result<Option<R>, CrdtError>
where
    P: FnOnce(&Document) -> Result<R, CrdtError>,
{
    if !reads::note_exists(conn, note_id) {
        return Ok(None);
    }

    let authored: Arc<Mutex<Vec<Vec<u8>>>> = Arc::new(Mutex::new(Vec::new()));
    let sink: UpdateSink = {
        let authored = Arc::clone(&authored);
        Arc::new(move |_, bytes: &[u8]| {
            authored
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .push(bytes.to_vec());
        })
    };
    let document = DocumentRegistry::new(device_id, sink).get_or_open(note_id)?;
    for blob in update_log::load_plan(conn, note_id)?.blobs() {
        // Durable, so the replay does not reach the sink.
        document.apply_durable_update(blob)?;
    }

    let result = plan(&document)?;

    let updates = std::mem::take(&mut *authored.lock().unwrap_or_else(PoisonError::into_inner));
    let update = match updates.len() {
        0 => return Ok(Some(result)),
        1 => updates.into_iter().next().unwrap_or_default(),
        _ => yrs::merge_updates_v1(&updates).map_err(|error| CrdtError::Undecodable {
            doc_id: note_id.to_owned(),
            what: error.to_string(),
        })?,
    };

    let change = outbox::Change::crdt_update(ITEM_TYPE, note_id, update.clone());
    outbox::commit(conn, &change, now_ms, |tx| {
        update_log::append_local_update_in(tx, note_id, &update, now_ms).map_err(|error| {
            crate::api::errors::StorageError::Failed {
                what: error.to_string(),
            }
        })
    })?;
    Ok(Some(result))
}

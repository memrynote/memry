//! Note ↔ task (FR-058): the task lines inside a note body.
//!
//! **What a task line is in the document.** Desktop's editor stores a task as
//! a `taskBlock` (`packages/editor-schema/src/blocks/configs.ts`,
//! `content: 'none'`) whose props carry `taskId`, `title`, `checked` and
//! `parentTaskId`. Its markdown is `- [ ] Title {task:<id>}`
//! (`packages/shared/src/task-block.ts`, `serializeTaskBlock`), and a
//! `checkListItem` whose text ends in that suffix is the same task before
//! `normalizeTaskBlocks` upgraded it. Both are read as task lines here; a
//! write that *creates* one writes the `taskBlock`, which is what desktop's
//! editor writes (`ContentArea.tsx`, `convertCheckboxToTask`).
//!
//! **Two halves.** The analysis over a block list is pure
//! ([`task_lines`], [`checkbox_flip`], [`checklist_conversion`],
//! [`task_parent_changes`]) so it is exercised without a database; the body
//! writes in [`write`] load the document, plan against that same read, and
//! commit every block edit of one operation as one update with one outbox row.
//!
//! **What stays with the caller.** Creating, completing and re-parenting the
//! task *row* is [`crate::domain::tasks`]' job; these functions report what
//! the body says (a flipped checkbox, a line nested under a task) and write
//! what the row says (a completed task's tick, a created task's id), so the
//! API layer composes the two without either module reaching into the other.

use rusqlite::Connection;

use crate::crdt::blocks::Block;
use crate::crdt::body_edit::BlockEdit;
use crate::crdt::errors::CrdtError;
use crate::domain::reads;

mod project;
mod write;

pub use project::{NoteTaskProjectInput, note_project_ids, resolve_note_task_project};
pub use write::{
    TaskLineRemoval, convert_checklist_to_task, remove_task_lines, rewire_task_parents,
    set_task_checked,
};

/// The block type desktop's editor stores a task as.
pub const TASK_BLOCK: &str = "taskBlock";
/// The block type a plain checkbox is.
pub const CHECK_LIST_ITEM: &str = "checkListItem";

/// `TASK_BLOCK_SUFFIX_OPEN` in `packages/shared/src/task-block.ts`.
const SUFFIX_OPEN: &str = "{task:";

/// Inline node tags, whose runs are not the block's typed text.
///
/// BlockNote builds each of these with `content: 'none'`, so desktop's
/// `checkboxLineText` / `extractInlineText` read no text from them. The same
/// six names [`crate::crdt::blocks`] treats as inline nodes.
const INLINE_NODES: [&str; 6] = [
    "wikiLink",
    "hashTag",
    "dateMention",
    "linkMention",
    "inlineImage",
    "inlineCheckbox",
];

/// Which of the two stored shapes a task line has.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TaskLineForm {
    /// A `taskBlock`: the title and the parent are props.
    TaskBlock,
    /// A `checkListItem` whose text ends in `{task:<id>}`, not yet upgraded by
    /// desktop's `normalizeTaskBlocks`. It has no `parentTaskId` prop.
    ChecklistSuffix,
}

/// One task line in a note body.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NoteTaskLine {
    /// The `blockContainer` id an edit addresses.
    pub block_id: String,
    pub task_id: String,
    /// The `title` prop, or the checkbox text in front of the suffix.
    pub title: String,
    pub checked: bool,
    pub form: TaskLineForm,
    /// The task whose line **directly** contains this one in the document, the
    /// rule `normalizeTaskBlocks` derives `parentTaskId` by.
    pub parent_task_id: Option<String>,
    /// The `parentTaskId` prop as stored (`""` reads as `None`). Always `None`
    /// for [`TaskLineForm::ChecklistSuffix`], which has no such prop.
    pub stored_parent_task_id: Option<String>,
    /// Nesting depth, 0 at the top of the body.
    pub depth: u32,
}

/// A task line's checkbox changing state under one block edit.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskCheckboxFlip {
    pub task_id: String,
    pub block_id: String,
    /// The state the edit leaves the checkbox in: `true` completes the task,
    /// `false` reopens it.
    pub checked: bool,
}

/// A plain checkbox desktop's editor would turn into a task.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChecklistConversion {
    pub block_id: String,
    /// The checkbox text, trimmed: what the task is created from and what the
    /// `taskBlock` keeps as its `title`.
    pub text: String,
    /// A ticked checkbox becomes a task that is already done.
    pub checked: bool,
    /// Set when the checkbox is nested (Tab) directly under a top-level task
    /// line: the new task is a subtask of that one.
    pub parent_task_id: Option<String>,
}

/// A task line whose `parentTaskId` no longer matches where it sits.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskParentChange {
    pub block_id: String,
    pub task_id: String,
    /// The parent the task row should now have; `None` promotes it.
    pub parent_task_id: Option<String>,
}

/// Every task line in `blocks`, in document order.
pub fn task_lines(blocks: &[Block]) -> Vec<NoteTaskLine> {
    let tree = Tree::of(blocks);
    (0..blocks.len())
        .filter_map(|index| tree.line(index))
        .collect()
}

/// The task line a block edit flips, and the state it flips it to.
///
/// Only a `checked` prop write changes a checkbox, and only one that differs
/// from the stored state is a flip: re-ticking a ticked line completes
/// nothing. `blocks` is the body **before** the edit.
pub fn checkbox_flip(blocks: &[Block], edit: &BlockEdit) -> Option<TaskCheckboxFlip> {
    let BlockEdit::SetProp {
        block_id,
        name,
        value,
    } = edit
    else {
        return None;
    };
    if name != "checked" {
        return None;
    }
    // The same coercion `body_edit` stores a boolean prop with.
    let checked = value == "true";
    let line = task_lines(blocks)
        .into_iter()
        .find(|line| &line.block_id == block_id)?;
    (line.checked != checked).then_some(TaskCheckboxFlip {
        task_id: line.task_id,
        block_id: line.block_id,
        checked,
    })
}

/// The conversion for one block, when it is a checkbox desktop would convert.
///
/// `None` for anything else: not a `checkListItem`, a checkbox already carrying
/// a `{task:<id>}` suffix (a persisted task — converting it would mint a
/// duplicate), or one with nothing typed on it yet (desktop #2271).
pub fn checklist_conversion(blocks: &[Block], block_id: &str) -> Option<ChecklistConversion> {
    conversion_candidates(blocks)
        .into_iter()
        .find(|candidate| candidate.block_id == block_id)
}

/// Every checkbox desktop's editor would convert, in document order.
///
/// Desktop converts them as the user types (`analyzeTaskIntents`); a shell
/// that wants the same behaviour converts each of these.
pub fn conversion_candidates(blocks: &[Block]) -> Vec<ChecklistConversion> {
    let tree = Tree::of(blocks);
    let mut candidates = Vec::new();
    for (index, block) in blocks.iter().enumerate() {
        if block.kind != CHECK_LIST_ITEM {
            continue;
        }
        let Some(block_id) = block.id.clone() else {
            continue;
        };
        let text = typed_text(block);
        // Wider than desktop's `hasTaskSuffix`, deliberately: without the
        // Obsidian field parser a suffix followed by plugin fields cannot be
        // told from one followed by prose, and converting a line that already
        // names a task mints a duplicate of it.
        if mentions_task_suffix(&text) {
            continue;
        }
        let text = text.trim();
        if text.is_empty() {
            continue;
        }
        candidates.push(ChecklistConversion {
            block_id,
            text: text.to_owned(),
            checked: prop(block, "checked").as_deref() == Some("true"),
            parent_task_id: tree.subtask_parent(index),
        });
    }
    candidates
}

/// The `taskBlock`s whose stored `parentTaskId` disagrees with their place.
///
/// Desktop's `analyzeTaskIntents`, both arms:
///
/// - **demoted** (Tab): a task line directly under a top-level task line whose
///   `parentTaskId` is not that task — becomes its subtask;
/// - **unindented** (Shift+Tab): a top-level task line that still carries a
///   `parentTaskId` — is promoted.
///
/// Only one level of subtasks exists; a task line under a subtask is left
/// alone, as desktop leaves it.
pub fn task_parent_changes(blocks: &[Block]) -> Vec<TaskParentChange> {
    let tree = Tree::of(blocks);
    let mut changes = Vec::new();
    for index in 0..blocks.len() {
        let Some(line) = tree.line(index) else {
            continue;
        };
        if line.form != TaskLineForm::TaskBlock {
            continue;
        }
        let wanted = if tree.parent(index).is_none() {
            None
        } else if let Some(parent) = tree.subtask_parent(index) {
            Some(parent)
        } else {
            continue;
        };
        if line.stored_parent_task_id != wanted {
            changes.push(TaskParentChange {
                block_id: line.block_id,
                task_id: line.task_id,
                parent_task_id: wanted,
            });
        }
    }
    changes
}

/// Every task line in one note, or `None` when this vault holds no live note
/// by that id.
pub fn read_task_lines(
    conn: &Connection,
    note_id: &str,
) -> Result<Option<Vec<NoteTaskLine>>, CrdtError> {
    Ok(reads::note_blocks(conn, note_id)?.map(|blocks| task_lines(&blocks)))
}

/// [`checkbox_flip`] against the note's current body — call it **before**
/// applying `edit`. `None` also when the note is not here.
pub fn detect_checkbox_flip(
    conn: &Connection,
    note_id: &str,
    edit: &BlockEdit,
) -> Result<Option<TaskCheckboxFlip>, CrdtError> {
    Ok(reads::note_blocks(conn, note_id)?.and_then(|blocks| checkbox_flip(&blocks, edit)))
}

/// Every [`conversion_candidates`] entry of one note's current body; `None`
/// when the note is not here.
pub fn read_conversion_candidates(
    conn: &Connection,
    note_id: &str,
) -> Result<Option<Vec<ChecklistConversion>>, CrdtError> {
    Ok(reads::note_blocks(conn, note_id)?.map(|blocks| conversion_candidates(&blocks)))
}

// MARK: - The tree a flat block list encodes

/// Parent links for a pre-order block list, rebuilt from `depth`, plus the
/// subtask context desktop's analyzer walks with.
struct Tree<'a> {
    blocks: &'a [Block],
    parents: Vec<Option<usize>>,
    task_ids: Vec<Option<String>>,
    /// `analyzeTaskIntents`' `parentTaskBlock` for each block: the index of
    /// the task line a checkbox or task line here would be a subtask of.
    contexts: Vec<Option<usize>>,
}

impl<'a> Tree<'a> {
    fn of(blocks: &'a [Block]) -> Self {
        let mut parents: Vec<Option<usize>> = Vec::with_capacity(blocks.len());
        let mut open: Vec<usize> = Vec::new();
        for (index, block) in blocks.iter().enumerate() {
            while let Some(&top) = open.last() {
                match blocks.get(top) {
                    Some(candidate) if candidate.depth >= block.depth => {
                        open.pop();
                    }
                    _ => break,
                }
            }
            parents.push(open.last().copied());
            open.push(index);
        }

        let task_ids: Vec<Option<String>> = blocks
            .iter()
            .map(|block| recognise(block).map(|seen| seen.task_id))
            .collect();

        // Desktop walks a task line's children with that line as their parent
        // task only when the line itself was walked without one; every other
        // block's children are walked without one. That is the one-level
        // limit, and parents precede children, so one forward pass decides it.
        let mut contexts: Vec<Option<usize>> = Vec::with_capacity(blocks.len());
        for index in 0..blocks.len() {
            let context = parents.get(index).copied().flatten().filter(|&parent| {
                task_ids.get(parent).is_some_and(Option::is_some)
                    && contexts.get(parent).copied().flatten().is_none()
            });
            contexts.push(context);
        }

        Self {
            blocks,
            parents,
            task_ids,
            contexts,
        }
    }

    fn parent(&self, index: usize) -> Option<usize> {
        self.parents.get(index).copied().flatten()
    }

    fn task_id(&self, index: usize) -> Option<String> {
        self.task_ids.get(index).cloned().flatten()
    }

    fn line(&self, index: usize) -> Option<NoteTaskLine> {
        let block = self.blocks.get(index)?;
        let seen = recognise(block)?;
        Some(NoteTaskLine {
            block_id: block.id.clone()?,
            task_id: seen.task_id,
            title: seen.title,
            checked: seen.checked,
            form: seen.form,
            parent_task_id: self.parent(index).and_then(|parent| self.task_id(parent)),
            stored_parent_task_id: seen.stored_parent,
            depth: block.depth,
        })
    }

    /// The task a block at `index` is a subtask of, by desktop's walk.
    fn subtask_parent(&self, index: usize) -> Option<String> {
        let context = self.contexts.get(index).copied().flatten()?;
        self.task_id(context)
    }
}

/// What one block says about being a task line.
struct Recognised {
    task_id: String,
    title: String,
    checked: bool,
    form: TaskLineForm,
    stored_parent: Option<String>,
}

fn recognise(block: &Block) -> Option<Recognised> {
    let checked = prop(block, "checked").as_deref() == Some("true");
    match block.kind.as_str() {
        TASK_BLOCK => {
            // A draft (`taskId: ''`) is a line whose task is not created yet.
            let task_id = prop(block, "taskId").filter(|id| !id.is_empty())?;
            Some(Recognised {
                task_id,
                title: prop(block, "title").unwrap_or_default(),
                checked,
                form: TaskLineForm::TaskBlock,
                stored_parent: prop(block, "parentTaskId").filter(|id| !id.is_empty()),
            })
        }
        CHECK_LIST_ITEM => {
            let (task_id, title) = parse_task_suffix(&typed_text(block))?;
            Some(Recognised {
                task_id,
                title,
                checked,
                form: TaskLineForm::ChecklistSuffix,
                stored_parent: None,
            })
        }
        _ => None,
    }
}

fn prop(block: &Block, name: &str) -> Option<String> {
    block
        .props
        .iter()
        .find(|prop| prop.name == name)
        .map(|prop| prop.value.clone())
}

/// A block's typed text: its runs, less the inline nodes desktop reads none of.
fn typed_text(block: &Block) -> String {
    block
        .inline
        .iter()
        .filter(|run| {
            !run.marks
                .iter()
                .any(|mark| INLINE_NODES.contains(&mark.as_str()))
        })
        .map(|run| run.text.as_str())
        .collect()
}

/// `parseTaskBlockSuffix`: the id and the title of a `… {task:<id>}` line.
///
/// Only the end-anchored form. Desktop also accepts a suffix followed by
/// Obsidian Tasks plugin fields; recognising those needs its field parser,
/// which the core does not carry, so such a line reads as a plain checkbox
/// here — and is then not offered for conversion either, because it still
/// contains `{task:`.
fn parse_task_suffix(text: &str) -> Option<(String, String)> {
    let trimmed = text.trim_end();
    let close = trimmed.len().checked_sub(1)?;
    if !trimmed.ends_with('}') {
        return None;
    }
    let open = trimmed.rfind(SUFFIX_OPEN)?;
    let id = trimmed.get(open + SUFFIX_OPEN.len()..close)?;
    if id.is_empty() || id.contains('}') {
        return None;
    }
    let title = trimmed.get(..open)?.trim();
    Some((id.to_owned(), title.to_owned()))
}

/// Whether `text` holds a `{task:` opener at all (desktop's cheap pre-check).
fn mentions_task_suffix(text: &str) -> bool {
    text.contains(SUFFIX_OPEN)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_suffix_parses_like_parse_task_block_suffix() {
        assert_eq!(
            parse_task_suffix("Buy milk {task:abc}  "),
            Some(("abc".to_owned(), "Buy milk".to_owned()))
        );
        assert_eq!(parse_task_suffix("Buy milk {task:}"), None);
        assert_eq!(parse_task_suffix("Buy milk {task:abc} later"), None);
        assert_eq!(parse_task_suffix("{task:a}b}"), None);
        assert_eq!(parse_task_suffix(""), None);
        assert!(mentions_task_suffix("x {task:"));
    }
}

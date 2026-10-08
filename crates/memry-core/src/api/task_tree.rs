//! The task hierarchy as the shell draws and edits it (desktop's
//! `subtask-tree-context.tsx` and `move-under-dialog.tsx`).
//!
//! The shell lays rows out and names the actions; every placement rule is the
//! tree's ([`TaskTree`]): which parent a task sits under (a `parentId` loop is
//! broken at its smallest id), which moves would put a task inside its own
//! branch, and, with the device-local `tasks.nestedSubtasks` setting off,
//! desktop's one-level rule. The write itself stays `set_parent`, which allows
//! any depth.

use std::collections::HashSet;

use crate::api::errors::StorageError;
use crate::api::tasks::Tasks;
use crate::domain::task_records::{self, TaskRecord};
use crate::domain::task_settings;
use crate::domain::task_tree::{TaskTree, TreeNode};

/// One live task's place in the tree, with the moves its menu offers.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct TaskTreeEntry {
    pub id: String,
    /// The parent the tree places the task under; `None` at the top level.
    /// Differs from the stored `parentId` only for the root of a loop.
    pub parent_id: Option<String>,
    /// Unarchived children, in `position` order.
    pub child_ids: Vec<String>,
    /// "Indent": the sibling above, when the task may move under it.
    pub indent_under: Option<String>,
    /// "Outdent": the grandparent, when the task may move under it.
    pub outdent_to: Option<String>,
    /// Whether a new subtask may go under this task.
    pub can_add_subtask: bool,
}

/// One row of the "Move under…" picker.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct TaskPlace {
    pub task_id: String,
    /// 0 for a top-level task.
    pub depth: u32,
    /// Ancestors, outermost first (shown beside a search match).
    pub path_ids: Vec<String>,
    /// False for the task's own branch and for a place the depth rule refuses.
    pub allowed: bool,
}

impl TreeNode for TaskRecord {
    fn node_id(&self) -> &str {
        &self.id
    }
    fn node_parent(&self) -> Option<&str> {
        self.parent_id.as_deref()
    }
}

#[uniffi::export]
impl Tasks {
    /// Every live task's place in the tree, in `position` order.
    pub fn tree(&self) -> Result<Vec<TaskTreeEntry>, StorageError> {
        self.db.call_blocking(|conn| {
            let tasks = task_records::all(conn)?;
            let nested = task_settings::read(conn)?.nested_subtasks;
            Ok(tree_entries(&tasks, nested))
        })
    }

    /// The "Move under…" picker for `task_id`: its project's unarchived tasks
    /// as the tree, depth first. Empty when the task is gone.
    pub fn move_under_places(&self, task_id: String) -> Result<Vec<TaskPlace>, StorageError> {
        self.db.call_blocking(move |conn| {
            let tasks = task_records::all(conn)?;
            let nested = task_settings::read(conn)?.nested_subtasks;
            Ok(places(&tasks, &task_id, nested))
        })
    }
}

fn tree_entries(tasks: &[TaskRecord], nested: bool) -> Vec<TaskTreeEntry> {
    let tree = TaskTree::build(tasks);
    let archived: HashSet<&str> = tasks
        .iter()
        .filter(|task| task.archived_at.is_some())
        .map(|task| task.id.as_str())
        .collect();
    let children = |id: &str| -> Vec<String> {
        tree.children_of(id)
            .iter()
            .filter(|child| !archived.contains(*child))
            .map(|child| (*child).to_owned())
            .collect()
    };
    tasks
        .iter()
        .map(|task| {
            let id = task.id.as_str();
            let parent = tree.parent_of(id);
            let allowed =
                |target: &str| tree.check_parent(Some(id), target, true, nested).is_none();
            let indent_under = parent.and_then(|parent| {
                let siblings = children(parent);
                let at = siblings.iter().position(|sibling| sibling == id)?;
                let above = siblings.get(at.checked_sub(1)?)?;
                allowed(above).then(|| above.clone())
            });
            let outdent_to = parent
                .and_then(|parent| tree.parent_of(parent))
                .filter(|grandparent| allowed(grandparent))
                .map(str::to_owned);
            TaskTreeEntry {
                id: task.id.clone(),
                parent_id: parent.map(str::to_owned),
                child_ids: children(id),
                indent_under,
                outdent_to,
                can_add_subtask: tree.check_parent(None, id, true, nested).is_none(),
            }
        })
        .collect()
}

fn places(tasks: &[TaskRecord], task_id: &str, nested: bool) -> Vec<TaskPlace> {
    let Some(task) = tasks.iter().find(|task| task.id == task_id) else {
        return Vec::new();
    };
    let project: Vec<&TaskRecord> = tasks
        .iter()
        .filter(|other| other.project_id == task.project_id && other.archived_at.is_none())
        .collect();
    let rows: Vec<Row<'_>> = project.iter().map(|task| Row(task)).collect();
    let tree = TaskTree::build(&rows);
    let branch: HashSet<&str> = std::iter::once(task_id)
        .chain(tree.descendant_ids(task_id))
        .collect();
    let mut out = Vec::new();
    let mut stack: Vec<(&str, Vec<String>)> = project
        .iter()
        .rev()
        .filter(|task| tree.is_root(&task.id))
        .map(|task| (task.id.as_str(), Vec::new()))
        .collect();
    while let Some((id, path)) = stack.pop() {
        let allowed =
            !branch.contains(id) && tree.check_parent(Some(task_id), id, true, nested).is_none();
        let mut child_path = path.clone();
        child_path.push(id.to_owned());
        for child in tree.children_of(id).iter().rev() {
            stack.push((child, child_path.clone()));
        }
        out.push(TaskPlace {
            task_id: id.to_owned(),
            depth: u32::try_from(path.len()).unwrap_or(u32::MAX),
            path_ids: path,
            allowed,
        });
    }
    out
}

/// A task of the picker's project, so its tree sees only that project.
struct Row<'a>(&'a TaskRecord);

impl TreeNode for Row<'_> {
    fn node_id(&self) -> &str {
        &self.0.id
    }
    fn node_parent(&self) -> Option<&str> {
        self.0.parent_id.as_deref()
    }
}

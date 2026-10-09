//! The task hierarchy at any depth, from the `parentId` pointers alone
//! (desktop's `packages/domain-tasks/src/tree.ts`).
//!
//! `parentId` merges as an ordinary field, so two devices re-parenting at once
//! can leave a loop. The tree breaks it deterministically: the member with the
//! smallest id is top level. A task whose parent is missing keeps that dangling
//! pointer, so it is neither a root nor anyone's child and shows nowhere.

use std::collections::{HashMap, HashSet};

/// A row the tree can place.
pub trait TreeNode {
    fn node_id(&self) -> &str;
    fn node_parent(&self) -> Option<&str>;
}

pub struct TaskTree<'a> {
    parents: HashMap<&'a str, Option<&'a str>>,
    children: HashMap<&'a str, Vec<&'a str>>,
}

impl<'a> TaskTree<'a> {
    pub fn build<T: TreeNode>(tasks: &'a [T]) -> Self {
        let declared: HashMap<&str, Option<&str>> = tasks
            .iter()
            .map(|task| (task.node_id(), task.node_parent()))
            .collect();
        let loop_roots = loop_roots(&declared);
        let mut parents = HashMap::new();
        let mut children: HashMap<&str, Vec<&str>> = HashMap::new();
        for task in tasks {
            let id = task.node_id();
            let parent = task
                .node_parent()
                .filter(|parent| *parent != id && !loop_roots.contains(id));
            parents.insert(id, parent);
            if let Some(parent) = parent {
                children.entry(parent).or_default().push(id);
            }
        }
        Self { parents, children }
    }

    /// The parent the tree uses; `None` for a root.
    pub fn parent_of(&self, id: &str) -> Option<&'a str> {
        self.parents.get(id).copied().flatten()
    }

    pub fn is_root(&self, id: &str) -> bool {
        self.parents.contains_key(id) && self.parent_of(id).is_none()
    }

    /// Every task below `id`, depth first, children in input order.
    pub fn descendant_ids(&self, id: &str) -> Vec<&'a str> {
        let mut out = Vec::new();
        let mut stack: Vec<&str> = self.children_of(id).iter().rev().copied().collect();
        while let Some(next) = stack.pop() {
            out.push(next);
            stack.extend(self.children_of(next).iter().rev().copied());
        }
        out
    }

    /// `id`'s ancestors, nearest first.
    pub fn ancestor_ids(&self, id: &str) -> Vec<&'a str> {
        let mut out = Vec::new();
        let mut current = self.parent_of(id);
        while let Some(parent) = current {
            if !self.parents.contains_key(parent) {
                break;
            }
            out.push(parent);
            current = self.parent_of(parent);
        }
        out
    }

    /// `id`'s children, in input order.
    pub fn children_of(&self, id: &str) -> &[&'a str] {
        self.children.get(id).map_or(&[], Vec::as_slice)
    }

    /// `checkParent`: whether `task_id` (`None` for a task not created yet)
    /// may sit under `parent_id`, read from the tree. A task never goes inside
    /// its own branch. With `allow_nested` off (the `tasks.nestedSubtasks`
    /// setting), the one-level rule of builds before nested subtasks holds:
    /// the parent is top level and the task has no subtasks.
    pub fn check_parent(
        &self,
        task_id: Option<&str>,
        parent_id: &str,
        same_project: bool,
        allow_nested: bool,
    ) -> Option<ParentRejection> {
        if task_id == Some(parent_id) {
            return Some(ParentRejection::SelfParent);
        }
        if !self.parents.contains_key(parent_id) {
            return Some(ParentRejection::Missing);
        }
        if !same_project {
            return Some(ParentRejection::OtherProject);
        }
        if task_id.is_some_and(|task| self.ancestor_ids(parent_id).contains(&task)) {
            return Some(ParentRejection::OwnBranch);
        }
        if !allow_nested
            && (!self.is_root(parent_id)
                || task_id.is_some_and(|task| !self.children_of(task).is_empty()))
        {
            return Some(ParentRejection::TooDeep);
        }
        None
    }
}

/// Why [`TaskTree::check_parent`] refuses a parent (desktop's `ParentRejection`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ParentRejection {
    SelfParent,
    Missing,
    OtherProject,
    OwnBranch,
    TooDeep,
}

/// The smallest id of every `parentId` loop.
fn loop_roots<'a>(declared: &HashMap<&'a str, Option<&'a str>>) -> HashSet<&'a str> {
    let mut roots = HashSet::new();
    let mut settled: HashSet<&str> = HashSet::new();
    for &start in declared.keys() {
        if settled.contains(start) {
            continue;
        }
        let mut path: Vec<&str> = Vec::new();
        let mut on_path: HashMap<&str, usize> = HashMap::new();
        let mut current = Some(start);
        while let Some(id) = current {
            if !declared.contains_key(id) || settled.contains(id) {
                break;
            }
            if let Some(&at) = on_path.get(id) {
                if let Some(min) = path[at..].iter().min() {
                    roots.insert(*min);
                }
                break;
            }
            on_path.insert(id, path.len());
            path.push(id);
            current = declared
                .get(id)
                .copied()
                .flatten()
                .filter(|parent| *parent != id);
        }
        settled.extend(path);
    }
    roots
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Row(&'static str, Option<&'static str>);
    impl TreeNode for Row {
        fn node_id(&self) -> &str {
            self.0
        }
        fn node_parent(&self) -> Option<&str> {
            self.1
        }
    }

    #[test]
    fn walks_any_depth() {
        let rows = [
            Row("a", None),
            Row("b", Some("a")),
            Row("c", Some("b")),
            Row("d", Some("a")),
        ];
        let tree = TaskTree::build(&rows);
        assert_eq!(tree.descendant_ids("a"), ["b", "c", "d"]);
        assert_eq!(tree.ancestor_ids("c"), ["b", "a"]);
    }

    #[test]
    fn breaks_a_loop_at_its_smallest_id() {
        let rows = [
            Row("y", Some("x")),
            Row("x", Some("z")),
            Row("z", Some("y")),
        ];
        let tree = TaskTree::build(&rows);
        assert!(tree.is_root("x"));
        assert!(!tree.is_root("y") && !tree.is_root("z"));
        assert_eq!(tree.ancestor_ids("z"), ["y", "x"]);
    }

    #[test]
    fn check_parent_locks_the_own_branch_and_gates_depth() {
        let rows = [
            Row("a", None),
            Row("b", Some("a")),
            Row("c", Some("b")),
            Row("d", None),
        ];
        let tree = TaskTree::build(&rows);
        assert_eq!(
            tree.check_parent(Some("a"), "c", true, true),
            Some(ParentRejection::OwnBranch)
        );
        assert_eq!(tree.check_parent(Some("d"), "c", true, true), None);
        assert_eq!(
            tree.check_parent(Some("d"), "b", true, false),
            Some(ParentRejection::TooDeep)
        );
        assert_eq!(
            tree.check_parent(Some("b"), "d", true, false),
            Some(ParentRejection::TooDeep)
        );
        assert_eq!(tree.check_parent(Some("c"), "d", true, false), None);
        assert_eq!(tree.check_parent(None, "c", true, true), None);
    }

    #[test]
    fn leaves_a_task_with_a_missing_parent_out() {
        let rows = [Row("a", None), Row("orphan", Some("gone"))];
        let tree = TaskTree::build(&rows);
        assert!(!tree.is_root("orphan"));
        assert!(tree.descendant_ids("a").is_empty());
    }
}

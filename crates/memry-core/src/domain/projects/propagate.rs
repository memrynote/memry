//! What a project rename or delete must rewrite, and the name rules for the
//! rewrite (`apps/desktop/src/main/tasks/project-name-propagation.ts`,
//! `apps/desktop/src/main/notes/project-property.ts`).
//!
//! A markdown note names its projects in its `project` property, so a rename
//! or delete that only touches the project leaves notes naming a project that
//! no longer matches. [`targets`] captures the project's name and its linked
//! markdown notes **before** the write, as `captureProjectName` and
//! `captureProjectForDelete` do: the delete tombstones the project and its
//! links with it. A shell that rewrites the notes itself (desktop, through its
//! property writer) applies [`renamed`] or [`without_name`] to each note's
//! [`project_names`].

use rusqlite::Connection;
use serde_json::Value;

use crate::api::errors::StorageError;

use super::{get, links};

/// A project's name and the markdown notes linked to it, as they stood before
/// a rename or delete.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PropagationTargets {
    pub name: String,
    /// Deduplicated, in `links` order.
    pub note_ids: Vec<String>,
}

/// The targets of a rename or a delete of `project_id`; `None` for an unknown
/// or deleted project, which has nothing to propagate.
pub fn targets(
    conn: &Connection,
    project_id: &str,
) -> Result<Option<PropagationTargets>, StorageError> {
    let Some(project) = get(conn, project_id)? else {
        return Ok(None);
    };
    Ok(Some(PropagationTargets {
        name: project.name,
        note_ids: links::markdown_note_ids(conn, project_id)?,
    }))
}

/// Desktop's `readProjectNames`: a clean, case-insensitively unique name list
/// from every shape a hand-edited frontmatter produces — an array, a bare
/// string, a JSON array written as a string by an older build, or nothing.
pub fn project_names(raw: Option<&Value>) -> Vec<String> {
    let entries: Vec<Value> = match raw {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::Array(entries)) => entries.clone(),
        Some(Value::String(text)) => {
            let trimmed = text.trim();
            match serde_json::from_str::<Value>(trimmed) {
                Ok(Value::Array(entries)) if trimmed.starts_with('[') => entries,
                _ => vec![Value::String(text.clone())],
            }
        }
        Some(_) => Vec::new(),
    };
    let mut names: Vec<String> = Vec::new();
    for entry in entries {
        let Some(name) = entry
            .as_str()
            .map(str::trim)
            .filter(|name| !name.is_empty())
        else {
            continue;
        };
        if !names
            .iter()
            .any(|seen| seen.to_lowercase() == name.to_lowercase())
        {
            names.push(name.to_owned());
        }
    }
    names
}

/// `propagateProjectRename`'s rewrite: every name equal to `old` (case folded)
/// becomes `new`.
pub fn renamed(names: Vec<String>, old: &str, new: &str) -> Vec<String> {
    names
        .into_iter()
        .map(|name| {
            if name.to_lowercase() == old.to_lowercase() {
                new.to_owned()
            } else {
                name
            }
        })
        .collect()
}

/// `withoutProjectName`: `name` (case folded) leaves the list.
pub fn without_name(names: Vec<String>, name: &str) -> Vec<String> {
    names
        .into_iter()
        .filter(|seen| seen.to_lowercase() != name.to_lowercase())
        .collect()
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn project_names_read_every_shape_desktop_tolerates() {
        assert_eq!(project_names(None), Vec::<String>::new());
        assert_eq!(project_names(Some(&json!(""))), Vec::<String>::new());
        assert_eq!(project_names(Some(&json!("Alpha"))), vec!["Alpha"]);
        assert_eq!(
            project_names(Some(&json!("[\"Alpha\",\"Beta\"]"))),
            vec!["Alpha", "Beta"]
        );
        assert_eq!(
            project_names(Some(&json!([" Alpha ", "alpha", null, "", "Beta"]))),
            vec!["Alpha", "Beta"]
        );
    }

    #[test]
    fn a_rename_and_a_removal_fold_case() {
        let names = vec!["alpha".to_owned(), "Beta".to_owned()];
        assert_eq!(
            renamed(names.clone(), "ALPHA", "Gamma"),
            vec!["Gamma", "Beta"]
        );
        assert_eq!(without_name(names, "BETA"), vec!["alpha"]);
    }
}

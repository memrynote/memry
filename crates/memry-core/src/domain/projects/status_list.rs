//! The nested `statuses` array: desktop's default set, a custom set, and the
//! reconcile an edit runs (`apps/desktop/src/main/database/queries/projects.ts`
//! `createDefaultStatuses`, `createCustomStatuses`, `reconcileProjectStatuses`).
//!
//! Every entry carries desktop's pushed row shape — `id, projectId, name,
//! color, position, isDefault, isDone, createdAt` — because desktop builds its
//! push payload from the `statuses` table row. **No `type` key is written**:
//! `StatusSyncSchema` has none, and the type is derived on read
//! ([`super::Status::status_type`]). The input's type only decides the two
//! flags, exactly as desktop's `isDefault = type === 'todo' && order === 0`,
//! `isDone = type === 'done'`.

use std::collections::HashSet;

use serde_json::{Map, Value, json};

use crate::api::errors::StorageError;

use super::write::{mint_id, valid_color};

/// `StatusInputSchema` / `StatusUpsertSchema` (`packages/contracts/src/tasks-api.ts:124`).
pub const MIN_STATUSES: usize = 2;
pub const MAX_STATUS_NAME_CHARS: usize = 50;

/// The three types desktop's status editor offers.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StatusType {
    Todo,
    InProgress,
    Done,
}

impl StatusType {
    /// Desktop's spelling (`'todo' | 'in_progress' | 'done'`).
    pub fn as_str(self) -> &'static str {
        match self {
            StatusType::Todo => "todo",
            StatusType::InProgress => "in_progress",
            StatusType::Done => "done",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "todo" => Some(StatusType::Todo),
            "in_progress" => Some(StatusType::InProgress),
            "done" => Some(StatusType::Done),
            _ => None,
        }
    }
}

/// One status as the status editor submits it.
///
/// `id` is only read by an edit: `Some` naming a status the project already
/// has updates it in place, anything else is a new status. `order` becomes
/// `position`.
#[derive(Debug, Clone, Copy)]
pub struct StatusInput<'a> {
    pub id: Option<&'a str>,
    pub name: &'a str,
    pub color: &'a str,
    pub status_type: StatusType,
    pub order: i64,
}

impl StatusInput<'_> {
    fn is_default(&self) -> bool {
        self.status_type == StatusType::Todo && self.order == 0
    }

    fn is_done(&self) -> bool {
        self.status_type == StatusType::Done
    }
}

/// Desktop's three default statuses for a new project (§5 of the plan).
pub(super) fn default_statuses(project_id: &str, at: &str) -> Vec<Value> {
    [
        ("todo", "To Do", "#6b7280", 0, true, false),
        ("in-progress", "In Progress", "#F59E0B", 1, false, false),
        ("done", "Done", "#22c55e", 2, false, true),
    ]
    .into_iter()
    .map(|(suffix, name, color, position, is_default, is_done)| {
        json!({
            "id": format!("{project_id}-{suffix}"),
            "projectId": project_id,
            "name": name,
            "color": color,
            "position": position,
            "isDefault": is_default,
            "isDone": is_done,
            "createdAt": at,
        })
    })
    .collect()
}

/// A custom list for a new project, ids `${projectId}-${order}`.
///
/// Two inputs with one `order` would mint one id twice, which desktop's
/// primary key refuses; this refuses it before anything is written.
pub(super) fn custom_statuses(
    project_id: &str,
    inputs: &[StatusInput<'_>],
    at: &str,
) -> Result<Vec<Value>, StorageError> {
    validate(inputs)?;
    let mut orders = HashSet::new();
    if let Some(repeated) = inputs.iter().find(|input| !orders.insert(input.order)) {
        return Err(invalid(format!(
            "two statuses share order {}; each needs its own",
            repeated.order
        )));
    }
    Ok(inputs
        .iter()
        .map(|input| {
            entry(
                &format!("{project_id}-{}", input.order),
                project_id,
                input,
                at,
            )
        })
        .collect())
}

/// Desktop's `reconcileProjectStatuses`, over the stored array.
///
/// A stored status the inputs do not name is dropped. An input naming a stored
/// status rewrites its five modelled keys and **keeps every other key** —
/// `createdAt`, and anything a newer build added (§13.2 rule 3). Any other
/// input is a new status under a fresh nanoid, as desktop mints one.
///
/// Tasks on a dropped status are not touched, which is desktop's behaviour: its
/// FK nulls the local column and the wire keeps the old id, which every reader
/// resolves as "no status".
pub(super) fn reconcile(
    project_id: &str,
    stored: Option<&Value>,
    inputs: &[StatusInput<'_>],
    at: &str,
) -> Result<Vec<Value>, StorageError> {
    validate(inputs)?;
    let existing: Vec<&Map<String, Value>> = match stored {
        Some(Value::Array(entries)) => entries.iter().filter_map(Value::as_object).collect(),
        _ => Vec::new(),
    };

    let mut seen = HashSet::new();
    let mut next = Vec::with_capacity(inputs.len());
    for input in inputs {
        let kept = input.id.and_then(|id| {
            existing
                .iter()
                .find(|entry| entry.get("id").and_then(Value::as_str) == Some(id))
        });
        let Some(kept) = kept else {
            next.push(entry(&mint_id(), project_id, input, at));
            continue;
        };
        if let Some(id) = input.id
            && !seen.insert(id)
        {
            return Err(invalid(format!("status {id} is listed twice")));
        }
        let mut updated = (*kept).clone();
        updated.insert("name".to_owned(), json!(input.name));
        updated.insert("color".to_owned(), json!(input.color));
        updated.insert("position".to_owned(), json!(input.order));
        updated.insert("isDefault".to_owned(), json!(input.is_default()));
        updated.insert("isDone".to_owned(), json!(input.is_done()));
        next.push(Value::Object(updated));
    }
    Ok(next)
}

fn entry(id: &str, project_id: &str, input: &StatusInput<'_>, at: &str) -> Value {
    json!({
        "id": id,
        "projectId": project_id,
        "name": input.name,
        "color": input.color,
        "position": input.order,
        "isDefault": input.is_default(),
        "isDone": input.is_done(),
        "createdAt": at,
    })
}

/// `StatusInputSchema`'s rules: at least two, each named (1..=50), a
/// `#rrggbb` colour and a non-negative order.
///
/// The renderer's extra editor rules (one todo, one done, unique names) are
/// **not** enforced here: desktop's main process does not enforce them either,
/// so a payload a desktop wrote without them must stay editable.
fn validate(inputs: &[StatusInput<'_>]) -> Result<(), StorageError> {
    if inputs.len() < MIN_STATUSES {
        return Err(invalid(format!(
            "a project needs at least {MIN_STATUSES} statuses, got {}",
            inputs.len()
        )));
    }
    for input in inputs {
        let chars = input.name.chars().count();
        if input.name.trim().is_empty() || chars > MAX_STATUS_NAME_CHARS {
            return Err(invalid(format!(
                "status name `{}` must be 1 to {MAX_STATUS_NAME_CHARS} characters",
                input.name
            )));
        }
        valid_color(input.color)?;
        if input.order < 0 {
            return Err(invalid(format!("status order {} is negative", input.order)));
        }
    }
    Ok(())
}

fn invalid(what: String) -> StorageError {
    StorageError::Invalid { what }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input<'a>(
        id: Option<&'a str>,
        name: &'a str,
        kind: StatusType,
        order: i64,
    ) -> StatusInput<'a> {
        StatusInput {
            id,
            name,
            color: "#6b7280",
            status_type: kind,
            order,
        }
    }

    #[test]
    fn the_type_decides_the_two_wire_flags_as_desktop_does() {
        let todo_later = input(None, "Later", StatusType::Todo, 1);
        assert!(
            !todo_later.is_default(),
            "a todo that is not first is not the default"
        );
        assert!(input(None, "Todo", StatusType::Todo, 0).is_default());
        assert!(input(None, "Done", StatusType::Done, 2).is_done());
    }

    #[test]
    fn a_status_type_round_trips_desktops_spelling() {
        for kind in [StatusType::Todo, StatusType::InProgress, StatusType::Done] {
            assert_eq!(StatusType::parse(kind.as_str()), Some(kind));
        }
        assert_eq!(StatusType::parse("blocked"), None);
    }

    #[test]
    fn fewer_than_two_statuses_are_refused() {
        let one = [input(None, "Todo", StatusType::Todo, 0)];
        assert!(custom_statuses("p", &one, "2026-01-01T00:00:00.000Z").is_err());
    }

    #[test]
    fn two_custom_statuses_with_one_order_are_refused() {
        let clash = [
            input(None, "A", StatusType::Todo, 0),
            input(None, "B", StatusType::Done, 0),
        ];
        assert!(custom_statuses("p", &clash, "2026-01-01T00:00:00.000Z").is_err());
    }
}

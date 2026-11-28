//! The task, project, status and tag read tools: the `tasks`, `projects`, `statuses` and `tags`
//! handles of Electron's `tools/handles-adapter.ts`, over [`TasksService`] and the tag reads the
//! `tasks:*` and `tags:*` commands use.

use std::collections::HashMap;
use std::sync::Arc;

use memry_core::seams::secure_store::SecureStore;
use serde::Serialize;
use serde_json::{Value, json};

use super::{arg, internal};
use crate::agent::mcp::ToolError;
use crate::session::OpenVault;
use crate::tags;
use crate::tasks::contract::TaskListInput;
use crate::tasks::service::TasksService;

pub const TOOLS: [&str; 6] = [
    "vault_list_tasks",
    "vault_get_task",
    "vault_list_projects",
    "vault_get_project",
    "vault_list_statuses",
    "vault_get_tags",
];

fn value(reply: impl Serialize) -> Result<Value, ToolError> {
    serde_json::to_value(reply).map_err(internal)
}

/// Electron's truthiness test on an optional string argument.
fn given<'a>(args: &'a Value, key: &str) -> Option<&'a str> {
    arg(args, key).filter(|text| !text.is_empty())
}

pub fn call(
    tool: &str,
    args: &Value,
    open: &OpenVault,
    identity: Arc<dyn SecureStore>,
) -> Result<Value, ToolError> {
    if tool == "vault_get_tags" {
        return tag_counts(open);
    }
    let service = TasksService::open(open, identity).map_err(internal)?;
    let id = |key| arg(args, key).unwrap_or_default();
    match tool {
        "vault_list_tasks" => list_tasks(&service, args),
        "vault_get_task" => value(service.get(id("id")).map_err(internal)?),
        "vault_list_projects" => list_projects(&service, open),
        "vault_get_project" => value(service.project(id("id")).map_err(internal)?),
        "vault_list_statuses" => value(service.statuses(id("project_id")).map_err(internal)?),
        _ => unreachable!("{tool} is not a task read tool"),
    }
}

/// `status` is `completed`, `open` or a status id; without one, open tasks of every status.
fn list_tasks(service: &TasksService, args: &Value) -> Result<Value, ToolError> {
    let status = given(args, "status");
    let page = service
        .list(TaskListInput {
            project_id: given(args, "project_id").map(str::to_owned),
            status_id: status
                .filter(|status| !matches!(*status, "completed" | "open"))
                .map(|status| Some(status.to_owned())),
            include_completed: Some(status == Some("completed")),
            due_before: arg(args, "due_before").map(str::to_owned),
            tags: given(args, "tag").map(|tag| vec![tag.to_owned()]),
            limit: args.get("limit").and_then(Value::as_i64),
            ..TaskListInput::default()
        })
        .map_err(internal)?;
    let tasks: Vec<Value> = page
        .tasks
        .into_iter()
        .map(|item| item.task)
        .filter(|task| match status {
            Some("completed") => task.completed_at.is_some(),
            Some("open") => task.completed_at.is_none(),
            _ => true,
        })
        .map(|task| {
            let status = match (&task.completed_at, &task.status_id) {
                (Some(_), _) => "completed",
                (None, Some(id)) => id.as_str(),
                (None, None) => "open",
            };
            json!({
                "id": task.id,
                "title": task.title,
                "status": status,
                "due": task.due_date,
                "project": task.project_id,
                "tags": task.tags,
            })
        })
        .collect();
    Ok(Value::Array(tasks))
}

/// The linked counts come from each project's contents, so they count what the project hub can
/// open (Electron counts every linked row with an index entry).
fn list_projects(service: &TasksService, open: &OpenVault) -> Result<Value, ToolError> {
    let projects = service.projects().map_err(internal)?.projects;
    let mut summaries = Vec::with_capacity(projects.len());
    for stats in projects {
        let project = stats.project;
        let counts = service
            .project_contents(&project.id, &open.vault, &open.path)
            .map_err(internal)?
            .counts;
        summaries.push(json!({
            "id": project.id,
            "name": project.name,
            "status": if project.archived_at.is_some() { "archived" } else { "active" },
            "task_count": stats.task_count,
            "icon": project.icon,
            "home_note_id": project.home_note_id,
            "linked_counts": { "notes": counts.notes, "files": counts.files, "events": counts.events },
        }));
    }
    Ok(Value::Array(summaries))
}

fn tag_counts(open: &OpenVault) -> Result<Value, ToolError> {
    let names: HashMap<String, String> = tags::categories(open)
        .map_err(internal)?
        .into_iter()
        .map(|category| (category.id, category.name))
        .collect();
    let tags: Vec<Value> = tags::all_with_counts(open)
        .map_err(internal)?
        .into_iter()
        .map(|tag| {
            let category_name = tag.category_id.as_ref().and_then(|id| names.get(id));
            json!({
                "name": tag.name,
                "count": tag.count,
                "color": tag.color,
                "icon": tag.icon,
                "category_id": tag.category_id,
                "category_name": category_name,
                "sort_order": tag.sort_order,
            })
        })
        .collect();
    Ok(Value::Array(tags))
}

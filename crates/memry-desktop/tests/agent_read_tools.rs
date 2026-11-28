//! `DesktopToolHost` behind the tool registry over a real `Session` (Step 28c4): the task,
//! project, status and tag reads answer Electron's reply shapes from the open vault, a call after
//! the vault switched never reads the other vault, and the help tools answer from the bundled
//! guide.

use std::sync::Arc;

use memry_core::api::tasks_write::NewTaskInput;
use memry_core::seams::secure_store::SecureStore;
use memry_desktop::agent::mcp::{CallContext, ToolRegistry};
use memry_desktop::agent::tools::{DesktopToolHost, VAULT_CLOSED};
use memry_desktop::registry::{AppConfig, VaultRegistry};
use memry_desktop::session::{OpenSource, Session};
use rmcp::model::CallToolResult;
use serde_json::{Value, json};

use crate::device_key;
use crate::tasks_service::draft;

struct App {
    _dir: tempfile::TempDir,
    session: Session,
    vault_b: std::path::PathBuf,
    registry: ToolRegistry,
    project: String,
    open_task: String,
    done_task: String,
}

fn task(input: (&str, &str, &[&str])) -> NewTaskInput {
    let (title, project, tags) = input;
    NewTaskInput {
        title: title.to_owned(),
        project_id: project.to_owned(),
        status_id: None,
        parent_id: None,
        priority: 0,
        description: None,
        due_date: Some("2026-03-12".to_owned()),
        due_time: None,
        start_date: None,
        repeat: None,
        repeat_from: None,
        tags: tags.iter().map(|tag| (*tag).to_owned()).collect(),
        linked_note_ids: Vec::new(),
        linked_canvas_ids: Vec::new(),
        source_note_id: None,
        position: None,
    }
}

/// Vault A open with a project "Work" holding one open and one completed task.
fn app() -> App {
    let dir = tempfile::tempdir().unwrap();
    let (vault_a, vault_b) = (dir.path().join("a"), dir.path().join("b"));
    std::fs::create_dir_all(&vault_a).unwrap();
    std::fs::create_dir_all(&vault_b).unwrap();
    std::fs::create_dir_all(dir.path().join("app")).unwrap();
    let config = AppConfig::load(dir.path().join("app/memry-config.json"));
    let session = Session::new(VaultRegistry::new(Arc::new(config)));
    session.open(&vault_a, OpenSource::Select).unwrap();
    let open = session.current().unwrap();
    let store: Arc<dyn SecureStore> = device_key::with_device_key();
    let tasks = open.vault.tasks(store.clone()).unwrap();
    let project = tasks.create_project(draft("Work")).unwrap();
    let open_task = tasks
        .create(task(("Open", &project, &["work"])))
        .unwrap()
        .created[0]
        .clone();
    let done_task = tasks.create(task(("Done", &project, &[]))).unwrap().created[0].clone();
    tasks
        .complete(done_task.clone(), "2026-03-10T09:30:00".to_owned())
        .unwrap();
    let host = DesktopToolHost::new(session.clone(), open.vault_id.clone(), store);
    App {
        _dir: dir,
        session,
        vault_b,
        registry: ToolRegistry::new(Arc::new(host)),
        project,
        open_task,
        done_task,
    }
}

impl App {
    async fn call(&self, tool: &str, args: Value) -> CallToolResult {
        let args = args.as_object().cloned();
        self.registry
            .call(tool, args, &CallContext::default())
            .await
    }

    /// The reply value of a call that succeeded: arrays and `null` come wrapped as `{result}`.
    async fn ok(&self, tool: &str, args: Value) -> Value {
        let result = self.call(tool, args).await;
        assert_ne!(result.is_error, Some(true), "{tool}: {result:?}");
        let value = result.structured_content.unwrap();
        match value.get("result") {
            Some(inner) if value.as_object().is_some_and(|o| o.len() == 1) => inner.clone(),
            _ => value,
        }
    }

    /// `{code, message}` of a refused call.
    async fn refused(&self, tool: &str, args: Value) -> (String, String) {
        let result = self.call(tool, args).await;
        assert_eq!(result.is_error, Some(true), "{tool} succeeded");
        let reply = serde_json::to_value(&result).unwrap();
        let value: Value =
            serde_json::from_str(reply["content"][0]["text"].as_str().unwrap()).unwrap();
        (
            value["code"].as_str().unwrap().to_owned(),
            value["message"].as_str().unwrap().to_owned(),
        )
    }
}

fn ids(list: &Value) -> Vec<&str> {
    list.as_array()
        .unwrap()
        .iter()
        .map(|item| item["id"].as_str().unwrap())
        .collect()
}

#[tokio::test(flavor = "multi_thread")]
async fn list_tasks_answers_open_tasks_and_filters_by_status_as_electron() {
    let app = app();
    let open = app.ok("vault_list_tasks", json!({})).await;
    assert_eq!(ids(&open), [app.open_task.as_str()]);
    assert_eq!(
        open[0],
        json!({
            "id": app.open_task,
            "title": "Open",
            "status": open[0]["status"],
            "due": "2026-03-12",
            "project": app.project,
            "tags": ["work"],
        })
    );
    assert_ne!(open[0]["status"], json!("completed"));

    let done = app
        .ok("vault_list_tasks", json!({ "status": "completed" }))
        .await;
    assert_eq!(ids(&done), [app.done_task.as_str()]);
    assert_eq!(done[0]["status"], json!("completed"));

    let tagged = app.ok("vault_list_tasks", json!({ "tag": "nope" })).await;
    assert_eq!(tagged, json!([]));
    let other = app
        .ok(
            "vault_list_tasks",
            json!({ "project_id": "no-such-project" }),
        )
        .await;
    assert_eq!(other, json!([]));
}

#[tokio::test(flavor = "multi_thread")]
async fn get_task_project_and_statuses_answer_the_vault_records() {
    let app = app();
    let task = app
        .ok("vault_get_task", json!({ "id": app.open_task }))
        .await;
    assert_eq!(task["id"], json!(app.open_task));
    assert_eq!(task["title"], json!("Open"));
    let missing = app.ok("vault_get_task", json!({ "id": "nope" })).await;
    assert_eq!(missing, Value::Null);

    let project = app
        .ok("vault_get_project", json!({ "id": app.project }))
        .await;
    assert_eq!(project["name"], json!("Work"));
    let statuses = app
        .ok("vault_list_statuses", json!({ "project_id": app.project }))
        .await;
    assert!(!statuses.as_array().unwrap().is_empty());
    assert_eq!(project["statuses"], statuses);
}

#[tokio::test(flavor = "multi_thread")]
async fn list_projects_answers_electrons_project_summary() {
    let app = app();
    let projects = app.ok("vault_list_projects", json!({})).await;
    let work = projects
        .as_array()
        .unwrap()
        .iter()
        .find(|project| project["id"] == json!(app.project))
        .unwrap();
    assert_eq!(
        *work,
        json!({
            "id": app.project,
            "name": "Work",
            "status": "active",
            "task_count": work["task_count"],
            "icon": null,
            "home_note_id": null,
            "linked_counts": { "notes": 0, "files": 0, "events": 0 },
        })
    );
    assert!(work["task_count"].as_i64().unwrap() >= 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn get_tags_answers_a_list() {
    let app = app();
    assert!(app.ok("vault_get_tags", json!({})).await.is_array());
}

#[tokio::test(flavor = "multi_thread")]
async fn a_call_after_a_switch_never_reads_the_other_vault() {
    let app = app();
    app.session.switch(&app.vault_b).unwrap();
    for tool in ["vault_list_tasks", "vault_list_projects", "vault_get_tags"] {
        let (code, message) = app.refused(tool, json!({})).await;
        assert_eq!(
            (code.as_str(), message.as_str()),
            ("PERMISSION_DENIED", VAULT_CLOSED)
        );
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn help_tools_answer_from_the_bundled_guide() {
    let app = app();
    let found = app
        .ok(
            "memry_help_search",
            json!({ "query": "search text inside pdf" }),
        )
        .await;
    assert!(!found["results"].as_array().unwrap().is_empty());
    let page = app
        .ok("memry_help_read", json!({ "page": "user-guide/search" }))
        .await;
    assert_eq!(page["page"], json!("user-guide/search"));
    let (code, _) = app
        .refused("memry_help_read", json!({ "page": "user-guide/nope" }))
        .await;
    assert_eq!(code, "NOT_FOUND");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_read_tool_not_ported_yet_says_so() {
    let app = app();
    let (code, message) = app
        .refused("vault_search_notes", json!({ "query": "x" }))
        .await;
    assert_eq!(code, "INTERNAL");
    assert_eq!(
        message,
        "vault_search_notes is not available in this build yet."
    );
}

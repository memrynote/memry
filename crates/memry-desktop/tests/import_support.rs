//! The recording [`ImportSink`] the importer tests share: the seams the TypeScript generator
//! (`apps/desktop/src/main/import/__vectors__/importer-vectors.test.ts`) mocks, recorded into
//! one timeline with the progress snapshots.

use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use base64::Engine;
use memry_core::markdown::frontmatter::{YamlMap, YamlValue};
use memry_desktop::attachments::{self, SavedAttachment};
use memry_desktop::import::{
    ImportProgress, ImportSink, ImportedBookmark, ImportedJournalEntry, ImportedNote,
    ImportedProjectTask, ImportedRepeat, ImportedStatus, ImportedTask, ImportedTickTickTask,
    JournalEntry, MonthlyRepeat, ProjectStatus, RepeatEnd, SinkError, StatusKind,
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

pub type Timeline = Arc<Mutex<Vec<Value>>>;

pub struct RecordingSink {
    pub timeline: Timeline,
    notes: AtomicUsize,
    tasks: AtomicUsize,
    projects: AtomicUsize,
    /// The generator's `getInboxProjectId`.
    pub inbox: Option<String>,
    /// The generator's `nestedSubtasks`.
    pub nested_subtasks: bool,
    /// The entries the generator's `readJournalEntry` finds, by date.
    pub journals: HashMap<String, JournalEntry>,
    /// `resolveJournalEntryId` throws.
    pub fail_journal_id: bool,
    /// `saveBookmark` throws for this URL.
    pub fail_bookmark_url: Option<String>,
    /// `createProject` throws for this name.
    pub fail_project: Option<String>,
    /// `createTask` (Todoist's) returns no task for this title.
    pub fail_project_task: Option<String>,
    /// TickTick's `createTask`, `completeTask` and `createReminder` throw for this title or task id.
    pub fail_ticktick_task: Option<String>,
    pub fail_complete: bool,
    pub fail_reminder: bool,
    /// The statuses `getStatusesByProject` returns: the Inbox's, then each created project's.
    statuses: Mutex<HashMap<String, Vec<ProjectStatus>>>,
}

/// The TickTick tests' `INBOX_STATUSES`.
fn inbox_statuses() -> Vec<ProjectStatus> {
    [
        ("inbox-todo", true, false),
        ("inbox-ip", false, false),
        ("inbox-done", false, true),
    ]
    .into_iter()
    .map(|(id, is_default, is_done)| ProjectStatus {
        id: id.to_owned(),
        is_default,
        is_done,
    })
    .collect()
}

impl RecordingSink {
    pub fn new(timeline: Timeline) -> Self {
        Self {
            timeline,
            notes: AtomicUsize::new(0),
            tasks: AtomicUsize::new(0),
            projects: AtomicUsize::new(0),
            inbox: Some("inbox".to_owned()),
            nested_subtasks: true,
            journals: HashMap::new(),
            fail_journal_id: false,
            fail_bookmark_url: None,
            fail_project: None,
            fail_project_task: None,
            fail_ticktick_task: None,
            fail_complete: false,
            fail_reminder: false,
            statuses: Mutex::new(HashMap::from([("inbox".to_owned(), inbox_statuses())])),
        }
    }

    fn push(&self, entry: Value) {
        self.timeline.lock().unwrap().push(entry);
    }
}

/// Records a snapshot as the generator's `broadcastToAllWindows` mock does.
pub fn record_progress(timeline: &Timeline, snapshot: &ImportProgress) {
    let mut entry = json!({ "op": "progress" });
    let Value::Object(fields) = serde_json::to_value(snapshot).unwrap() else {
        unreachable!("a snapshot serializes to an object")
    };
    entry.as_object_mut().unwrap().extend(fields);
    timeline.lock().unwrap().push(entry);
}

impl ImportSink for RecordingSink {
    fn new_note_id(&self) -> String {
        format!("note-{}", self.notes.fetch_add(1, Ordering::SeqCst) + 1)
    }

    fn save_attachment(
        &self,
        note_id: &str,
        file_name: &str,
        bytes: &[u8],
    ) -> Result<SavedAttachment, SinkError> {
        let ext = attachments::extension(file_name);
        if !attachments::is_allowed_extension(ext) {
            self.push(
                json!({ "op": "saveAttachment", "noteId": note_id, "name": file_name, "refused": true }),
            );
            return Err(SinkError(format!(
                "unsupported attachment type .{}",
                ext.to_lowercase()
            )));
        }
        self.push(json!({
            "op": "saveAttachment",
            "noteId": note_id,
            "name": file_name,
            "size": bytes.len(),
            "sha256": hex::encode(Sha256::digest(bytes)),
        }));
        Ok(SavedAttachment {
            path: format!("attachments/{note_id}/{file_name}"),
            name: file_name.to_owned(),
            size: bytes.len(),
            mime_type: attachments::mime_type(file_name),
            kind: attachments::kind_of(file_name),
            disk_path: Default::default(),
        })
    }

    fn create_note(&self, note: ImportedNote) -> Result<(), SinkError> {
        self.push(note_record("createNote", note));
        Ok(())
    }

    fn create_note_as_written(&self, note: ImportedNote) -> Result<(), SinkError> {
        self.push(note_record("createNoteAsWritten", note));
        Ok(())
    }

    fn inbox_project_id(&self) -> Option<String> {
        self.inbox.clone()
    }

    fn nested_subtasks(&self) -> bool {
        self.nested_subtasks
    }

    /// The generator's `recordingProjects.createProject`.
    fn create_project(&self, name: &str) -> Result<String, SinkError> {
        if self.fail_project.as_deref() == Some(name) {
            return Err(SinkError("project boom".to_owned()));
        }
        self.push(json!({ "op": "createProject", "name": name }));
        Ok(format!(
            "project-{}",
            self.projects.fetch_add(1, Ordering::SeqCst) + 1
        ))
    }

    /// The generator's `recordingProjects.createTask`.
    fn create_project_task(&self, task: ImportedProjectTask) -> Result<String, SinkError> {
        if self.fail_project_task.as_deref() == Some(task.title.as_str()) {
            return Err(SinkError("Task creation failed".to_owned()));
        }
        self.push(json!({
            "op": "createTask",
            "projectId": task.project_id,
            "parentId": task.parent_id,
            "title": task.title,
            "description": task.description,
            "priority": task.priority,
            "dueDate": task.due_date,
            "dueTime": task.due_time,
            "position": task.position,
        }));
        Ok(format!(
            "task-{}",
            self.tasks.fetch_add(1, Ordering::SeqCst) + 1
        ))
    }

    /// The TickTick tests' `createProject`, which gives each status the id `<project>-st-<i>`.
    fn create_status_project(
        &self,
        name: &str,
        statuses: &[ImportedStatus],
    ) -> Result<String, SinkError> {
        if self.fail_project.as_deref() == Some(name) {
            return Err(SinkError("project boom".to_owned()));
        }
        let id = format!(
            "project-{}",
            self.projects.fetch_add(1, Ordering::SeqCst) + 1
        );
        self.push(json!({
            "op": "createProject",
            "name": name,
            "statuses": statuses.iter().map(|s| json!({
                "name": s.name,
                "color": s.color,
                "type": kind(s.kind),
                "order": s.order,
            })).collect::<Vec<_>>(),
        }));
        let stored = statuses
            .iter()
            .enumerate()
            .map(|(i, s)| ProjectStatus {
                id: format!("{id}-st-{i}"),
                is_default: i == 0,
                is_done: s.kind == StatusKind::Done,
            })
            .collect();
        self.statuses.lock().unwrap().insert(id.clone(), stored);
        Ok(id)
    }

    fn project_statuses(&self, project_id: &str) -> Vec<ProjectStatus> {
        self.statuses
            .lock()
            .unwrap()
            .get(project_id)
            .cloned()
            .unwrap_or_default()
    }

    fn create_ticktick_task(&self, task: ImportedTickTickTask) -> Result<String, SinkError> {
        if self.fail_ticktick_task.as_deref() == Some(task.title.as_str()) {
            return Err(SinkError("task boom".to_owned()));
        }
        self.push(json!({
            "op": "createTask",
            "projectId": task.project_id,
            "title": task.title,
            "description": task.description,
            "priority": task.priority,
            "statusId": task.status_id,
            "parentId": task.parent_id,
            "position": task.position,
            "startDate": task.start_date,
            "dueDate": task.due_date,
            "dueTime": task.due_time,
            "repeatConfig": task.repeat.map(repeat_record),
            "tags": task.tags,
        }));
        Ok(format!(
            "task-{}",
            self.tasks.fetch_add(1, Ordering::SeqCst) + 1
        ))
    }

    fn create_reminder(&self, task_id: &str, remind_at: &str) -> Result<(), SinkError> {
        if self.fail_reminder {
            return Err(SinkError("reminder boom".to_owned()));
        }
        self.push(json!({ "op": "createReminder", "targetId": task_id, "remindAt": remind_at }));
        Ok(())
    }

    fn create_task(&self, task: ImportedTask) -> Result<String, SinkError> {
        self.push(json!({
            "op": "createTask",
            "projectId": task.project_id,
            "title": task.title,
            "dueDate": task.due_date,
            "parentId": task.parent_id,
            "sourceNoteId": task.source_note_id,
        }));
        Ok(format!(
            "task-{}",
            self.tasks.fetch_add(1, Ordering::SeqCst) + 1
        ))
    }

    fn complete_task(&self, id: &str, completed_at: Option<&str>) -> Result<(), SinkError> {
        if self.fail_complete {
            return Err(SinkError("complete boom".to_owned()));
        }
        self.push(json!({
            "op": "completeTask",
            "id": id,
            "completedAt": completed_at,
            "recordOnly": true,
        }));
        Ok(())
    }

    fn archive_task(&self, id: &str) -> Result<(), SinkError> {
        self.push(json!({ "op": "archiveTask", "id": id }));
        Ok(())
    }

    fn journal_entry_id(&self, date: &str) -> Result<String, SinkError> {
        if self.fail_journal_id {
            return Err(SinkError("no journal id".to_owned()));
        }
        Ok(format!("j{date}"))
    }

    fn read_journal_entry(&self, date: &str) -> Result<Option<JournalEntry>, SinkError> {
        Ok(self.journals.get(date).cloned())
    }

    fn create_journal_entry(&self, entry: ImportedJournalEntry) -> Result<(), SinkError> {
        self.push(json!({
            "op": "createJournalEntry",
            "date": entry.date,
            "tags": entry.tags,
            "properties": entry.properties.map(|properties| properties_record(&properties)),
            "content": entry.content,
        }));
        Ok(())
    }

    fn finish(&self) {
        self.push(json!({ "op": "finish" }));
    }

    /// The generator's `saveBookmark`, with the run's `now` given as `<now>`.
    fn save_bookmark(&self, bookmark: ImportedBookmark) -> Result<(), SinkError> {
        if self.fail_bookmark_url.as_deref() == Some(bookmark.source_url.as_str()) {
            return Err(SinkError("db boom".to_owned()));
        }
        let meta = bookmark.metadata;
        self.push(json!({
            "op": "saveBookmark",
            "title": bookmark.title,
            "content": bookmark.content,
            "sourceUrl": bookmark.source_url,
            "createdAt": bookmark.created_at.as_deref().unwrap_or("<now>"),
            "tags": bookmark.tags,
            "metadata": {
                "url": meta.url,
                "excerpt": meta.excerpt,
                "note": meta.note,
                "folder": meta.folder,
                "favorite": meta.favorite,
                "heroImage": meta.hero_image,
                "highlights": meta.highlights,
            },
        }));
        Ok(())
    }
}

fn kind(kind: StatusKind) -> &'static str {
    match kind {
        StatusKind::Todo => "todo",
        StatusKind::InProgress => "in_progress",
        StatusKind::Done => "done",
    }
}

/// A JS number as `JSON.stringify` writes it: `null` for `NaN` and the infinities.
fn js_number(n: f64) -> Value {
    if !n.is_finite() {
        Value::Null
    } else if n.fract() == 0.0 && n.abs() < 9.007_199_254_740_992e15 {
        json!(n as i64)
    } else {
        json!(n)
    }
}

/// `RepeatConfig` as `JSON.stringify` writes it.
fn repeat_record(repeat: ImportedRepeat) -> Value {
    let mut record = json!({
        "frequency": format!("{:?}", repeat.frequency).to_lowercase(),
        "interval": js_number(repeat.interval),
        "endType": "never",
        "completedCount": 0,
        "createdAt": repeat.created_at,
    });
    let fields = record.as_object_mut().unwrap();
    if let Some(days) = repeat.days_of_week {
        fields.insert("daysOfWeek".to_owned(), json!(days));
    }
    match repeat.monthly {
        Some(MonthlyRepeat::DayOfMonth(day)) => {
            fields.insert("monthlyType".to_owned(), json!("dayOfMonth"));
            fields.insert("dayOfMonth".to_owned(), js_number(day));
        }
        Some(MonthlyRepeat::WeekPattern {
            week_of_month,
            day_of_week,
        }) => {
            fields.insert("monthlyType".to_owned(), json!("weekPattern"));
            fields.insert("weekOfMonth".to_owned(), js_number(week_of_month));
            if let Some(day) = day_of_week {
                fields.insert("dayOfWeekForMonth".to_owned(), json!(day));
            }
        }
        None => {}
    }
    match repeat.end {
        RepeatEnd::Never => {}
        RepeatEnd::Date(date) => {
            fields.insert("endType".to_owned(), json!("date"));
            fields.insert("endDate".to_owned(), json!(date));
        }
        RepeatEnd::Count(count) => {
            fields.insert("endType".to_owned(), json!("count"));
            fields.insert("endCount".to_owned(), js_number(count));
        }
    }
    record
}

/// The generator's `noteRecord`.
fn note_record(op: &str, note: ImportedNote) -> Value {
    json!({
            "op": op,
            "id": note.id,
            "title": note.title,
            "folder": note.folder,
            "tags": note.tags,
            "properties": properties_record(&note.properties),
            "created": note.created.map(|_| "<birthtime>"),
            "modified": note.modified,
            "content": note.content,
    })
}

/// `Object.entries(properties)` with each value tagged.
fn properties_record(properties: &YamlMap) -> Value {
    properties
        .iter()
        .map(|(key, value)| json!([key, tag_value(value)]))
        .collect()
}

/// The generator's `tagValue`: a frontmatter value as `JSON.stringify` writes it, with the
/// types JSON lacks tagged.
fn tag_value(value: &YamlValue) -> Value {
    match value {
        YamlValue::Null => Value::Null,
        YamlValue::Bool(flag) => Value::Bool(*flag),
        YamlValue::Number(n) if !n.is_finite() => {
            let text = if n.is_nan() {
                "NaN"
            } else if *n > 0.0 {
                "Infinity"
            } else {
                "-Infinity"
            };
            json!({ "$number": text })
        }
        // JSON.stringify writes an integral double, -0 included, without a fraction.
        YamlValue::Number(n) if n.fract() == 0.0 && n.abs() < 9.007_199_254_740_992e15 => {
            json!(*n as i64)
        }
        YamlValue::Number(n) => json!(n),
        YamlValue::String(text) => json!(text),
        YamlValue::Date(ms) => {
            let at = chrono::DateTime::from_timestamp_millis(*ms).expect("a date in range");
            json!({ "$date": at.to_rfc3339_opts(chrono::SecondsFormat::Millis, true) })
        }
        YamlValue::Binary(bytes) => {
            json!({ "$binary": base64::engine::general_purpose::STANDARD.encode(bytes.as_slice()) })
        }
        YamlValue::Seq(items) => Value::Array(items.iter().map(tag_value).collect()),
        YamlValue::Map(map) => json!({
            "$map": map.iter().map(|(key, inner)| json!([key, tag_value(inner)])).collect::<Vec<_>>()
        }),
    }
}

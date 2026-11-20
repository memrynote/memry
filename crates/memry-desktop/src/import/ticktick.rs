//! The TickTick importer: `apps/desktop/src/main/import/ticktick/{ticktick-importer,apply-plan}.ts`
//! and `packages/importers/src/ticktick/`.
//!
//! A TickTick backup CSV holds every list. Each list becomes a project with statuses (its kanban
//! columns, or To Do, In Progress and Done), except `Inbox`, whose tasks go to the vault's Inbox
//! project. Rows become tasks with parents, statuses, positions, dates in the task's time zone,
//! repeats and reminders; a completed task is completed and a won't-do task archived after it is
//! created, and a reminder in the past is skipped.
//!
//! Electron parsed every file into a plan and held them all before the first write, with no
//! bound. Here the reader keeps only the columns `mapRows` reads, and the plans of one run share a
//! [`MAX_PLANNED_BYTES`] budget. A file past it fails before any of its writes, and the other
//! files still import.

mod dates;
mod map;
mod order;
mod rrule;

use std::collections::HashMap;
use std::path::Path;

use jiff::tz::TimeZone;
use memry_core::markdown::frontmatter::js_trim;
use tokio_util::sync::CancellationToken;

use super::csv_lex::lex;
use super::messages::{ImportMessage, ImportText, codes, status};
use super::todoist::parse_int;
use super::{
    FileSpec, ImportContext, ImportError, ImportInput, ImportPhase, ImportPreview, ImportSink,
    ImportedTickTickTask, Importer, ImporterMeta, MAX_PLANNED_BYTES, PreviewCount, PreviewGroup,
    StatusKind, base_name, read_source_text,
};
use crate::web::extract::utils::date::iso_string;
use map::{Plan, Row, map_rows};

/// What a planned row or status costs besides the text it stores: the structs, their strings'
/// headers and the allocator's overhead.
const ITEM_COST: usize = 1024;
/// What a warning costs besides its text, which it stores twice (message and params).
const WARNING_COST: usize = 256;
// The budget holds 300,000 tasks with 300 bytes of text and one warning each.
const _: () = assert!(MAX_PLANNED_BYTES / (ITEM_COST + 300 + WARNING_COST + 2 * 100) >= 300_000);
const SAMPLE_MAX: usize = 5;
const TOO_MANY: &str = "The picked TickTick files hold more tasks than one import can take. \
                        Import fewer files at a time, or split the export into smaller files.";
const HEADER_FIRST_CELL: &str = "Folder Name";

/// The columns `parseTickTickCsv` fills that `mapRows` reads.
const COLUMNS: [&str; 19] = [
    "Folder Name",
    "List Name",
    "Title",
    "Tags",
    "Content",
    "Start Date",
    "Due Date",
    "Reminder",
    "Repeat",
    "Priority",
    "Status",
    "Completed Time",
    "Order",
    "Timezone",
    "Is All Day",
    "Column Name",
    "Column Order",
    "taskId",
    "parentId",
];

/// The bytes one run's plans may still take.
struct Budget(usize);

impl Budget {
    fn charge(&mut self, cost: usize) -> Result<(), String> {
        self.0 = self
            .0
            .checked_sub(cost)
            .ok_or_else(|| TOO_MANY.to_owned())?;
        Ok(())
    }
}

/// `int`: `parseInt(raw.trim(), 10)`, 0 for `NaN`.
fn int(raw: &str) -> f64 {
    match parse_int(js_trim(raw)) {
        n if n.is_nan() => 0.0,
        n => n,
    }
}

/// `bool`.
fn flag(raw: &str) -> bool {
    js_trim(raw).to_lowercase() == "true"
}

/// `splitTags`.
fn split_tags(raw: &str) -> Vec<String> {
    raw.split(',')
        .map(|tag| js_trim(tag).to_lowercase())
        .filter(|tag| !tag.is_empty())
        .collect()
}

/// `parseTickTickCsv` in one pass over the export.
struct Reader<'b> {
    /// Each cell index's column, once the header row ended.
    columns: Option<Vec<Option<usize>>>,
    /// The header row being read, and the columns it named so far (a column is found by its
    /// first header, as `indexOf`).
    header: Option<(Vec<Option<usize>>, [bool; 19])>,
    at: usize,
    cells: [String; 19],
    /// Whether a cell of the row being read is not empty.
    filled: bool,
    rows: Vec<Row>,
    budget: &'b mut Budget,
    failure: Option<String>,
}

impl Reader<'_> {
    fn field(&mut self, text: &str) {
        if let Some(columns) = &self.columns {
            self.filled |= !text.is_empty();
            if let Some(Some(column)) = columns.get(self.at) {
                text.clone_into(&mut self.cells[*column]);
            }
        } else if let Some((header, named)) = &mut self.header {
            let name = js_trim(text);
            let column = COLUMNS
                .iter()
                .position(|c| *c == name)
                .filter(|c| !std::mem::replace(&mut named[*c], true));
            header.push(column);
        } else if self.at == 0 && js_trim(text) == HEADER_FIRST_CELL {
            let mut named = [false; 19];
            named[0] = true;
            self.header = Some((vec![Some(0)], named));
        }
        self.at += 1;
    }

    /// Ends a row; false once the plan failed.
    fn row_end(&mut self) -> bool {
        self.at = 0;
        if self.columns.is_none() {
            self.columns = self.header.take().map(|(header, _)| header);
            return true;
        }
        let cells = std::mem::take(&mut self.cells);
        if std::mem::take(&mut self.filled) {
            let cost = ITEM_COST + cells.iter().map(String::len).sum::<usize>();
            if let Err(failure) = self.budget.charge(cost) {
                self.failure = Some(failure);
                return false;
            }
            self.rows.push(row(cells));
        }
        true
    }
}

fn row(cells: [String; 19]) -> Row {
    let [
        folder,
        list,
        title,
        tags,
        content,
        start,
        due,
        reminder,
        repeat,
        priority,
        status,
        completed,
        order,
        timezone,
        all_day,
        column,
        column_order,
        task_id,
        parent_id,
    ] = cells;
    Row {
        folder: !js_trim(&folder).is_empty(),
        list,
        title,
        tags: split_tags(&tags),
        content,
        start,
        due,
        reminder,
        repeat,
        priority: int(&priority),
        status: int(&status),
        completed,
        order,
        timezone,
        all_day: flag(&all_day),
        column,
        column_order,
        task_id,
        parent_id,
    }
}

/// Reads and plans one file, charging `budget` only when the whole file fits.
fn plan_file(
    path: &Path,
    now: &str,
    local: &TimeZone,
    budget: &mut Budget,
) -> Result<Plan, ImportMessage> {
    let text = read_source_text(path).map_err(|error| message(error.to_string()))?;
    let text = text.strip_prefix('\u{FEFF}').unwrap_or(&text);
    let mut left = Budget(budget.0);
    let mut reader = Reader {
        columns: None,
        header: None,
        at: 0,
        cells: Default::default(),
        filled: false,
        rows: Vec::new(),
        budget: &mut left,
        failure: None,
    };
    lex(text, |event| match event {
        Some(field) => {
            reader.field(field);
            true
        }
        None => reader.row_end(),
    });
    if let Some(failure) = reader.failure {
        return Err(message(failure));
    }
    if reader.columns.is_none() {
        return Err(ImportMessage::coded(
            codes::TICKTICK_HEADER_NOT_FOUND,
            "TickTick CSV header row (\"Folder Name\") not found",
        ));
    }
    let rows = reader.rows;
    let plan = map_rows(rows, now, local, &mut left).map_err(message)?;
    *budget = left;
    Ok(plan)
}

fn message(text: String) -> ImportMessage {
    ImportMessage {
        code: None,
        message: text,
        params: None,
    }
}

/// `applyPlan`: writes one file's plan. Warnings Electron collected and never showed are logged.
fn apply(plan: Plan, sink: &dyn ImportSink, ctx: &mut ImportContext, now_ms: f64) {
    let mut project_ids: Vec<Option<String>> = Vec::with_capacity(plan.projects.len());
    let mut status_ids: HashMap<usize, String> = HashMap::new();
    for project in &plan.projects {
        if project.inbox {
            let Some(inbox) = sink.inbox_project_id() else {
                tracing::warn!(
                    scope = "import",
                    "No inbox project found; Inbox tasks skipped"
                );
                project_ids.push(None);
                continue;
            };
            let real = sink.project_statuses(&inbox);
            let real_todo = real.iter().find(|s| s.is_default).or(real.first());
            let real_done = real.iter().find(|s| s.is_done).or(real_todo);
            let planned = project.statuses.iter().zip(&project.status_ids);
            let plan_todo = planned.clone().find(|(s, _)| s.kind != StatusKind::Done);
            let plan_done = planned.clone().find(|(s, _)| s.kind == StatusKind::Done);
            for (planned, real) in [(plan_todo, real_todo), (plan_done, real_done)] {
                if let (Some((_, temp)), Some(real)) = (planned, real) {
                    status_ids.insert(*temp, real.id.clone());
                }
            }
            project_ids.push(Some(inbox));
            continue;
        }
        let id = match sink.create_status_project(&project.name, &project.statuses) {
            Ok(id) => id,
            Err(_) => {
                tracing::warn!(scope = "import", "TickTick project creation failed");
                project_ids.push(None);
                continue;
            }
        };
        for (temp, real) in project.status_ids.iter().zip(sink.project_statuses(&id)) {
            status_ids.insert(*temp, real.id);
        }
        project_ids.push(Some(id));
    }

    // Parents before children so a parent id resolves; otherwise in plan order.
    let mut order: Vec<usize> = (0..plan.tasks.len()).collect();
    order.sort_by_key(|&at| plan.tasks[at].parent.is_some());
    let mut real_ids: Vec<Option<String>> = vec![None; plan.tasks.len()];
    let mut tasks: Vec<Option<map::Task>> = plan.tasks.into_iter().map(Some).collect();
    for at in order {
        if ctx.is_cancelled() {
            return;
        }
        let task = tasks[at].take().expect("each task is applied once");
        let Some(project_id) = project_ids[task.project].clone() else {
            ctx.report_skipped(&task.title, Some("no project".into()));
            continue;
        };
        let title = task.title.clone();
        let created = sink.create_ticktick_task(ImportedTickTickTask {
            project_id,
            title: task.title,
            description: task.description,
            priority: task.priority,
            status_id: task.status.and_then(|id| status_ids.get(&id).cloned()),
            parent_id: task.parent.and_then(|parent| real_ids[parent].clone()),
            position: task.position,
            start_date: task.start_date,
            due_date: task.due_date,
            due_time: task.due_time,
            repeat: task.repeat,
            tags: task.tags,
        });
        let id = match created {
            Ok(id) => id,
            Err(error) => {
                ctx.report_failed(&title, &error.0);
                continue;
            }
        };
        real_ids[at] = Some(id.clone());
        ctx.report_imported();

        let completed = task
            .completed_at
            .map_or(Ok(()), |at| sink.complete_task(&id, Some(&at)));
        let archived = completed.and_then(|()| {
            if task.archived {
                sink.archive_task(&id)
            } else {
                Ok(())
            }
        });
        if let Err(error) = archived {
            ctx.report_failed(&title, &error.0);
            continue;
        }
        for reminder in task.reminders {
            if reminder.ms <= now_ms {
                ctx.report_skipped(&title, Some("reminder in the past".into()));
                continue;
            }
            if sink.create_reminder(&id, &reminder.at).is_err() {
                tracing::warn!(scope = "import", "TickTick reminder creation failed");
            }
        }
    }
}

pub struct TickTickImporter {
    /// The run's [`MAX_PLANNED_BYTES`]; tests lower it.
    pub budget: usize,
    /// The clock in milliseconds since the epoch; `None` is the system clock, as Electron's
    /// `Date.now()`.
    pub now: Option<f64>,
    /// The zone `new Date(text)` reads a time without a zone in; `None` is the system zone.
    pub local: Option<TimeZone>,
}

impl Default for TickTickImporter {
    fn default() -> Self {
        Self {
            budget: MAX_PLANNED_BYTES,
            now: None,
            local: None,
        }
    }
}

impl TickTickImporter {
    fn now_ms(&self) -> f64 {
        self.now
            .unwrap_or_else(|| chrono::Utc::now().timestamp_millis() as f64)
    }

    fn now_iso(&self) -> String {
        iso_string(Some(self.now_ms())).expect("the clock is inside the Date range")
    }

    fn local(&self) -> TimeZone {
        self.local.clone().unwrap_or_else(|| {
            TimeZone::try_system().unwrap_or_else(|_| {
                tracing::warn!(scope = "import", "system time zone unknown; reading UTC");
                TimeZone::UTC
            })
        })
    }
}

impl Importer for TickTickImporter {
    fn meta(&self) -> ImporterMeta {
        ImporterMeta {
            id: "ticktick".to_owned(),
            name: "TickTick".to_owned(),
            description_key: "import.sources.ticktick".to_owned(),
            file_spec: FileSpec {
                label: "TickTick CSV backup".to_owned(),
                extensions: vec!["csv".to_owned()],
                allow_multiple: true,
                ..FileSpec::default()
            },
            supports_preview: true,
            account_based: false,
        }
    }

    /// `buildTickTickPreview`.
    fn preview(
        &self,
        input: &ImportInput,
        cancel: &CancellationToken,
    ) -> Result<ImportPreview, ImportError> {
        let (now, local) = (self.now_iso(), self.local());
        let mut budget = Budget(self.budget);
        let mut groups = Vec::new();
        for source in &input.source_paths {
            if cancel.is_cancelled() {
                break;
            }
            let path = Path::new(source);
            groups.push(match plan_file(path, &now, &local, &mut budget) {
                Ok(plan) => PreviewGroup {
                    label: base_name(path),
                    counts: vec![
                        count("import.stats.projects", plan.projects.len()),
                        count("import.stats.tasks", plan.tasks.len()),
                        count("import.stats.subtasks", plan.subtasks),
                        count("import.stats.reminders", plan.reminders),
                    ],
                    sample_titles: Some(
                        plan.tasks
                            .iter()
                            .take(SAMPLE_MAX)
                            .map(|task| task.title.clone())
                            .collect(),
                    ),
                    warnings: Some(plan.warnings.into_iter().map(ImportText::Message).collect()),
                    error: None,
                },
                Err(error) => PreviewGroup {
                    label: base_name(path),
                    counts: Vec::new(),
                    sample_titles: None,
                    warnings: None,
                    error: Some(ImportText::Message(error)),
                },
            });
        }
        Ok(ImportPreview { groups })
    }

    /// `ticktickImporter.run` and `runTickTickImport`.
    fn run(
        &self,
        input: &ImportInput,
        ctx: &mut ImportContext,
        sink: &dyn ImportSink,
    ) -> Result<(), ImportError> {
        ctx.set_phase(ImportPhase::Importing);
        ctx.status(status("ticktickImporting"));

        let (now, local) = (self.now_iso(), self.local());
        let mut budget = Budget(self.budget);
        let plans: Vec<(String, Result<Plan, ImportMessage>)> = input
            .source_paths
            .iter()
            .map(|source| {
                let path = Path::new(source);
                (base_name(path), plan_file(path, &now, &local, &mut budget))
            })
            .collect();
        let total = plans
            .iter()
            .map(|(_, plan)| plan.as_ref().map_or(0, |plan| plan.tasks.len()))
            .sum();
        let mut done = 0;
        ctx.report_progress(0, total);

        for (file_name, plan) in plans {
            if ctx.is_cancelled() {
                return Ok(());
            }
            let plan = match plan {
                Ok(plan) => plan,
                Err(error) => {
                    tracing::error!(scope = "import", "TickTick import failed for a file");
                    ctx.report_failed(&file_name, &error.message);
                    continue;
                }
            };
            done += plan.tasks.len();
            apply(plan, sink, ctx, self.now_ms());
            ctx.report_progress(done, total);
        }
        Ok(())
    }
}

fn count(label_key: &str, value: usize) -> PreviewCount {
    PreviewCount {
        label_key: label_key.to_owned(),
        value,
    }
}

//! The Todoist importer: `apps/desktop/src/main/import/todoist/todoist-importer.ts` and
//! `packages/importers/src/todoist/{parse-csv,map-rows,priority,dates,attachments}.ts`.
//!
//! Each picked Todoist project CSV becomes one project ([`ImportSink::create_project`], named for
//! the file) and its task rows become that project's tasks
//! ([`ImportSink::create_project_task`]), parents before children. Comment rows append to the
//! task above them, sections are flattened, and DATE (or DEADLINE) becomes the due date.
//!
//! Electron parsed every file into a plan and held them all before the first write, with no
//! bound. Here the reader keeps only the columns Electron reads, and the plans of one run share a
//! [`MAX_PLANNED_BYTES`] budget. A file past it fails before its project is created, and the
//! other files still import.

mod comment;
mod dates;

use std::path::Path;

use chrono::NaiveDate;
use memry_core::markdown::frontmatter::{js_trim, number_to_string};
use serde_json::Value;
use tokio_util::sync::CancellationToken;

use super::csv_lex::{lex, step};
use super::messages::{ImportMessage, ImportText, codes, status};
use super::{
    FileSpec, ImportContext, ImportError, ImportInput, ImportPhase, ImportPreview, ImportSink,
    ImportedProjectTask, Importer, ImporterMeta, MAX_PLANNED_BYTES, PreviewCount, PreviewGroup,
    base_name, read_source_text,
};
use comment::comment_to_markdown;
use dates::resolve_due_date;

/// What a planned task costs besides the text it stores: the struct, its strings' headers and
/// the allocator's overhead.
const ITEM_COST: usize = 512;
/// What a warning costs besides its text, which it stores twice (message and params).
const WARNING_COST: usize = 256;
// The budget holds 300,000 tasks with 300 bytes of text and one warning each.
const _: () = assert!(MAX_PLANNED_BYTES / (ITEM_COST + 300 + WARNING_COST + 2 * 100) >= 300_000);
const SAMPLE_MAX: usize = 5;
const DEFAULT_PROJECT: &str = "Imported Todoist Project";
const TOO_MANY: &str = "The picked Todoist files hold more tasks than one import can take. \
                        Import fewer files at a time, or split the export into smaller files.";
/// The `RangeError` V8 threw on `stack.length = indent + 1` past 2^32 - 1, failing the file.
const INVALID_ARRAY_LENGTH: &str = "Invalid array length";
const MAX_ARRAY_LENGTH: f64 = 4_294_967_295.0;

/// The columns `parseTodoistCsv` reads (TIMEZONE is read but never used).
const COLUMNS: [&str; 8] = [
    "TYPE",
    "CONTENT",
    "DESCRIPTION",
    "PRIORITY",
    "INDENT",
    "DATE",
    "DATE_LANG",
    "DEADLINE",
];
const TYPE: usize = 0;
const CONTENT: usize = 1;
const DESCRIPTION: usize = 2;
const PRIORITY: usize = 3;
const INDENT: usize = 4;
const DATE: usize = 5;
const DATE_LANG: usize = 6;
const DEADLINE: usize = 7;

/// `TaskPlan`; its temp id is its index and its position.
struct Task {
    parent: Option<usize>,
    title: String,
    description: Option<String>,
    priority: u8,
    due: Option<dates::DueDate>,
}

/// `ImportPlan`, without the stats nothing reads.
#[derive(Default)]
struct Plan {
    tasks: Vec<Task>,
    warnings: Vec<ImportMessage>,
    comments: usize,
    skipped: usize,
}

/// `parseInt(text, 10)` of a trimmed cell.
pub(super) fn parse_int(text: &str) -> f64 {
    let (sign, digits) = match text.as_bytes().first() {
        Some(b'-') => (-1.0, &text[1..]),
        Some(b'+') => (1.0, &text[1..]),
        _ => (1.0, text),
    };
    let end = digits
        .find(|c: char| !c.is_ascii_digit())
        .unwrap_or(digits.len());
    match digits[..end].parse::<f64>() {
        Ok(value) => sign * value,
        Err(_) => f64::NAN,
    }
}

/// `parseInt(...) || fallback`.
fn int_or(text: &str, fallback: f64) -> f64 {
    match parse_int(text) {
        n if n.is_nan() || n == 0.0 => fallback,
        n => n,
    }
}

/// A JS number as `JSON.stringify` writes it and `serde_json` reads it back.
pub(super) fn json_number(n: f64) -> Value {
    if n.fract() == 0.0 && n.abs() < 9.0e18 {
        Value::from(n as i64)
    } else {
        Value::from(n)
    }
}

/// `todoistPriorityToMemry`.
fn memry_priority(n: f64) -> u8 {
    match n {
        4.0 => 4,
        3.0 => 3,
        2.0 => 2,
        _ => 0,
    }
}

/// `parseTodoistCsv` and `mapRows` in one pass over the export.
struct Reader<'b> {
    today: NaiveDate,
    /// Each column's first index, once the `TYPE` header row ended.
    columns: Option<[Option<usize>; 8]>,
    /// The header row being read.
    header: Option<[Option<usize>; 8]>,
    at: usize,
    cells: [String; 8],
    plan: Plan,
    /// `stack`, by indent level, as (level, task) in strictly increasing level.
    stack: Vec<(u64, usize)>,
    last_task: Option<usize>,
    budget: &'b mut usize,
    failure: Option<&'static str>,
}

impl Reader<'_> {
    fn field(&mut self, text: &str) {
        if let Some(columns) = &self.columns {
            if let Some(column) = columns.iter().position(|c| *c == Some(self.at)) {
                text.clone_into(&mut self.cells[column]);
            }
        } else if let Some(header) = &mut self.header {
            let name = js_trim(text).to_uppercase();
            if let Some(column) = COLUMNS.iter().position(|c| *c == name) {
                header[column].get_or_insert(self.at);
            }
        } else if self.at == 0 && js_trim(text).to_uppercase() == "TYPE" {
            let mut header = [None; 8];
            header[TYPE] = Some(0);
            self.header = Some(header);
        }
        self.at += 1;
    }

    /// Ends a row; false once the plan failed.
    fn row_end(&mut self) -> bool {
        self.at = 0;
        if self.columns.is_none() {
            self.columns = self.header.take();
            return true;
        }
        let cells = std::mem::take(&mut self.cells);
        self.map_row(&cells);
        self.failure.is_none()
    }

    fn charge(&mut self, cost: usize) -> bool {
        match self.budget.checked_sub(cost) {
            Some(left) => *self.budget = left,
            None => {
                self.failure.get_or_insert(TOO_MANY);
            }
        }
        self.failure.is_none()
    }

    /// Records a warning without Electron's `row`, which the renderer never reads.
    fn warn(&mut self, warning: ImportMessage) {
        if self.charge(WARNING_COST + 2 * warning.message.len()) {
            self.plan.warnings.push(warning);
        }
    }

    fn map_row(&mut self, cells: &[String; 8]) {
        match js_trim(&cells[TYPE]).to_lowercase().as_str() {
            "section" => {
                let section = js_trim(&cells[CONTENT]);
                self.warn(
                    ImportMessage::coded(
                        codes::TODOIST_SECTION_FLATTENED,
                        format!("Section \"{section}\" flattened"),
                    )
                    .with_param("section", section),
                );
                self.last_task = None;
                self.stack.clear();
            }
            "note" => {
                let Some(task) = self.last_task else {
                    self.plan.skipped += 1;
                    self.warn(ImportMessage::coded(
                        codes::TODOIST_ORPHAN_COMMENT,
                        "Comment with no preceding task skipped",
                    ));
                    return;
                };
                let md = comment_to_markdown(&cells[CONTENT]);
                if !md.is_empty() && self.charge(md.len() + 2) {
                    let description = &mut self.plan.tasks[task].description;
                    match description {
                        Some(text) => {
                            text.push_str("\n\n");
                            text.push_str(&md);
                        }
                        None => *description = Some(md),
                    }
                    self.plan.comments += 1;
                }
            }
            "task" => self.task(cells),
            _ => {}
        }
    }

    fn task(&mut self, cells: &[String; 8]) {
        let mut title = js_trim(&cells[CONTENT]).to_owned();
        if title.is_empty() {
            title = "(untitled)".to_owned();
            self.warn(ImportMessage::coded(
                codes::TODOIST_EMPTY_TITLE,
                "Task with empty content imported as (untitled)",
            ));
        }

        let priority = int_or(js_trim(&cells[PRIORITY]), 0.0);
        if !(1.0..=4.0).contains(&priority) {
            self.warn(
                ImportMessage::coded(
                    codes::TODOIST_UNKNOWN_PRIORITY,
                    format!(
                        "Unknown priority {} \u{2192} none",
                        number_to_string(priority)
                    ),
                )
                .with_param("priority", json_number(priority)),
            );
        }

        let date = js_trim(&cells[DATE]);
        let mut due = None;
        if !date.is_empty() {
            due = resolve_due_date(date, self.today, js_trim(&cells[DATE_LANG]));
            if due.is_none() {
                self.warn(
                    ImportMessage::coded(
                        codes::TODOIST_UNPARSED_DATE,
                        format!("Could not parse date \"{date}\""),
                    )
                    .with_param("date", date),
                );
            }
        }
        let deadline = js_trim(&cells[DEADLINE]);
        if due.is_none() && !deadline.is_empty() {
            due = resolve_due_date(deadline, self.today, "en");
        }

        let indent = int_or(js_trim(&cells[INDENT]), 1.0).max(1.0);
        if indent >= MAX_ARRAY_LENGTH {
            self.failure.get_or_insert(INVALID_ARRAY_LENGTH);
            return;
        }
        let indent = indent as u64;
        let mut parent = None;
        if indent > 1 {
            parent = self
                .stack
                .binary_search_by_key(&(indent - 1), |(level, _)| {
                    step();
                    *level
                })
                .ok()
                .map(|at| self.stack[at].1);
            if parent.is_none() {
                let level = indent - 1;
                self.warn(
                    ImportMessage::coded(
                        codes::TODOIST_SUBTASK_NO_PARENT,
                        format!(
                            "Sub-task \"{title}\" has no parent at indent {level}; imported top-level"
                        ),
                    )
                    .with_param("title", title.as_str())
                    .with_param("indent", level),
                );
            }
        }

        let task = Task {
            parent,
            description: Some(js_trim(&cells[DESCRIPTION]))
                .filter(|text| !text.is_empty())
                .map(str::to_owned),
            priority: memry_priority(priority),
            due,
            title,
        };
        let cost =
            ITEM_COST + task.title.len() + task.description.as_ref().map_or(0, String::len) + 16;
        if !self.charge(cost) {
            return;
        }
        let at = self.plan.tasks.len();
        self.plan.tasks.push(task);
        while self.stack.last().is_some_and(|(level, _)| *level >= indent) {
            step();
            self.stack.pop();
        }
        self.stack.push((indent, at));
        self.last_task = Some(at);
    }
}

/// `projectNameFromPath`: the file name without `.csv` (any case), trimmed.
fn project_name(path: &Path) -> String {
    let name = base_name(path);
    let stem = match name.len().checked_sub(4) {
        Some(at) if name.is_char_boundary(at) && name[at..].eq_ignore_ascii_case(".csv") => {
            &name[..at]
        }
        _ => &name,
    };
    match js_trim(stem) {
        "" => DEFAULT_PROJECT.to_owned(),
        stem => stem.to_owned(),
    }
}

/// Reads and plans one file, charging `budget` only when the whole file fits.
fn plan_file(path: &Path, today: NaiveDate, budget: &mut usize) -> Result<Plan, ImportMessage> {
    let text = read_source_text(path).map_err(|error| message(error.to_string()))?;
    let text = text.strip_prefix('\u{FEFF}').unwrap_or(&text);
    let mut left = *budget;
    let mut reader = Reader {
        today,
        columns: None,
        header: None,
        at: 0,
        cells: Default::default(),
        plan: Plan::default(),
        stack: Vec::new(),
        last_task: None,
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
        return Err(message(failure.to_owned()));
    }
    if reader.columns.is_none() {
        return Err(ImportMessage::coded(
            codes::TODOIST_HEADER_NOT_FOUND,
            "Not a Todoist CSV: missing TYPE header row",
        ));
    }
    let plan = reader.plan;
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

pub struct TodoistImporter {
    /// The run's [`MAX_PLANNED_BYTES`]; tests lower it.
    pub budget: usize,
    /// The day relative dates count from; `None` is today in local time, as Electron's `new
    /// Date()`. The vectors fix it.
    pub today: Option<NaiveDate>,
}

impl Default for TodoistImporter {
    fn default() -> Self {
        Self {
            budget: MAX_PLANNED_BYTES,
            today: None,
        }
    }
}

impl TodoistImporter {
    fn today(&self) -> NaiveDate {
        self.today
            .unwrap_or_else(|| chrono::Local::now().date_naive())
    }
}

impl Importer for TodoistImporter {
    fn meta(&self) -> ImporterMeta {
        ImporterMeta {
            id: "todoist".to_owned(),
            name: "Todoist".to_owned(),
            description_key: "import.sources.todoist".to_owned(),
            file_spec: FileSpec {
                label: "Todoist CSV export".to_owned(),
                extensions: vec!["csv".to_owned()],
                allow_multiple: true,
                ..FileSpec::default()
            },
            supports_preview: true,
            account_based: false,
        }
    }

    /// `buildTodoistPreview`.
    fn preview(
        &self,
        input: &ImportInput,
        cancel: &CancellationToken,
    ) -> Result<ImportPreview, ImportError> {
        let today = self.today();
        let mut budget = self.budget;
        let mut groups = Vec::new();
        for source in &input.source_paths {
            if cancel.is_cancelled() {
                break;
            }
            let path = Path::new(source);
            groups.push(match plan_file(path, today, &mut budget) {
                Ok(plan) => PreviewGroup {
                    label: project_name(path),
                    counts: vec![
                        count("import.stats.tasks", plan.tasks.len()),
                        count(
                            "import.stats.subtasks",
                            plan.tasks.iter().filter(|t| t.parent.is_some()).count(),
                        ),
                        count(
                            "import.stats.withDueDate",
                            plan.tasks.iter().filter(|t| t.due.is_some()).count(),
                        ),
                        count("import.stats.comments", plan.comments),
                        count("import.stats.skipped", plan.skipped),
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

    /// `todoistImporter.run` and `applyTodoistImport`.
    fn run(
        &self,
        input: &ImportInput,
        ctx: &mut ImportContext,
        sink: &dyn ImportSink,
    ) -> Result<(), ImportError> {
        ctx.set_phase(ImportPhase::Importing);
        ctx.status(status("todoistImporting"));

        let today = self.today();
        let mut budget = self.budget;
        let plans: Vec<(String, String, Result<Plan, ImportMessage>)> = input
            .source_paths
            .iter()
            .map(|source| {
                let path = Path::new(source);
                let plan = plan_file(path, today, &mut budget);
                (base_name(path), project_name(path), plan)
            })
            .collect();
        let total = plans
            .iter()
            .map(|(_, _, plan)| plan.as_ref().map_or(0, |plan| plan.tasks.len()))
            .sum();
        let mut done = 0;
        ctx.report_progress(0, total);

        for (file_name, project, plan) in plans {
            if ctx.is_cancelled() {
                return Ok(());
            }
            let plan = match plan {
                Ok(plan) => plan,
                Err(error) => {
                    tracing::error!(scope = "import", "Todoist import failed for a file");
                    ctx.report_failed(&file_name, &error.message);
                    continue;
                }
            };
            let project_id = match sink.create_project(&project) {
                Ok(id) => id,
                Err(error) => {
                    tracing::error!(scope = "import", "Todoist project creation failed");
                    ctx.report_failed(&file_name, &error.0);
                    continue;
                }
            };
            let mut ids: Vec<String> = Vec::with_capacity(plan.tasks.len());
            for (position, task) in plan.tasks.into_iter().enumerate() {
                if ctx.is_cancelled() {
                    return Ok(());
                }
                let (due_date, due_time) = task.due.unzip();
                let created = sink.create_project_task(ImportedProjectTask {
                    project_id: project_id.clone(),
                    parent_id: task.parent.map(|parent| ids[parent].clone()),
                    title: task.title,
                    description: task.description,
                    priority: task.priority,
                    due_date,
                    due_time: due_time.flatten(),
                    position,
                });
                match created {
                    Ok(id) => ids.push(id),
                    Err(error) => {
                        tracing::error!(scope = "import", "Todoist task creation failed");
                        ctx.report_failed(&file_name, &error.0);
                        break;
                    }
                }
                done += 1;
                ctx.report_imported();
                ctx.report_progress(done, total);
            }
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

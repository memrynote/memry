//! The NotePlan 3 importer: `apps/desktop/src/main/import/noteplan/noteplan-importer.ts` over
//! the mappers of `packages/importers/src/noteplan/`.
//!
//! The pick is a NotePlan data folder, one of its `Backups/<stamp>` copies, or a bare notes
//! folder ([`scan`]):
//!
//! - `Calendar/YYYYMMDD.txt` becomes the journal entry of that day, appended below a rule when
//!   the day already has one;
//! - `Calendar/YYYY-Wnn|MM|Qn|YYYY` becomes a note in `NotePlan/Calendar`;
//! - `Notes/**` becomes notes in `NotePlan/<folder>`, `@Archive/**` in `NotePlan/Archive`.
//!
//! NotePlan's `*` lines are tasks: each becomes a task row in the Inbox project, linked to its
//! note, and the line a `- [ ] title {task:<id>}` checkbox ([`map::convert_body`]). `+` lines
//! are checklists and stay plain checkboxes, so the note is created as written, without the
//! sink's checklist step.

mod map;
mod scan;

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::Path;
use std::sync::LazyLock;
use std::time::SystemTime;

use chrono::{DateTime, SecondsFormat, Utc};
use memry_core::markdown::frontmatter::{
    YamlMap, YamlValue, gray_matter_data, gray_matter_parts, js_trim,
};

pub use map::{
    CalendarFile, ConvertedBody, ParsedTask, TaskState, classify_calendar_stem, convert_body,
    first_heading, lines_scanned, parse_tags, strip_first_heading, task_placeholder,
};
pub use scan::{ALREADY_WALKED, LINK_NOT_FOLLOWED, MAX_FOLDER_DEPTH, RESERVED_NAME, TOO_DEEP};

use super::assets::{AssetNote, RealRoots, resolve_co_located_assets};
use super::markdown::object_entries;
use super::messages::{ImportText, importing_item, status};
use super::{
    FileSpec, ImportContext, ImportError, ImportInput, ImportPhase, ImportSink,
    ImportedJournalEntry, ImportedNote, ImportedTask, Importer, ImporterMeta, read_source_text,
};
use regex::{Captures, Regex};
use scan::{Plan, PlannedJournal, PlannedNote, scan_source};

/// Where the macOS app keeps its data, under the home folder.
const MACOS_CONTAINER_REL: &str = "Library/Containers/co.noteplan.NotePlan3/Data/Library/Application Support/co.noteplan.NotePlan3";

/// A `{np-task:<temp id>}` placeholder and the space before it.
static PLACEHOLDER: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"( ?)\{np-task:(t[0-9]+)\}").expect("valid regex"));

pub struct NotePlanImporter;

impl Importer for NotePlanImporter {
    fn meta(&self) -> ImporterMeta {
        let default_path = cfg!(target_os = "macos")
            .then(|| std::env::home_dir().map(|home| home.join(MACOS_CONTAINER_REL)))
            .flatten()
            .map(|path| path.to_string_lossy().into_owned());
        ImporterMeta {
            id: "noteplan".to_owned(),
            name: "NotePlan".to_owned(),
            description_key: "import.sources.noteplan".to_owned(),
            file_spec: FileSpec {
                label: "NotePlan folder".to_owned(),
                extensions: Vec::new(),
                allow_multiple: false,
                directory: Some(true),
                folder_hint_key: Some("import.dialog.noteplanFolderHint".to_owned()),
                default_path,
                message: Some(
                    "Select your NotePlan folder \u{2014} either the app\u{2019}s data folder or \
                     one of its Backups copies."
                        .to_owned(),
                ),
                ..FileSpec::default()
            },
            supports_preview: false,
            account_based: false,
        }
    }

    fn run(
        &self,
        input: &ImportInput,
        ctx: &mut ImportContext,
        sink: &dyn ImportSink,
    ) -> Result<(), ImportError> {
        ctx.set_phase(ImportPhase::Scanning);
        ctx.status(status("notePlanScanning"));
        let mut plan = Plan::default();
        for source in &input.source_paths {
            if ctx.is_cancelled() {
                return Ok(());
            }
            scan_source(Path::new(source), &mut plan, ctx);
        }
        let total = plan.notes.len() + plan.journals.len();
        ctx.report_progress(0, total);
        if ctx.is_cancelled() {
            return Ok(());
        }

        ctx.set_phase(ImportPhase::Importing);
        let mut run = Run {
            sink,
            project_id: sink.inbox_project_id(),
            nested_subtasks: sink.nested_subtasks(),
            roots: RealRoots::default(),
        };
        if run.project_id.is_none() {
            tracing::warn!(
                scope = "import",
                "no inbox project: NotePlan tasks import as plain checkboxes"
            );
            ctx.report_skipped(
                "Tasks",
                Some(ImportText::from("No Inbox project to import tasks into")),
            );
        }
        let mut done = 0;
        for note in &plan.notes {
            if ctx.is_cancelled() {
                return Ok(());
            }
            if let Err(error) = run.note(note, ctx) {
                tracing::warn!(scope = "import", "noteplan note import failed");
                ctx.report_failed(&note.path.to_string_lossy(), &error);
            }
            done += 1;
            ctx.report_progress(done, total);
        }
        for journal in &plan.journals {
            if ctx.is_cancelled() {
                return Ok(());
            }
            if let Err(error) = run.journal(journal, ctx) {
                tracing::warn!(scope = "import", "noteplan journal import failed");
                ctx.report_failed(&journal.path.to_string_lossy(), &error);
            }
            done += 1;
            ctx.report_progress(done, total);
        }
        // `ctx.setPhase('done')`: the run emits its own done snapshot, as in Electron.
        ctx.set_phase(ImportPhase::Done);
        Ok(())
    }
}

/// `PreparedBody`: one file read, parsed and converted, nothing written.
struct Prepared {
    title: String,
    markdown: String,
    tags: Vec<String>,
    properties: YamlMap,
    tasks: Vec<ParsedTask>,
    created: Option<SystemTime>,
    modified: Option<SystemTime>,
}

/// `prepare`. `strip_heading` drops the H1 a note's title carries; a journal entry has no
/// title, so it keeps it. The file's times are read here, before any write.
fn prepare(
    path: &Path,
    fallback_title: &str,
    strip_heading: bool,
    nested_subtasks: bool,
) -> Result<Prepared, String> {
    let raw = read_source_text(path).map_err(|e| e.to_string())?;
    let meta = fs::metadata(path).map_err(|e| e.to_string())?;
    let (data, content) = match gray_matter_parts(&raw) {
        Some((_, content)) => (gray_matter_data(&raw).map_err(|e| e.to_string())?, content),
        None => (
            YamlValue::map(YamlMap::new()),
            raw.strip_prefix('\u{FEFF}').unwrap_or(&raw),
        ),
    };
    let mut declared = None;
    let mut rest = Vec::new();
    for (key, value) in object_entries(&data) {
        if key == "tags" && matches!(data, YamlValue::Map(_)) {
            declared = Some(value);
        } else {
            rest.push((key, value));
        }
    }
    let heading = first_heading(content);
    let body = if heading.is_some() && strip_heading {
        strip_first_heading(content)
    } else {
        content.to_owned()
    };
    let converted = convert_body(&body, nested_subtasks);
    let mut tags: Vec<String> = map::frontmatter_tags(declared.as_ref())
        .into_iter()
        .chain(parse_tags(&body))
        .collect::<HashSet<_>>()
        .into_iter()
        .collect();
    map::sort_utf16(&mut tags);
    let modified = meta.modified().ok();
    Ok(Prepared {
        title: heading.unwrap_or_else(|| fallback_title.to_owned()),
        markdown: converted.markdown,
        tags,
        properties: map::map_properties(rest),
        tasks: converted.tasks,
        // Node reports a birth time of the epoch where the file system keeps none; the
        // modification time is the closer answer.
        created: meta.created().ok().or(modified),
        modified,
    })
}

fn iso(time: SystemTime) -> String {
    DateTime::<Utc>::from(time).to_rfc3339_opts(SecondsFormat::Millis, true)
}

/// The writes of one run, and what they share.
struct Run<'a> {
    sink: &'a dyn ImportSink,
    /// `None`: no Inbox, so no task rows and every placeholder is dropped.
    project_id: Option<String>,
    nested_subtasks: bool,
    roots: RealRoots,
}

impl Run<'_> {
    fn note(&mut self, planned: &PlannedNote, ctx: &mut ImportContext) -> Result<(), String> {
        let prepared = prepare(&planned.path, &planned.title, true, self.nested_subtasks)?;
        ctx.status(importing_item(&prepared.title));
        let note_id = self.sink.new_note_id();
        let content = self.body_for_write(&prepared, &planned.path, &planned.root, &note_id, ctx);
        self.sink
            .create_note_as_written(ImportedNote {
                id: Some(note_id),
                title: prepared.title,
                content,
                folder: Some(planned.folder.clone()),
                tags: prepared.tags,
                properties: prepared.properties,
                created: prepared.created.map(iso),
                modified: prepared.modified.map(iso),
            })
            .map_err(|e| e.0)?;
        ctx.report_imported();
        Ok(())
    }

    /// A journal entry is the person's own writing: an entry with content is never replaced;
    /// the import is appended below `## Imported from NotePlan`, and the stored tags and
    /// properties are kept, the file's merged over them.
    fn journal(&mut self, planned: &PlannedJournal, ctx: &mut ImportContext) -> Result<(), String> {
        let prepared = prepare(&planned.path, &planned.date, false, self.nested_subtasks)?;
        ctx.status(importing_item(&planned.date));
        let existing = self
            .sink
            .read_journal_entry(&planned.date)
            .map_err(|e| e.0)?;
        let entry_id = self.sink.journal_entry_id(&planned.date).map_err(|e| e.0)?;
        let markdown = self.body_for_write(&prepared, &planned.path, &planned.root, &entry_id, ctx);

        let (content, tags, mut properties) = match existing {
            Some(entry) => {
                let content = if js_trim(&entry.content).is_empty() {
                    markdown
                } else {
                    format!(
                        "{}\n\n## Imported from NotePlan\n\n{markdown}",
                        js_trim(&entry.content)
                    )
                };
                (content, entry.tags, entry.properties)
            }
            None => (markdown, Vec::new(), YamlMap::new()),
        };
        for (key, value) in prepared.properties.iter() {
            properties.insert(key.to_owned(), value.clone());
        }
        // `new Set([...stored, ...file])`: first appearance wins.
        let mut seen = HashSet::new();
        let unique: Vec<String> = tags
            .into_iter()
            .chain(prepared.tags)
            .filter(|tag| seen.insert(tag.clone()))
            .collect();
        self.sink
            .create_journal_entry(ImportedJournalEntry {
                date: planned.date.clone(),
                content,
                tags: unique,
                properties: (!properties.is_empty()).then_some(properties),
            })
            .map_err(|e| e.0)?;
        ctx.report_imported();
        Ok(())
    }

    /// `bodyForWrite`: saves the file's co-located assets, creates its task rows, then swaps
    /// every placeholder for the row's `{task:<id>}`.
    fn body_for_write(
        &mut self,
        prepared: &Prepared,
        path: &Path,
        root: &Path,
        note_id: &str,
        ctx: &mut ImportContext,
    ) -> String {
        let markdown = resolve_co_located_assets(
            &AssetNote {
                body: &prepared.markdown,
                note_id,
                note_path: path,
                root,
            },
            ctx,
            self.sink,
            &mut self.roots,
        );
        let real_ids = match &self.project_id {
            Some(project_id) => create_tasks(&prepared.tasks, note_id, project_id, self.sink, ctx),
            None => HashMap::new(),
        };
        apply_task_ids(&markdown, &prepared.tasks, &real_ids)
    }
}

/// `createTasks`: a row per task, parents first. A task with no title is skipped and one the
/// sink refuses fails; both lose their placeholder.
fn create_tasks(
    tasks: &[ParsedTask],
    note_id: &str,
    project_id: &str,
    sink: &dyn ImportSink,
    ctx: &mut ImportContext,
) -> HashMap<String, String> {
    let mut real_ids: HashMap<String, String> = HashMap::new();
    for task in tasks {
        if ctx.is_cancelled() {
            break;
        }
        if task.title.is_empty() {
            ctx.report_skipped(&task.temp_id, Some(ImportText::from("Task has no title")));
            continue;
        }
        let parent_id = task
            .parent_temp_id
            .as_ref()
            .and_then(|temp| real_ids.get(temp).cloned());
        let created = sink.create_task(ImportedTask {
            project_id: project_id.to_owned(),
            title: task.title.clone(),
            due_date: task.due_date.clone(),
            parent_id,
            source_note_id: note_id.to_owned(),
        });
        let id = match created {
            Ok(id) => id,
            Err(error) => {
                ctx.report_failed(&task.title, &error.0);
                continue;
            }
        };
        real_ids.insert(task.temp_id.clone(), id.clone());
        // The row exists and is mapped: a failed state change leaves it open, never aborts
        // the note it points at.
        let changed = match task.state {
            TaskState::Done => sink.complete_task(&id, task.completed_at.as_deref()),
            TaskState::Cancelled => sink.archive_task(&id),
            TaskState::Open => Ok(()),
        };
        if let Err(error) = changed {
            ctx.report_failed(&task.title, &error.0);
        }
    }
    real_ids
}

/// `applyTaskIds`: each placeholder becomes `{task:<id>}`, or goes, with the space before it,
/// when its task has no row. One pass over the body, however many tasks it holds.
fn apply_task_ids(
    markdown: &str,
    tasks: &[ParsedTask],
    real_ids: &HashMap<String, String>,
) -> String {
    let temp_ids: HashSet<&str> = tasks.iter().map(|task| task.temp_id.as_str()).collect();
    PLACEHOLDER
        .replace_all(markdown, |caps: &Captures<'_>| {
            let temp_id = &caps[2];
            match real_ids.get(temp_id) {
                Some(id) => format!("{}{{task:{id}}}", &caps[1]),
                None if temp_ids.contains(temp_id) => String::new(),
                None => caps[0].to_owned(),
            }
        })
        .into_owned()
}

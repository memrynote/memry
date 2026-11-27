//! [`ImportSink`]: every write an importer makes.
//!
//! An importer parses what the person picked and decides what to create. It never writes SQL
//! or vault files: it hands each write to the sink. Electron's importers called
//! `createImportedNote`, `saveAttachment` and `generateNoteId` directly; the sink gathers
//! those seams into one trait, so the same importer runs against two implementations:
//!
//! - the production sink (stage 32h2), over `NotesService::create`, `attachments::save` and
//!   the tasks service. It owns `createImportedNote`'s checklist step: a `- [ ] ...` line of a
//!   note's body becomes a task before the note is written
//!   (`apps/desktop/src/main/import/_shared/imported-note.ts`). An importer passes the body as
//!   it built it.
//! - a recording sink in the tests, which mints ids from a counter and records every call. The
//!   importer vectors (`packages/contracts/test-vectors/importers/`) are those recordings, made
//!   by the TypeScript importers with the same seams mocked.
//!
//! The trait grows with the importers that need more writes (NotePlan added tasks and journal
//! entries, Raindrop inbox links, Todoist projects, TickTick status projects and reminders): each
//! later stage adds the method it uses, with a
//! default only when a no-op is a correct answer.

use memry_core::markdown::frontmatter::YamlMap;

use crate::attachments::SavedAttachment;

/// A refused write, shown to the person as the failed item's error or the skip reason.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{0}")]
pub struct SinkError(pub String);

/// `NoteCreateInput` as an importer fills it in.
#[derive(Debug, Clone, PartialEq)]
pub struct ImportedNote {
    /// An id from [`ImportSink::new_note_id`] when attachments were saved under it first;
    /// `None` lets the sink mint one.
    pub id: Option<String>,
    pub title: String,
    pub content: String,
    /// Vault-relative folder with `/` separators; `None` is the default notes folder.
    pub folder: Option<String>,
    pub tags: Vec<String>,
    /// Frontmatter properties in the order they are written. A value keeps its YAML type: a
    /// date stays a date, as gray-matter's `Date` did.
    pub properties: YamlMap,
    /// ISO 8601 instants of the source file, when it has them.
    pub created: Option<String>,
    pub modified: Option<String>,
}

/// `NotePlanTaskDeps.createTask` input: one task row an importer lifts out of a note body.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImportedTask {
    pub project_id: String,
    pub title: String,
    /// `YYYY-MM-DD`.
    pub due_date: Option<String>,
    /// A task id [`ImportSink::create_task`] returned earlier in this run.
    pub parent_id: Option<String>,
    /// The note or journal entry the task line lives in.
    pub source_note_id: String,
}

/// `ImportTasksDomain.createTask` input (`apps/desktop/src/main/import/todoist/todoist-importer.ts`):
/// a task of a project the importer created, with Todoist's fields mapped.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImportedProjectTask {
    /// An id [`ImportSink::create_project`] returned earlier in this run.
    pub project_id: String,
    /// A task id [`ImportSink::create_project_task`] returned earlier in this run.
    pub parent_id: Option<String>,
    pub title: String,
    pub description: Option<String>,
    /// Memry's priority, 0 (none) to 4 (urgent): Todoist's 4, 3 and 2 keep their number, and
    /// anything else is 0.
    pub priority: u8,
    /// `YYYY-MM-DD`, or the year Todoist's text named (`0-06-20` for year 0000), as Electron
    /// stored it.
    pub due_date: Option<String>,
    /// `HH:mm`.
    pub due_time: Option<String>,
    /// The task's place among the project's tasks, from 0.
    pub position: usize,
}

/// A status of a project TickTick creates (`CreateProjectArgs.statuses`,
/// `apps/desktop/src/main/import/ticktick/apply-plan.ts`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImportedStatus {
    pub name: String,
    /// `#rrggbb`.
    pub color: String,
    pub kind: StatusKind,
    /// The status's place among the project's statuses, from 0.
    pub order: usize,
}

/// `StatusType`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StatusKind {
    Todo,
    InProgress,
    Done,
}

/// A stored status of a project (`getStatusesByProject`'s row).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectStatus {
    pub id: String,
    pub is_default: bool,
    pub is_done: bool,
}

/// `RepeatConfig` (`packages/importers/src/ticktick/types.ts`) as TickTick's RRULE gave it. The
/// numbers are JS numbers: `parseInt` of the rule's text, so `NaN` where the text has no number
/// and `Infinity` past f64, which `JSON.stringify` writes as `null`. `completedCount` is 0.
#[derive(Debug, Clone, PartialEq)]
pub struct ImportedRepeat {
    pub frequency: RepeatFrequency,
    /// 1 or more.
    pub interval: f64,
    /// Sunday 0 to Saturday 6, for a weekly rule with `BYDAY`.
    pub days_of_week: Option<Vec<u8>>,
    pub monthly: Option<MonthlyRepeat>,
    pub end: RepeatEnd,
    /// The run's start as `toISOString` writes it.
    pub created_at: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RepeatFrequency {
    Daily,
    Weekly,
    Monthly,
    Yearly,
}

/// `monthlyType` with its fields.
#[derive(Debug, Clone, PartialEq)]
pub enum MonthlyRepeat {
    DayOfMonth(f64),
    WeekPattern {
        week_of_month: f64,
        day_of_week: Option<u8>,
    },
}

/// `endType` with its field.
#[derive(Debug, Clone, PartialEq)]
pub enum RepeatEnd {
    Never,
    /// `YYYY-MM-DD`.
    Date(String),
    Count(f64),
}

/// `CreateTaskArgs` of TickTick's `applyPlan`: a task of a project this run created or of the
/// Inbox, with TickTick's fields mapped.
#[derive(Debug, Clone, PartialEq)]
pub struct ImportedTickTickTask {
    pub project_id: String,
    pub title: String,
    pub description: Option<String>,
    /// Memry's 0 to 3: TickTick's 1, 3 and 5 become 1, 2 and 3.
    pub priority: u8,
    /// A status id [`ImportSink::project_statuses`] returned, possibly of another project when
    /// two lists' `list column` names collide, as in Electron.
    pub status_id: Option<String>,
    /// A task id [`ImportSink::create_ticktick_task`] returned earlier in this run.
    pub parent_id: Option<String>,
    /// The task's place among its project's tasks of the same status, from 0.
    pub position: usize,
    /// `Y-MM-DD` in the task's time zone, the year as `Intl` writes it (no padding, and the era
    /// year before year 1).
    pub start_date: Option<String>,
    pub due_date: Option<String>,
    /// `HH:mm`.
    pub due_time: Option<String>,
    /// Repeats from the due date (`repeatFrom: 'due'`).
    pub repeat: Option<ImportedRepeat>,
    pub tags: Vec<String>,
}

/// The parts of a stored journal entry an importer merges into (`readJournalEntry`).
#[derive(Debug, Clone, PartialEq)]
pub struct JournalEntry {
    pub content: String,
    pub tags: Vec<String>,
    pub properties: YamlMap,
}

/// `createJournalEntry` input: writes the day's entry, replacing its body.
#[derive(Debug, Clone, PartialEq)]
pub struct ImportedJournalEntry {
    /// `YYYY-MM-DD`.
    pub date: String,
    pub content: String,
    pub tags: Vec<String>,
    /// `None` keeps the entry's stored properties; `Some` replaces them.
    pub properties: Option<YamlMap>,
}

/// `InboxItemPlan` (`packages/importers/src/raindrop/types.ts`): one bookmark for the inbox.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImportedBookmark {
    pub title: String,
    pub content: Option<String>,
    pub source_url: String,
    /// The source's ISO 8601 creation time; `None` is the import time.
    pub created_at: Option<String>,
    pub tags: Vec<String>,
    pub metadata: BookmarkMetadata,
}

/// `InboxItemPlan.metadata`, kept when the article extraction later rewrites the content.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BookmarkMetadata {
    pub url: String,
    pub excerpt: String,
    pub note: String,
    pub folder: String,
    pub favorite: bool,
    pub hero_image: String,
    pub highlights: String,
}

/// The writes of one import run. Called from the blocking thread the runner runs the importer
/// on, one call at a time.
pub trait ImportSink: Send + Sync {
    /// Mints the id a note will be created under (`generateNoteId`), so its attachments can be
    /// saved before the note exists and the note is written once, with its final body.
    fn new_note_id(&self) -> String;

    /// `saveAttachment(noteId, bytes, fileName)`: stores `bytes` in the note's attachments
    /// folder. `Err` is a refused file (its type, its size), which the importer reports as a
    /// skipped item and the import goes on.
    fn save_attachment(
        &self,
        note_id: &str,
        file_name: &str,
        bytes: &[u8],
    ) -> Result<SavedAttachment, SinkError>;

    /// `createImportedNote`: creates the note. `Err` fails that item; the import goes on.
    fn create_note(&self, note: ImportedNote) -> Result<(), SinkError>;

    /// `createNote` without `createImportedNote`'s checklist step: the body is written as
    /// given. For an importer that lifts its own tasks out of the body (NotePlan, whose `+`
    /// checklist lines must stay plain checkboxes).
    fn create_note_as_written(&self, note: ImportedNote) -> Result<(), SinkError>;

    /// The Inbox project's id (`getInboxProject`); `None` when the vault has none.
    fn inbox_project_id(&self) -> Option<String>;

    /// The `tasks.nestedSubtasks` setting: whether a subtask may parent a task.
    fn nested_subtasks(&self) -> bool;

    /// Creates an open task and returns its id. `Err` fails that task; the note goes on.
    fn create_task(&self, task: ImportedTask) -> Result<String, SinkError>;

    /// `completeTask({ id, completedAt, recordOnly: true })`: marks a task created in this run
    /// done at `completed_at` (NotePlan's `YYYY-MM-DD`, or TickTick's text as exported), or now.
    fn complete_task(&self, id: &str, completed_at: Option<&str>) -> Result<(), SinkError>;

    /// `archiveTask`: Memry has no cancelled state.
    fn archive_task(&self, id: &str) -> Result<(), SinkError>;

    /// `resolveJournalEntryId`: the id the entry of `date` has or will be created under. `Err`
    /// fails that entry, as Electron's throw did.
    fn journal_entry_id(&self, date: &str) -> Result<String, SinkError>;

    /// `readJournalEntry`: the stored entry of `date`, if any.
    fn read_journal_entry(&self, date: &str) -> Result<Option<JournalEntry>, SinkError>;

    /// `createJournalEntry`: writes the entry of `entry.date`.
    fn create_journal_entry(&self, entry: ImportedJournalEntry) -> Result<(), SinkError>;

    /// Raindrop's `saveBookmark`: `insertItemWithTags` inserts a `link` inbox item with its tags
    /// (processing complete, captured by `api`, modified now), then `emitCapturedAndSync` emits
    /// the inbox's captured event and writes the item to sync. Both run for every bookmark. Only
    /// when `source_url` matches `/^https?:\/\//i` (`http://` or `https://` at the start, the
    /// scheme ASCII case-insensitive) does `queueInboxArticleExtractJob` run too. A sink that
    /// skips the event or the sync write, or tests the URL any other way, departs from
    /// Electron. `Err` fails that bookmark; the import goes on.
    fn save_bookmark(&self, bookmark: ImportedBookmark) -> Result<(), SinkError>;

    /// `ImportTasksDomain.createProject` (`createDesktopTasksDomain`): creates a project named
    /// `name` and returns its id. `Err` fails the file whose tasks it would hold; the import goes
    /// on with the next file.
    fn create_project(&self, name: &str) -> Result<String, SinkError>;

    /// `ImportTasksDomain.createTask`: creates an open task in a project of this run and
    /// returns its id. `Err` fails the rest of the task's file; the tasks created before it stay.
    fn create_project_task(&self, task: ImportedProjectTask) -> Result<String, SinkError>;

    /// `ImportTasksDomain.createProject` with statuses (TickTick): creates a project named
    /// `name` with `statuses` in order and returns its id. `Err` skips the project's tasks; the
    /// import goes on.
    fn create_status_project(
        &self,
        name: &str,
        statuses: &[ImportedStatus],
    ) -> Result<String, SinkError>;

    /// `getStatusesByProject`: a project's statuses in their order.
    fn project_statuses(&self, project_id: &str) -> Vec<ProjectStatus>;

    /// TickTick's `createTask`: creates an open task and returns its id. `Err` fails that task;
    /// the import goes on.
    fn create_ticktick_task(&self, task: ImportedTickTickTask) -> Result<String, SinkError>;

    /// `createReminder({ targetType: 'task', targetId, remindAt })`: a reminder at `remind_at`
    /// (`toISOString` form, later than the run's start) on a task of this run. `Err` drops that
    /// reminder; the task stays.
    fn create_reminder(&self, task_id: &str, remind_at: &str) -> Result<(), SinkError>;

    /// Runs once after the importer returned, before the runner reports `done`: the production
    /// sink waits for the index to hold every note it wrote (`flushProjectionEvents`), so a
    /// refetch after the import sees them.
    fn finish(&self) {}
}

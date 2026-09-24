//! Task parsing, reminders, activity, related items and the note checklist
//! conversion (spec 004 TP028).
//!
//! The parsers are free functions: they read no database, and every one takes
//! the shell's local wall clock (`YYYY-MM-DDTHH:MM:SS`) as `now`. They are the
//! Rust ports pinned by the `task-parsing` vectors (D1: English only).

use crate::api::errors::StorageError;
use crate::api::task_records::RepeatRule;
use crate::api::tasks::Tasks;
use crate::api::tasks_write::{NewTaskInput, now_ms};
use crate::domain::calendar::{CivilDate, LocalDateTime};
use crate::domain::note_tasks;
use crate::domain::projects;
use crate::domain::recurrence;
use crate::domain::related_items::{self, LinkState, LinkedField, RelatedItem, RelatedKind};
use crate::domain::reminders::{self, NewTaskReminder, Reminder, ReminderUpdate};
use crate::domain::task_activity::{self, ActivityQuery};
use crate::domain::task_parse::{completion, natural_date, quick_add};
use crate::domain::task_records;

fn local(now: &str) -> Result<LocalDateTime, StorageError> {
    LocalDateTime::parse(now).ok_or_else(|| StorageError::Failed {
        what: format!("`{now}` is not a local YYYY-MM-DDTHH:MM:SS instant"),
    })
}

/// A natural-language date, resolved.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct ParsedDate {
    /// `YYYY-MM-DD`.
    pub date: String,
    /// `HH:MM`, 24-hour.
    pub time: Option<String>,
    /// "Wednesday, January 14, 2026 · 3:00 PM".
    pub display_text: String,
}

/// One stretch of quick-add input that carries syntax.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct QuickAddSpan {
    /// UTF-16 offsets, end exclusive (an `NSRange`).
    pub start: u32,
    pub end: u32,
    /// `priority`, `project`, `tag`, `noteLink`, `datePhrase` or `repeat`.
    pub kind: String,
}

/// What quick-add read out of the input.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct QuickAddParse {
    pub title: String,
    pub due_date: Option<String>,
    pub due_time: Option<String>,
    /// 0 none .. 4 urgent.
    pub priority: i64,
    pub project_id: Option<String>,
    pub repeat: Option<RepeatRule>,
    pub tags: Vec<String>,
    pub note_titles: Vec<String>,
    pub spans: Vec<QuickAddSpan>,
}

fn u32_of(value: usize) -> u32 {
    u32::try_from(value).unwrap_or(u32::MAX)
}

/// `parseNaturalDate`; `nil` when it does not read as a date.
#[uniffi::export]
pub fn parse_task_date(input: String, now: String) -> Option<ParsedDate> {
    let now = LocalDateTime::parse(&now)?;
    natural_date::parse_natural_date(&input, now)
        .ok()
        .map(|parsed| ParsedDate {
            date: parsed.date.key(),
            time: parsed.time,
            display_text: parsed.display_text,
        })
}

/// Ghost completion for a half-typed date phrase (the text after `@`).
#[uniffi::export]
pub fn predict_task_date(query: String, now: String) -> Option<String> {
    completion::predict_date_completion(&query, LocalDateTime::parse(&now)?)
}

/// Whether a time is still being typed after a date (keeps the ghost open).
#[uniffi::export]
pub fn is_task_time_in_progress(query: String, now: String) -> bool {
    LocalDateTime::parse(&now).is_some_and(|now| completion::is_time_in_progress(&query, now))
}

/// Ghost completion for a half-typed `every …`.
#[uniffi::export]
pub fn predict_task_repeat(query: String) -> Option<String> {
    quick_add::predict_repeat_completion(&query)
}

/// The next `count` dates of a repeat rule from `start` (`YYYY-MM-DD`),
/// `start` first — the custom repeat sheet's preview.
#[uniffi::export]
pub fn repeat_preview(rule: RepeatRule, start: String, count: u32) -> Vec<String> {
    let Some(start) = CivilDate::parse_key(&start) else {
        return Vec::new();
    };
    recurrence::calculate_next_occurrences(start, &rule.config(), count as usize)
        .into_iter()
        .map(CivilDate::key)
        .collect()
}

/// One reminder.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct ReminderItem {
    pub id: String,
    pub target_type: String,
    pub target_id: String,
    pub remind_at: String,
    pub title: Option<String>,
    pub note: Option<String>,
    pub status: String,
    pub snoozed_until: Option<String>,
}

impl From<Reminder> for ReminderItem {
    fn from(reminder: Reminder) -> Self {
        Self {
            id: reminder.id,
            target_type: reminder.target_type,
            target_id: reminder.target_id,
            remind_at: reminder.remind_at,
            title: reminder.title,
            note: reminder.note,
            status: reminder.status,
            snoozed_until: reminder.snoozed_until,
        }
    }
}

/// A reminder that will fire, with what its notification says (FR-061/062).
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct DueReminderItem {
    pub reminder: ReminderItem,
    pub fire_at: String,
    pub fire_at_ms: i64,
    pub target_title: Option<String>,
    pub target_exists: bool,
    pub target_completed: bool,
}

/// One activity row.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct ActivityItem {
    pub id: String,
    pub action: String,
    pub field: Option<String>,
    /// JSON-encoded values, as desktop stores them.
    pub old_value: Option<String>,
    pub new_value: Option<String>,
    pub is_this_device: bool,
    pub created_at_ms: Option<i64>,
}

/// One page of a task's activity.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct ActivityPageItem {
    pub entries: Vec<ActivityItem>,
    pub total: u32,
    pub has_more: bool,
}

/// A note, file or journal a task can link to.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct RelatedItemRecord {
    /// `note`, `file`, `journal` or `canvas`.
    pub kind: String,
    pub id: String,
    pub title: String,
    pub folder_path: Option<String>,
    pub emoji: Option<String>,
}

impl From<RelatedItem> for RelatedItemRecord {
    fn from(item: RelatedItem) -> Self {
        let kind = match item.kind {
            RelatedKind::Note => "note",
            RelatedKind::File => "file",
            RelatedKind::Journal => "journal",
            RelatedKind::Canvas => "canvas",
        };
        Self {
            kind: kind.to_owned(),
            id: item.id,
            title: item.title,
            folder_path: item.folder_path,
            emoji: item.emoji,
        }
    }
}

/// One linked id on a task and what it resolved to.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct LinkedItemRecord {
    /// `note` (linkedNoteIds) or `canvas` (linkedCanvasIds).
    pub field: String,
    pub id: String,
    /// `present`, `missing` or `notOnDevice`.
    pub state: String,
    pub item: Option<RelatedItemRecord>,
}

#[uniffi::export]
impl Tasks {
    /// Quick-add over this vault's projects.
    pub fn parse_quick_add(
        &self,
        input: String,
        now: String,
    ) -> Result<QuickAddParse, StorageError> {
        let now = local(&now)?;
        self.db.call_blocking(move |conn| {
            let projects: Vec<quick_add::QuickAddProject> = projects::list(conn, true)?
                .into_iter()
                .map(|project| quick_add::QuickAddProject {
                    is_archived: project.archived_at.is_some(),
                    id: project.id,
                    name: project.name,
                })
                .collect();
            let parsed = quick_add::parse_quick_add(&input, &projects, now);
            let spans = quick_add::find_quick_add_spans(&input, now)
                .into_iter()
                .map(|span| QuickAddSpan {
                    start: u32_of(span.start),
                    end: u32_of(span.end),
                    kind: span.kind.as_str().to_owned(),
                })
                .collect();
            Ok(QuickAddParse {
                title: parsed.title,
                due_date: parsed.due_date.map(CivilDate::key),
                due_time: parsed.due_time,
                priority: parsed.priority.to_wire(),
                project_id: parsed.project_id,
                repeat: parsed.repeat.map(RepeatRule::from),
                tags: parsed.tags,
                note_titles: parsed.note_titles,
                spans,
            })
        })
    }

    /// A task's reminders; `active_only` drops dismissed and triggered ones.
    pub fn task_reminders(
        &self,
        task_id: String,
        active_only: bool,
    ) -> Result<Vec<ReminderItem>, StorageError> {
        self.db.call_blocking(move |conn| {
            Ok(reminders::for_task(conn, &task_id, active_only)?
                .into_iter()
                .map(ReminderItem::from)
                .collect())
        })
    }

    /// Adds a reminder to a task at an ISO instant; returns its id.
    pub fn add_task_reminder(
        &self,
        task_id: String,
        remind_at: String,
        title: Option<String>,
        note: Option<String>,
    ) -> Result<String, StorageError> {
        let device = self.device_id.clone();
        self.db.call_blocking(move |conn| {
            let reminder = NewTaskReminder {
                id: None,
                task_id: &task_id,
                remind_at: &remind_at,
                title: title.as_deref(),
                note: note.as_deref(),
            };
            Ok(reminders::create_for_task(conn, &reminder, &device, now_ms())?.acknowledge())
        })
    }

    /// Reschedules or retitles a reminder (any target).
    pub fn update_reminder(
        &self,
        id: String,
        remind_at: Option<String>,
        title: Option<String>,
    ) -> Result<(), StorageError> {
        let device = self.device_id.clone();
        self.db.call_blocking(move |conn| {
            let update = ReminderUpdate {
                remind_at: remind_at.as_deref(),
                title: title.as_deref().map(Some),
                note: None,
            };
            reminders::update(conn, &id, &update, &device, now_ms())?.acknowledge();
            Ok(())
        })
    }

    pub fn delete_reminder(&self, id: String) -> Result<(), StorageError> {
        let device = self.device_id.clone();
        self.db.call_blocking(move |conn| {
            reminders::delete(conn, &id, &device, now_ms())?.acknowledge();
            Ok(())
        })
    }

    pub fn dismiss_reminder(&self, id: String) -> Result<(), StorageError> {
        let device = self.device_id.clone();
        self.db.call_blocking(move |conn| {
            reminders::dismiss(conn, &id, &device, now_ms())?.acknowledge();
            Ok(())
        })
    }

    pub fn snooze_reminder(&self, id: String, until: String) -> Result<(), StorageError> {
        let device = self.device_id.clone();
        self.db.call_blocking(move |conn| {
            reminders::snooze(conn, &id, &until, &device, now_ms())?.acknowledge();
            Ok(())
        })
    }

    /// Every pending or snoozed reminder that fires by `until_ms` (all of them
    /// with `nil`), for scheduling local notifications.
    pub fn due_reminders(
        &self,
        until_ms: Option<i64>,
    ) -> Result<Vec<DueReminderItem>, StorageError> {
        self.db.call_blocking(move |conn| {
            Ok(reminders::due_window(conn, until_ms)?
                .into_iter()
                .map(|due| DueReminderItem {
                    reminder: due.reminder.into(),
                    fire_at: due.fire_at,
                    fire_at_ms: due.fire_at_ms,
                    target_title: due.target_title,
                    target_exists: due.target_exists,
                    target_completed: due.target_completed,
                })
                .collect())
        })
    }

    /// One page of a task's activity, newest first.
    pub fn activity(
        &self,
        task_id: String,
        actions: Vec<String>,
        limit: u32,
        offset: u32,
    ) -> Result<ActivityPageItem, StorageError> {
        let device = self.device_id.clone();
        self.db.call_blocking(move |conn| {
            let query = ActivityQuery {
                task_id: &task_id,
                actions: &actions,
                limit: limit as usize,
                offset: offset as usize,
            };
            let page = task_activity::list(conn, &query, Some(&device), now_ms())?;
            Ok(ActivityPageItem {
                total: u32_of(page.total),
                has_more: page.has_more,
                entries: page
                    .entries
                    .into_iter()
                    .map(|entry| ActivityItem {
                        id: entry.id,
                        action: entry.action,
                        field: entry.field,
                        old_value: entry.old_value,
                        new_value: entry.new_value,
                        is_this_device: entry.is_this_device,
                        created_at_ms: entry.created_at_ms,
                    })
                    .collect(),
            })
        })
    }

    /// Notes and files to offer in the related-item picker.
    pub fn search_related(
        &self,
        query: String,
        limit: u32,
    ) -> Result<Vec<RelatedItemRecord>, StorageError> {
        self.db.call_blocking(move |conn| {
            Ok(related_items::search(conn, &query, limit as usize)?
                .into_iter()
                .map(RelatedItemRecord::from)
                .collect())
        })
    }

    /// A task's linked notes and canvases, each present, missing or not on
    /// this device.
    pub fn linked_items(&self, task_id: String) -> Result<Vec<LinkedItemRecord>, StorageError> {
        self.db.call_blocking(move |conn| {
            let Some(task) = task_records::get(conn, &task_id)? else {
                return Ok(Vec::new());
            };
            Ok(
                related_items::resolve(conn, &task.linked_note_ids, &task.linked_canvas_ids)?
                    .into_iter()
                    .map(|linked| {
                        let field = match linked.field {
                            LinkedField::Note => "note",
                            LinkedField::Canvas => "canvas",
                        };
                        let (state, item) = match linked.state {
                            LinkState::Present(item) => ("present", Some(item.into())),
                            LinkState::Missing => ("missing", None),
                            LinkState::NotOnDevice => ("notOnDevice", None),
                        };
                        LinkedItemRecord {
                            field: field.to_owned(),
                            id: linked.id,
                            state: state.to_owned(),
                            item,
                        }
                    })
                    .collect(),
            )
        })
    }

    /// Turns a checklist item in a note into a task (FR-058): creates the task
    /// in the resolved project (a parent task line's, else the note's, else the
    /// default, else the Inbox), then rewrites the line into a task block.
    /// Returns the new task's id, or `nil` when the block is not a convertible
    /// checkbox.
    pub fn convert_checklist_item(
        &self,
        note_id: String,
        block_id: String,
        local_now: String,
    ) -> Result<Option<String>, StorageError> {
        let failed = |error: crate::crdt::errors::CrdtError| StorageError::Failed {
            what: error.to_string(),
        };
        let candidate = self
            .db
            .call_blocking({
                let note_id = note_id.clone();
                move |conn| {
                    Ok(note_tasks::read_conversion_candidates(conn, &note_id)
                        .map_err(failed)?
                        .unwrap_or_default())
                }
            })?
            .into_iter()
            .find(|candidate| candidate.block_id == block_id);
        let Some(candidate) = candidate else {
            return Ok(None);
        };
        let project_id = self.db.call_blocking({
            let note_id = note_id.clone();
            let parent = candidate.parent_task_id.clone();
            move |conn| {
                let parent_project = match parent {
                    Some(parent) => task_records::get(conn, &parent)?.map(|task| task.project_id),
                    None => None,
                };
                let note_projects = note_tasks::note_project_ids(conn, &note_id)?;
                let settings = crate::domain::task_settings::read(conn)?;
                let all = projects::list(conn, false)?;
                Ok(note_tasks::resolve_note_task_project(
                    &note_tasks::NoteTaskProjectInput {
                        parent_task_project_id: parent_project.as_deref(),
                        quick_add_project_id: None,
                        note_project_ids: &note_projects,
                        settings_default_project_id: settings.default_project_id.as_deref(),
                        projects: &all,
                    },
                ))
            }
        })?;
        let Some(project_id) = project_id else {
            return Ok(None);
        };
        let created = self.create(NewTaskInput {
            title: candidate.text.clone(),
            project_id,
            status_id: None,
            parent_id: candidate.parent_task_id.clone(),
            priority: 0,
            description: None,
            due_date: None,
            due_time: None,
            start_date: None,
            repeat: None,
            repeat_from: None,
            tags: Vec::new(),
            linked_note_ids: vec![note_id.clone()],
            linked_canvas_ids: Vec::new(),
            source_note_id: Some(note_id.clone()),
            position: None,
        })?;
        let Some(task_id) = created.created.first().cloned() else {
            return Ok(None);
        };
        if candidate.checked {
            self.complete(task_id.clone(), local_now)?;
        }
        let device = self.device_id.clone();
        let converted = task_id.clone();
        self.db.call_blocking(move |conn| {
            note_tasks::convert_checklist_to_task(
                conn,
                &note_id,
                &block_id,
                &converted,
                &device,
                now_ms(),
            )
            .map_err(failed)?;
            Ok(())
        })?;
        Ok(Some(task_id))
    }
}

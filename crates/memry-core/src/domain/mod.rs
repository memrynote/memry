//! Domain logic: what the product means, above the storage and sync tiers.
//!
//! Every module here writes through the same two calls in one transaction —
//! [`crate::storage::repositories::sync_items::apply_local_edit_in`] to merge
//! the change into the stored payload, and [`crate::sync::outbox::enqueue`] to
//! publish it — because a merged payload without its outbox row is a local
//! edit no peer ever sees (FR-030, data-model §A.2, chapter 13 §13.2 rule 3).
//!
//! Nothing here parses or serialises markdown. `extract_text` is the core's
//! only text operation (chapter 12 §12.1).

pub mod attachments;
pub mod body_write;
pub mod calendar;
pub mod folders;
pub mod inbox;
pub mod journal;
pub mod journal_ops;
pub mod journal_rules;
pub mod note_meta;
pub mod note_tasks;
pub mod notes;
pub mod projects;
pub mod properties;
pub mod reads;
pub mod recurrence;
pub mod related_items;
pub mod reminders;
pub mod repeat_config;
pub mod saved_filters;
pub mod search;
pub mod settings;
pub mod tags;
pub mod task_activity;
pub mod task_filter;
pub mod task_merge;
pub mod task_parse;
pub mod task_records;
pub mod task_settings;
pub mod task_views;
pub mod tasks;
pub mod templates;

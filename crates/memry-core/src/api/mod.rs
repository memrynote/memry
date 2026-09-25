//! The surface the shells call. Everything below `api` is internal to the core.

pub mod account;
pub mod auth;
pub mod conformance;
pub mod content_admin;
pub mod crypto;
pub mod errors;
pub mod large_notes;
pub mod linking;
pub mod linking_approver;
pub mod notes;
pub mod notes_write;
pub mod projects;
pub mod runtime;
pub mod search;
pub mod settings;
pub mod sync;
pub mod task_conformance;
pub mod task_extras;
pub mod task_records;
pub mod tasks;
pub mod tasks_write;
pub mod vault;

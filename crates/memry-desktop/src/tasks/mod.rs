//! Tasks and projects of the open vault (Step 21, #3538). The core owns every task and project
//! rule; this module runs them at the points of the vault lifecycle Electron does and maps the
//! `tasks:*` commands onto them.

pub mod contract;
pub mod defaults;
pub mod project_contract;
mod projects;
pub mod service;
pub mod write_contract;
mod writes;

pub use projects::{INBOX_ARCHIVE, INBOX_DELETE, PROJECT_NOT_FOUND, PROJECT_REORDER_FAILED};
pub use writes::{MOVE_MANY_FAILED, REORDER_FAILED, TASK_NOT_FOUND};

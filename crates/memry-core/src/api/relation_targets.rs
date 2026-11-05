//! `RelationTargets`: the records a relation property names, read for its chips (desktop's
//! `resolveRefs`, #3530 13q-2). Reached from [`crate::api::vault::Vault::relation_targets`]. Not
//! exported over UniFFI: iOS resolves no relation chips yet.
//!
//! Reads only, each through its domain's own read, so unlike [`crate::api::vault::Vault::tasks`]
//! it needs no device identity: a locked keychain cannot fail a chip. Every method blocks; the
//! shell runs them in `spawn_blocking`.

use crate::api::calendar_records::CalendarEventRecord;
use crate::api::errors::StorageError;
use crate::domain::calendar_items::reads::{self as calendar, ExternalRelation};
use crate::domain::canvas::{self, Canvas};
use crate::domain::journal_ops::reads::{self as journal, DayStamp};
use crate::domain::task_records::{self, TaskRecord};
use crate::storage::Db;

pub struct RelationTargets {
    db: Db,
}

impl RelationTargets {
    pub(crate) fn over(db: Db) -> Self {
        Self { db }
    }

    /// One live task.
    pub fn task(&self, id: &str) -> Result<Option<TaskRecord>, StorageError> {
        let id = id.to_owned();
        self.db
            .read_blocking(move |conn| task_records::get(conn, &id))
    }

    /// One live native event.
    pub fn event(&self, id: &str) -> Result<Option<CalendarEventRecord>, StorageError> {
        let id = id.to_owned();
        self.db
            .read_blocking(move |conn| calendar::event(conn, &id))
    }

    /// One imported event, as [`calendar::external_relation`] reads it.
    pub fn external_event(&self, id: &str) -> Result<Option<ExternalRelation>, StorageError> {
        let id = id.to_owned();
        self.db
            .read_blocking(move |conn| calendar::external_relation(conn, &id))
    }

    /// One live canvas.
    pub fn canvas(&self, id: &str) -> Result<Option<Canvas>, StorageError> {
        let id = id.to_owned();
        self.db.read_blocking(move |conn| canvas::get(conn, &id))
    }

    /// The live journal day for `date`.
    pub fn day(&self, date: &str) -> Result<Option<DayStamp>, StorageError> {
        let date = date.to_owned();
        self.db
            .read_blocking(move |conn| journal::stamp(conn, &date))
    }
}

//! `ReadwiseStore`: Readwise's device-local links and run state ([`crate::domain::readwise`]),
//! reached from [`crate::api::vault::Vault::readwise`]. Not exported over UniFFI: iOS never
//! pulls from Readwise (D13). Every call blocks; the shell runs them off the async runtime.

use std::time::{SystemTime, UNIX_EPOCH};

use crate::api::errors::StorageError;
use crate::domain::readwise::{self, Link, LinkKey, LinkState, UpsertLink};
use crate::storage::Db;

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| {
            i64::try_from(elapsed.as_millis()).unwrap_or(i64::MAX)
        })
}

pub struct ReadwiseStore {
    db: Db,
}

impl ReadwiseStore {
    pub(crate) fn over(db: Db) -> Self {
        Self { db }
    }

    /// [`readwise::link_for_book`].
    pub fn link_for_book(
        &self,
        book_id: i64,
        external_id: Option<&str>,
    ) -> Result<Option<Link>, StorageError> {
        let external_id = external_id.map(str::to_owned);
        self.db.read_blocking(move |conn| {
            readwise::link_for_book(conn, book_id, external_id.as_deref())
        })
    }

    /// [`readwise::link_by_note`].
    pub fn link_by_note(&self, note_id: &str) -> Result<Option<Link>, StorageError> {
        let note_id = note_id.to_owned();
        self.db
            .read_blocking(move |conn| readwise::link_by_note(conn, &note_id))
    }

    /// [`readwise::links`].
    pub fn links(&self, state: Option<LinkState>) -> Result<Vec<Link>, StorageError> {
        self.db
            .read_blocking(move |conn| readwise::links(conn, state.as_ref()))
    }

    /// [`readwise::complete_link`].
    pub fn complete_link(
        &self,
        link: &Link,
        book_id: i64,
        document_id: Option<&str>,
    ) -> Result<(), StorageError> {
        let (link, document_id) = (link.clone(), document_id.map(str::to_owned));
        self.db.call_blocking(move |conn| {
            readwise::complete_link(conn, &link, book_id, document_id.as_deref(), now_ms())
        })
    }

    /// [`readwise::upsert_link`].
    pub fn upsert_link(
        &self,
        book_id: Option<i64>,
        document_id: Option<&str>,
        note_id: &str,
        state: LinkState,
    ) -> Result<Link, StorageError> {
        let (document_id, note_id) = (document_id.map(str::to_owned), note_id.to_owned());
        self.db.call_blocking(move |conn| {
            let input = UpsertLink {
                book_id,
                document_id: document_id.as_deref(),
                note_id: &note_id,
                state,
            };
            readwise::upsert_link(conn, &input, now_ms())
        })
    }

    /// [`readwise::mark_link_state`].
    pub fn mark_link_state(
        &self,
        key: LinkKey,
        state: LinkState,
    ) -> Result<Option<Link>, StorageError> {
        self.db
            .call_blocking(move |conn| readwise::mark_link_state(conn, &key, &state, now_ms()))
    }

    /// [`readwise::rebuild_links`].
    pub fn rebuild_links(&self, urls: Vec<(String, String)>) -> Result<usize, StorageError> {
        self.db
            .call_blocking(move |conn| readwise::rebuild_links(conn, urls, now_ms()))
    }

    /// [`readwise::run_state`].
    pub fn run_state(&self, key: &str) -> Result<Option<String>, StorageError> {
        let key = key.to_owned();
        self.db
            .read_blocking(move |conn| readwise::run_state(conn, &key))
    }

    /// [`readwise::set_run_state`]; `None` deletes the key.
    pub fn set_run_state(&self, key: &str, value: Option<&str>) -> Result<(), StorageError> {
        let (key, value) = (key.to_owned(), value.map(str::to_owned));
        self.db.call_blocking(move |conn| {
            readwise::set_run_state(conn, &key, value.as_deref(), now_ms())
        })
    }
}

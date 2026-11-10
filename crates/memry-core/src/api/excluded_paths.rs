//! The vault paths the app reads but never writes (#3530 13m-7b-3b): on desktop, the files a
//! vault exclude pattern covers. Electron's index drops such a note, so no write of the app
//! reaches it; here it stays listed and opens read-only, and every writer of the app asks this.
//! The shell sets the rule each time its patterns change. Until it does, nothing is excluded
//! (iOS never sets one).
//!
//! The patterns the shell last applied are also kept on this device, in `meta` under
//! `desktop.exclude_patterns` (#4118): while the vault's own copy cannot be read, the shell keeps
//! excluding what it excluded, instead of falling back to defaults that exclude less. An older
//! build ignores the key.

use std::sync::{Arc, PoisonError, RwLock};

use rusqlite::{Connection, OptionalExtension as _, params};

use crate::api::errors::StorageError;
use crate::domain::notes::failed;

/// The `meta` key of the remembered patterns: a JSON array of strings.
const REMEMBERED_KEY: &str = "desktop.exclude_patterns";

type Rule = Arc<dyn Fn(&str) -> bool + Send + Sync>;

/// Shared by a vault and its editor: a rule set on one is the rule of both.
#[derive(Clone, Default)]
pub struct ExcludedPaths(Arc<RwLock<Option<Rule>>>);

impl ExcludedPaths {
    /// `covers` decides from now on.
    pub fn set(&self, covers: impl Fn(&str) -> bool + Send + Sync + 'static) {
        *self.0.write().unwrap_or_else(PoisonError::into_inner) = Some(Arc::new(covers));
    }

    /// Whether the file at vault-relative `path` is excluded.
    pub fn covers(&self, path: &str) -> bool {
        let rule = self
            .0
            .read()
            .unwrap_or_else(PoisonError::into_inner)
            .clone();
        rule.is_some_and(|covers| covers(path))
    }

    /// Whether any rule is set: without one no path needs looking up.
    pub(crate) fn is_set(&self) -> bool {
        self.0
            .read()
            .unwrap_or_else(PoisonError::into_inner)
            .is_some()
    }
}

/// The patterns [`remember`] kept, or `None` when none were. What is kept but is not a list of
/// strings is an error.
pub(crate) fn remembered(conn: &Connection) -> Result<Option<Vec<String>>, StorageError> {
    let text: Option<String> = conn
        .query_row(
            "SELECT value FROM meta WHERE key = ?1",
            [REMEMBERED_KEY],
            |row| row.get(0),
        )
        .optional()
        .map_err(failed)?;
    text.map(|text| {
        serde_json::from_str(&text).map_err(|error| StorageError::Failed {
            what: format!("the remembered exclude patterns are not a list of strings: {error}"),
        })
    })
    .transpose()
}

/// Keeps `patterns` as the ones the shell applies now.
pub(crate) fn remember(conn: &Connection, patterns: &[String]) -> Result<(), StorageError> {
    let text = serde_json::to_string(patterns).map_err(|error| StorageError::Failed {
        what: error.to_string(),
    })?;
    conn.execute(
        "INSERT INTO meta (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![REMEMBERED_KEY, text],
    )
    .map(drop)
    .map_err(failed)
}

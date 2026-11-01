//! The once-per-vault import of the pre-sync template files, `.memry/templates/<id>.md`
//! (`migrateTemplateFilesToDb`), run as the vault opens. The parse and the insert are the
//! core's (`memry_core::domain::template_legacy`); this side lists and reads the files and
//! decides when the import may run and when it is done.
//!
//! - **The files stay.** Nothing here removes one: an older build downgraded onto the vault
//!   still reads them, and each template is durable in the database before the flag says so.
//!   Only a delete of the template removes its file ([`super::Templates::delete`]).
//! - **Once, and only once everything landed.** The flag is set when no file failed to read.
//!   A file that could not be read (a lock, a cloud client still hydrating it, a link out of
//!   the vault) leaves it unset, so the next open tries again; one that never imports
//!   (frontmatter that does not parse, too large) does not hold it. An absent folder sets
//!   nothing: a folder a cloud client brings later still imports.
//! - **Repeats are harmless.** Each template commits on its own, and an id the database ever
//!   held is never written again, so a crash halfway and the next open's run add nothing twice
//!   and bring back nothing deleted.
//! - **Beside Electron's database** (`.memry/data.db`) the templates are Electron's rows, which
//!   only the Electron import (Step 36) carries over. Before it ran, the files wait, as files
//!   that would be notes do (`mints_beside_electron`). After it ran, Electron's own flag says
//!   whether its rows already hold the files: when they do, importing again would bring back
//!   a template deleted in Electron (its row is gone, its file is not), so nothing is imported.
//!
//! What failed and what never imports reaches the vault activity log ([`activity`]).

use std::fs;
use std::io::{self, Read as _};
use std::path::Path;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use memry_core::domain::template_admin::is_built_in;
use memry_core::domain::template_legacy::{self, Parsed};
use memry_core::seams::secure_store::SecureStore;
use memry_core::storage::repositories::instants::to_iso8601;
use rusqlite::{Connection, OpenFlags, OptionalExtension as _};

use super::{LEGACY_DIR, Templates};
use crate::session::{OpenStage, Session};
use crate::vault::activity::{ActivityInput, ActivityKind, ActivityLog, ActivitySource};
use crate::vault::layout::MEMRY_DIR;
use crate::vault::paths::open_vault_file;

/// A template file bigger than this is never read. Electron's built-ins are under 1 KB.
pub const MAX_TEMPLATE_BYTES: u64 = 16 * 1024 * 1024;
/// Electron's settings key for the same flag, in its own `data.db`.
const ELECTRON_FLAG: &str = "templates.importedFromFiles";
/// One activity entry per file and problem a day, however often the vault opens.
const ACTIVITY_WINDOW_MS: i64 = 24 * 60 * 60 * 1000;

/// What one run did.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct LegacyImport {
    /// Templates written.
    pub imported: usize,
    /// Files that could not be read, vault-relative, with why; the flag waits for them.
    pub failed: Vec<(String, String)>,
    /// Files that will never import, with why.
    pub refused: Vec<(String, String)>,
    pub outcome: LegacyOutcome,
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub enum LegacyOutcome {
    /// Every file landed: the flag is set (now or before).
    #[default]
    Done,
    /// Some file failed to read; the next open runs again.
    Retry,
    /// There is no template folder; nothing is set.
    NoFolder,
    /// Electron's database is beside this one and was not imported yet.
    WaitsForElectronImport,
}

fn rel(name: &str) -> String {
    format!("{MEMRY_DIR}/{LEGACY_DIR}/{name}")
}

/// Electron's flag in its `data.db`, read without writing to it.
fn electron_flag(vault: &Path) -> rusqlite::Result<bool> {
    let db = vault.join(MEMRY_DIR).join("data.db");
    let conn = Connection::open_with_flags(
        db,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    let has_settings = conn
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'settings'",
            [],
            |_| Ok(()),
        )
        .optional()?
        .is_some();
    if !has_settings {
        return Ok(false);
    }
    let value: Option<String> = conn
        .query_row(
            "SELECT value FROM settings WHERE key = ?1",
            [ELECTRON_FLAG],
            |row| row.get(0),
        )
        .optional()?;
    Ok(value.as_deref() == Some("1"))
}

/// The file's text, decoded as Node decodes `utf8` (a bad sequence reads as U+FFFD). `None`
/// when it is over [`MAX_TEMPLATE_BYTES`].
fn read(vault: &Path, rel: &str) -> Result<Option<String>, String> {
    let file = match open_vault_file(vault, rel) {
        Ok(Some(file)) => file,
        Ok(None) => return Err("the file is gone".into()),
        Err(error) => return Err(error.to_string()),
    };
    let mut bytes = Vec::new();
    file.take(MAX_TEMPLATE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    if bytes.len() as u64 > MAX_TEMPLATE_BYTES {
        return Ok(None);
    }
    Ok(Some(String::from_utf8_lossy(&bytes).into_owned()))
}

impl Templates {
    /// Imports the vault's template files unless that is done or must wait.
    pub fn import_legacy(&self, now_ms: i64) -> io::Result<LegacyImport> {
        let storage = |error: memry_core::api::errors::StorageError| io::Error::other(error);
        let mut run = LegacyImport::default();
        if self.store.legacy_imported().map_err(storage)? {
            return Ok(run);
        }
        if self.vault.join(MEMRY_DIR).join("data.db").is_file() {
            let beside = self.store.beside_electron().map_err(storage)?;
            if beside.imported {
                if electron_flag(&self.vault).map_err(io::Error::other)? {
                    self.store.mark_legacy_imported().map_err(storage)?;
                    return Ok(run);
                }
            } else if !beside.mints {
                run.outcome = LegacyOutcome::WaitsForElectronImport;
                return Ok(run);
            }
        }
        let entries = match fs::read_dir(self.vault.join(MEMRY_DIR).join(LEGACY_DIR)) {
            Ok(entries) => entries,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                run.outcome = LegacyOutcome::NoFolder;
                return Ok(run);
            }
            Err(error) => return Err(error),
        };
        let now = to_iso8601(now_ms).unwrap_or_default();
        let mut names = Vec::new();
        for entry in entries {
            let name = entry?.file_name();
            match name.to_str() {
                Some(name) => names.push(name.to_owned()),
                None => run.refused.push((
                    rel(&name.to_string_lossy()),
                    "the file name is not UTF-8".into(),
                )),
            }
        }
        names.sort();
        for name in names {
            // Every pre-sync build wrote the built-ins out; they are never read.
            let Some(stem) = name.strip_suffix(".md") else {
                continue;
            };
            if is_built_in(stem) {
                continue;
            }
            let path = rel(&name);
            let text = match read(&self.vault, &path) {
                Ok(Some(text)) => text,
                Ok(None) => {
                    run.refused.push((path, "file-too-large".into()));
                    continue;
                }
                Err(why) => {
                    run.failed.push((path, why));
                    continue;
                }
            };
            match template_legacy::parse(stem, &text, &now) {
                Parsed::BuiltIn => {}
                Parsed::Refused(why) => run.refused.push((path, why)),
                // An insert the database refuses is skipped, as Electron's catch skips it.
                Parsed::Template(template) => match self.store.import_legacy(&template, now_ms) {
                    Ok(true) => run.imported += 1,
                    Ok(false) => {}
                    Err(error) => run.refused.push((path, error.to_string())),
                },
            }
        }
        if run.failed.is_empty() {
            self.store.mark_legacy_imported().map_err(storage)?;
        } else {
            run.outcome = LegacyOutcome::Retry;
        }
        Ok(run)
    }
}

/// The activity entries a run leaves: a file that failed to read, and one that never imports.
pub fn activity(run: &LegacyImport) -> Vec<ActivityInput> {
    let failed = run.failed.iter().map(|(path, why)| {
        ActivityInput::new(ActivityKind::Failed, ActivitySource::Import)
            .path(path.clone())
            .reason("read-failed")
            .message(why.clone())
            .dedupe(format!("template-import:failed:{path}"), ACTIVITY_WINDOW_MS)
    });
    let refused = run.refused.iter().map(|(path, why)| {
        let entry = ActivityInput::new(ActivityKind::Skipped, ActivitySource::Import)
            .path(path.clone())
            .dedupe(
                format!("template-import:skipped:{path}"),
                ACTIVITY_WINDOW_MS,
            );
        if why == "file-too-large" {
            entry.reason("file-too-large")
        } else {
            entry.message(why.clone())
        }
    });
    failed.chain(refused).collect()
}

/// Runs the import as every vault opens, before it reads as open, as Electron's `openVault`
/// does, so the first template list already holds the files. It never fails the open: what
/// went wrong is logged and, for a file, recorded in the vault's activity log, which the
/// watcher stage opened.
pub fn register(session: &Session, store: Arc<dyn SecureStore>, log: Arc<ActivityLog>) {
    session.on_open(
        "template-import",
        OpenStage::Defaults,
        Arc::new(move |vault| {
            let now_ms = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_or(0, |elapsed| elapsed.as_millis() as i64);
            let run = Templates::open(vault, store.clone())
                .map_err(|error| io::Error::other(error.to_string()))
                .and_then(|templates| templates.import_legacy(now_ms));
            match run {
                Ok(run) => {
                    if run.imported > 0 || run.outcome != LegacyOutcome::Done {
                        tracing::info!(
                            scope = "templates",
                            imported = run.imported,
                            failed = run.failed.len(),
                            refused = run.refused.len(),
                            "template files: {:?}",
                            run.outcome
                        );
                    }
                    for entry in activity(&run) {
                        log.record(&vault.path, entry);
                    }
                }
                Err(error) => tracing::warn!(
                    scope = "templates",
                    "the template files were not imported; the next open tries again: {error}"
                ),
            }
            Ok(())
        }),
    );
}

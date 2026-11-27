//! Electron's `settings` table, one key-value row per setting, kept apart as Electron keeps it:
//!
//! - the synced part (`synced_settings` and `synced_settings_clocks`, `SettingsSyncManager`)
//!   becomes the core `settings` record `synced_settings`, payload `{settings, fieldClocks}` as
//!   Electron's `getPayload` pushes it, per-path clocks included;
//! - the vault key verifier and the account binding go to the core `meta` table under the same
//!   keys, before any key is installed, so Step 37's first `set_at_rest_key` checks the key
//!   against Electron's verifier; so do the tag field rename job and the preset offer flag,
//!   which the core reads from `meta` under Electron's keys and values;
//! - `general` and `editor` are copied verbatim like every local row: Electron's rows alone
//!   hold this device's fields (`onboardingCompleted`, `clockFormat`, `zoomFactor`, editor
//!   `width`), and the core reads of a group skip the synced fields of its row, so the synced
//!   record and `.memry/config.json` still own theirs;
//! - Readwise run state, the sync state rows and a tag rename cut off mid-run wait for their
//!   stages;
//! - every other row is device-local and lands in `local_settings` under its key, value
//!   verbatim (`ai-inline` with its key: the desktop `InlineAiStore` moves it into the keychain
//!   on its first read). A key outside [`KNOWN_LOCAL_KEYS`] is copied too and counted.

use memry_core::storage::import::{ImportLocalSetting, ImportRecord};
use memry_core::storage::repositories::instants::to_epoch_ms;
use serde_json::{Map, Value};

use super::js_json::{self, JsonError};
use super::locks::read_rows;
use super::records::{malformed, text};
use super::{SourceDb, TableStats};
use crate::electron_import::vault_db::{ImportError, TableCtx, read_source_id};

const TABLE: &str = "settings";

/// `SETTINGS_SYNC_SETTINGS_KEY` and `SETTINGS_SYNC_CLOCKS_KEY` (`sync-client/settings-sync.ts`).
const SYNCED: &str = "synced_settings";
const SYNCED_CLOCKS: &str = "synced_settings_clocks";

/// Electron keys the core keeps in `meta` under the same name and value: the key verifier
/// (`crypto/vault-key-state.ts:17`), the account binding (`vault-account-binding.ts:39`), the
/// field rename a locked note held (`field-rename.ts:25`, core `tag_schema/rename.rs`) and the
/// dismissed preset offer (`presets.ts:17`, core `tag_schema::preset_offer_dismissed`).
const META_KEYS: [&str; 4] = [
    "vault.crypto.verifier.v1",
    "sync.account-binding.v1",
    "tags.fieldRenameJob",
    "tagFields.presetOfferDismissed",
];

/// Electron's tag rename in progress (`rename-tag.ts:33`, `{from, to, runId}`). The core's
/// (`tags.rename_job`) carries the plan Electron recomputes: the name pairs and the holders not
/// renamed yet, which this import cannot derive from the job alone. Electron finishes it at its
/// next start, so a vault holding one is refused until it has.
const TAG_RENAME_JOB: &str = "tags.renameJob";

/// The Readwise run state (`readwise/run-state.ts`), owned by Step 33's `readwise_run_state`.
const READWISE_RUN_STATE: [&str; 9] = [
    "readwise.cursor",
    "readwise.errorToastShown",
    "readwise.fullPass",
    "readwise.highlightIndex",
    "readwise.journalPending",
    "readwise.lastFullRead",
    "readwise.lastRun",
    "readwise.readerCursor",
    "readwise.retryList",
];

/// Device-local keys Electron writes (`getSetting`/`setSetting` callers on `main`).
const KNOWN_LOCAL_KEYS: &[&str] = &[
    "ai-inline",
    "ai.enabled",
    "ai.imageEmbeddings",
    "ai.summarizeAgent",
    "ai.summarizeLongNotes",
    "backup",
    "calendar",
    "calendar.caldav",
    "calendar.caldav.authFailures",
    "calendar.defaultWriteTarget",
    "calendar.google",
    "calendar.google.pushUnsupportedSources",
    "calendar.ics",
    "captureAllowedOrigins",
    "codeLinkReindexV2",
    "editor",
    "editor.calloutTypes",
    "features",
    "features.spatialCanvasPromoted",
    "frontmatterPropertiesRootV1",
    "general",
    "general.openPagesInNewTabDefaultFlipped",
    "graph",
    "graphViews",
    "inbox",
    "inbox.reviewLastNotifiedDate",
    "inbox.staleThresholdDays",
    "journal.allYearsView",
    "journal.defaultTemplate",
    "journal.showAIConnections",
    "journal.showOnThisDay",
    "journal.showSchedule",
    "journal.showStatsFooter",
    "journal.showTasks",
    "journal.weekdayTemplates",
    "keyboard",
    "noteCoverReindexV1",
    "noteEditor.toolbarMode",
    "noteTaskIdsReindexV2",
    "projectFrontmatterBackfill",
    "propertyDefinitionsFileBackfillV1",
    "readwise",
    "search.ftsDedupeVersion",
    "sidebar.navCollapsed",
    "sidebar.notesFirst",
    "sidebar.railOrder",
    "sidebar.sectionOrder",
    "sidebar.showFiles",
    "sidebar.sortModes",
    "sticky",
    "sync",
    "tabs.restoreSessionOnStart",
    "tabs.tabCloseButton",
    "tagSearches",
    "tasks",
    "templates.importedFromFiles",
    "theme",
    "vaultIcon",
    "voiceTranscription",
];

/// What the import does with one settings key.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SettingRule {
    /// Part of the synced settings record.
    Synced,
    /// Copied into core `meta`.
    Meta,
    /// Dropped into the report under the reason.
    Skip(&'static str),
    /// Carried once the named stage writes it; a source holding it fails with `NotReady`.
    Pending(&'static str),
    /// Copied into `local_settings`; `known` is false for a key Electron's code does not name.
    Local { known: bool },
}

pub fn rule(key: &str) -> SettingRule {
    match key {
        SYNCED | SYNCED_CLOCKS => SettingRule::Synced,
        key if META_KEYS.contains(&key) => SettingRule::Meta,
        TAG_RENAME_JOB => SettingRule::Pending("tagRename"),
        // The sync state table's rules (`sync_state.rs`): session status, then 36c3's keys.
        "lastSyncAt" => SettingRule::Skip("settingsSessionStatus"),
        "syncPaused" | "quarantinedItems" => SettingRule::Pending("36c3"),
        key if READWISE_RUN_STATE.contains(&key) => SettingRule::Pending("36f"),
        key => SettingRule::Local {
            known: KNOWN_LOCAL_KEYS.contains(&key),
        },
    }
}

struct Row {
    key: String,
    value: String,
    updated_at: i64,
    rowid: i64,
}

pub fn settings(ctx: &mut TableCtx<'_>) -> Result<TableStats, ImportError> {
    let rows = read_rows(
        ctx,
        "SELECT rowid, key, value, modified_at FROM settings ORDER BY rowid",
        |row, rowid| {
            Ok(Row {
                key: read_source_id(row, SourceDb::Data, TABLE, "key")?,
                value: text(row, "value")?
                    .ok_or_else(|| malformed(TABLE, rowid, "value is NULL"))?,
                updated_at: text(row, "modified_at")?
                    .and_then(|iso| to_epoch_ms(&iso))
                    .ok_or_else(|| malformed(TABLE, rowid, "modified_at is not an ISO instant"))?,
                rowid,
            })
        },
    )?;
    let mut stats = TableStats::default();
    let mut synced: (Option<&Row>, Option<&Row>) = (None, None);
    let mut local = Vec::new();
    let mut unknown = 0;
    for row in &rows {
        match rule(&row.key) {
            SettingRule::Synced if row.key == SYNCED => synced.0 = Some(row),
            SettingRule::Synced => synced.1 = Some(row),
            SettingRule::Meta => {
                ctx.writer.put_meta(&row.key, &row.value)?;
                stats.written += 1;
            }
            SettingRule::Skip(reason) => count(&mut stats.dropped, reason),
            // The preflight refused the run before anything was written.
            SettingRule::Pending(stage) => {
                return Err(ImportError::CheckFailed {
                    check: 1,
                    detail: format!("settings key of stage {stage} reached its importer"),
                });
            }
            SettingRule::Local { known } => {
                unknown += u64::from(!known);
                local.push(ImportLocalSetting {
                    key: row.key.clone(),
                    value: row.value.clone(),
                    updated_at: row.updated_at,
                });
            }
        }
    }
    if unknown > 0 {
        stats.notices.push(("unknownSettingsKeys", unknown));
    }
    ctx.writer.put_local_settings(&local)?;
    stats.written += local.len() as u64;
    if let (None, None) = synced {
        return Ok(stats);
    }
    let mut payload = Map::new();
    for (key, row) in [("settings", synced.0), ("fieldClocks", synced.1)] {
        payload.insert(key.into(), loaded(row, &mut stats)?);
    }
    let record = ImportRecord {
        item_type: "settings",
        item_id: SYNCED.into(),
        payload: js_json::stringify(&Value::Object(payload)),
        synced_at: None,
    };
    ctx.writer.put_records(&[record], ctx.now_ms)?;
    // Each source row lands in the one record.
    stats.written += u64::from(synced.0.is_some()) + u64::from(synced.1.is_some());
    Ok(stats)
}

/// `loadSettings`/`loadClocks`: a missing row or text that does not parse reads as `{}`.
fn loaded(row: Option<&Row>, stats: &mut TableStats) -> Result<Value, ImportError> {
    let Some(row) = row else {
        return Ok(Value::Object(Map::new()));
    };
    match js_json::parse(&row.value) {
        Ok(value) => Ok(value),
        Err(JsonError::NotJson) => {
            count(&mut stats.notices, "unreadableSyncedSettings");
            Ok(Value::Object(Map::new()))
        }
        Err(JsonError::Unsupported) => Err(malformed(
            TABLE,
            row.rowid,
            "synced settings this import cannot re-serialise",
        )),
    }
}

fn count(list: &mut Vec<(&'static str, u64)>, reason: &'static str) {
    match list.iter_mut().find(|(name, _)| *name == reason) {
        Some((_, n)) => *n += 1,
        None => list.push((reason, 1)),
    }
}

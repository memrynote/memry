//! `vault reindex|set-icon|activity|locks` (`runVaultAdmin`, `apps/cli/src/commands/vault-admin.ts`),
//! each over the desktop owner of its state.

use std::time::{Instant, SystemTime, UNIX_EPOCH};

use memry_desktop::registry::vault_icon::{self, IconError};
use memry_desktop::vault::activity::{self, ActivityFilter, ActivityLog};
use serde_json::{Value, json};

use crate::context::VaultContext;
use crate::output::print;
use crate::parse::ParsedCli;
use crate::values::{parse_number, require_first};
use crate::{CliError, CliIo, CliResult};

const USAGE: &str = "Usage: memrynote [--vault <path>] vault reindex|set-icon <icon|null>|activity list|clear|locks list|set";
/// `DEFAULT_ACTIVITY_LIMIT` of `apps/cli/src/app-core/vault-admin.ts`.
const DEFAULT_ACTIVITY_LIMIT: f64 = 200.0;

pub fn run(parsed: &ParsedCli, io: &mut dyn CliIo, vault: &VaultContext) -> CliResult {
    match parsed.subcommand.as_deref() {
        Some("reindex") => reindex(parsed, io, vault),
        Some("set-icon") => set_icon(parsed, io, vault),
        Some("activity") => run_activity(parsed, io, vault),
        Some("locks") => run_locks(parsed, io, vault),
        _ => Err(USAGE.into()),
    }
}

/// The app's search index pass (core `Search::reindex`), from this process. Two processes never
/// race on the index: the pass runs in one `index.db` transaction that SQLite serialises with the
/// app's own pass (a writer waits on the other for the 5 s busy timeout, then fails and commits
/// nothing), and it is idempotent and incremental, so whichever runs second indexes only what is
/// left. The command line never sets a damaged index aside under a running app: that is the
/// app's open ([`memry_core::api::vault::Vault::search_keeping_index`]).
fn reindex(parsed: &ParsedCli, io: &mut dyn CliIo, vault: &VaultContext) -> CliResult {
    let started = Instant::now();
    let refused = |error: memry_core::api::errors::StorageError| {
        CliError(format!(
            "The search index cannot be updated here ({error}). Open MemryNote, which repairs it, then run this command again."
        ))
    };
    let search = vault.vault.search_keeping_index().map_err(refused)?;
    let done = search.reindex_counts().map_err(refused)?;
    let output = json!({
        "notes": done.notes_indexed,
        "tasks": done.tasks_indexed,
        "inbox": done.inbox_indexed,
        "skipped": done.corrupt_skipped,
        "durationMs": u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
    });
    print(io, parsed.json, Some(&output));
    Ok(())
}

/// `setIcon` (`apps/cli/src/app-core/vault-admin.ts:92-118`) over the app's icon rules.
fn set_icon(parsed: &ParsedCli, io: &mut dyn CliIo, vault: &VaultContext) -> CliResult {
    let value = require_first(&parsed.positionals, "icon (icon:<Name>, an emoji, or null)")?;
    let icon = (value != "null").then_some(value);
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |since| {
            i64::try_from(since.as_millis()).unwrap_or(i64::MAX)
        });
    vault_icon::write(&vault.root, icon, now_ms).map_err(|error| match error {
        IconError::Invalid => CliError(format!(
            "Invalid vault icon: {value} (use icon:<Name> or a single emoji)"
        )),
        IconError::Unreadable { path, message } => CliError(format!(
            "Cannot read {path} ({message}); vault icon not changed"
        )),
        other => CliError(other.to_string()),
    })?;
    print(io, parsed.json, Some(&json!({ "icon": icon })));
    Ok(())
}

/// `runActivity` (`apps/cli/src/commands/vault-admin.ts:15-35`).
fn run_activity(parsed: &ParsedCli, io: &mut dyn CliIo, vault: &VaultContext) -> CliResult {
    match parsed.positionals.first().map(String::as_str) {
        Some("list") => {
            let filter = if parsed.flags.has("problems") {
                ActivityFilter::Problems
            } else {
                ActivityFilter::All
            };
            let limit = if parsed.flags.has("limit") {
                let limit = parse_number(parsed.flags.get("limit"), DEFAULT_ACTIVITY_LIMIT)?;
                if limit.fract() != 0.0 || !(1.0..=1000.0).contains(&limit) {
                    return Err("--limit must be an integer from 1 to 1000".into());
                }
                limit
            } else {
                DEFAULT_ACTIVITY_LIMIT
            };
            // Read straight from the file, as the TypeScript did: the log's owner is the app.
            #[expect(
                clippy::cast_possible_truncation,
                clippy::cast_sign_loss,
                reason = "an integer from 1 to 1000"
            )]
            let lines = activity::listed_on_disk(&vault.root, limit as usize, filter)
                .ok_or_else(|| CliError(activity::ActivityError::Unreadable.to_string()))?;
            let entries = lines
                .iter()
                .filter_map(|raw| serde_json::from_str::<Value>(raw).ok())
                .collect();
            print(io, parsed.json, Some(&Value::Array(entries)));
            Ok(())
        }
        Some("clear") => {
            if !parsed.flags.has("yes") {
                return Err("Pass --yes to clear the vault activity log".into());
            }
            // No file is nothing to clear, and none is created.
            if activity::log_path(&vault.root).exists() {
                let log = ActivityLog::new();
                log.open(&vault.root);
                let cleared = log.clear();
                log.close(&vault.root);
                cleared.map_err(|error| CliError(error.to_string()))?;
            }
            print(io, parsed.json, Some(&json!({ "cleared": true })));
            Ok(())
        }
        _ => Err(
            "Usage: memrynote [--vault <path>] vault activity list [--problems] [--limit <n>] | clear --yes"
                .into(),
        ),
    }
}

/// `runLocks` (`apps/cli/src/commands/vault-admin.ts:37-53`).
fn run_locks(parsed: &ParsedCli, io: &mut dyn CliIo, vault: &VaultContext) -> CliResult {
    match parsed.positionals.first().map(String::as_str) {
        Some("list") => {
            let state = vault
                .vault
                .locks()
                .list()
                .map_err(|error| CliError(error.to_string()))?;
            print(
                io,
                parsed.json,
                Some(&json!({ "notes": state.notes, "folders": state.folders })),
            );
            Ok(())
        }
        // Locking also makes the files read-only on disk, keeps a baseline of each locked note
        // and enqueues the sync record; the app owns all three.
        Some("set") => Err("Setting a lock needs the desktop app: it protects the files on disk and syncs the lock. Lock it from the note or folder menu in Memry.".into()),
        _ => Err("Usage: memrynote [--vault <path>] vault locks list".into()),
    }
}

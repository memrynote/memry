//! The first step of `createMemryApp` (`apps/cli/src/app-core/memry-app.ts`): `ensureVaultLayout`
//! (`app-core/paths.ts:209-210`) runs `fs.mkdir(path.join(vault, '.memry'), { recursive: true })`,
//! which fails on a path that cannot hold a vault. So every command after the registry ones
//! fails there, with Node's message, before the vault opens ([`crate::context::open`]).
//!
//! Also the `vault` subcommands that run on an open vault (`runVault`,
//! `apps/cli/src/cli-commands-vault.ts:24-50`): `config` and `update-config` here, the rest in
//! [`crate::vault_admin`].

use std::path::{Component, Path, PathBuf};

use memry_desktop::vault::config::{self, ConfigError};
use memry_desktop::vault::journal_format::normalize_journal_folder;
use memry_desktop::vault::layout::DEFAULT_EXCLUDE_PATTERNS;
use serde_json::{Map, Value, json};

use crate::context::VaultContext;
use crate::output::print;
use crate::parse::ParsedCli;
use crate::registry::normalize;
use crate::values::parse_object_value;
use crate::{CliError, CliIo, CliResult, vault_admin};

/// The usage error of `runVault`.
const USAGE: &str = "Usage: memrynote vault list|current|use|remove OR memrynote [--vault <path>] vault init|status|config|update-config|reindex|set-icon|activity|locks";

pub fn run(parsed: &ParsedCli, io: &mut dyn CliIo, vault: &VaultContext) -> CliResult {
    match parsed.subcommand.as_deref() {
        // The open did the work: `init` on a folder with no `.memry` initialised it.
        Some("init" | "status" | "open") => {
            print(
                io,
                parsed.json,
                Some(&json!({ "isOpen": true, "path": vault.path })),
            );
            Ok(())
        }
        Some("config") => {
            print(io, parsed.json, Some(&Value::Object(config_view(vault))));
            Ok(())
        }
        Some("update-config") => {
            let updates = parse_object_value(
                parsed.positionals.first().map(String::as_str),
                "vault config",
            )?;
            let updated = update_config(vault, &updates)?;
            print(io, parsed.json, Some(&Value::Object(updated)));
            Ok(())
        }
        Some("reindex" | "set-icon" | "activity" | "locks") => vault_admin::run(parsed, io, vault),
        _ => Err(USAGE.into()),
    }
}

/// The config `createMemryApp` holds (`ensureVaultLayout`, `apps/cli/src/app-core/paths.ts:209-247`):
/// `{ ...defaults without excludePatterns, ...file, excludePatterns, journalFolder normalized,
/// journalShowInSidebar === true }`, so every key of the file is shown. A missing or unusable
/// file reads as `{}`.
fn config_view(vault: &VaultContext) -> Map<String, Value> {
    let file = config::read_map(&vault.root).unwrap_or_default();
    let mut view = Map::new();
    for (key, value) in [
        ("defaultNoteFolder", ""),
        ("journalFolder", "journal"),
        ("journalDateFormat", "YYYY-MM-DD"),
        ("attachmentsFolder", "attachments"),
    ] {
        view.insert(key.into(), value.into());
    }
    view.extend(file.clone());
    view.insert(
        "excludePatterns".into(),
        exclude_patterns(vault, &file).into(),
    );
    if let Some(Value::String(folder)) = view.get("journalFolder") {
        let folder = normalize_journal_folder(folder);
        view.insert("journalFolder".into(), folder.into());
    }
    let sidebar = view.get("journalShowInSidebar") == Some(&Value::Bool(true));
    view.insert("journalShowInSidebar".into(), sidebar.into());
    view
}

/// `resolveExcludePatterns` (`paths.ts:159-180`): a list in the file is the user's (strings only);
/// with no key, the defaults and the patterns the app last applied on this device (core meta
/// `desktop.exclude_patterns`); any other value, the defaults.
fn exclude_patterns(vault: &VaultContext, file: &Map<String, Value>) -> Vec<String> {
    let mut patterns: Vec<String> = DEFAULT_EXCLUDE_PATTERNS.map(str::to_owned).to_vec();
    match file.get("excludePatterns") {
        Some(Value::Array(items)) => {
            return items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect();
        }
        Some(_) => {}
        None => {
            if let Ok(Some(kept)) = vault.vault.remembered_exclude_patterns() {
                for pattern in kept {
                    if !patterns.contains(&pattern) {
                        patterns.push(pattern);
                    }
                }
            }
        }
    }
    patterns
}

/// `updateVaultConfig` (`paths.ts:107-126`): writes `{ ...file, ...config without excludePatterns,
/// ...updates }` through the config's one owner, creates the folders it names, and returns the
/// config with the updates and the exclude patterns the written file gives.
fn update_config(
    vault: &VaultContext,
    updates: &Map<String, Value>,
) -> Result<Map<String, Value>, CliError> {
    let mut view = config_view(vault);
    let written = config::update(&vault.root, |file| {
        for (key, value) in view.iter().filter(|(key, _)| *key != "excludePatterns") {
            file.insert(key.clone(), value.clone());
        }
        for (key, value) in updates {
            file.insert(key.clone(), value.clone());
        }
        file.clone()
    })
    .map_err(|error| match error {
        ConfigError::Unreadable { path, message } => CliError(format!(
            "{path} cannot be read ({message}); the file is left unchanged. Fix it and retry."
        )),
        other => CliError(other.to_string()),
    })?;
    view.extend(updates.clone());
    create_folders(&vault.root, &view)?;
    view.insert(
        "excludePatterns".into(),
        exclude_patterns(vault, &written).into(),
    );
    Ok(view)
}

/// `ensureVaultFolders` (`paths.ts:128-134`). A folder that would land outside the vault is not
/// created (`deliberate-differences.json`).
fn create_folders(root: &Path, config: &Map<String, Value>) -> CliResult {
    let named = ["defaultNoteFolder", "journalFolder"]
        .into_iter()
        .filter_map(|key| config.get(key).and_then(Value::as_str));
    for folder in named.chain(["attachments", "attachments/images", "attachments/files"]) {
        let Some(path) = inside(root, folder) else {
            continue;
        };
        std::fs::create_dir_all(&path)
            .map_err(|error| CliError(format!("{}: {error}", path.display())))?;
    }
    Ok(())
}

/// `root` joined with the relative `folder`, or `None` when `folder` is absolute or climbs out.
fn inside(root: &Path, folder: &str) -> Option<PathBuf> {
    let mut path = root.to_path_buf();
    let mut depth = 0usize;
    for part in Path::new(folder).components() {
        match part {
            Component::Normal(name) => {
                path.push(name);
                depth += 1;
            }
            Component::CurDir => {}
            Component::ParentDir if depth > 0 => {
                path.pop();
                depth -= 1;
            }
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => return None,
        }
    }
    Some(path)
}

/// Fails as Node's recursive `mkdir` of `<vault>/.memry` fails (`MKDirpSync`/`MKDirpAsync` of
/// `src/node_file.cc`): `EEXIST` when `.memry` is there and is not a folder, `ENOTDIR` when
/// the nearest existing ancestor is not a folder. On Windows the second case reaches the
/// same `ENOTDIR` through `ENOENT`, then `EEXIST` on the ancestor.
pub fn check_path(vault: &str, cwd: &Path) -> CliResult {
    let memry = normalize(&Path::new(vault).join(".memry"));
    let on_disk = cwd.join(&memry);
    let code = match std::fs::metadata(&on_disk) {
        Ok(meta) if meta.is_dir() => return Ok(()),
        Ok(_) => "EEXIST: file already exists",
        Err(_) => match on_disk
            .ancestors()
            .skip(1)
            .find_map(|dir| std::fs::metadata(dir).ok())
        {
            Some(meta) if !meta.is_dir() => "ENOTDIR: not a directory",
            _ => return Ok(()),
        },
    };
    Err(format!("{code}, mkdir '{}'", memry.display()).into())
}

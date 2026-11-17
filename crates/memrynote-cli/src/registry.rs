//! `vault list|current|use|remove` and the default vault: `runVaultRegistryCommand`
//! (`apps/cli/src/cli-commands-vault.ts:53-91`), `resolveDefaultVaultPath`
//! (`cli-support.ts:125-145`) and the desktop registry adapter
//! (`apps/desktop/src/main/cli/vault-registry.ts`) over the app's `memry-config.json`.
//!
//! None of them opens a vault or starts an async runtime.

use std::path::{Component, MAIN_SEPARATOR, Path, PathBuf};

use memry_desktop::registry::{RegistryError, StoredVault, VaultRegistry};
use serde_json::{Map, Value, json};

use crate::output::print;
use crate::parse::ParsedCli;
use crate::{CliDeps, CliError, CliIo};

/// Runs the four registry subcommands; `Ok(false)` for any other `vault` subcommand.
pub fn run_registry_command(
    parsed: &ParsedCli,
    io: &mut dyn CliIo,
    registry: Option<&VaultRegistry>,
    deps: &CliDeps,
) -> Result<bool, CliError> {
    match parsed.subcommand.as_deref() {
        Some("list") => {
            let vaults = require(registry)?.stored().iter().map(cli_vault).collect();
            print(io, parsed.json, Some(&Value::Array(vaults)));
        }
        Some("current") => {
            let path = match &parsed.vault_path {
                Some(path) => path.clone(),
                None => resolve_default_vault_path(registry)?,
            };
            let vault = require(registry)?
                .stored()
                .iter()
                .find(|vault| vault.path == path)
                .map_or_else(|| json!({ "path": path }), cli_vault);
            print(io, parsed.json, Some(&vault));
        }
        Some("use") => {
            let reference = parsed
                .positionals
                .first()
                .or(parsed.vault_path.as_ref())
                .filter(|reference| !reference.is_empty())
                .ok_or("Usage: memrynote vault use <vault-name-or-path>")?;
            let registry = require(registry)?;
            let path = resolve_reference(registry, reference, deps)?;
            let unknown = || CliError(format!("Unknown vault: {reference}"));
            registry.set_default(&path).map_err(|error| match error {
                RegistryError::NotRegistered(_) => unknown(),
                error => CliError(error.to_string()),
            })?;
            let vault = registry.get(&path).ok_or_else(unknown)?;
            print(io, parsed.json, Some(&cli_vault(&vault)));
        }
        Some("remove") => {
            let reference = parsed
                .positionals
                .first()
                .filter(|reference| !reference.is_empty())
                .ok_or("Usage: memrynote vault remove <vault-name-or-path> --yes")?;
            if !parsed.flags.has("yes") {
                return Err(
                    "Pass --yes to remove the vault from the list (its files are kept)".into(),
                );
            }
            let registry = require(registry)?;
            let path = resolve_reference(registry, reference, deps)?;
            let vault = registry
                .get(&path)
                .ok_or_else(|| CliError(format!("Unknown vault: {reference}")))?;
            // The app's `vault:remove`: clears `currentVault` when it names this vault and
            // never touches the vault's files.
            registry
                .remove(&path)
                .map_err(|error| CliError(error.to_string()))?;
            print(
                io,
                parsed.json,
                Some(&json!({ "removed": cli_vault(&vault) })),
            );
        }
        _ => return Ok(false),
    }
    Ok(true)
}

/// `resolveDefaultVaultPath`: the default vault, else the only vault.
pub fn resolve_default_vault_path(registry: Option<&VaultRegistry>) -> Result<String, CliError> {
    let vaults = require(registry)?.stored();
    if let Some(vault) = vaults.iter().find(|vault| vault.is_default) {
        return Ok(vault.path.clone());
    }
    match vaults.as_slice() {
        [only] => Ok(only.path.clone()),
        [] => Err("No default vault configured. Open Memry and choose Settings > Command Line > Default vault, or run with --vault <path>.".into()),
        _ => Err("Multiple vaults found. Choose one with `memrynote vault use <vault-name-or-path>` or run with --vault <path>.".into()),
    }
}

fn require(registry: Option<&VaultRegistry>) -> Result<&VaultRegistry, CliError> {
    registry.ok_or_else(|| {
        "No CLI vault registry is available. Pass --vault <path> or run Memry from the desktop app command.".into()
    })
}

/// `toCliVault`. `lastOpened` is left out when the entry has none, as `JSON.stringify` drops
/// an undefined field.
fn cli_vault(vault: &StoredVault) -> Value {
    let mut object = Map::new();
    object.insert("path".into(), vault.path.clone().into());
    object.insert("name".into(), vault.name.clone().into());
    object.insert("isDefault".into(), vault.is_default.into());
    if !vault.last_opened.is_empty() {
        object.insert("lastOpened".into(), vault.last_opened.clone().into());
    }
    Value::Object(object)
}

/// `resolveVaultReference`: a unique vault name, else a registered path, compared as given or
/// after `path.resolve` of both sides.
fn resolve_reference(
    registry: &VaultRegistry,
    reference: &str,
    deps: &CliDeps,
) -> Result<String, CliError> {
    let vaults = registry.stored();
    let mut by_name = vaults.iter().filter(|vault| vault.name == reference);
    if let Some(vault) = by_name.next() {
        if by_name.next().is_some() {
            return Err(
                format!("Multiple vaults named {reference}; use the vault path instead").into(),
            );
        }
        return Ok(vault.path.clone());
    }
    let expanded = expand(reference, deps);
    vaults
        .iter()
        .find(|vault| vault.path == reference || node_resolve(&deps.cwd, &vault.path) == expanded)
        .map(|vault| vault.path.clone())
        .ok_or_else(|| format!("Unknown vault: {reference}").into())
}

/// `expandVaultReference`: `~` and `~<sep>` expand to the home folder, anything else is
/// `path.resolve`d.
fn expand(reference: &str, deps: &CliDeps) -> PathBuf {
    if let Some(home) = &deps.home {
        if reference == "~" {
            return home.clone();
        }
        if let Some(rest) = reference.strip_prefix(&format!("~{MAIN_SEPARATOR}")) {
            return normalize(&home.join(rest));
        }
    }
    node_resolve(&deps.cwd, reference)
}

/// Node's `path.resolve(p)` against `cwd`: absolute, `.` and `..` resolved lexically, no
/// trailing separator.
fn node_resolve(cwd: &Path, path: &str) -> PathBuf {
    normalize(&cwd.join(path))
}

fn normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            // `pop` keeps a root or a drive, as `..` at the root stays there.
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other),
        }
    }
    out
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[test]
    fn resolve_is_lexical_and_absolute() {
        let cwd = Path::new("/work/dir");
        assert_eq!(node_resolve(cwd, "a/../b/./c/"), Path::new("/work/dir/b/c"));
        assert_eq!(node_resolve(cwd, "/x/y/.."), Path::new("/x"));
        assert_eq!(node_resolve(cwd, "/../.."), Path::new("/"));
        assert_eq!(node_resolve(cwd, ""), Path::new("/work/dir"));
    }
}

//! The first step of `createMemryApp` (`apps/cli/src/app-core/memry-app.ts`): `ensureVaultLayout`
//! (`app-core/paths.ts:209-210`) runs `fs.mkdir(path.join(vault, '.memry'), { recursive: true })`,
//! which fails on a path that cannot hold a vault. So every command after the registry ones
//! fails there, with Node's message, before the vault opens ([`crate::context::open`]).
//!
//! Also the `vault` subcommands that run on an open vault (`runVault`,
//! `apps/cli/src/cli-commands-vault.ts:24-50`).

use std::path::Path;

use serde_json::json;

use crate::context::VaultContext;
use crate::output::print;
use crate::parse::ParsedCli;
use crate::registry::normalize;
use crate::{CliIo, CliResult, not_ported};

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
        Some("config" | "update-config" | "reindex" | "set-icon" | "activity" | "locks") => {
            Err(not_ported(parsed))
        }
        _ => Err(USAGE.into()),
    }
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

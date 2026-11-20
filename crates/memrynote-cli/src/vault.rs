//! The first step of `createMemryApp` (`apps/cli/src/app-core/memry-app.ts`): `ensureVaultLayout`
//! (`app-core/paths.ts:209-210`) runs `fs.mkdir(path.join(vault, '.memry'), { recursive: true })`,
//! which fails on a path that cannot hold a vault. So every command after the registry ones
//! fails there, with Node's message. Stage B opens the vault, which creates the folder; until
//! then this only reads.

use std::path::Path;

use crate::CliResult;
use crate::registry::normalize;

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

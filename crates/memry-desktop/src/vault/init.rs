//! Creating a vault's structure (`initVault`, `vault/init.ts`) and counting its notes
//! (`countMarkdownFiles`).
//!
//! Initialising creates `.memry`, the default `config.json` (created exclusively, mode 0600, so
//! a config that is already there, even one made a moment ago by another process, is never
//! replaced) and the default folders. It is idempotent. Electron runs it only for a vault
//! whose `.memry` folder does not exist ([`is_vault_initialized`]), and so does the session, so
//! a user who deleted `journal` from an existing vault does not get it back.

use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use super::config::{VaultConfig, config_path};
use super::layout::MEMRY_DIR;
use super::move_journal::is_staging_name;

/// `VAULT_FOLDERS` of `init.ts`.
pub const VAULT_FOLDERS: [&str; 4] = [
    "journal",
    "attachments",
    "attachments/images",
    "attachments/files",
];

/// `isVaultInitialized`: the `.memry` folder exists. A folder that cannot be looked at
/// (`EACCES`, `EIO`, a share that went away) counts as initialised: an init would then write
/// into a vault this app cannot see, and the open reports the real failure.
pub fn is_vault_initialized(vault: &Path) -> bool {
    match vault.join(MEMRY_DIR).try_exists() {
        Ok(exists) => exists,
        Err(error) => {
            tracing::warn!(
                scope = "vault_init",
                "cannot look for .memry: {:?}",
                error.kind()
            );
            true
        }
    }
}

/// `initVault`. Errors carry the OS error kind: `PermissionDenied` is a vault the user cannot
/// write to.
pub fn init_vault(vault: &Path) -> io::Result<()> {
    fs::create_dir_all(vault.join(MEMRY_DIR))?;

    let default = serde_json::to_vec_pretty(&VaultConfig::default().to_map())?;
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    match options.open(config_path(vault)) {
        Ok(mut file) => {
            file.write_all(&default)?;
            file.sync_all()?;
        }
        // The config is there already: leave it exactly as it is.
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(error),
    }

    for folder in VAULT_FOLDERS {
        fs::create_dir_all(vault.join(folder))?;
    }
    Ok(())
}

/// Step bounds of [`count_markdown_files`]. A vault is untrusted input: a count never walks
/// forever.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CountLimits {
    pub max_depth: usize,
    pub max_entries: usize,
}

impl CountLimits {
    pub const DEFAULT: CountLimits = CountLimits {
        max_depth: 256,
        max_entries: 2_000_000,
    };
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MarkdownCount {
    pub count: u32,
    pub visited: usize,
    /// A cap stopped the walk: `count` is a lower bound.
    pub truncated: bool,
    /// The staging folders of interrupted folder moves the walk passed, for the open's sweep
    /// ([`is_staging_name`]): listed whatever the exclude list says, but never from inside a
    /// hidden or excluded folder, and never through a link.
    pub staging: Vec<PathBuf>,
}

/// `countMarkdownFiles`: every regular `.md` file under `vault`, links not followed. An entry
/// is skipped when its name equals a pattern or **starts with** one (so `.git` also skips
/// `.github`, as Electron does). Unlike the vault walk, hidden files are counted when no
/// pattern names them. An unreadable folder counts as empty.
pub fn count_markdown_files(
    vault: &Path,
    exclude: &[String],
    limits: CountLimits,
) -> MarkdownCount {
    let mut result = MarkdownCount {
        count: 0,
        visited: 0,
        truncated: false,
        staging: Vec::new(),
    };
    // Each folder with whether it is in a hidden one.
    let mut stack = vec![(vault.to_path_buf(), 0usize, false)];
    'folders: while let Some((dir, depth, hidden)) = stack.pop() {
        if depth > limits.max_depth {
            result.truncated = true;
            continue;
        }
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            if result.visited >= limits.max_entries {
                result.truncated = true;
                break 'folders;
            }
            result.visited += 1;
            let name = entry.file_name().to_string_lossy().into_owned();
            if !hidden
                && is_staging_name(&name)
                && entry.file_type().is_ok_and(|kind| kind.is_dir())
            {
                result.staging.push(entry.path());
            }
            if exclude.iter().any(|p| name.starts_with(p.as_str())) {
                continue;
            }
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            if kind.is_dir() {
                stack.push((entry.path(), depth + 1, hidden || name.starts_with('.')));
            } else if kind.is_file() && name.ends_with(".md") {
                result.count = result.count.saturating_add(1);
            }
        }
    }
    if result.truncated {
        tracing::warn!(scope = "vault_init", "the note count stopped at a cap");
    }
    result
}

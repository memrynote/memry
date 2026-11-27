//! `cargo xtask seed bench`, ported from `apps/desktop/scripts/seed-bench-vault.ts`: wipe the
//! vault folder (only an empty one or an earlier bench vault), then write the generated notes through the vault file tier.

use std::error::Error;
use std::fs::{self, File};
use std::io;
use std::path::{Component, Path, PathBuf};
use std::time::SystemTime;

use chrono::DateTime;
use memry_desktop::vault::properties_file::{self, PropertyDefinition, PropertyKind};
use memry_desktop::vault::{config, folder_file, fs_atomic, layout::MEMRY_DIR, note_file};

use crate::bulk_notes::{self, BulkNote};

pub type SeedResult<T> = Result<T, Box<dyn Error + Send + Sync>>;

/// `--count` and `--seed` defaults of `seed-bench-vault.ts`.
pub const DEFAULT_COUNT: usize = 1000;
pub const DEFAULT_SEED: u32 = 42;

/// The `.memry/config.json` title [`seed_bench`] writes: the only non-empty folder it wipes.
const BENCH_TITLE: &str = "memrynote Benchmark Vault";

/// The frontmatter keys every bulk note carries, with their definitions' types and colours.
const PROPERTY_DEFS: [(&str, &str); 4] = [
    ("status", "#6366f1"),
    ("priority", "#ef4444"),
    ("owner", "#6b7280"),
    ("rating", "#f59e0b"),
];

/// `~/MemryBenchVault`.
pub fn default_bench_vault() -> Option<PathBuf> {
    std::env::home_dir().map(|home| home.join("MemryBenchVault"))
}

/// Node's `path.resolve` without touching the disk: absolute, `.` dropped, `..` removing the
/// folder before it, no trailing separator (so a symlink path names the link, not its target).
fn resolve_lexically(path: &Path) -> io::Result<PathBuf> {
    let mut resolved = PathBuf::new();
    for component in std::path::absolute(path)?.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                resolved.pop();
            }
            other => resolved.push(other),
        }
    }
    Ok(resolved)
}

/// `ensureSafeVaultPath` of `seed-vault/wipe.ts`: never the file system root, the home folder,
/// its Documents or Desktop, nor a path less than two folders deep.
fn ensure_safe_vault_path(vault: &Path) -> SeedResult<PathBuf> {
    let absolute = resolve_lexically(vault)?;
    let home = std::env::home_dir()
        .map(|home| resolve_lexically(&home))
        .transpose()?;
    let forbidden = [
        home.clone(),
        home.as_ref().map(|h| h.join("Documents")),
        home.as_ref().map(|h| h.join("Desktop")),
    ];
    let depth = absolute
        .components()
        .filter(|c| matches!(c, Component::Normal(_)))
        .count();
    if forbidden.iter().flatten().any(|path| *path == absolute) || depth == 0 {
        return Err(format!(
            "Refusing to operate on protected path: {}",
            absolute.display()
        )
        .into());
    }
    if depth < 2 {
        return Err(format!(
            "Vault path looks too shallow, refusing: {}",
            absolute.display()
        )
        .into());
    }
    Ok(absolute)
}

/// Only a missing or empty folder, or a vault [`seed_bench`] wrote, may be wiped: anything else
/// (a real vault, a repo, a symlink) is refused. Stricter than `wipe.ts`, which wiped any folder.
fn ensure_wipeable(vault: &Path) -> SeedResult<()> {
    let metadata = match fs::symlink_metadata(vault) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        metadata => metadata?,
    };
    if metadata.is_dir() && (fs::read_dir(vault)?.next().is_none() || is_bench_vault(vault)) {
        return Ok(());
    }
    Err(format!(
        "Refusing to wipe {}: not an empty folder or a benchmark vault (its .memry/config.json title is not \"{BENCH_TITLE}\")",
        vault.display()
    )
    .into())
}

/// An unreadable or unparsable config is not a bench vault: the caller refuses the wipe.
pub(crate) fn is_bench_vault(vault: &Path) -> bool {
    fs::read(config::config_path(vault))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
        .is_some_and(|config| config["title"] == BENCH_TITLE)
}

/// `wipeVault`: the folder removed with everything in it, then the empty layout made again.
pub fn wipe_vault(vault: &Path) -> SeedResult<PathBuf> {
    let absolute = ensure_safe_vault_path(vault)?;
    ensure_wipeable(&absolute)?;
    match fs::remove_dir_all(&absolute) {
        Err(error) if error.kind() != io::ErrorKind::NotFound => return Err(error.into()),
        _ => {}
    }
    for folder in [MEMRY_DIR, "notes", "journal", "attachments"] {
        fs::create_dir_all(absolute.join(folder))?;
    }
    Ok(absolute)
}

/// Writes each note as a new file through [`note_file::write_new_note`], its mtime set to the
/// note's `modified_at` (the app reads a note's dates from the file, not its frontmatter).
///
/// Each write syncs the file and its folder to disk, so the time goes to waiting on the disk,
/// not the CPU: the notes are written on up to 8 threads.
pub fn write_notes(vault: &Path, notes: &[BulkNote]) -> SeedResult<()> {
    let threads = std::thread::available_parallelism().map_or(1, |n| n.get().min(8));
    let chunk = notes.len().div_ceil(threads).max(1);
    std::thread::scope(|scope| {
        let writers: Vec<_> = notes
            .chunks(chunk)
            .map(|part| scope.spawn(move || write_each(vault, part)))
            .collect();
        writers
            .into_iter()
            .try_for_each(|writer| writer.join().expect("a note writer panicked"))
    })
}

fn write_each(vault: &Path, notes: &[BulkNote]) -> SeedResult<()> {
    for note in notes {
        note_file::write_new_note(vault, &note.path, &note.frontmatter, &note.body)
            .map_err(|error| format!("{}: {error}", note.path))?;
        let modified: SystemTime = DateTime::parse_from_rfc3339(&note.modified_at)?.into();
        File::options()
            .write(true)
            .open(vault.join(&note.path))?
            .set_modified(modified)?;
    }
    Ok(())
}

/// What [`seed_bench`] wrote.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BenchSummary {
    pub vault: PathBuf,
    pub notes: usize,
    pub folders: usize,
    pub tags: usize,
    pub bytes: u64,
}

/// Wipes `vault` and seeds `count` bulk notes from `seed`, with the folder icons, the property
/// definitions and the config `seed-bench-vault.ts` writes.
pub fn seed_bench(vault: &Path, count: usize, seed: u32) -> SeedResult<BenchSummary> {
    let generated = bulk_notes::generate(count, seed);
    let vault = wipe_vault(vault)?;

    let config = serde_json::json!({
        "version": 1,
        "title": BENCH_TITLE,
        "excludePatterns": [".git", "node_modules", ".DS_Store"],
    });
    fs_atomic::atomic_write(
        &config::config_path(&vault),
        serde_json::to_string_pretty(&config)?.as_bytes(),
    )?;
    for folder in &generated.folders {
        folder_file::update(&vault, &folder.path, |file| {
            file.set_icon(Some(&folder.icon))
        })?;
    }
    properties_file::update(&vault, |definitions| {
        for (name, color) in PROPERTY_DEFS {
            let kind = match name {
                "rating" => PropertyKind::Number(Vec::new()),
                _ => PropertyKind::Text(Vec::new()),
            };
            let definition = PropertyDefinition {
                kind,
                default_value: None,
                color: Some(color.to_owned()),
            };
            definitions.insert(name.to_owned(), definition);
        }
    })?;
    write_notes(&vault, &generated.notes)?;

    let mut bytes = 0;
    for note in &generated.notes {
        bytes += fs::metadata(vault.join(&note.path))?.len();
    }
    Ok(BenchSummary {
        vault,
        notes: generated.notes.len(),
        folders: generated.folders.len(),
        tags: generated.tags.len(),
        bytes,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn refused(path: &Path) -> bool {
        ensure_safe_vault_path(path).is_err()
    }

    #[test]
    fn a_dotdot_path_is_checked_where_it_resolves() {
        let home = std::env::home_dir().expect("a home folder");
        assert!(refused(&home.join("Documents").join("..")));
        assert!(refused(&home.join("Desktop").join(".").join("")));
        assert!(refused(Path::new("/a/b/../..")));
        assert!(refused(Path::new("/a/b/..")));
    }

    #[test]
    fn the_wipe_runs_on_the_resolved_path() {
        let tmp = tempfile::tempdir().expect("a scratch dir");
        let wiped = wipe_vault(&tmp.path().join("a").join("..").join("bench")).expect("wiped");
        assert_eq!(wiped, tmp.path().join("bench"));
        assert!(tmp.path().join("bench").join("notes").is_dir());
        assert!(!tmp.path().join("a").exists());
    }

    #[cfg(unix)]
    #[test]
    fn a_symlinked_vault_keeps_its_target() {
        let tmp = tempfile::tempdir().expect("a scratch dir");
        let real = tmp.path().join("real");
        fs::create_dir(&real).expect("real folder");
        fs::write(real.join("keep.md"), "keep").expect("a note");
        std::os::unix::fs::symlink(&real, tmp.path().join("link")).expect("a symlink");
        let mut with_slash = tmp.path().join("link").into_os_string();
        with_slash.push("/");
        assert!(wipe_vault(Path::new(&with_slash)).is_err());
        assert!(wipe_vault(&tmp.path().join("link")).is_err());
        assert!(real.join("keep.md").is_file());
    }

    #[test]
    fn a_folder_that_is_not_a_bench_vault_is_kept() {
        let tmp = tempfile::tempdir().expect("a scratch dir");
        let vault = tmp.path().join("vault");
        fs::create_dir(&vault).expect("vault folder");
        fs::write(vault.join("note.md"), "mine").expect("a note");
        let error = wipe_vault(&vault).expect_err("refused").to_string();
        assert!(
            error.contains("not an empty folder or a benchmark vault"),
            "{error}"
        );
        assert!(vault.join("note.md").is_file());
    }

    #[test]
    fn an_empty_folder_or_a_bench_vault_is_reseeded() {
        let tmp = tempfile::tempdir().expect("a scratch dir");
        let vault = tmp.path().join("vault");
        fs::create_dir(&vault).expect("empty folder");
        seed_bench(&vault, 3, 42).expect("an empty folder is seeded");
        fs::write(vault.join("stale.md"), "old").expect("a stale file");
        seed_bench(&vault, 3, 42).expect("a bench vault is reseeded");
        assert!(!vault.join("stale.md").exists());
    }
}

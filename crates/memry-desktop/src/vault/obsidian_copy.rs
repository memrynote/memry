//! Opening an Obsidian vault for the first time offers to work on a copy (a port of
//! `apps/desktop/src/main/vault/obsidian-vault-copy.ts`).
//!
//! The app rewrites a checklist line when it turns it into a task: an Obsidian Tasks line loses
//! its plugin fields (`📅 2026-11-01`, `🔁 every week`) and gains the app's `{task:<id>}`
//! suffix. The task keeps the due date, the file does not, so Obsidian, reading the same folder,
//! shows the task without one. So a folder holding `.obsidian/` and no `.memry/` is asked about
//! before it opens: copy it to `<name>-memrynote` beside it and open the copy, open the original
//! anyway, or cancel. A folder that has `.memry/` opens without asking: the app opened it before,
//! and its owner chose then.
//!
//! - The copy leaves out what belongs to the original alone, at its top level only: Obsidian's
//!   config, its trash and the git history ([`LEFT_OUT`]).
//! - The original is only read. The copy fills a fresh hidden folder beside the target
//!   (`.<target>.partial-<uuid>`), which is renamed into place only when complete, and never
//!   over anything that appeared there meanwhile. A failed copy removes that folder, so nothing
//!   is left that a later attempt could take for a vault. A crash leaves it hidden and is never
//!   taken for one either.
//! - A link inside the vault is copied as a link with the same target, never followed: a
//!   relative link keeps pointing inside the copy, and nothing outside the vault is read. The
//!   picked folder itself may be a link; it is the folder the user chose, so its contents are
//!   copied (Electron's `fs.cp` copied the link itself, a "copy" that wrote to the original).
//! - Files keep their bytes, permissions and modified time (the indexer dates notes from
//!   their files). Folders are made with the default permissions, where `fs.cp` kept the
//!   original's: a read-only folder would refuse the files copied into it, and the removal of a
//!   failed copy. A pipe, socket or device fails the copy, as `fs.cp` refuses one, and so do two
//!   names the copy's volume takes for one (`Note.md` and `note.md` onto a volume that folds
//!   case): the second would replace the first.
//! - The tree is walked with a stack of its own and at most [`MAX_OPEN_DIRS`] folder listings
//!   open, so a deep tree costs neither thread stack nor file handles, and a wide folder is
//!   listed as it is copied, not read into memory first.

use std::ffi::{OsStr, OsString};
use std::fs::{self, FileType};
use std::io;
use std::path::{Path, PathBuf};
use std::time::Duration;

use super::fs_atomic::{RETRY_DELAYS_MS, rename_no_replace, with_transient_retry};
use super::init::is_vault_initialized;
use super::layout::MEMRY_DIR;

const SCOPE: &str = "obsidian_copy";

/// `<name>` + this is the copy's folder name; `-2`, `-3` follow when a folder that is not a
/// vault holds it.
pub const COPY_SUFFIX: &str = "-memrynote";

/// What the copy leaves out, at the vault's top level.
pub const LEFT_OUT: [&str; 3] = [".obsidian", ".trash", ".git"];

/// Where the copy of a vault goes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CopyTarget {
    /// Nothing is there yet: the copy is made here.
    Create(PathBuf),
    /// The copy made last time, a vault of this app: it opens as it is.
    Reuse(PathBuf),
}

impl CopyTarget {
    pub fn path(&self) -> &Path {
        match self {
            CopyTarget::Create(path) | CopyTarget::Reuse(path) => path,
        }
    }
}

/// The user's answer, in the dialog's button order.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Choice {
    Copy,
    Original,
    Cancel,
}

/// What [`resolve_obsidian_open`] decided.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ObsidianOpenDecision {
    /// The copy was made here; it opens.
    CreateCopy(PathBuf),
    /// The copy made last time opens.
    OpenCopy(PathBuf),
    /// The picked folder opens: not an Obsidian vault this app never opened, or the user
    /// chose the original.
    OpenOriginal(PathBuf),
    Cancel,
}

impl ObsidianOpenDecision {
    /// The folder to open, `None` when the user cancelled.
    pub fn into_folder(self) -> Option<PathBuf> {
        match self {
            Self::CreateCopy(path) | Self::OpenCopy(path) | Self::OpenOriginal(path) => Some(path),
            Self::Cancel => None,
        }
    }
}

/// Where the copy of `picked` would go, or `None` when `picked` opens without asking: it is not
/// an Obsidian vault, or this app opened it before. An error when a candidate's name cannot be
/// looked up at all.
pub fn copy_target(picked: &Path) -> io::Result<Option<CopyTarget>> {
    let obsidian = fs::metadata(picked.join(".obsidian")).is_ok_and(|meta| meta.is_dir());
    if !obsidian || is_vault_initialized(picked) {
        return Ok(None);
    }
    let Some(name) = picked.file_name() else {
        // A volume root holds no folder beside it to copy into.
        tracing::warn!(
            scope = SCOPE,
            "an Obsidian vault at a volume root opens in place"
        );
        return Ok(None);
    };
    copy_target_beside(picked, name).map(Some)
}

/// `<name>-memrynote` beside the vault. A folder holding `.memry` at a candidate is the copy
/// made last time; anything else there (a file, a link, a folder that is not a vault or cannot
/// be looked into) is left alone and the next number is tried. A lookup that fails other than
/// with "not found" (a name too long for the volume) fails every number alike, so it ends the
/// search.
fn copy_target_beside(source: &Path, name: &OsStr) -> io::Result<CopyTarget> {
    for n in 1u32.. {
        let mut candidate = name.to_owned();
        candidate.push(COPY_SUFFIX);
        if n > 1 {
            candidate.push(format!("-{n}"));
        }
        let candidate = source.with_file_name(candidate);
        match fs::symlink_metadata(&candidate) {
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                return Ok(CopyTarget::Create(candidate));
            }
            Err(error) => return Err(error),
            Ok(meta)
                if meta.is_dir() && candidate.join(MEMRY_DIR).try_exists().unwrap_or(false) =>
            {
                return Ok(CopyTarget::Reuse(candidate));
            }
            Ok(_) => {}
        }
    }
    unreachable!("a free candidate exists before the counter runs out")
}

/// The folder `vault_select` opens for `picked`. Only an Obsidian vault this app never opened
/// is asked about: `ask` gets the picked folder and where its copy goes, and is not called
/// otherwise. An error is a copy that failed, or one that could not be placed; nothing it made
/// is left.
pub fn resolve_obsidian_open(
    picked: &Path,
    ask: impl FnOnce(&Path, &CopyTarget) -> Choice,
) -> io::Result<ObsidianOpenDecision> {
    let Some(target) = copy_target(picked)? else {
        return Ok(ObsidianOpenDecision::OpenOriginal(picked.to_owned()));
    };
    match (ask(picked, &target), target) {
        (Choice::Cancel, _) => Ok(ObsidianOpenDecision::Cancel),
        (Choice::Original, _) => {
            tracing::info!(scope = SCOPE, "opening an Obsidian vault in place");
            Ok(ObsidianOpenDecision::OpenOriginal(picked.to_owned()))
        }
        (Choice::Copy, CopyTarget::Reuse(copy)) => Ok(ObsidianOpenDecision::OpenCopy(copy)),
        (Choice::Copy, CopyTarget::Create(copy)) => {
            copy_vault(picked, &copy)?;
            tracing::info!(scope = SCOPE, "copied an Obsidian vault before opening it");
            Ok(ObsidianOpenDecision::CreateCopy(copy))
        }
    }
}

/// Copies the vault `source` to `target`, where nothing may be (module doc). On an error
/// nothing of the copy is left.
pub fn copy_vault(source: &Path, target: &Path) -> io::Result<()> {
    let name = target.file_name().ok_or_else(|| {
        io::Error::new(io::ErrorKind::InvalidInput, "the copy needs a folder name")
    })?;
    let id = uuid::Uuid::new_v4();
    let mut partial = OsString::from(".");
    partial.push(name);
    partial.push(format!(".partial-{id}"));
    let partial = target.with_file_name(partial);
    fs::create_dir(&partial)?;
    // A scanner reading the files just written (Windows Defender) refuses the folder's rename
    // for a moment.
    let copied = copy_tree(source, &partial).and_then(|()| {
        with_transient_retry(&RETRY_DELAYS_MS.map(Duration::from_millis), || {
            rename_no_replace(&partial, target)
        })
    });
    if copied.is_err()
        && let Err(error) = fs::remove_dir_all(&partial)
    {
        // The error kind only: the path is note-derived.
        tracing::warn!(
            scope = SCOPE,
            kind = ?error.kind(),
            "could not remove a partial vault copy"
        );
    }
    copied
}

/// Folders read at once, at most. Deeper, the oldest open listing is read to its end and
/// closed (`walkdir`'s `max_open`), so a deep tree runs out of neither handles nor memory, and
/// a wide folder is held in memory only while a tree this deep sits under it.
pub const MAX_OPEN_DIRS: usize = 32;

/// A folder's entries: listed as they are copied, or, once it is closed, the rest of them.
enum Entries {
    Open(fs::ReadDir),
    Read(std::vec::IntoIter<io::Result<(OsString, FileType)>>),
}

/// A folder being copied: its entries and where they go. The top level leaves out [`LEFT_OUT`].
struct Level {
    from: PathBuf,
    to: PathBuf,
    top: bool,
    entries: Entries,
}

impl Level {
    fn open(from: PathBuf, to: PathBuf, top: bool) -> io::Result<Self> {
        let entries = Entries::Open(fs::read_dir(&from)?);
        Ok(Self {
            from,
            to,
            top,
            entries,
        })
    }

    fn next(&mut self) -> Option<io::Result<(OsString, FileType)>> {
        loop {
            let entry = match &mut self.entries {
                Entries::Open(listing) => listing
                    .next()?
                    .and_then(|entry| Ok((entry.file_name(), entry.file_type()?))),
                Entries::Read(rest) => rest.next()?,
            };
            match entry {
                Ok((name, _)) if self.top && LEFT_OUT.iter().any(|left| name == *left) => {}
                other => return Some(other),
            }
        }
    }

    fn is_open(&self) -> bool {
        matches!(self.entries, Entries::Open(_))
    }

    /// Reads the listing to its end and closes it.
    fn close(&mut self) {
        if let Entries::Open(listing) = &mut self.entries {
            let rest: Vec<_> = listing
                .map(|entry| entry.and_then(|entry| Ok((entry.file_name(), entry.file_type()?))))
                .collect();
            self.entries = Entries::Read(rest.into_iter());
        }
    }
}

/// Copies what is under `source` into the empty folder `dest`, depth first.
fn copy_tree(source: &Path, dest: &Path) -> io::Result<()> {
    let mut stack = vec![Level::open(source.to_owned(), dest.to_owned(), true)?];
    while let Some(level) = stack.last_mut() {
        let Some(entry) = level.next() else {
            stack.pop();
            continue;
        };
        let (name, kind) = entry?;
        let (from, to) = (level.from.join(&name), level.to.join(&name));
        // `DirEntry::file_type` does not follow a link, so a link is never taken for its target.
        if kind.is_symlink() {
            copy_link(&from, &to)?;
        } else if kind.is_dir() {
            fs::create_dir(&to)?;
            if stack.iter().filter(|level| level.is_open()).count() >= MAX_OPEN_DIRS
                && let Some(oldest) = stack.iter_mut().find(|level| level.is_open())
            {
                oldest.close();
            }
            stack.push(Level::open(from, to, false)?);
        } else if kind.is_file() {
            copy_file(&from, &to)?;
        } else {
            return Err(io::Error::new(
                io::ErrorKind::Unsupported,
                "the vault holds a pipe, socket or device, which cannot be copied",
            ));
        }
    }
    Ok(())
}

/// The bytes and permissions (`std::fs::copy`: a clone on APFS and Btrfs when it can), then the
/// access and modified times, set by path (`utimensat`; `FILE_WRITE_ATTRIBUTES` on Windows), so
/// a copy its own mode makes unreadable or read-only takes them too.
fn copy_file(from: &Path, to: &Path) -> io::Result<()> {
    // Only this copy writes into its fresh folder, so a name already there is another name of
    // the source's that this volume folds into the same one; `fs::copy` would replace it.
    if fs::symlink_metadata(to).is_ok() {
        return Err(io::Error::new(
            io::ErrorKind::AlreadyExists,
            "two names in the vault are one name on the copy's volume",
        ));
    }
    fs::copy(from, to)?;
    // Read after the copy, which may have moved the source's access time.
    set_times(to, &fs::metadata(from)?)
}

#[cfg(unix)]
fn set_times(path: &Path, from: &fs::Metadata) -> io::Result<()> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    use std::os::unix::fs::MetadataExt;
    let path = CString::new(path.as_os_str().as_bytes())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "a path holds a NUL byte"))?;
    // `time_t` and `c_long` are `i64` on 64-bit targets and narrower on 32-bit Linux.
    let at = |sec: i64, nsec: i64| libc::timespec {
        tv_sec: sec as _,
        tv_nsec: nsec as _,
    };
    let times = [
        at(from.atime(), from.atime_nsec()),
        at(from.mtime(), from.mtime_nsec()),
    ];
    // SAFETY: `path` is NUL-terminated and `times` holds the two entries `utimensat` reads; both
    // outlive the call.
    if unsafe { libc::utimensat(libc::AT_FDCWD, path.as_ptr(), times.as_ptr(), 0) } == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

/// `SetFileTime` needs `FILE_WRITE_ATTRIBUTES`, which the read-only attribute does not refuse.
#[cfg(windows)]
fn set_times(path: &Path, from: &fs::Metadata) -> io::Result<()> {
    use std::os::windows::fs::OpenOptionsExt;
    const FILE_WRITE_ATTRIBUTES: u32 = 0x100;
    let times = fs::FileTimes::new()
        .set_accessed(from.accessed()?)
        .set_modified(from.modified()?);
    fs::OpenOptions::new()
        .access_mode(FILE_WRITE_ATTRIBUTES)
        .open(path)?
        .set_times(times)
}

#[cfg(unix)]
fn copy_link(from: &Path, to: &Path) -> io::Result<()> {
    std::os::unix::fs::symlink(fs::read_link(from)?, to)
}

/// A Windows link names its kind; creating one needs the symbolic-link privilege (Developer
/// Mode), without which the copy fails as Electron's did.
#[cfg(windows)]
fn copy_link(from: &Path, to: &Path) -> io::Result<()> {
    use std::os::windows::fs::{FileTypeExt, symlink_dir, symlink_file};
    let link = fs::read_link(from)?;
    if fs::symlink_metadata(from)?.file_type().is_symlink_dir() {
        symlink_dir(link, to)
    } else {
        symlink_file(link, to)
    }
}

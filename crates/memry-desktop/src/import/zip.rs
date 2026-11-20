//! Zip exports: `apps/desktop/src/main/import/_shared/zip.ts` over yauzl.
//!
//! [`Zips::walk`] visits every file entry of a picked zip in central-directory order, and
//! descends into a `.zip` that sits at the root of its archive (`Export-….zip` around
//! `…-Part-N.zip`). A nested zip elsewhere is an ordinary entry. An entry path that would leave
//! the archive fails the walk, as yauzl's `validateFileName` and `assertSafeEntryPath` did.
//!
//! Electron read the whole zip into memory and every entry with no limit. Here the picked zip
//! is read from disk on demand, [`Zips::read`] takes the caller's limit and checks it against
//! the declared size before inflating and against the bytes inflated after, a nested zip is held
//! in memory only up to [`MAX_SOURCE_BYTES`] and all of them up to [`MAX_NESTED_ZIP_BYTES`], and
//! nesting stops at [`MAX_ZIP_NESTING`] archives before the next one is read.

use std::fs::File;
use std::io::{self, Cursor, Read, Seek};
use std::path::Path;

use ::zip::ZipArchive;
use ::zip::result::ZipError;
use tokio_util::sync::CancellationToken;

use super::MAX_SOURCE_BYTES;

/// Archives one walk may open, the picked zip included. Electron recursed without a bound, so a
/// zip that holds itself never ended.
pub const MAX_ZIP_NESTING: usize = 4;

/// Bytes of nested zips one walk holds in memory. Takeout splits an export only into parts of
/// 1 GB or more, which [`MAX_SOURCE_BYTES`] already refuses as a nested zip, so a real nested
/// export holds one part of at most 100 MB; this leaves room for two.
pub const MAX_NESTED_ZIP_BYTES: u64 = 256 * 1024 * 1024;

trait Source: Read + Seek + Send {}
impl<T: Read + Seek + Send> Source for T {}

/// Where an entry's bytes are, for [`Zips::read`] while the walk's archives stay open.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EntryAt {
    archive: usize,
    index: usize,
}

/// `ZipEntry` of `zip.ts`.
#[derive(Debug, Clone)]
pub struct ZipEntry {
    /// Path within its archive, `/`-separated.
    pub filepath: String,
    /// `path.posix.basename(filepath)`.
    pub name: String,
    /// Lower-cased text after the path's last `.`; empty without one.
    pub extension: String,
    /// The folder within the archive; empty at the root.
    pub parent: String,
    pub at: EntryAt,
}

/// The archives of one import run.
#[derive(Default)]
pub struct Zips {
    archives: Vec<ZipArchive<Box<dyn Source>>>,
    /// Bytes of the nested zips in `archives`.
    held: u64,
}

pub type Visit<'a> = dyn FnMut(&mut Zips, ZipEntry) -> io::Result<()> + 'a;

impl Zips {
    /// `forEachZipEntry` for one picked zip: calls `visit` with each file entry until `cancel`
    /// fires. An unreadable archive, an unsafe entry path or a nesting past the cap is `Err`.
    pub fn walk(
        &mut self,
        path: &Path,
        cancel: &CancellationToken,
        visit: &mut Visit<'_>,
    ) -> io::Result<()> {
        let file: Box<dyn Source> = Box::new(File::open(path)?);
        self.open(file, 1, cancel, visit)
    }

    fn open(
        &mut self,
        source: Box<dyn Source>,
        depth: usize,
        cancel: &CancellationToken,
        visit: &mut Visit<'_>,
    ) -> io::Result<()> {
        let archive_at = self.archives.len();
        self.archives
            .push(ZipArchive::new(source).map_err(zip_error)?);
        for index in 0..self.archives[archive_at].len() {
            if cancel.is_cancelled() {
                return Ok(());
            }
            let raw = self.archives[archive_at]
                .name_for_index(index)
                .transpose()
                .map_err(zip_error)?
                .unwrap_or_default()
                .into_owned();
            // yauzl without `strictFileNames` reads `\` as `/`.
            let filepath = raw.replace('\\', "/");
            if filepath.ends_with('/') {
                continue;
            }
            if !is_safe_entry_path(&filepath) {
                return Err(io::Error::other(format!(
                    "Unsafe zip entry path: {filepath}"
                )));
            }
            let at = EntryAt {
                archive: archive_at,
                index,
            };
            let entry = ZipEntry {
                name: filepath.rsplit('/').next().unwrap_or("").to_owned(),
                extension: filepath
                    .rsplit_once('.')
                    .map_or(String::new(), |(_, ext)| ext.to_lowercase()),
                parent: filepath
                    .rsplit_once('/')
                    .map_or(String::new(), |(parent, _)| parent.to_owned()),
                filepath,
                at,
            };
            if entry.extension == "zip" && entry.parent.is_empty() {
                if depth == MAX_ZIP_NESTING {
                    return Err(io::Error::other(format!(
                        "Zip nested more than {MAX_ZIP_NESTING} deep"
                    )));
                }
                let room = MAX_NESTED_ZIP_BYTES - self.held;
                let nested = self.read(at, MAX_SOURCE_BYTES.min(room)).map_err(|error| {
                    if error.kind() == io::ErrorKind::FileTooLarge && room < MAX_SOURCE_BYTES {
                        io::Error::other(format!(
                            "Zip holds more than {} MB of nested zips. Extract the inner zips and pick them directly.",
                            MAX_NESTED_ZIP_BYTES / (1024 * 1024)
                        ))
                    } else {
                        error
                    }
                })?;
                self.held += nested.len() as u64;
                self.open(Box::new(Cursor::new(nested)), depth + 1, cancel, visit)?;
                continue;
            }
            visit(self, entry)?;
        }
        Ok(())
    }

    /// The entry's bytes, refused when it holds more than `limit`.
    pub fn read(&mut self, at: EntryAt, limit: u64) -> io::Result<Vec<u8>> {
        let mut entry = self.archives[at.archive]
            .by_index(at.index)
            .map_err(zip_error)?;
        if entry.size() > limit {
            return Err(too_large(limit));
        }
        let mut bytes = Vec::with_capacity(usize::try_from(entry.size()).unwrap_or(0));
        (&mut entry).take(limit + 1).read_to_end(&mut bytes)?;
        if bytes.len() as u64 > limit {
            return Err(too_large(limit));
        }
        Ok(bytes)
    }
}

/// A read refused for its size: [`io::ErrorKind::FileTooLarge`], so a caller can tell it from a
/// broken archive.
pub fn too_large(limit: u64) -> io::Error {
    io::Error::new(
        io::ErrorKind::FileTooLarge,
        format!("File is larger than {} MB", limit.div_ceil(1024 * 1024)),
    )
}

/// yauzl's `validateFileName` and `assertSafeEntryPath`: no absolute path, drive letter or `..`
/// segment, and nothing `path.normalize` would start with `..`.
fn is_safe_entry_path(path: &str) -> bool {
    let bytes = path.as_bytes();
    let drive = bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':';
    !(path.starts_with('/')
        || path.starts_with("..")
        || drive
        || path.split('/').any(|segment| segment == ".."))
}

fn zip_error(error: ZipError) -> io::Error {
    match error {
        ZipError::Io(error) => error,
        other => io::Error::other(other.to_string()),
    }
}

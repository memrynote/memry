//! Verified copy of a downloaded-data folder (embedding models, OCR languages) into the Tauri
//! data dir under the same relative paths.
//!
//! [`plan`] lists and hashes every source file before anything is written, so an unreadable
//! source fails the phase with nothing copied. Each file then goes to a temp sibling with `std::fs::copy` (a clone on APFS), is checked against
//! the source by size and sha256, synced and renamed into place, so a crash or a failed check
//! never leaves a partial file under the real name. Symlinks are never followed. A Tauri file
//! already at the path is kept: byte-equal is counted as present, different as kept.

use std::fs::{self, File, OpenOptions};
use std::io::{ErrorKind, Read};
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

use crate::electron_import::ImportError;
use crate::electron_import::report::CopyReport;

const TEMP_SUFFIX: &str = ".electron-import";

type FileDigest = (u64, [u8; 32]);

/// The regular files under a source folder with their size and sha256.
pub(super) struct CopyPlan {
    root: PathBuf,
    files: Vec<(PathBuf, FileDigest)>,
    skipped_non_regular: usize,
}

/// A missing folder is an empty plan.
pub(super) fn plan(root: &Path) -> Result<CopyPlan, ImportError> {
    let mut plan = CopyPlan {
        root: root.to_owned(),
        files: Vec::new(),
        skipped_non_regular: 0,
    };
    match fs::symlink_metadata(root) {
        Ok(meta) if meta.is_dir() => {}
        Ok(_) => {
            plan.skipped_non_regular = 1;
            return Ok(plan);
        }
        Err(e) if e.kind() == ErrorKind::NotFound => return Ok(plan),
        Err(e) => return Err(ImportError::io(root, e)),
    }
    let mut stack = vec![PathBuf::new()];
    while let Some(rel) = stack.pop() {
        let dir = root.join(&rel);
        for entry in fs::read_dir(&dir).map_err(|e| ImportError::io(&dir, e))? {
            let entry = entry.map_err(|e| ImportError::io(&dir, e))?;
            let child = rel.join(entry.file_name());
            let kind = entry
                .file_type()
                .map_err(|e| ImportError::io(entry.path(), e))?;
            if kind.is_dir() {
                stack.push(child);
            } else if kind.is_file() {
                let path = entry.path();
                let digest = digest(&path).map_err(|e| ImportError::io(&path, e))?;
                plan.files.push((child, digest));
            } else {
                plan.skipped_non_regular += 1;
            }
        }
    }
    plan.files.sort();
    Ok(plan)
}

pub(super) fn run(plan: &CopyPlan, dest_root: &Path) -> Result<CopyReport, ImportError> {
    let mut report = CopyReport {
        files: plan.files.len(),
        skipped_non_regular: plan.skipped_non_regular,
        ..CopyReport::default()
    };
    for (rel, expected) in &plan.files {
        let source = plan.root.join(rel);
        let dest = dest_root.join(rel);
        report.bytes += expected.0;
        match digest(&dest) {
            Ok(found) if found == *expected => report.already_present += 1,
            Ok(_) => report.kept_existing += 1,
            Err(e) if e.kind() == ErrorKind::NotFound => {
                copy_verified(&source, &dest, rel, expected)?;
                report.copied += 1;
            }
            Err(e) => return Err(ImportError::io(dest, e)),
        }
    }
    Ok(report)
}

fn copy_verified(
    source: &Path,
    dest: &Path,
    rel: &Path,
    expected: &FileDigest,
) -> Result<(), ImportError> {
    let parent = dest.parent().unwrap_or(dest);
    fs::create_dir_all(parent).map_err(|e| ImportError::io(parent, e))?;
    let mut temp = dest.as_os_str().to_owned();
    temp.push(TEMP_SUFFIX);
    let temp = PathBuf::from(temp);
    let result = (|| {
        fs::copy(source, &temp).map_err(|e| ImportError::io(source, e))?;
        if digest(&temp).map_err(|e| ImportError::io(&temp, e))? != *expected {
            return Err(ImportError::CopyMismatch(rel.to_owned()));
        }
        // Write access: Windows' `FlushFileBuffers` refuses a read-only handle.
        OpenOptions::new()
            .write(true)
            .open(&temp)
            .and_then(|f| f.sync_all())
            .map_err(|e| ImportError::io(&temp, e))?;
        fs::rename(&temp, dest).map_err(|e| ImportError::io(dest, e))
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}

/// Size and sha256 of a file, read in 1 MiB blocks.
fn digest(path: &Path) -> std::io::Result<FileDigest> {
    let mut file = File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0; 1 << 20];
    let mut len = 0;
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
        len += n as u64;
    }
    Ok((len, hasher.finalize().into()))
}

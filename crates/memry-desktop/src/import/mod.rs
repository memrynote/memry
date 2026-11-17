//! Imports from other apps (Step 32, #3549): Electron's framework
//! (`apps/desktop/src/main/import/{types,registry,runner,import-context}.ts`) and the importers
//! with their mappers (`packages/importers/src/<source>/`).
//!
//! An [`Importer`] reads the files a person picked, reports what it does through the
//! [`ImportContext`] and hands every write to an [`ImportSink`]. The [`runner`] runs one import
//! at a time per vault on a blocking thread, throttles its progress and writes the activity log
//! line. The importers agree with Electron's through the vectors in
//! `packages/contracts/test-vectors/importers/`, which
//! `apps/desktop/src/main/import/__vectors__/importer-vectors.test.ts` records from the
//! TypeScript importers and `tests/importer_vectors.rs` replays here.

pub mod assets;
pub mod context;
pub mod csv;
pub mod markdown;
pub mod messages;
pub mod registry;
pub mod runner;
pub mod sink;

use std::fs::{File, OpenOptions};
use std::io::{self, Read};
use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use tokio_util::sync::CancellationToken;

pub use context::{
    FailedItem, ImportContext, ImportPhase, ImportProgress, ImportSummary, SkippedGroup,
};
pub use messages::{ImportMessage, ImportText};
pub use registry::Registry;
pub use sink::{ImportSink, ImportedNote, SinkError};

/// The largest source file an importer reads into memory. Electron read any size; a larger file
/// fails its item before it is read.
pub const MAX_SOURCE_BYTES: u64 = 100 * 1024 * 1024;

/// `ImportInput`: the picked paths and the importer's own options.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportInput {
    pub source_paths: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub options: Option<Map<String, Value>>,
}

/// `ImporterMeta.fileSpec`: what the picker offers.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileSpec {
    pub label: String,
    pub extensions: Vec<String>,
    pub allow_multiple: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub directory: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub allow_directory: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub choose_label_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub folder_hint_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

/// `ImporterMeta`: one row of the Settings import catalog.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImporterMeta {
    pub id: String,
    pub name: String,
    pub description_key: String,
    pub file_spec: FileSpec,
    pub supports_preview: bool,
    pub account_based: bool,
}

/// `ImportPreviewGroup.counts[]`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewCount {
    pub label_key: String,
    pub value: usize,
}

/// `ImportPreviewGroup`: what one file or project would import.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewGroup {
    pub label: String,
    pub counts: Vec<PreviewCount>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sample_titles: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub warnings: Option<Vec<ImportText>>,
    /// Set when the group could not be read; the other groups still preview.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<ImportText>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct ImportPreview {
    pub groups: Vec<PreviewGroup>,
}

#[derive(Debug, thiserror::Error)]
pub enum ImportError {
    #[error("Unknown importer: {0}")]
    UnknownImporter(String),
    #[error("Importer \"{0}\" has no preview")]
    NoPreview(String),
    #[error("Importer \"{0}\" already registered")]
    AlreadyRegistered(String),
    /// A run or preview with this `importId` is still in flight; the new one is refused, so a
    /// cancel keeps reaching the first.
    #[error("Import \"{0}\" is already running")]
    DuplicateImport(String),
    /// The whole run failed: a folder of the selection could not be listed, say.
    #[error(transparent)]
    Io(#[from] io::Error),
    /// The importer's thread panicked; nothing after the panic was imported.
    #[error("the import stopped unexpectedly")]
    Crashed,
}

/// One source of imports (`Importer` of `types.ts`).
pub trait Importer: Send + Sync {
    fn meta(&self) -> ImporterMeta;

    /// Reads the input and reports what a run would import, writing nothing. Only an importer
    /// whose meta says `supports_preview` overrides it.
    fn preview(
        &self,
        _input: &ImportInput,
        _cancel: &CancellationToken,
    ) -> Result<ImportPreview, ImportError> {
        Err(ImportError::NoPreview(self.meta().id))
    }

    /// Imports. A failed item goes to `ctx.report_failed` and the run goes on; `Err` is a run
    /// that could not go on. Returns early, with what it did so far, once `ctx` is cancelled.
    fn run(
        &self,
        input: &ImportInput,
        ctx: &mut ImportContext,
        sink: &dyn ImportSink,
    ) -> Result<(), ImportError>;
}

/// Opens a regular file for reading, with its size. Anything else (a FIFO, a device, a
/// directory) is refused from the open handle before a read: a FIFO blocks the read until a
/// writer comes, holding the run and its vault, and `/dev/zero` never ends. The open itself
/// does not block on a FIFO (`O_NONBLOCK`, which a regular file ignores).
pub(crate) fn open_regular(path: &Path) -> io::Result<(File, u64)> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NONBLOCK);
    }
    let file = options.open(path)?;
    let meta = file.metadata()?;
    if !meta.is_file() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Not a regular file",
        ));
    }
    Ok((file, meta.len()))
}

/// Reads a source file as text the way Node's `readFile(path, 'utf8')` does (malformed UTF-8
/// becomes U+FFFD), refusing one over [`MAX_SOURCE_BYTES`] before it is read, and one that is
/// not a regular file ([`open_regular`]).
pub(crate) fn read_source_text(path: &Path) -> io::Result<String> {
    let too_large = || {
        io::Error::other(format!(
            "File is larger than {} MB",
            MAX_SOURCE_BYTES / (1024 * 1024)
        ))
    };
    let (file, size) = open_regular(path)?;
    if size > MAX_SOURCE_BYTES {
        return Err(too_large());
    }
    let mut bytes = Vec::new();
    // A file that grew since the open is still cut off at the cap.
    file.take(MAX_SOURCE_BYTES + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_SOURCE_BYTES {
        return Err(too_large());
    }
    Ok(match String::from_utf8(bytes) {
        Ok(text) => text,
        Err(error) => String::from_utf8_lossy(error.as_bytes()).into_owned(),
    })
}

/// `path.basename` of a picked path, for item labels.
pub(crate) fn base_name(path: &Path) -> String {
    path.file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string_lossy().into_owned())
}

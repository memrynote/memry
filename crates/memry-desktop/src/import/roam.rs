//! The Roam Research importer: `apps/desktop/src/main/import/roam/roam-importer.ts`.
//!
//! Each picked `.json` file is a Roam graph export, an array of pages. The first pass reads and
//! parses every file, writing nothing; a file that is not an array of titled pages fails its
//! item. Then every page of every file is mapped at once ([`map`]), so a block reference
//! resolves across files, and a graph the mapper refuses fails the run before any note exists.
//! The second pass creates one note per page under `Roam`. Roam exports carry no attachments:
//! Firebase image URLs stay inline as links, as in Electron.

mod map;

use std::io;
use std::path::Path;

pub use map::{
    MapError, NotePlan, map_pages, parse_daily_note_title, quoted_bytes_scrubbed, scrub_markup,
    split_title_path, template_bytes_scanned,
};

use super::messages::{importing_item, status};
use super::{
    FileSpec, ImportContext, ImportError, ImportInput, ImportPhase, ImportSink, ImportedNote,
    Importer, ImporterMeta, read_source_text,
};
use crate::web::extract::utils::json::{self, JsValue};

/// The most note body text one run maps. Electron had no bound: a block referenced from many
/// blocks, or a deep outline of empty blocks, grows far past the export that holds it.
pub const MAX_MAPPED_BYTES: usize = 256 * 1024 * 1024;
/// The most export text one run reads across every picked file, since every parsed graph is
/// held until the mapping ends. Electron had no bound.
pub const MAX_TOTAL_SOURCE_BYTES: usize = 128 * 1024 * 1024;

const NOT_ROAM: &str = "Not a Roam JSON export (expected an array of pages)";
/// Node's `JSON.parse` message names the token; this one does not.
const INVALID_JSON: &str = "Invalid JSON";
const UNSAFE_FOLDER: &str = "The page title names a folder outside the Roam folder";

/// `isRoamPageArray`.
fn is_page(value: &JsValue) -> bool {
    matches!(value, JsValue::Object(_)) && matches!(value.get("title"), Some(JsValue::String(_)))
}

/// A `.` or `..` folder segment, split on either separator, would place the note outside
/// `Roam`. Electron joined it into the path as written.
fn climbs_out(folder: &str) -> bool {
    folder
        .split(['/', '\\'])
        .any(|segment| segment == "." || segment == "..")
}

pub struct RoamImporter;

impl Importer for RoamImporter {
    fn meta(&self) -> ImporterMeta {
        ImporterMeta {
            id: "roam".to_owned(),
            name: "Roam".to_owned(),
            description_key: "import.sources.roam".to_owned(),
            file_spec: FileSpec {
                label: "Roam JSON export".to_owned(),
                extensions: vec!["json".to_owned()],
                allow_multiple: true,
                ..FileSpec::default()
            },
            supports_preview: false,
            account_based: false,
        }
    }

    fn run(
        &self,
        input: &ImportInput,
        ctx: &mut ImportContext,
        sink: &dyn ImportSink,
    ) -> Result<(), ImportError> {
        ctx.set_phase(ImportPhase::Scanning);
        ctx.status(status("roamReading"));

        let mut pages: Vec<JsValue> = Vec::new();
        let mut read_bytes = 0usize;
        for path in &input.source_paths {
            if ctx.is_cancelled() {
                return Ok(());
            }
            let text = read_source_text(Path::new(path));
            if let Ok(text) = &text {
                read_bytes = read_bytes.saturating_add(text.len());
                if read_bytes > MAX_TOTAL_SOURCE_BYTES {
                    return Err(io::Error::other(format!(
                        "The picked Roam files hold more than {} MB. Import fewer files at a time.",
                        MAX_TOTAL_SOURCE_BYTES / (1024 * 1024)
                    ))
                    .into());
                }
            }
            let parsed = text
                .map_err(|error| error.to_string())
                .and_then(|text| json::parse(&text).map_err(|_| INVALID_JSON.to_owned()));
            match parsed {
                Ok(JsValue::Array(items)) if items.iter().all(is_page) => {
                    pages.extend(items);
                    ctx.report_progress(pages.len(), 0);
                }
                Ok(_) => ctx.report_failed(path, NOT_ROAM),
                Err(error) => {
                    tracing::warn!(scope = "import", "roam file read/parse failed");
                    ctx.report_failed(path, &error);
                }
            }
        }
        if ctx.is_cancelled() {
            return Ok(());
        }

        let plans = match map_pages(&pages, MAX_MAPPED_BYTES, &ctx.cancel_token()) {
            Ok(plans) => plans,
            Err(MapError::Cancelled) => return Ok(()),
            Err(MapError::Shape(reason)) => {
                return Err(io::Error::new(io::ErrorKind::InvalidData, reason).into());
            }
            Err(MapError::TooLarge) => {
                return Err(io::Error::other(format!(
                    "The Roam export expands past {} MB of notes",
                    MAX_MAPPED_BYTES / (1024 * 1024)
                ))
                .into());
            }
        };
        drop(pages);

        ctx.set_phase(ImportPhase::Importing);
        let total = plans.len();
        for (done, note) in plans.into_iter().enumerate() {
            if ctx.is_cancelled() {
                return Ok(());
            }
            write_note(note, ctx, sink);
            ctx.report_progress(done + 1, total);
        }
        Ok(())
    }
}

/// `writeNote`: a refused note fails its item and the import goes on.
fn write_note(note: NotePlan, ctx: &mut ImportContext, sink: &dyn ImportSink) {
    ctx.status(importing_item(&note.title));
    // The page's title path, so two failed `Note` leaves stay apart.
    let title = match note
        .folder
        .strip_prefix(map::ROOT)
        .and_then(|f| f.strip_prefix('/'))
    {
        Some(parents) => format!("{parents}/{}", note.title),
        None => note.title.clone(),
    };
    let created = if climbs_out(&note.folder) {
        Err(UNSAFE_FOLDER.to_owned())
    } else {
        sink.create_note(ImportedNote {
            id: None,
            title: note.title,
            content: note.body,
            folder: Some(note.folder),
            tags: Vec::new(),
            properties: Default::default(),
            created: note.created,
            modified: note.modified,
        })
        .map_err(|error| error.0)
    };
    match created {
        Ok(()) => ctx.report_imported(),
        Err(error) => {
            tracing::warn!(scope = "import", "roam page import failed");
            ctx.report_failed(&title, &error);
        }
    }
}

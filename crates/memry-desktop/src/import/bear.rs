//! The Bear importer: `apps/desktop/src/main/import/bear/bear-importer.ts`.
//!
//! A Bear export (`.bear2bk`, or a zip) holds one `<Title>.textbundle/` folder per note, usually
//! under a backup folder: `text.md`, `info.json` and `assets/`. The first pass walks every picked
//! zip and groups its entries by bundle, writing nothing, so an archive that cannot be read fails
//! the run before any note exists. The second pass maps each bundle to a note under `Bear`,
//! `Bear/Archived` or `Bear/Trash`, rewrites `bear://` links between notes of the export to wiki
//! links, and saves the `assets/` files the body references.

mod map;

use std::collections::{HashMap, HashSet};
use std::io;
use std::path::Path;

use regex::{NoExpand, Regex};

pub use map::{BearInfo, MappedNote, map_note, parse_info, parse_tags, rewrite_bear_links};

use super::assets::{attachment_markdown, decode_uri_or_keep, encode_attachment_url};
use super::messages::{ImportText, importing_item, status};
use super::zip::{EntryAt, Zips};
use super::{
    FileSpec, ImportContext, ImportError, ImportInput, ImportPhase, ImportSink, ImportedNote,
    Importer, ImporterMeta, MAX_SOURCE_BYTES,
};
use crate::attachments::{AttachmentKind, MAX_FILE_SIZE};
use crate::web::extract::utils::json::{self, JsValue};

/// The largest `info.json` read. Electron read any size; Bear writes a few hundred bytes, and a
/// larger one is read as missing, as an unparsable one is.
const MAX_INFO_BYTES: u64 = 1024 * 1024;

/// `NoteStash`: what the walk found of one textbundle.
struct Stash {
    folder_name: String,
    md: Option<EntryAt>,
    info: JsValue,
    /// `assets/` files by file name; the last of a name wins.
    assets: HashMap<String, EntryAt>,
}

/// The bundles in the order their first entry was seen (`Map` insertion order).
#[derive(Default)]
struct Scan {
    zips: Zips,
    stashes: Vec<Stash>,
    by_folder: HashMap<String, usize>,
    uid_to_title: HashMap<String, String>,
}

impl Scan {
    fn stash(&mut self, folder: &str) -> &mut Stash {
        let at = *self.by_folder.entry(folder.to_owned()).or_insert_with(|| {
            self.stashes.push(Stash {
                folder_name: bundle_name(folder),
                md: None,
                info: JsValue::Null,
                assets: HashMap::new(),
            });
            self.stashes.len() - 1
        });
        &mut self.stashes[at]
    }
}

/// `textbundleFolder`: the path up to and including its first `.textbundle` segment.
fn textbundle_folder(filepath: &str) -> Option<&str> {
    let mut end = 0;
    for part in filepath.split('/') {
        end += part.len();
        if part.ends_with(".textbundle") {
            return Some(&filepath[..end]);
        }
        end += 1;
    }
    None
}

/// `bundleName`: the bundle's last segment without `.textbundle`.
fn bundle_name(folder: &str) -> String {
    let last = folder.rsplit('/').next().unwrap_or(folder);
    last.strip_suffix(".textbundle").unwrap_or(last).to_owned()
}

/// Reads an entry as `Buffer.toString('utf8')` does.
fn read_text(zips: &mut Zips, at: EntryAt, limit: u64) -> io::Result<String> {
    let bytes = zips.read(at, limit)?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

pub struct BearImporter;

impl Importer for BearImporter {
    fn meta(&self) -> ImporterMeta {
        ImporterMeta {
            id: "bear".to_owned(),
            name: "Bear".to_owned(),
            description_key: "import.sources.bear".to_owned(),
            file_spec: FileSpec {
                label: "Bear export".to_owned(),
                extensions: vec!["bear2bk".to_owned(), "zip".to_owned()],
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
        ctx.status(status("bearScanning"));

        let mut scan = Scan::default();
        for path in &input.source_paths {
            if ctx.is_cancelled() {
                return Ok(());
            }
            scan_zip(Path::new(path), &mut scan, ctx)?;
        }
        if ctx.is_cancelled() {
            return Ok(());
        }

        // Link targets by the title each note will get, read before any note is written.
        for at in 0..scan.stashes.len() {
            let stash = &scan.stashes[at];
            let (Some(md), Some(uid)) = (stash.md, parse_info(&stash.info).unique_identifier)
            else {
                continue;
            };
            if let Ok(md) = read_text(&mut scan.zips, md, MAX_SOURCE_BYTES) {
                let stash = &scan.stashes[at];
                let title = map_note(&stash.folder_name, &md, &parse_info(&stash.info)).title;
                scan.uid_to_title.insert(uid, title);
            }
        }

        ctx.set_phase(ImportPhase::Importing);
        let total = scan.stashes.len();
        for at in 0..total {
            if ctx.is_cancelled() {
                return Ok(());
            }
            let folder_name = scan.stashes[at].folder_name.clone();
            if scan.stashes[at].md.is_none() {
                ctx.report_skipped(&folder_name, Some("No text.md found".into()));
            } else {
                ctx.status(importing_item(&folder_name));
                match import_note(at, &mut scan, ctx, sink) {
                    Ok(()) => ctx.report_imported(),
                    Err(error) => {
                        tracing::warn!(scope = "import", "bear note import failed");
                        ctx.report_failed(&folder_name, &error);
                    }
                }
            }
            ctx.report_progress(at + 1, total);
        }
        Ok(())
    }
}

/// Pass one over a picked zip: groups its entries by textbundle and reads each `info.json`.
fn scan_zip(path: &Path, scan: &mut Scan, ctx: &mut ImportContext) -> io::Result<()> {
    let cancel = ctx.cancel_token();
    let mut zips = std::mem::take(&mut scan.zips);
    let walked = zips.walk(path, &cancel, &mut |zips, entry| {
        if ctx.is_cancelled() {
            return Ok(());
        }
        let Some(folder) = textbundle_folder(&entry.filepath) else {
            return Ok(());
        };
        if entry.name == "text.md" {
            scan.stash(folder).md = Some(entry.at);
            ctx.report_progress(scan.stashes.len(), 0);
        } else if entry.name == "info.json" {
            let info = match read_text(zips, entry.at, MAX_INFO_BYTES) {
                Ok(text) => json::parse(&text).ok(),
                Err(error) if error.kind() == io::ErrorKind::FileTooLarge => {
                    let note = bundle_name(folder);
                    tracing::warn!(
                        scope = "import",
                        note,
                        size = zips.size(entry.at).ok(),
                        "bear info.json over the size limit, read as missing"
                    );
                    let item = format!("{note}/info.json");
                    ctx.report_skipped(&item, Some(ImportText::Text(error.to_string())));
                    None
                }
                Err(_) => None,
            }
            .unwrap_or(JsValue::Null);
            let uid = parse_info(&info).unique_identifier;
            let stash = scan.stash(folder);
            stash.info = info;
            // Until pass one ends: the bundle's name stands in for the title.
            if let Some(uid) = uid {
                let name = stash.folder_name.clone();
                scan.uid_to_title.insert(uid, name);
            }
        } else if entry
            .parent
            .strip_prefix(folder)
            .is_some_and(|rest| rest.starts_with('/'))
        {
            scan.stash(folder).assets.insert(entry.name, entry.at);
        }
        Ok(())
    });
    scan.zips = zips;
    walked
}

/// Pass two for one bundle: saves the referenced assets under a fresh note id, then creates the
/// note once with its final body. `Err` fails this note only.
fn import_note(
    at: usize,
    scan: &mut Scan,
    ctx: &mut ImportContext,
    sink: &dyn ImportSink,
) -> Result<(), String> {
    let stash = &scan.stashes[at];
    let md_at = stash.md.expect("pass two imports bundles with a text.md");
    let md = read_text(&mut scan.zips, md_at, MAX_SOURCE_BYTES).map_err(|e| e.to_string())?;
    let stash = &scan.stashes[at];
    let mapped = map_note(&stash.folder_name, &md, &parse_info(&stash.info));
    let mut body = rewrite_bear_links(&md, &scan.uid_to_title);

    let note_id = sink.new_note_id();
    let mut seen = HashSet::new();
    for reference in &mapped.asset_refs {
        if !seen.insert(reference) {
            continue;
        }
        // Body refs are URL-encoded (`My%20File.png`); entries carry the decoded name.
        let name = decode_uri_or_keep(reference);
        let Some(&entry) = scan.stashes[at].assets.get(&name) else {
            continue;
        };
        let bytes = match scan.zips.read(entry, MAX_FILE_SIZE as u64) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == io::ErrorKind::FileTooLarge => {
                ctx.report_skipped(&name, Some(ImportText::Text(error.to_string())));
                continue;
            }
            Err(error) => return Err(error.to_string()),
        };
        match sink.save_attachment(&note_id, &name, &bytes) {
            Ok(saved) if saved.kind == AttachmentKind::Image => {
                // The alt text stays; only the target changes.
                body = body.replace(
                    &format!("](assets/{reference})"),
                    &format!("]({})", encode_attachment_url(&saved.path)),
                );
                ctx.report_attachment();
            }
            Ok(saved) => {
                // The whole `![alt](assets/<ref>)` embed becomes a file block.
                let embed = Regex::new(&format!(
                    r"!\[[^\]]*\]\(assets/{}\)",
                    regex::escape(reference)
                ))
                .map_err(|e| e.to_string())?;
                body = embed
                    .replace_all(&body, NoExpand(&attachment_markdown(&saved)))
                    .into_owned();
                ctx.report_attachment();
            }
            Err(error) => ctx.report_skipped(&name, Some(ImportText::Text(error.0))),
        }
    }

    sink.create_note(ImportedNote {
        id: Some(note_id),
        title: mapped.title,
        content: body,
        folder: Some(mapped.folder.to_owned()),
        tags: mapped.tags,
        properties: Default::default(),
        created: mapped.created,
        modified: mapped.modified,
    })
    .map_err(|e| e.0)
}

//! The Markdown importer: `apps/desktop/src/main/import/markdown/markdown-importer.ts` and
//! `packages/importers/src/markdown/{parse-frontmatter,map-files}.ts`.
//!
//! Each `.md` / `.markdown` file of the picked files and folders becomes a note under
//! `Markdown/<its folder>`. Frontmatter `title` and `tags` are lifted, the other keys become
//! properties, and co-located media is saved as attachments.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use chrono::{DateTime, SecondsFormat, Utc};
use memry_core::markdown::frontmatter::{
    YamlError, YamlMap, YamlValue, gray_matter_data, gray_matter_parts, js_trim,
};

use super::assets::{AssetNote, RealRoots, resolve_co_located_assets};
use super::messages::{importing_item, status};
use super::{
    FileSpec, ImportContext, ImportError, ImportInput, ImportPhase, ImportSink, ImportedNote,
    Importer, ImporterMeta, read_source_text,
};
use crate::attachments::extension;

/// Frontmatter and body of one file (`ParsedMarkdown`).
#[derive(Debug, Clone, PartialEq)]
pub struct ParsedMarkdown {
    pub title: Option<String>,
    pub tags: Vec<String>,
    pub properties: YamlMap,
    pub body: String,
}

/// `parseFrontmatter`: gray-matter's split and data, `title` and `tags` lifted out.
pub fn parse_frontmatter(source: &str) -> Result<ParsedMarkdown, YamlError> {
    let unbommed = source.strip_prefix('\u{FEFF}').unwrap_or(source);
    let (data, body) = match gray_matter_parts(source) {
        Some((_, content)) => (gray_matter_data(source)?, content),
        None => (YamlValue::map(YamlMap::new()), unbommed),
    };
    let mut parsed = ParsedMarkdown {
        title: None,
        tags: Vec::new(),
        properties: YamlMap::new(),
        body: body.to_owned(),
    };
    for (key, value) in object_entries(&data) {
        match key.as_str() {
            "title" => {
                if let YamlValue::String(title) = value {
                    parsed.title = Some(title);
                }
            }
            "tags" => parsed.tags = normalize_tags(&value),
            _ => parsed.properties.insert(key, value),
        }
    }
    Ok(parsed)
}

/// `Object.entries(data)` for whatever the frontmatter loaded as: a mapping's entries, an
/// array's or a string's elements under their indexes, nothing for any other scalar.
fn object_entries(data: &YamlValue) -> Vec<(String, YamlValue)> {
    match data {
        YamlValue::Map(map) => map
            .iter()
            .map(|(key, value)| (key.to_owned(), value.clone()))
            .collect(),
        YamlValue::Seq(items) => items
            .iter()
            .enumerate()
            .map(|(at, value)| (at.to_string(), value.clone()))
            .collect(),
        YamlValue::Binary(bytes) => bytes
            .iter()
            .enumerate()
            .map(|(at, byte)| (at.to_string(), YamlValue::Number(f64::from(*byte))))
            .collect(),
        // One entry per UTF-16 code unit; half of a surrogate pair becomes U+FFFD.
        YamlValue::String(text) => text
            .encode_utf16()
            .enumerate()
            .map(|(at, unit)| {
                (
                    at.to_string(),
                    YamlValue::String(String::from_utf16_lossy(&[unit])),
                )
            })
            .collect(),
        YamlValue::Null | YamlValue::Bool(_) | YamlValue::Number(_) | YamlValue::Date(_) => {
            Vec::new()
        }
    }
}

/// `normalizeTags`: every string of a list, or one trimmed string.
fn normalize_tags(raw: &YamlValue) -> Vec<String> {
    match raw {
        YamlValue::Seq(items) => items
            .iter()
            .filter_map(|item| match item {
                YamlValue::String(tag) => Some(tag.clone()),
                _ => None,
            })
            .collect(),
        YamlValue::String(tag) if !js_trim(tag).is_empty() => vec![js_trim(tag).to_owned()],
        _ => Vec::new(),
    }
}

/// One file of the plan (`NotePlan`).
#[derive(Debug, Clone, PartialEq)]
pub struct PlannedNote {
    pub path: PathBuf,
    /// The file name without its extension.
    pub title: String,
    /// `Markdown`, or `Markdown/<folder under the root>` with `/` separators.
    pub folder: String,
    /// The folder the person picked, or a lone file's own folder: assets stay inside it.
    pub root: PathBuf,
}

fn is_markdown_file(name: &str) -> bool {
    let ext = extension(name);
    ext.eq_ignore_ascii_case("md") || ext.eq_ignore_ascii_case("markdown")
}

/// `mapFiles` for one file `rel` (its path under `root`, `/`-separated).
fn plan_note(rel: &str, path: PathBuf, root: &Path) -> PlannedNote {
    let (dir, name) = rel.rsplit_once('/').unwrap_or(("", rel));
    let ext = extension(name);
    PlannedNote {
        path,
        title: name[..name.len() - ext.len() - 1].to_owned(),
        folder: if dir.is_empty() {
            "Markdown".to_owned()
        } else {
            format!("Markdown/{dir}")
        },
        root: root.to_path_buf(),
    }
}

/// `collectMarkdownFiles`: the markdown files under `root` in depth-first order, entries of a
/// folder by name. Links are neither files nor folders, as for Node's `Dirent`, so a link loop
/// is never entered. Iterative, so a deep tree cannot exhaust the stack.
fn collect(root: &Path, out: &mut Vec<PlannedNote>) -> std::io::Result<()> {
    let mut stack = vec![sorted_entries(root, "")?.into_iter()];
    while let Some(entries) = stack.last_mut() {
        let Some((rel, path, kind)) = entries.next() else {
            stack.pop();
            continue;
        };
        if kind.is_dir() {
            stack.push(sorted_entries(&path, &rel)?.into_iter());
        } else if kind.is_file() && is_markdown_file(&rel) {
            out.push(plan_note(&rel, path, root));
        }
    }
    Ok(())
}

type Entry = (String, PathBuf, fs::FileType);

/// A folder's entries by name, each with its path under the root. Node lists them in the
/// order the file system returns; sorting makes a run repeatable.
fn sorted_entries(dir: &Path, rel_dir: &str) -> std::io::Result<Vec<Entry>> {
    let mut entries = Vec::new();
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let name = entry.file_name();
        let kind = entry.file_type()?;
        entries.push((name, entry.path(), kind));
    }
    entries.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(entries
        .into_iter()
        .map(|(name, path, kind)| {
            let name = name.to_string_lossy();
            let rel = if rel_dir.is_empty() {
                name.into_owned()
            } else {
                format!("{rel_dir}/{name}")
            };
            (rel, path, kind)
        })
        .collect())
}

fn iso(time: SystemTime) -> String {
    DateTime::<Utc>::from(time).to_rfc3339_opts(SecondsFormat::Millis, true)
}

pub struct MarkdownImporter;

impl Importer for MarkdownImporter {
    fn meta(&self) -> ImporterMeta {
        ImporterMeta {
            id: "markdown".to_owned(),
            name: "Markdown".to_owned(),
            description_key: "import.sources.markdown".to_owned(),
            file_spec: FileSpec {
                label: "Markdown files".to_owned(),
                extensions: vec!["md".to_owned(), "markdown".to_owned()],
                allow_multiple: true,
                // Folder picks are what make co-located media work: `../Images/x.png`
                // resolves against the picked folder, not the note's own.
                allow_directory: Some(true),
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
        ctx.status(status("scanningFiles"));

        let mut plan = Vec::new();
        for source in &input.source_paths {
            if ctx.is_cancelled() {
                return Ok(());
            }
            let path = Path::new(source);
            let meta = match fs::metadata(path) {
                Ok(meta) => meta,
                Err(error) => {
                    ctx.report_failed(source, &error.to_string());
                    continue;
                }
            };
            if meta.is_dir() {
                collect(path, &mut plan)?;
            } else if let Some(name) = path.file_name().map(|n| n.to_string_lossy())
                && is_markdown_file(&name)
            {
                let root = path.parent().unwrap_or(Path::new(""));
                plan.push(plan_note(&name, path.to_path_buf(), root));
            }
        }

        let total = plan.len();
        ctx.report_progress(0, total);
        if ctx.is_cancelled() {
            return Ok(());
        }

        ctx.set_phase(ImportPhase::Importing);
        let mut done = 0;
        let mut roots = RealRoots::default();
        for note in &plan {
            if ctx.is_cancelled() {
                return Ok(());
            }
            ctx.status(importing_item(&note.title));
            match import_note(note, ctx, sink, &mut roots) {
                Ok(()) => {
                    ctx.report_imported();
                    done += 1;
                    ctx.report_progress(done, total);
                }
                Err(error) => {
                    tracing::warn!(scope = "import", "markdown note import failed");
                    ctx.report_failed(&note.path.to_string_lossy(), &error);
                }
            }
        }
        Ok(())
    }
}

fn import_note(
    note: &PlannedNote,
    ctx: &mut ImportContext,
    sink: &dyn ImportSink,
    roots: &mut RealRoots,
) -> Result<(), String> {
    let raw = read_source_text(&note.path).map_err(|e| e.to_string())?;
    let meta = fs::metadata(&note.path).map_err(|e| e.to_string())?;
    let parsed = parse_frontmatter(&raw).map_err(|e| e.to_string())?;
    let title = parsed
        .title
        .filter(|title| !title.is_empty())
        .unwrap_or_else(|| note.title.clone());

    // The id comes first so attachments are saved under it, and the note is written once with
    // its final body.
    let note_id = sink.new_note_id();
    let content = resolve_co_located_assets(
        &AssetNote {
            body: &parsed.body,
            note_id: &note_id,
            note_path: &note.path,
            root: &note.root,
        },
        ctx,
        sink,
        roots,
    );
    let modified = meta.modified().ok();
    // Node reports a birth time of the epoch where the file system keeps none; the
    // modification time is the closer answer.
    let created = meta.created().ok().or(modified);
    sink.create_note(ImportedNote {
        id: Some(note_id),
        title,
        content,
        folder: Some(note.folder.clone()),
        tags: parsed.tags,
        properties: parsed.properties,
        created: created.map(iso),
        modified: modified.map(iso),
    })
    .map_err(|e| e.0)
}

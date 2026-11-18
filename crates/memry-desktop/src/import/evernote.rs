//! The Evernote importer: `apps/desktop/src/main/import/evernote/evernote-importer.ts` and
//! `packages/importers/src/evernote/{enml,resources}.ts`.
//!
//! Each `.enex` file is a notebook: its notes go to `Evernote/<file name>`. The ENML of a note
//! is converted to Markdown; each `<en-media>` resolves by the MD5 of its resource's bytes,
//! which is saved as an attachment of the note.

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::LazyLock;

use md5::{Digest, Md5};
use memry_core::markdown::frontmatter::{YamlMap, js_trim};
use regex::{Captures, Regex};

use super::assets::attachment_markdown;
use super::enex::{EnexNote, parse_enex};
use super::html_md::{HtmlHooks, html_to_markdown, parse_html};
use super::messages::{ImportText, importing_item, status};
use super::{
    FileSpec, ImportContext, ImportError, ImportInput, ImportPhase, ImportSink, ImportedNote,
    Importer, ImporterMeta, base_name, read_text_capped,
};

const ROOT: &str = "Evernote";
const ENEX_SCHEME: &str = "memry-enex:";
/// An export holds its notebook's attachments, so it is read up to V8's string limit, which
/// bounded Electron's `readFileSync(path, 'utf8')`.
pub const MAX_ENEX_BYTES: u64 = 512 * 1024 * 1024;

static XML_DECL: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)<\?xml[^?]*\?>").expect("valid regex"));
static DOCTYPE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)<!DOCTYPE[^>]*>").expect("valid regex"));
static EN_NOTE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)<en-note(?:\s[^>]*)?>([\s\S]*?)</en-note>").expect("valid regex")
});
static TODO: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?i)<en-todo\s+checked="(true|false)"\s*/>"#).expect("valid regex")
});
/// Where a todo's label ends: the lookahead of `convertTodos`.
static TODO_END: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)<en-todo|</div>|</p>|<br\s*/?>").expect("valid regex"));
static EN_MEDIA: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)<en-media(?-u:\b)([^>]*?)/?>").expect("valid regex"));
static HASH_ATTR: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"hash="([^"]+)""#).expect("valid regex"));
static TYPE_ATTR: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"type="([^"]+)""#).expect("valid regex"));
/// A placeholder token, image or link, resolved or not.
static PLACEHOLDER: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"!?\[[^\]]*\]\(memry-enex:([^)]*)\)").expect("valid regex"));

/// `prepareEnml`: the inner HTML of `<en-note>`, todos as checkbox items.
pub fn prepare_enml(content: &str) -> String {
    let stripped = XML_DECL.replace_all(content, "");
    let stripped = DOCTYPE.replace_all(&stripped, "");
    let inner = EN_NOTE
        .captures(&stripped)
        .map_or_else(|| stripped.to_string(), |caps| caps[1].to_owned());
    convert_todos(&inner)
}

/// `convertTodos`: `<en-todo checked="..."/>label` becomes a one-item checkbox list.
fn convert_todos(html: &str) -> String {
    let mut out = String::with_capacity(html.len());
    let mut pos = 0;
    while let Some(caps) = TODO.captures_at(html, pos) {
        let head = caps.get(0).expect("group 0");
        let end = TODO_END
            .find_at(html, head.end())
            .map_or(html.len(), |m| m.start());
        out.push_str(&html[pos..head.start()]);
        let checked = if &caps[1] == "true" { " checked" } else { "" };
        let label = js_trim(&html[head.end()..end]);
        out.push_str(&format!(
            r#"<ul><li><input type="checkbox"{checked}>{label}</li></ul>"#
        ));
        pos = end;
    }
    out.push_str(&html[pos..]);
    out
}

/// `substituteEnMedia`: an image `<en-media>` becomes `<img src="memry-enex:H">`, any other a
/// link to it, before the HTML is parsed.
pub fn substitute_en_media(html: &str) -> String {
    EN_MEDIA
        .replace_all(html, |caps: &Captures<'_>| {
            let attrs = &caps[1];
            let hash = HASH_ATTR
                .captures(attrs)
                .map_or("", |c| c.get(1).map_or("", |m| m.as_str()));
            let mime = TYPE_ATTR
                .captures(attrs)
                .map_or("", |c| c.get(1).map_or("", |m| m.as_str()));
            if hash.is_empty() {
                String::new()
            } else if mime.starts_with("image/") {
                format!(r#"<img src="{ENEX_SCHEME}{hash}" alt="">"#)
            } else {
                format!(r#"<a href="{ENEX_SCHEME}{hash}">[attachment]</a>"#)
            }
        })
        .into_owned()
}

/// `sanitizeFilename` of `lib/export-utils.ts`.
pub fn sanitize_filename(name: &str) -> String {
    let kept: String = name
        .chars()
        .filter(|c| !matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*'))
        .collect();
    let collapsed = kept.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut units = 0;
    js_trim(&collapsed)
        .chars()
        .take_while(|c| {
            units += c.len_utf16();
            units <= 200
        })
        .collect()
}

/// `Buffer.from(base64, 'base64')`: both alphabets, anything else skipped, stop at `=`.
pub fn decode_base64_lenient(text: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(text.len() / 4 * 3);
    let (mut acc, mut bits) = (0u32, 0);
    for b in text.bytes() {
        let value = match b {
            b'A'..=b'Z' => b - b'A',
            b'a'..=b'z' => b - b'a' + 26,
            b'0'..=b'9' => b - b'0' + 52,
            b'+' | b'-' => 62,
            b'/' | b'_' => 63,
            b'=' => break,
            _ => continue,
        };
        acc = (acc << 6) | u32::from(value);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
            acc &= (1 << bits) - 1;
        }
    }
    out
}

/// A resource's fallback name from its MIME type.
fn resource_file_name(mime: &str, hash: &str) -> String {
    let ext = match mime.split('/').nth(1) {
        Some(sub) => {
            let sub = sub.split(';').next().unwrap_or("");
            sub.split_once('+').map_or(sub, |(head, _)| head).to_owned()
        }
        None => "bin".to_owned(),
    };
    format!("{}.{ext}", &hash[..hash.len().min(8)])
}

/// Collects the `memry-enex:` refs and keeps their placeholder tokens. A link's token has an
/// empty label: `[[attachment]](memry-enex:H)`, Electron's, matched neither its rewrite nor its
/// strip regex, so the note kept the internal link. The label never reaches the note: the
/// token becomes the attachment or nothing.
#[derive(Default)]
struct EnexHooks {
    refs: Vec<String>,
}

impl HtmlHooks for EnexHooks {
    fn image(&mut self, src: &str, _alt: &str, _assets: &mut Vec<String>) -> Option<String> {
        let hash = src.strip_prefix(ENEX_SCHEME)?;
        self.refs.push(hash.to_owned());
        Some(format!("![]({src})"))
    }

    fn anchor(&mut self, href: &str, _text: &str, _assets: &mut Vec<String>) -> Option<String> {
        let hash = href.strip_prefix(ENEX_SCHEME)?;
        self.refs.push(hash.to_owned());
        Some(format!("[]({href})"))
    }
}

pub struct EvernoteImporter;

impl Importer for EvernoteImporter {
    fn meta(&self) -> ImporterMeta {
        ImporterMeta {
            id: "evernote".to_owned(),
            name: "Evernote".to_owned(),
            description_key: "import.sources.evernote".to_owned(),
            file_spec: FileSpec {
                label: "Evernote export".to_owned(),
                extensions: vec!["enex".to_owned()],
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
        ctx.status(status("evernoteScanning"));
        let mut files = Vec::new();
        for source in &input.source_paths {
            if ctx.is_cancelled() {
                return Ok(());
            }
            let base = base_name(Path::new(source));
            // `path.basename(p, '.enex')`.
            let stem = match base.strip_suffix(".enex") {
                Some(stem) if !stem.is_empty() => stem,
                _ => &base,
            };
            files.push((source, sanitize_filename(stem)));
        }
        ctx.set_phase(ImportPhase::Importing);
        for (source, notebook) in files {
            if ctx.is_cancelled() {
                return Ok(());
            }
            let notes = match read_text_capped(Path::new(source), MAX_ENEX_BYTES) {
                Ok(xml) => match parse_enex(&xml) {
                    Ok(notes) => notes,
                    Err(error) => {
                        tracing::warn!(scope = "import", "enex parse failed");
                        ctx.report_failed(source, &error.to_string());
                        continue;
                    }
                },
                Err(error) => {
                    ctx.report_failed(source, &error.to_string());
                    continue;
                }
            };
            let folder = if notebook.is_empty() {
                ROOT.to_owned()
            } else {
                format!("{ROOT}/{notebook}")
            };
            let total = notes.len();
            let mut done = 0;
            for note in notes {
                if ctx.is_cancelled() {
                    return Ok(());
                }
                ctx.status(importing_item(&note.title));
                let title = note.title.clone();
                match import_note(note, &folder, ctx, sink) {
                    Ok(()) => {
                        ctx.report_imported();
                        done += 1;
                        ctx.report_progress(done, total);
                    }
                    Err(error) => {
                        tracing::warn!(scope = "import", "evernote note import failed");
                        ctx.report_failed(&title, &error);
                    }
                }
            }
        }
        Ok(())
    }
}

fn import_note(
    note: EnexNote,
    folder: &str,
    ctx: &mut ImportContext,
    sink: &dyn ImportSink,
) -> Result<(), String> {
    // `resourceByHash`: the MD5 of each resource's bytes; a later duplicate wins.
    let mut by_hash = HashMap::new();
    for resource in &note.resources {
        let bytes = decode_base64_lenient(&resource.base64);
        by_hash.insert(hex::encode(Md5::digest(&bytes)), (resource, bytes));
    }
    let media = substitute_en_media(&prepare_enml(&note.content_html));
    let html = format!("<html><body>{media}</body></html>");
    let mut doc = parse_html(&html).map_err(|e| e.to_string())?;
    let nodes = doc.body().map(|b| doc.child_nodes(b)).unwrap_or_default();
    let mut hooks = EnexHooks::default();
    let converted =
        html_to_markdown(&doc, &nodes, html.len(), &mut hooks).map_err(|e| e.to_string())?;
    let note_id = sink.new_note_id();
    let mut saved: HashMap<String, String> = HashMap::new();
    let mut seen = HashSet::new();
    for hash in hooks.refs {
        if !seen.insert(hash.clone()) {
            continue;
        }
        let Some((resource, bytes)) = by_hash.get(&hash) else {
            continue;
        };
        let name = resource
            .file_name
            .clone()
            .unwrap_or_else(|| resource_file_name(&resource.mime, &hash));
        match sink.save_attachment(&note_id, &name, bytes) {
            Ok(result) => {
                saved.insert(hash, attachment_markdown(&result));
                ctx.report_attachment();
            }
            Err(error) => ctx.report_skipped(&name, Some(ImportText::Text(error.0))),
        }
    }
    // Every placeholder in one pass: a saved one becomes its attachment, any other is dropped
    // so the internal scheme never reaches the note.
    let content = PLACEHOLDER
        .replace_all(&converted.markdown, |caps: &Captures<'_>| {
            saved.get(&caps[1]).cloned().unwrap_or_default()
        })
        .into_owned();
    sink.create_note(ImportedNote {
        id: Some(note_id),
        title: note.title,
        content,
        folder: Some(folder.to_owned()),
        tags: note.tags,
        properties: YamlMap::new(),
        created: note.created,
        modified: note.updated,
    })
    .map_err(|e| e.0)
}

//! The HTML importer: `apps/desktop/src/main/import/html/html-importer.ts` and
//! `packages/importers/src/html/{classify-ref,asset-filter,rewrite-links,map-files}.ts`.
//!
//! Each picked `.html` / `.htm` file becomes a note under `HTML`, titled by its `<title>`. A
//! link to another picked page becomes a wikilink; local, `file://` and https images are saved
//! as attachments of the note; `data:` images stay inline.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;

use memry_core::markdown::frontmatter::{YamlMap, js_trim};
use regex::{Captures, RegexBuilder};

use super::assets::{
    attachment_markdown, encode_attachment_url, file_name, lexical_join, percent_decode_ref,
};
use super::html_md::{HtmlHooks, html_to_markdown, parse_html, select, tag, text_content};
use super::messages::{ImportText, importing_item, status};
use super::remote::{HttpRemoteAssets, RemoteAssets, RemoteError, safe_remote_asset_url};
use super::{
    FileSpec, ImportContext, ImportError, ImportInput, ImportPhase, ImportSink, ImportedNote,
    Importer, ImporterMeta, base_name, open_regular, read_source_text,
};
use crate::attachments::{AttachmentKind, SavedAttachment};

const ROOT: &str = "HTML";
/// `MAX_ASSET_BYTES`: the largest image the importer saves.
pub const MAX_ASSET_BYTES: usize = 10 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RefKind {
    Data,
    Http,
    File,
    Local,
}

/// `classifyRef`.
pub fn classify_ref(reference: &str) -> RefKind {
    let lower = |prefix: &str| {
        reference
            .get(..prefix.len())
            .is_some_and(|head| head.eq_ignore_ascii_case(prefix))
    };
    if reference.starts_with("data:") {
        RefKind::Data
    } else if lower("http://") || lower("https://") {
        RefKind::Http
    } else if lower("file://") {
        RefKind::File
    } else {
        RefKind::Local
    }
}

/// `path.extname` of a base name.
fn ext_name(base: &str) -> &str {
    match base.rfind('.') {
        Some(at) if at > 0 && base != ".." => &base[at..],
        _ => "",
    }
}

/// `path.basename(p, path.extname(p))`.
pub fn stem(path: &str) -> String {
    let base = file_name(path);
    let ext = ext_name(&base);
    base[..base.len() - ext.len()].to_owned()
}

/// `interFileWikilink`: the title of the picked page an href names, by its base name.
pub fn inter_file_wikilink(href: &str, titles: &HashMap<String, String>) -> Option<String> {
    let decoded = percent_decode_ref(href);
    let clean = decoded.split('?').next().unwrap_or("");
    let clean = clean.split('#').next().unwrap_or("");
    titles.get(&stem(clean).to_lowercase()).cloned()
}

/// `extractTitle`: the first `<title>`'s text, or the file name without its extension.
fn extract_title(doc: &crate::web::extract::dom::Document, path: &Path) -> String {
    let title = select(doc, doc.root(), |n| tag(doc, n).as_deref() == Some("title"))
        .first()
        .map(|&t| js_trim(&text_content(doc, t)).to_owned())
        .filter(|t| !t.is_empty());
    title.unwrap_or_else(|| stem(&path.to_string_lossy()))
}

fn is_html(path: &Path) -> bool {
    let ext = ext_name(&base_name(path)).to_lowercase();
    ext == ".html" || ext == ".htm"
}

/// The `anchor` and `image` hooks of the importer.
struct PageHooks<'a> {
    titles: &'a HashMap<String, String>,
}

impl HtmlHooks for PageHooks<'_> {
    fn anchor(&mut self, href: &str, _text: &str, _assets: &mut Vec<String>) -> Option<String> {
        inter_file_wikilink(href, self.titles).map(|title| format!("[[{title}]]"))
    }

    fn image(&mut self, src: &str, alt: &str, assets: &mut Vec<String>) -> Option<String> {
        let kind = classify_ref(src);
        if kind == RefKind::Data {
            return Some(format!("![{alt}]({src})"));
        }
        // `../` is kept so the containment check sees a parent-relative path.
        let decoded = if kind == RefKind::Http {
            src.to_owned()
        } else {
            percent_decode_ref(src)
        };
        assets.push(decoded.clone());
        Some(format!("![{alt}]({decoded})"))
    }
}

pub struct HtmlImporter {
    remote: Arc<dyn RemoteAssets>,
}

impl Default for HtmlImporter {
    fn default() -> Self {
        Self::new(Arc::new(HttpRemoteAssets::default()))
    }
}

impl HtmlImporter {
    pub fn new(remote: Arc<dyn RemoteAssets>) -> Self {
        Self { remote }
    }
}

struct Planned {
    path: PathBuf,
    title: String,
}

impl Importer for HtmlImporter {
    fn meta(&self) -> ImporterMeta {
        ImporterMeta {
            id: "html".to_owned(),
            name: "HTML".to_owned(),
            description_key: "import.sources.html".to_owned(),
            file_spec: FileSpec {
                label: "HTML files".to_owned(),
                extensions: vec!["html".to_owned(), "htm".to_owned()],
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
        ctx.status(status("htmlScanning"));
        let mut plan = Vec::new();
        for source in &input.source_paths {
            if ctx.is_cancelled() {
                return Ok(());
            }
            let path = Path::new(source);
            if !is_html(path) {
                continue;
            }
            match read_source_text(path) {
                Ok(html) => plan.push(Planned {
                    title: extract_title(&parse_html(&html), path),
                    path: path.to_path_buf(),
                }),
                Err(error) => ctx.report_failed(source, &error.to_string()),
            }
        }
        let total = plan.len();
        ctx.report_progress(0, total);
        if ctx.is_cancelled() {
            return Ok(());
        }
        let titles: HashMap<String, String> = plan
            .iter()
            .map(|p| {
                (
                    stem(&p.path.to_string_lossy()).to_lowercase(),
                    p.title.clone(),
                )
            })
            .collect();

        ctx.set_phase(ImportPhase::Importing);
        let mut done = 0;
        for page in &plan {
            if ctx.is_cancelled() {
                return Ok(());
            }
            ctx.status(importing_item(&page.title));
            match self.import_page(page, &titles, ctx, sink) {
                Ok(()) => {
                    ctx.report_imported();
                    done += 1;
                    ctx.report_progress(done, total);
                }
                Err(error) => {
                    tracing::warn!(scope = "import", "html page import failed");
                    ctx.report_failed(&page.path.to_string_lossy(), &error);
                }
            }
        }
        Ok(())
    }
}

/// What a saved ref becomes in the body.
enum Rewrite {
    /// `](ref)` becomes `](url)`, keeping the alt text.
    Image(String),
    /// The whole `![alt](ref)` becomes a file block.
    File(String),
}

impl HtmlImporter {
    fn import_page(
        &self,
        page: &Planned,
        titles: &HashMap<String, String>,
        ctx: &mut ImportContext,
        sink: &dyn ImportSink,
    ) -> Result<(), String> {
        let html = read_source_text(&page.path).map_err(|e| e.to_string())?;
        let mut doc = parse_html(&html);
        let nodes = doc.body().map(|b| doc.child_nodes(b)).unwrap_or_default();
        let converted = html_to_markdown(&doc, &nodes, html.len(), &mut PageHooks { titles })
            .map_err(|e| e.to_string())?;
        // Attachments are saved under the id first; the note is written once, with its body.
        let note_id = sink.new_note_id();
        let dir = page.path.parent().unwrap_or(Path::new(""));
        let real_dir = fs::canonicalize(dir).unwrap_or_else(|_| dir.to_path_buf());
        // One save per file: `a.png` and `./a.png` reuse the first save.
        let mut by_real: HashMap<PathBuf, SavedAttachment> = HashMap::new();
        let mut rewrites: Vec<(String, Rewrite)> = Vec::new();
        let mut seen = HashSet::new();
        for reference in converted.assets {
            if !seen.insert(reference.clone()) {
                continue;
            }
            let fetched = match classify_ref(&reference) {
                RefKind::Data => continue,
                RefKind::Local => self.local(&reference, dir, &real_dir),
                RefKind::File => match decode_file_url(&reference) {
                    Some(local) => self.local(&local, dir, &real_dir),
                    None => {
                        ctx.report_failed(&reference, "URI malformed");
                        continue;
                    }
                },
                RefKind::Http => self.http(&reference),
            };
            let saved = match fetched {
                Fetched::Bytes(real, bytes) => {
                    if let Some(saved) = real.as_ref().and_then(|r| by_real.get(r)) {
                        rewrites.push((reference.clone(), rewrite_for(saved)));
                        continue;
                    }
                    let name = file_name(reference.split('?').next().unwrap_or(""));
                    match sink.save_attachment(&note_id, &name, &bytes) {
                        Ok(saved) => {
                            if let Some(real) = real {
                                by_real.insert(real, saved.clone());
                            }
                            saved
                        }
                        Err(error) => {
                            ctx.report_skipped(&reference, Some(ImportText::Text(error.0)));
                            continue;
                        }
                    }
                }
                Fetched::Skip(reason) => {
                    ctx.report_skipped(&reference, Some(ImportText::Text(reason)));
                    continue;
                }
                Fetched::Fail(error) => {
                    ctx.report_failed(&reference, &error);
                    continue;
                }
            };
            rewrites.push((reference, rewrite_for(&saved)));
            ctx.report_attachment();
        }
        let content = rewrite_refs(&converted.markdown, &rewrites)?;
        sink.create_note(ImportedNote {
            id: Some(note_id),
            title: page.title.clone(),
            content,
            folder: Some(ROOT.to_owned()),
            tags: Vec::new(),
            properties: YamlMap::new(),
            created: None,
            modified: None,
        })
        .map_err(|e| e.0)
    }

    /// A ref resolved against the page's folder. One that leaves the folder, by `..` or by a
    /// link, is refused before it is read.
    fn local(&self, reference: &str, dir: &Path, real_dir: &Path) -> Fetched {
        let unsafe_path = || Fetched::Skip("unsafe path".to_owned());
        let not_found = || Fetched::Skip("not found".to_owned());
        let joined = lexical_join(dir, reference);
        let lexical_dir = lexical_join(dir, "");
        // `path.relative(dir, abs).startsWith('..')`.
        let Ok(rel) = joined.strip_prefix(&lexical_dir) else {
            return unsafe_path();
        };
        if rel.components().next().is_some_and(
            |c| matches!(c, Component::Normal(n) if n.to_string_lossy().starts_with("..")),
        ) {
            return unsafe_path();
        }
        let Ok(real) = fs::canonicalize(&joined) else {
            return not_found();
        };
        if !real.starts_with(real_dir) {
            return unsafe_path();
        }
        let Ok((file, size)) = open_regular(&real) else {
            return not_found();
        };
        if size > MAX_ASSET_BYTES as u64 {
            return Fetched::Skip("too large".to_owned());
        }
        let mut bytes = Vec::new();
        if file
            .take(MAX_ASSET_BYTES as u64 + 1)
            .read_to_end(&mut bytes)
            .is_err()
        {
            return not_found();
        }
        if bytes.len() > MAX_ASSET_BYTES {
            return Fetched::Skip("too large".to_owned());
        }
        Fetched::Bytes(Some(real), bytes)
    }

    fn http(&self, reference: &str) -> Fetched {
        let Some(url) = safe_remote_asset_url(reference) else {
            return Fetched::Skip("unsafe URL".to_owned());
        };
        match self.remote.fetch(&url, MAX_ASSET_BYTES) {
            Ok(bytes) => Fetched::Bytes(None, bytes),
            Err(RemoteError::Status(code)) => Fetched::Skip(format!("HTTP {code}")),
            Err(RemoteError::TooLarge) => Fetched::Skip("too large".to_owned()),
            Err(RemoteError::Unreachable(reason)) => Fetched::Skip(reason),
            Err(RemoteError::Body(error)) => Fetched::Fail(error),
        }
    }
}

enum Fetched {
    /// The bytes, with the file's real path when it came from disk.
    Bytes(Option<PathBuf>, Vec<u8>),
    Skip(String),
    Fail(String),
}

/// `decodeURIComponent(ref.replace(/^file:\/\//i, ''))`; `None` where JavaScript throws.
fn decode_file_url(reference: &str) -> Option<String> {
    let rest = &reference["file://".len()..];
    let decoded = percent_decode_ref(rest);
    // `percent_decode_ref` gives the input back where `decodeURIComponent` throws.
    (decoded != rest || !rest.contains('%')).then_some(decoded)
}

fn rewrite_for(saved: &SavedAttachment) -> Rewrite {
    if saved.kind == AttachmentKind::Image {
        Rewrite::Image(encode_attachment_url(&saved.path))
    } else {
        Rewrite::File(attachment_markdown(saved))
    }
}

/// Every saved ref rewritten in one pass over the body. Electron replaced ref by ref, a pass
/// each, so a page with thousands of images took that many passes.
fn rewrite_refs(body: &str, rewrites: &[(String, Rewrite)]) -> Result<String, String> {
    if rewrites.is_empty() {
        return Ok(body.to_owned());
    }
    let patterns: Vec<String> = rewrites
        .iter()
        .map(|(reference, rewrite)| match rewrite {
            Rewrite::Image(_) => format!(r"\]\({}\)", regex::escape(reference)),
            Rewrite::File(_) => format!(r"!\[[^\]]*\]\({}\)", regex::escape(reference)),
        })
        .collect();
    let regex = RegexBuilder::new(&format!("(?:{})", patterns.join(")|(?:")))
        .size_limit(64 * 1024 * 1024)
        .build()
        .map_err(|_| "Too many images to import on one page".to_owned())?;
    let by_ref: HashMap<&str, &Rewrite> = rewrites
        .iter()
        .map(|(reference, rewrite)| (reference.as_str(), rewrite))
        .collect();
    Ok(regex
        .replace_all(body, |caps: &Captures<'_>| {
            let whole = &caps[0];
            // `](ref)` or `![alt](ref)`: the alt holds no `]`, so the ref follows the first `](`.
            let at = whole.find("](").map_or(0, |at| at + 2);
            let reference = &whole[at..whole.len() - 1];
            match by_ref.get(reference) {
                Some(Rewrite::Image(url)) if whole.starts_with(']') => format!("]({url})"),
                Some(Rewrite::File(md)) if whole.starts_with('!') => md.clone(),
                _ => whole.to_owned(),
            }
        })
        .into_owned())
}

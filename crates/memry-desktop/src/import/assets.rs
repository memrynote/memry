//! Co-located assets of folder-shaped exports: `packages/importers/src/markdown/
//! extract-asset-refs.ts`, `apps/desktop/src/main/import/_shared/{co-located-assets,
//! attachment-markdown}.ts`.
//!
//! A note references media next to or above it. Each reference resolves against the note's own
//! folder, anything that leaves the folder the person picked is refused, the rest is saved as
//! an attachment of the note and its reference is rewritten to the saved file.

use std::cell::Cell;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::sync::LazyLock;

use memry_core::markdown::frontmatter::js_trim;
use regex::{Captures, Regex};

use super::messages::ImportText;
use super::{ImportContext, ImportSink, open_regular};
use crate::attachments::{self, AttachmentKind, MAX_FILE_SIZE, SavedAttachment};

/// `MD_LINK_RE`: `![alt](ref)` or `[text](ref)`. Neither class takes `[`, so a run cannot
/// overrun into the next link.
static MD_LINK: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"!?\[[^\]\[]*\]\(([^)\[]+)\)").expect("valid regex"));
/// `WIKI_EMBED_RE`: Obsidian's `![[ref]]`, `![[ref|300x200]]`, `![[ref#page=3]]`.
static WIKI_EMBED: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"!\[\[([^\]\[|#]+)(?:[|#][^\]\[]*)?\]\]").expect("valid regex"));
/// Any `![[...]]` the rewrite looks at: `replaceAssetToken`'s embed pattern for every ref.
static ANY_EMBED: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"!\[\[([^\]\[]+)\]\]").expect("valid regex"));
/// `URL_RE`: a scheme, or a Windows drive.
static URL: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[a-zA-Z][a-zA-Z\d+\-.]*:").expect("valid regex"));

const NOT_FOUND: &str = "Asset file not found";
const OUTSIDE_ROOT: &str = "Path traversal outside selected folder";

thread_local! {
    static BYTES_SCANNED: Cell<usize> = const { Cell::new(0) };
}

/// Body bytes this thread's ref extraction and rewrite passes have read: two passes each, so
/// a body costs four times its length whatever the number of refs.
#[doc(hidden)]
pub fn bytes_scanned() -> usize {
    BYTES_SCANNED.with(Cell::get)
}

fn count_pass(body: &str) {
    BYTES_SCANNED.with(|scanned| scanned.set(scanned.get() + body.len()));
}

/// `extractAssetRefs`: the relative asset refs of a body in first-seen order, no duplicates.
/// URLs, absolute paths, other notes (`.md`, `.markdown`) and note embeds are not assets.
pub fn extract_asset_refs(body: &str) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut refs = Vec::new();
    let mut keep = |reference: &str| {
        if seen.insert(reference.to_owned()) {
            refs.push(reference.to_owned());
        }
    };
    count_pass(body);
    for caps in MD_LINK.captures_iter(body) {
        let reference = js_trim(&caps[1]);
        let path_part = reference.split(['?', '#']).next().unwrap_or("");
        if reference.is_empty()
            || URL.is_match(reference)
            || reference.starts_with("[[")
            || reference.starts_with('/')
            || is_markdown_name(path_part)
        {
            continue;
        }
        keep(reference);
    }
    count_pass(body);
    for caps in WIKI_EMBED.captures_iter(body) {
        let reference = js_trim(&caps[1]);
        if reference.is_empty()
            || URL.is_match(reference)
            || reference.starts_with('/')
            || !is_embeddable(reference)
        {
            continue;
        }
        keep(reference);
    }
    refs
}

/// `/\.(md|markdown)$/i`.
fn is_markdown_name(name: &str) -> bool {
    name.rsplit_once('.').is_some_and(|(_, ext)| {
        ext.eq_ignore_ascii_case("md") || ext.eq_ignore_ascii_case("markdown")
    })
}

/// `EMBEDDABLE_REF_RE` (`/\.(?!md$|markdown$)[^./\\]+$/i`): a file name with an extension that
/// is not another note's.
fn is_embeddable(reference: &str) -> bool {
    reference.rsplit_once('.').is_some_and(|(_, ext)| {
        !ext.is_empty()
            && !ext.contains(['/', '\\'])
            && !ext.eq_ignore_ascii_case("md")
            && !ext.eq_ignore_ascii_case("markdown")
    })
}

/// `percentDecodeRef`: `decodeURIComponent`, or the ref unchanged when that throws (a `%` not
/// followed by two hex digits, or escapes that are not UTF-8).
pub fn percent_decode_ref(reference: &str) -> String {
    decode_uri(reference, b"").unwrap_or_else(|| reference.to_owned())
}

/// `decodeURI` (`decodeURIComponent` that keeps the escapes of `;/?:@&=+$,#`), or the text
/// unchanged when that throws.
pub fn decode_uri_or_keep(text: &str) -> String {
    decode_uri(text, b";/?:@&=+$,#").unwrap_or_else(|| text.to_owned())
}

/// Decodes `%XX` escapes, keeping the escape of a byte in `reserved` as written.
fn decode_uri(text: &str, reserved: &[u8]) -> Option<String> {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    let escaped = |at: usize| -> Option<u8> {
        if bytes.get(at) != Some(&b'%') {
            return None;
        }
        let hex = bytes.get(at + 1..at + 3)?;
        // `from_str_radix` alone also takes a sign: `%+1` would decode where JavaScript throws.
        if !hex.iter().all(u8::is_ascii_hexdigit) {
            return None;
        }
        u8::from_str_radix(std::str::from_utf8(hex).ok()?, 16).ok()
    };
    while i < bytes.len() {
        if bytes[i] != b'%' {
            out.push(bytes[i]);
            i += 1;
            continue;
        }
        let lead = escaped(i)?;
        i += 3;
        if reserved.contains(&lead) {
            out.extend_from_slice(&bytes[i - 3..i]);
            continue;
        }
        let len = match lead.leading_ones() {
            0 => 1,
            n @ 2..=4 => n as usize,
            _ => return None,
        };
        let mut sequence = vec![lead];
        for _ in 1..len {
            let byte = escaped(i)?;
            if byte & 0xC0 != 0x80 {
                return None;
            }
            sequence.push(byte);
            i += 3;
        }
        // Rejects overlong forms, surrogates and code points past U+10FFFF, as JavaScript does.
        std::str::from_utf8(&sequence).ok()?;
        out.extend(sequence);
    }
    String::from_utf8(out).ok()
}

/// `encodeAttachmentUrl`: a space or a parenthesis would end the markdown link.
pub(crate) fn encode_attachment_url(url: &str) -> String {
    url.replace(' ', "%20")
        .replace('(', "%28")
        .replace(')', "%29")
}

/// `attachmentMarkdown`: an inline image, or a file block marker the renderer opens.
pub fn attachment_markdown(saved: &SavedAttachment) -> String {
    if saved.kind == AttachmentKind::Image {
        let alt: String = saved
            .name
            .chars()
            .filter(|c| !matches!(c, '[' | ']'))
            .collect();
        return format!("![{alt}]({})", encode_attachment_url(&saved.path));
    }
    let props = serde_json::json!({
        "url": saved.path,
        // A `}` in the name would end the marker early.
        "name": saved.name.chars().filter(|c| !matches!(c, '{' | '}')).collect::<String>(),
        "size": saved.size,
        "mimeType": saved.mime_type,
    });
    format!("<!-- file:{props} -->")
}

/// The note whose assets [`resolve_co_located_assets`] saves.
pub struct AssetNote<'a> {
    pub body: &'a str,
    /// The id the note will be created under; its attachments are saved under it first.
    pub note_id: &'a str,
    pub note_path: &'a Path,
    /// The folder the person picked: no asset may resolve outside it.
    pub root: &'a Path,
}

/// `realpath` of each selection root, resolved once per run.
#[derive(Default)]
pub struct RealRoots(HashMap<PathBuf, PathBuf>);

impl RealRoots {
    /// The root's real path, or the path as given when it does not resolve: the containment
    /// check then compares against it, as Electron's did.
    fn get(&mut self, root: &Path) -> PathBuf {
        self.0
            .entry(root.to_path_buf())
            .or_insert_with(|| fs::canonicalize(root).unwrap_or_else(|_| root.to_path_buf()))
            .clone()
    }
}

/// `resolveCoLocatedAssets`: saves every asset `note.body` references and returns the body with
/// those references rewritten to the saved files. A missing file, one outside the root, one
/// that is not a regular file or one the sink refuses is reported skipped and its reference
/// stays.
///
/// A cancel is not checked here: the importer checks it between notes, so a note is either
/// written with every asset it references or not at all. Electron stopped mid-note and wrote
/// the note with its remaining references pointing at the export.
pub fn resolve_co_located_assets(
    note: &AssetNote<'_>,
    ctx: &mut ImportContext,
    sink: &dyn ImportSink,
    roots: &mut RealRoots,
) -> String {
    let source_dir = note.note_path.parent().unwrap_or(Path::new(""));
    let real_root = roots.get(note.root);
    let mut saved: HashMap<String, (usize, String)> = HashMap::new();
    // One save per file: `a.png`, `./a.png` and `x/../a.png` reuse the first save's markdown.
    let mut by_real: HashMap<PathBuf, String> = HashMap::new();

    for (order, reference) in extract_asset_refs(note.body).into_iter().enumerate() {
        let decoded = percent_decode_ref(&reference);
        // Resolved against the note's folder, then for real: a link inside the selection can
        // point anywhere, and macOS reports `/private/var` for a `/var` path.
        let Ok(real) = fs::canonicalize(lexical_join(source_dir, &decoded)) else {
            ctx.report_skipped(&reference, Some(ImportText::from(NOT_FOUND)));
            continue;
        };
        if !real.starts_with(&real_root) {
            ctx.report_skipped(&reference, Some(ImportText::from(OUTSIDE_ROOT)));
            continue;
        }
        if let Some(markdown) = by_real.get(&real) {
            saved.insert(reference, (order, markdown.clone()));
            continue;
        }
        let name = file_name(&decoded);
        // Electron's `readFile` of a folder failed as not found; a FIFO or device is refused
        // the same way instead of blocking the run.
        let Ok((file, size)) = open_regular(&real) else {
            ctx.report_skipped(&reference, Some(ImportText::from(NOT_FOUND)));
            continue;
        };
        if size > MAX_FILE_SIZE as u64 {
            let error = attachments::AttachmentError::TooLarge {
                size: usize::try_from(size).unwrap_or(usize::MAX),
                limit: MAX_FILE_SIZE,
            };
            ctx.report_skipped(&name, Some(ImportText::Text(error.to_string())));
            continue;
        }
        let mut bytes = Vec::new();
        if file
            .take(MAX_FILE_SIZE as u64 + 1)
            .read_to_end(&mut bytes)
            .is_err()
        {
            ctx.report_skipped(&reference, Some(ImportText::from(NOT_FOUND)));
            continue;
        }
        match sink.save_attachment(note.note_id, &name, &bytes) {
            Ok(result) => {
                let markdown = attachment_markdown(&result);
                by_real.insert(real, markdown.clone());
                saved.insert(reference, (order, markdown));
                ctx.report_attachment();
            }
            Err(error) => ctx.report_skipped(&name, Some(ImportText::Text(error.0))),
        }
    }

    rewrite_asset_refs(note.body, &saved)
}

/// `replaceAssetToken` for every saved ref at once: each `![alt](ref)` / `[text](ref)` and each
/// `![[ref]]`, `![[ref|...]]`, `![[ref#...]]` becomes the ref's markdown. `saved` maps a ref to
/// its first-seen order and its replacement; when several refs match one embed, the earliest
/// wins, as it did when Electron replaced ref by ref.
#[doc(hidden)]
pub fn rewrite_asset_refs(body: &str, saved: &HashMap<String, (usize, String)>) -> String {
    if saved.is_empty() {
        return body.to_owned();
    }
    count_pass(body);
    let links = MD_LINK.replace_all(body, |caps: &Captures<'_>| match saved.get(&caps[1]) {
        Some((_, markdown)) => markdown.clone(),
        None => caps[0].to_owned(),
    });
    count_pass(&links);
    let longest = saved.keys().map(String::len).max().unwrap_or(0);
    ANY_EMBED
        .replace_all(&links, |caps: &Captures<'_>| {
            let inner = &caps[1];
            // `ref` alone, or `ref` followed by a `|` or `#` tail.
            let candidates = std::iter::once(inner).chain(
                inner
                    .match_indices(['|', '#'])
                    .map(|(at, _)| &inner[..at])
                    .take_while(|prefix| prefix.len() <= longest),
            );
            candidates
                .filter_map(|candidate| saved.get(candidate))
                .min_by_key(|(order, _)| *order)
                .map_or_else(|| caps[0].to_owned(), |(_, markdown)| markdown.clone())
        })
        .into_owned()
}

/// `path.resolve(dir, reference)` without touching the disk: `..` leaves the folder before any
/// link is followed, as in Node.
pub(crate) fn lexical_join(dir: &Path, reference: &str) -> PathBuf {
    let mut out = PathBuf::new();
    for component in dir.join(reference).components() {
        match component {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other),
        }
    }
    out
}

/// `path.basename` of a decoded ref.
pub(crate) fn file_name(reference: &str) -> String {
    let separators: &[char] = if cfg!(windows) { &['/', '\\'] } else { &['/'] };
    let trimmed = reference.trim_end_matches(separators);
    trimmed
        .rsplit(separators)
        .next()
        .unwrap_or(trimmed)
        .to_owned()
}

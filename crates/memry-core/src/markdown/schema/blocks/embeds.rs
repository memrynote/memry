//! The image-embed blocks of `blocks/markdown.ts`: bookmark, YouTube embed and
//! whiteboard, each a whole line `![alt](url)` whose alt text names the block.

use serde::Serialize;

use crate::markdown::frontmatter::js::is_js_whitespace;
use crate::markdown::shared::youtube::extract_youtube_video_id;

/// The alt text Memry itself writes, and the `alt` prop's default.
pub const YOUTUBE_EMBED_DEFAULT_ALT: &str = "embed";

/// `BOOKMARK_LINE_REGEX`, `^!\[bookmark\]\(([^)]+)\)$`: the URL of a whole line
/// that is nothing but a bookmark marker.
pub fn bookmark_line_url(line: &str) -> Option<&str> {
    let url = line.strip_prefix("![bookmark](")?.strip_suffix(')')?;
    (!url.is_empty() && !url.contains(')')).then_some(url)
}

/// Whether a line matches `BOOKMARK_LINE_REGEX`.
pub fn is_bookmark_line(line: &str) -> bool {
    bookmark_line_url(line).is_some()
}

/// `^!\[([^\]\n]*)\]\(([^)\s]+)\)$`: `(alt, url)` of a whole `![alt](url)` line.
fn image_line(line: &str) -> Option<(&str, &str)> {
    let rest = line.strip_prefix("![")?;
    let close = rest.find(']')?;
    let alt = &rest[..close];
    if alt.contains('\n') {
        return None;
    }
    let url = rest[close + 1..].strip_prefix('(')?.strip_suffix(')')?;
    let valid = !url.is_empty() && !url.contains(')') && !url.contains(is_js_whitespace);
    valid.then_some((alt, url))
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct YoutubeEmbedLine {
    pub video_id: String,
    pub video_url: String,
    pub alt: String,
}

/// `parseYoutubeEmbedLine`: a whole line `![alt](youtube-url)`, with any alt
/// text except the names of the other marker blocks, as a YouTube embed.
pub fn parse_youtube_embed_line(line: &str) -> Option<YoutubeEmbedLine> {
    let (alt, video_url) = image_line(line)?;
    if matches!(alt, "bookmark" | "whiteboard") {
        return None;
    }
    let video_id = extract_youtube_video_id(video_url)?;
    Some(YoutubeEmbedLine {
        video_id,
        video_url: video_url.to_owned(),
        alt: alt.to_owned(),
    })
}

pub fn serialize_youtube_embed(video_url: &str, alt: Option<&str>) -> String {
    format!(
        "![{}]({video_url})",
        alt.unwrap_or(YOUTUBE_EMBED_DEFAULT_ALT)
    )
}

pub fn serialize_bookmark(url: &str) -> String {
    format!("![bookmark]({url})")
}

pub fn serialize_whiteboard(canvas_id: &str) -> String {
    format!("![whiteboard]({})", whiteboard_url(canvas_id))
}

pub fn whiteboard_url(canvas_id: &str) -> String {
    format!("memry://canvas/{canvas_id}")
}

/// `parseWhiteboardLine`: the canvas id a whole-line whiteboard marker points
/// at, `^!\[whiteboard\]\(memry:\/\/canvas\/([A-Za-z0-9_-]+)\)$`.
pub fn parse_whiteboard_line(line: &str) -> Option<&str> {
    let id = line
        .strip_prefix("![whiteboard](memry://canvas/")?
        .strip_suffix(')')?;
    let valid = !id.is_empty()
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-');
    valid.then_some(id)
}

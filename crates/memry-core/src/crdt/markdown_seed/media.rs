//! Images, videos and the embed blocks Memry writes as one line: desktop's
//! `separateBlockImages` (`shared/empty-lines.ts`), the marker lines
//! `parseCustomBlockMarkerLine` claims (`blocknote-converter.ts`, with the
//! parsers in `editor-schema/src/blocks/markdown.ts`), and the media block an
//! `<img>` or `<video>` parses to (`withImageWidthInAlt`, `isVideoUrl`).

use crate::domain::journal_rules::js_trim;

use super::hard_breaks::restore_hard_break_spelling;
use super::prepare::split_by_code_fences;
use super::web_url::{self, Url};
use super::{FileProps, SeedBlock, SeedKind, Unsupported};

/// `separateBlockImages`: outside code fences, a line that is only an image
/// gets a blank line above and below it, so it parses as its own block.
pub(super) fn separate_block_images(markdown: &str) -> String {
    if !markdown.contains("![") {
        return markdown.to_owned();
    }
    split_by_code_fences(markdown)
        .into_iter()
        .map(|(text, is_code)| {
            if is_code {
                return text.to_owned();
            }
            let lines: Vec<&str> = text.split('\n').collect();
            let mut result: Vec<&str> = Vec::with_capacity(lines.len());
            for (index, line) in lines.iter().enumerate() {
                if is_standalone_image_line(line) {
                    if result
                        .last()
                        .is_some_and(|before| !js_trim(before).is_empty())
                    {
                        result.push("");
                    }
                    result.push(line);
                    if lines
                        .get(index + 1)
                        .is_some_and(|after| !js_trim(after).is_empty())
                    {
                        result.push("");
                    }
                    continue;
                }
                result.push(line);
            }
            result.join("\n")
        })
        .collect()
}

/// `STANDALONE_IMAGE_LINE`, `/^\s*!\[[^\]]*\]\([^)]+\)\s*$/`.
fn is_standalone_image_line(line: &str) -> bool {
    let Some(rest) = js_trim(line).strip_prefix("![") else {
        return false;
    };
    let Some((alt, target)) = rest.split_once("](") else {
        return false;
    };
    !alt.contains(']')
        && target
            .strip_suffix(')')
            .is_some_and(|url| !url.is_empty() && !url.contains(')'))
}

/// `IMAGE_LINE_REGEX`, `/^!\[([^\]\n]*)\]\(([^)\s]+)\)$/`: the alt and the
/// address of a line that is nothing but an image.
fn image_line(line: &str) -> Option<(&str, &str)> {
    let rest = line.strip_prefix("![")?;
    let (alt, target) = rest.split_once("](")?;
    let url = target.strip_suffix(')')?;
    let ok = !alt.contains([']', '\n'])
        && !url.is_empty()
        && !url.contains(|c: char| c == ')' || crate::domain::journal_rules::is_js_whitespace(c));
    ok.then_some((alt, url))
}

/// `parseCustomBlockMarkerLine`: a file marker on the trimmed line, a YouTube
/// embed, a bookmark or a whiteboard on the raw one. `Err` when the line is
/// one of them in a shape this port does not decide.
pub(super) fn marker_line(line: &str) -> Result<Option<SeedBlock>, Unsupported> {
    let trimmed = js_trim(line);
    if let Some(json) = trimmed
        .strip_prefix("<!-- file:")
        .and_then(|rest| rest.strip_suffix(" -->"))
        .filter(|json| json.starts_with('{') && json.ends_with('}'))
        .filter(|json| json.len() > 2 && !json[1..json.len() - 1].contains('}'))
    {
        let props = file_props(json).ok_or(Unsupported("file marker"))?;
        return Ok(Some(block(SeedKind::File(props))));
    }
    if let Some((alt, url)) = image_line(line)
        && alt != "bookmark"
        && alt != "whiteboard"
        && let Some(video_id) = youtube_video_id(url)?
    {
        return Ok(Some(block(SeedKind::YoutubeEmbed {
            video_id,
            video_url: url.to_owned(),
            alt: alt.to_owned(),
        })));
    }
    if let Some(url) = line
        .strip_prefix("![bookmark](")
        .and_then(|rest| rest.strip_suffix(')'))
        .filter(|url| !url.is_empty() && !url.contains(')'))
    {
        match web_url::parse(url) {
            Url::Parsed(parts) if matches!(parts.scheme.as_str(), "http" | "https") => {
                let domain = parts.host.strip_prefix("www.").unwrap_or(&parts.host);
                return Ok(Some(block(SeedKind::Bookmark {
                    url: url.to_owned(),
                    domain: domain.to_owned(),
                })));
            }
            Url::Unknown => return Err(Unsupported("bookmark")),
            _ => {}
        }
    }
    if let Some(canvas_id) = line
        .strip_prefix("![whiteboard](memry://canvas/")
        .and_then(|rest| rest.strip_suffix(')'))
        .filter(|id| {
            !id.is_empty()
                && id
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-'))
        })
    {
        return Ok(Some(block(SeedKind::Whiteboard {
            canvas_id: canvas_id.to_owned(),
        })));
    }
    Ok(None)
}

fn block(kind: SeedKind) -> SeedBlock {
    SeedBlock::new(kind, Vec::new())
}

/// `parseFileBlockMarker`: `JSON.parse` of the props, `display` kept only as
/// `link`. A key of another type than the spec declares is refused.
fn file_props(json: &str) -> Option<FileProps> {
    let value: serde_json::Value = serde_json::from_str(json).ok()?;
    let object = value.as_object()?;
    let text = |key: &str| match object.get(key) {
        None => Some(String::new()),
        Some(serde_json::Value::String(value)) => Some(value.clone()),
        Some(_) => None,
    };
    let number = |key: &str| match object.get(key) {
        None => Some(serde_json::Number::from(0)),
        Some(serde_json::Value::Number(value)) => Some(value.clone()),
        Some(_) => None,
    };
    let align = text("align")?;
    Some(FileProps {
        url: text("url")?,
        name: text("name")?,
        size: number("size")?,
        mime_type: text("mimeType")?,
        width: number("width")?,
        height: number("height")?,
        align: if align.is_empty() {
            "left".to_owned()
        } else {
            align
        },
        link: object.get("display").and_then(|v| v.as_str()) == Some("link"),
    })
}

/// `extractYouTubeVideoId` (`shared/youtube.ts`).
fn youtube_video_id(url: &str) -> Result<Option<String>, Unsupported> {
    let parts = match web_url::parse(url) {
        Url::Parsed(parts) => parts,
        Url::Invalid => return Ok(None),
        Url::Unknown => return Err(Unsupported("YouTube address")),
    };
    let valid = |id: &str| {
        (id.len() == 11
            && id
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-')))
        .then(|| id.to_owned())
    };
    let mut segments = parts.path.split('/').filter(|segment| !segment.is_empty());
    if parts.host == "youtu.be" {
        return Ok(segments.next().and_then(valid));
    }
    if parts.host != "youtube.com" && !parts.host.ends_with(".youtube.com") {
        return Ok(None);
    }
    if parts.path == "/watch" {
        let id = match parts.query.as_deref() {
            Some(query) => {
                web_url::query_value(query, "v").ok_or(Unsupported("YouTube address"))?
            }
            None => None,
        };
        return Ok(id.as_deref().and_then(valid));
    }
    Ok(match (segments.next(), segments.next()) {
        (Some("embed" | "shorts"), Some(id)) => valid(id),
        _ => None,
    })
}

/// `isVideoUrl` (`@blocknote/core` `util/string.ts`): an address whose path
/// ends in a video extension.
fn is_video_url(url: &str) -> Result<bool, Unsupported> {
    let parts = match web_url::parse(url) {
        Url::Parsed(parts) => parts,
        Url::Invalid => return Ok(false),
        Url::Unknown => return Err(Unsupported("media address")),
    };
    let extension = parts
        .path
        .rsplit('.')
        .next()
        .unwrap_or("")
        .to_ascii_lowercase();
    Ok(matches!(
        extension.as_str(),
        "mp4" | "webm" | "ogg" | "mov" | "mkv" | "flv" | "avi" | "wmv" | "m4v"
    ))
}

/// What `parseImage` prints for `![alt](url "title")`: a `<video>` named by
/// the alt (or the title) for a video address, an `<img>` otherwise.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum Media {
    Image { url: String, alt: String },
    Video { url: String, name: String },
}

pub(super) fn media(url: String, alt: String, title: Option<String>) -> Result<Media, Unsupported> {
    if is_video_url(&url)? {
        let name = if alt.is_empty() {
            title.unwrap_or_default()
        } else {
            alt
        };
        return Ok(Media::Video { url, name });
    }
    Ok(Media::Image { url, alt })
}

/// The block an `<img>` or `<video>` parses to. An image's alt may carry its
/// width as `name|300` (`withImageWidthInAlt`, `parseInlineImageAlt`).
/// Every string prop gets its hard-break spelling back (`repairBlocks`).
pub(super) fn media_block(media: &Media, breaks: &[String]) -> Result<SeedBlock, Unsupported> {
    let restore = |text: &str| restore_hard_break_spelling(text, breaks);
    Ok(match media {
        Media::Image { url, alt } => {
            let (name, width) = alt_width(alt);
            // `img.src` is the DOM's serialization of the address; a
            // `<video src>` and an `inlineImage` read the attribute as written.
            let src = web_url::img_src(url).ok_or(Unsupported("image address"))?;
            block(SeedKind::Image {
                url: restore(&src),
                name: restore(name),
                preview_width: width,
            })
        }
        Media::Video { url, name } => block(SeedKind::Video {
            url: restore(url),
            name: restore(name),
        }),
    })
}

/// `parseInlineImageAlt`: `ALT_WIDTH_SUFFIX`, `/^(.*)\|(\d+)$/`, with a
/// positive width.
pub(super) fn alt_width(alt: &str) -> (&str, Option<u32>) {
    let Some((name, digits)) = alt.rsplit_once('|') else {
        return (alt, None);
    };
    if name.contains('\n') || digits.is_empty() || !digits.chars().all(|c| c.is_ascii_digit()) {
        return (alt, None);
    }
    match digits.parse::<u32>() {
        Ok(width) if width > 0 => (name, Some(width)),
        _ => (alt, None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_standalone_image_line_gets_blank_lines_around_it() {
        assert_eq!(separate_block_images("a\n![x](u)\nb"), "a\n\n![x](u)\n\nb");
        assert_eq!(
            separate_block_images("```\na\n![x](u)\n```"),
            "```\na\n![x](u)\n```"
        );
        assert_eq!(
            separate_block_images("see ![x](u) here"),
            "see ![x](u) here"
        );
    }

    #[test]
    fn youtube_addresses_name_their_video() {
        let id = |url: &str| youtube_video_id(url).expect("decided");
        assert_eq!(
            id("https://youtu.be/dQw4w9WgXcQ").as_deref(),
            Some("dQw4w9WgXcQ")
        );
        assert_eq!(
            id("https://m.youtube.com/watch?v=dQw4w9WgXcQ&t=1").as_deref(),
            Some("dQw4w9WgXcQ")
        );
        assert_eq!(
            id("https://youtube.com/shorts/dQw4w9WgXcQ").as_deref(),
            Some("dQw4w9WgXcQ")
        );
        assert_eq!(id("https://www.youtube.com/watch?v=short"), None);
        assert_eq!(id("https://example.com/watch?v=dQw4w9WgXcQ"), None);
    }

    #[test]
    fn a_width_rides_in_the_alt_text() {
        assert_eq!(alt_width("a|300"), ("a", Some(300)));
        assert_eq!(alt_width("a|b|300"), ("a|b", Some(300)));
        assert_eq!(alt_width("a|0"), ("a|0", None));
        assert_eq!(alt_width("a|300x200"), ("a|300x200", None));
    }
}

//! The header of an exported note: its icon and metadata (`export-utils.ts`
//! `renderNoteIcon`, `libraryIconSvg`, `customIconDataUri` and the metadata
//! template of `renderNoteAsHtml`).

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use chrono::NaiveDate;

use super::icons::{IconPart, library_icon};
use super::{CustomIcon, NoteExport, escape_html};
use crate::vault::svg::sanitize_svg_bytes;

const LIBRARY_ICON_PREFIX: &str = "icon:";
const CUSTOM_ICON_PREFIX: &str = "custom:";

/// `formatDate`: `toLocaleDateString('en-US', { year, month: 'long', day })`.
fn format_date(date: NaiveDate) -> String {
    date.format("%B %-d, %Y").to_string()
}

pub(super) fn metadata_section(note: &NoteExport<'_>) -> String {
    let tags = if note.tags.is_empty() {
        String::new()
    } else {
        let spans: String = note
            .tags
            .iter()
            .map(|tag| format!("<span class=\"tag\">#{}</span>", escape_html(tag)))
            .collect();
        format!("\n        <div class=\"note-tags\">\n          {spans}\n        </div>\n      ")
    };
    format!(
        "
      <div class=\"note-meta\">
        <span class=\"note-meta-item\">
          <strong>Created:</strong> {created}
        </span>
        <span class=\"note-meta-item\">
          <strong>Modified:</strong> {modified}
        </span>
      </div>
      {tags}
    ",
        created = format_date(note.created),
        modified = format_date(note.modified),
    )
}

/// The header markup for a note's stored icon. An icon that cannot be resolved
/// is left out: its reference is not text to print.
pub(super) fn render_note_icon(
    value: Option<&str>,
    find_custom_icon: &dyn Fn(&str) -> Option<CustomIcon>,
) -> String {
    let Some(value) = value.filter(|value| !value.is_empty()) else {
        return String::new();
    };
    if let Some(name) = value.strip_prefix(LIBRARY_ICON_PREFIX) {
        return library_icon(name).map_or_else(String::new, library_icon_svg);
    }
    if let Some(id) = value.strip_prefix(CUSTOM_ICON_PREFIX) {
        return find_custom_icon(id)
            .and_then(|icon| custom_icon_data_uri(&icon))
            .map_or_else(String::new, |src| {
                format!(
                    "<img class=\"note-emoji\" src=\"{}\" alt=\"\">",
                    escape_html(&src)
                )
            });
    }
    format!("<span class=\"note-emoji\">{}</span>", escape_html(value))
}

/// A png as it is stored; an svg through the app's sanitizer, since the row is
/// synced input and the export is a file the user hands on.
fn custom_icon_data_uri(icon: &CustomIcon) -> Option<String> {
    match icon.ext.as_str() {
        "png" => Some(format!("data:image/png;base64,{}", icon.data)),
        "svg" => {
            let bytes = node_base64_decode(&icon.data);
            let svg = sanitize_svg_bytes(&bytes).ok()?;
            Some(format!(
                "data:image/svg+xml;base64,{}",
                STANDARD.encode(svg)
            ))
        }
        _ => None,
    }
}

/// `Buffer.from(data, 'base64')`: both alphabets, every other character
/// skipped, decoding stops at the first `=`, and a lone trailing character is
/// dropped.
fn node_base64_decode(data: &str) -> Vec<u8> {
    let sextets: Vec<u32> = data
        .bytes()
        .take_while(|&b| b != b'=')
        .filter_map(|b| {
            Some(u32::from(match b {
                b'A'..=b'Z' => b - b'A',
                b'a'..=b'z' => b - b'a' + 26,
                b'0'..=b'9' => b - b'0' + 52,
                b'+' | b'-' => 62,
                b'/' | b'_' => 63,
                _ => return None,
            }))
        })
        .collect();
    let mut out = Vec::with_capacity(sextets.len() * 3 / 4);
    for group in sextets.chunks(4) {
        let bits = group
            .iter()
            .enumerate()
            .fold(0u32, |bits, (i, s)| bits | s << (18 - 6 * i));
        let bytes = bits.to_be_bytes();
        out.extend_from_slice(&bytes[1..group.len()]);
    }
    out
}

/// A HugeIcons glyph as inline SVG, drawn the way the renderer's
/// `HugeiconsIcon` draws it. React-style attribute names (`strokeWidth`)
/// become SVG ones (`stroke-width`).
fn library_icon_svg(parts: &[IconPart]) -> String {
    let children: String = parts
        .iter()
        .map(|(tag, attrs)| {
            let attributes: String = attrs
                .iter()
                .filter(|(name, _)| name != "key")
                .map(|(name, value)| {
                    let mut svg_name = String::with_capacity(name.len() + 2);
                    for c in name.chars() {
                        if c.is_ascii_uppercase() {
                            svg_name.push('-');
                            svg_name.push(c.to_ascii_lowercase());
                        } else {
                            svg_name.push(c);
                        }
                    }
                    format!(" {}=\"{}\"", escape_html(&svg_name), escape_html(value))
                })
                .collect();
            format!("<{}{attributes}/>", escape_html(tag))
        })
        .collect();
    format!(
        "<svg class=\"note-emoji\" xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 24 24\" width=\"48\" height=\"48\" fill=\"none\" color=\"currentColor\" aria-hidden=\"true\">{children}</svg>"
    )
}

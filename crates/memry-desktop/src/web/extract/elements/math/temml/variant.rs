//! `variant.js`.

use super::style::Style;
use super::val::V;

fn font_map(font: &str) -> Option<&'static str> {
    Some(match font {
        "mathbf" => "bold",
        "mathrm" => "normal",
        "textit" | "mathit" | "mathnormal" => "italic",
        "mathbb" => "double-struck",
        "mathcal" | "mathscr" => "script",
        "mathfrak" => "fraktur",
        "mathsf" => "sans-serif",
        "mathtt" => "monospace",
        _ => return None,
    })
}

/// `getVariant(group, style)`; `None` is JS `null`.
pub fn get_variant(group: &V, style: &Style) -> Option<&'static str> {
    if style.font_family == "texttt" {
        return Some("monospace");
    } else if style.font_family == "textsc" {
        return Some("normal");
    } else if style.font_family == "textsf" {
        return Some(if style.font_shape == "textit" && style.font_weight == "textbf" {
            "sans-serif-bold-italic"
        } else if style.font_shape == "textit" {
            "sans-serif-italic"
        } else if style.font_weight == "textbf" {
            "sans-serif-bold"
        } else {
            "sans-serif"
        });
    } else if style.font_shape == "textit" && style.font_weight == "textbf" {
        return Some("bold-italic");
    } else if style.font_shape == "textit" {
        return Some("italic");
    } else if style.font_weight == "textbf" {
        return Some("bold");
    }
    let font = style.font.as_str();
    if font.is_empty() || font == "mathnormal" {
        return None;
    }
    match font {
        "mathit" => return Some("italic"),
        "mathrm" => {
            let cp = group.text("text").chars().next().map_or(0, |c| c as u32);
            return Some(if 0x03ab < cp && cp < 0x03cf { "italic" } else { "normal" });
        }
        "greekItalic" => return Some("italic"),
        "up@greek" => return Some("normal"),
        "boldsymbol" | "mathboldsymbol" => return Some("bold-italic"),
        "mathbf" => return Some("bold"),
        "mathbb" => return Some("double-struck"),
        "mathfrak" => return Some("fraktur"),
        "mathscr" | "mathcal" => return Some("script"),
        "mathsf" => return Some("sans-serif"),
        "mathsfit" => return Some("sans-serif-italic"),
        "mathtt" => return Some("monospace"),
        _ => {}
    }
    font_map(font)
}

//! `resolveSvgColors`: CSS variables and `light-dark()` in SVG paint become concrete colors, and
//! Tailwind paint classes become attributes, so a standalone SVG stays legible.
//!
//! Defuddle also asks `getComputedStyle` when it runs in a browser; linkedom never does, so only
//! the name-based inference is ported.

use std::sync::LazyLock;

use regex::{Captures, Regex};

use crate::web::extract::constants::{
    TAILWIND_COLORS, TAILWIND_SPECIAL, TW_ARBITRARY_RE, TW_COLOR_CLASS_RE, TW_SPECIAL_CLASS_RE,
};
use crate::web::extract::dom::{Document, NodeId};
use crate::web::extract::error::ExtractError;
use crate::web::extract::utils::js::{WS, parse_float, to_lower, trim};
use crate::web::extract::utils::json::number_to_string;

static LIGHT_DARK: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!("light-dark\\({WS}*([^,]+?){WS}*,{WS}*[^)]+?\\)")).expect("static pattern")
});
static CSS_VAR: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!("var\\(--([^,)]+)(?:,{WS}*([^)]+))?\\)")).expect("static pattern")
});
static ANY_CSS_VAR: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!("var\\(--[^,)]+(?:,{WS}*[^)]+)?\\)")).expect("static pattern")
});
static TW_SHADE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new("(?:^|-)([a-z]+)-([0-9]{2,3})$").expect("static pattern"));
static CLOSED_PATH: LazyLock<Regex> = LazyLock::new(|| Regex::new("[Zz]$").expect("static"));
static STYLE_FILL: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(&format!("(?:^|;){WS}*fill{WS}*:")).expect("static"));
static STYLE_STROKE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(&format!("(?:^|;){WS}*stroke{WS}*:")).expect("static"));

const SVG_COLOR_ATTRS: &[&str] = &[
    "fill",
    "stroke",
    "color",
    "stop-color",
    "flood-color",
    "lighting-color",
];
const SVG_FILLED_TAGS: &[&str] = &["path", "rect", "circle", "ellipse", "polygon"];
const SVG_STROKE_TAGS: &[&str] = &["line", "polyline"];
const SVG_TEXT_TAGS: &[&str] = &["text", "tspan"];
const SVG_NON_RENDERED_ANCESTOR: &str = "defs, clipPath, mask, pattern, marker";
const GRIDLINE_STROKE_OPACITY: &str = "0.2";

/// `TAILWIND_COLORS[color]?.[shade]`.
fn tailwind_hex(color: &str, shade: &str) -> Option<&'static str> {
    TAILWIND_COLORS
        .iter()
        .find(|(name, _)| *name == color)
        .and_then(|(_, shades)| shades.iter().find(|(s, _)| *s == shade))
        .map(|(_, hex)| *hex)
}

/// `value.replace(LIGHT_DARK_RE, (_, light) => light.trim())`: the light-mode value wins.
fn unwrap_light_dark(value: &str) -> String {
    LIGHT_DARK
        .replace_all(value, |caps: &Captures| trim(&caps[1]).to_string())
        .into_owned()
}

/// `resolveVar(value)` outside a browser.
fn resolve_var(value: &str) -> String {
    let value = unwrap_light_dark(value);
    if !value.contains("var(") {
        return value;
    }
    if let Some(caps) = CSS_VAR.captures(&value) {
        let fallback = caps.get(2).map(|m| trim(m.as_str())).unwrap_or("");
        if !fallback.is_empty() && !fallback.contains("var(") {
            return fallback.to_string();
        }
        let name = to_lower(&caps[1]);
        if let Some(tw) = TW_SHADE.captures(&name)
            && let Some(hex) = tailwind_hex(&tw[1], &tw[2])
        {
            return hex.to_string();
        }
        if name.ends_with("-black") {
            return "#000".into();
        }
        if name.ends_with("-white") {
            return "#fff".into();
        }
        if ["background", "card", "surface", "bg"]
            .iter()
            .any(|k| name.contains(k))
        {
            return "Canvas".into();
        }
        if ["border", "divider", "separator"]
            .iter()
            .any(|k| name.contains(k))
        {
            return "#ccc".into();
        }
        if ["muted", "subtle", "secondary", "placeholder"]
            .iter()
            .any(|k| name.contains(k))
        {
            return "#888".into();
        }
    }
    "currentColor".into()
}

/// `resolveTailwindClasses(el)`: paint and a few font classes become attributes and inline style.
fn resolve_tailwind_classes(doc: &mut Document, el: NodeId) {
    let class_name = doc
        .get_attribute(el, "class")
        .map(|c| c.into_owned())
        .unwrap_or_default();
    if class_name.is_empty() {
        return;
    }
    let tokens: Vec<&str> = class_name
        .split(crate::web::extract::utils::js::is_js_whitespace)
        .collect();
    let mut keep: Vec<&str> = Vec::new();
    let mut styles: Vec<String> = Vec::new();
    for token in &tokens {
        if let Some(caps) = TW_COLOR_CLASS_RE.captures(token)
            && let Some(hex) = tailwind_hex(&caps[2], &caps[3])
        {
            if let Some(opacity) = caps.get(4) {
                let alpha = parse_float(opacity.as_str()).unwrap_or(f64::NAN) / 100.0;
                let channel =
                    |from: usize| i64::from_str_radix(&hex[from..from + 2], 16).unwrap_or_default();
                let rgba = format!(
                    "rgba({},{},{},{})",
                    channel(1),
                    channel(3),
                    channel(5),
                    number_to_string(alpha)
                );
                doc.set_attribute(el, &caps[1], &rgba);
            } else {
                doc.set_attribute(el, &caps[1], hex);
            }
            continue;
        }
        if let Some(caps) = TW_SPECIAL_CLASS_RE.captures(token) {
            let value = TAILWIND_SPECIAL
                .iter()
                .find(|(k, _)| *k == &caps[2])
                .map(|(_, v)| *v)
                .unwrap_or_default();
            doc.set_attribute(el, &caps[1], value);
            continue;
        }
        if let Some(caps) = TW_ARBITRARY_RE.captures(token) {
            let size = &caps[1];
            if !size.starts_with('#') && !size.starts_with("rgb") && !size.starts_with("hsl") {
                styles.push(format!("font-size:{size}"));
                continue;
            }
        }
        match *token {
            "font-semibold" => styles.push("font-weight:600".into()),
            "font-bold" => styles.push("font-weight:700".into()),
            "font-medium" => styles.push("font-weight:500".into()),
            "font-mono" => styles.push("font-family:monospace".into()),
            _ => keep.push(token),
        }
    }
    if keep.len() == tokens.len() {
        return;
    }
    if keep.is_empty() {
        doc.remove_attribute(el, "class");
    } else {
        doc.set_attribute(el, "class", &keep.join(" "));
    }
    if !styles.is_empty() {
        let existing = doc
            .get_attribute(el, "style")
            .map(|s| s.into_owned())
            .unwrap_or_default();
        let sep = if !existing.is_empty() && !existing.ends_with(';') {
            ";"
        } else {
            ""
        };
        doc.set_attribute(el, "style", &format!("{existing}{sep}{}", styles.join(";")));
    }
}

/// `hasStyleProp(el, 'fill' | 'stroke')`.
fn has_style_prop(doc: &Document, el: NodeId, re: &Regex) -> bool {
    doc.get_attribute(el, "style")
        .is_some_and(|style| !style.is_empty() && re.is_match(&style))
}

/// `applySvgFallbackStyles(svg)`: when CSS-based paint was lost (a shape with a class and no
/// fill), shapes get a visible default.
fn apply_svg_fallback_styles(doc: &mut Document, svg: NodeId) -> Result<(), ExtractError> {
    if doc.query_selector(svg, "style")?.is_some() {
        return Ok(());
    }
    let all = doc.query_selector_all(svg, "*")?;
    let tag_of = |doc: &Document, el: NodeId| to_lower(doc.local_name(el).unwrap_or_default());
    let has_class = |doc: &Document, el: NodeId| {
        doc.get_attribute(el, "class")
            .is_some_and(|c| !c.is_empty())
    };
    let mut has_unstyled = false;
    for &el in &all {
        if !SVG_FILLED_TAGS.contains(&tag_of(doc, el).as_str()) || !has_class(doc, el) {
            continue;
        }
        if doc.closest(el, SVG_NON_RENDERED_ANCESTOR)?.is_some() {
            continue;
        }
        if doc.has_attribute(el, "fill") || has_style_prop(doc, el, &STYLE_FILL) {
            continue;
        }
        has_unstyled = true;
        break;
    }
    if !has_unstyled {
        return Ok(());
    }
    for el in all {
        let tag = tag_of(doc, el);
        let is_filled = SVG_FILLED_TAGS.contains(&tag.as_str());
        let is_stroke = SVG_STROKE_TAGS.contains(&tag.as_str());
        let is_text = SVG_TEXT_TAGS.contains(&tag.as_str());
        if (!is_filled && !is_stroke && !is_text) || !has_class(doc, el) {
            continue;
        }
        if doc.closest(el, SVG_NON_RENDERED_ANCESTOR)?.is_some() {
            continue;
        }
        if is_text {
            if !doc.has_attribute(el, "fill") && !has_style_prop(doc, el, &STYLE_FILL) {
                doc.set_attribute(el, "fill", "currentColor");
            }
            continue;
        }
        let has_fill = doc.has_attribute(el, "fill")
            && doc.get_attribute(el, "fill").as_deref() != Some("none");
        let has_stroke_attr =
            doc.has_attribute(el, "stroke") || has_style_prop(doc, el, &STYLE_STROKE);
        if is_filled && !doc.has_attribute(el, "fill") && !has_style_prop(doc, el, &STYLE_FILL) {
            doc.set_attribute(el, "fill", "none");
        }
        if !has_stroke_attr {
            if is_stroke {
                doc.set_attribute(el, "stroke", "currentColor");
                if !doc.has_attribute(el, "stroke-opacity") {
                    doc.set_attribute(el, "stroke-opacity", GRIDLINE_STROKE_OPACITY);
                }
            } else if is_filled && !has_fill {
                let d = doc.get_attribute(el, "d").unwrap_or_default();
                if !CLOSED_PATH.is_match(trim(&d)) {
                    doc.set_attribute(el, "stroke", "currentColor");
                }
            }
        }
    }
    Ok(())
}

/// `resolveSvgColors(element, doc)`.
pub fn resolve_svg_colors(doc: &mut Document, element: NodeId) -> Result<(), ExtractError> {
    for svg in doc.query_selector_all(element, "svg")? {
        let mut all = vec![svg];
        all.extend(doc.query_selector_all(svg, "*")?);
        for el in all {
            for name in SVG_COLOR_ATTRS {
                let Some(value) = doc.get_attribute(el, name).map(|v| v.into_owned()) else {
                    continue;
                };
                if !value.contains("var(") && !value.contains("light-dark(") {
                    continue;
                }
                doc.set_attribute(el, name, &resolve_var(&value));
            }
            if let Some(style) = doc.get_attribute(el, "style").map(|s| s.into_owned())
                && (style.contains("var(") || style.contains("light-dark("))
            {
                let unwrapped = unwrap_light_dark(&style);
                let resolved = ANY_CSS_VAR
                    .replace_all(&unwrapped, |caps: &Captures| resolve_var(&caps[0]))
                    .into_owned();
                doc.set_attribute(el, "style", &resolved);
            }
            resolve_tailwind_classes(doc, el);
        }
        apply_svg_fallback_styles(doc, svg)?;
    }
    Ok(())
}

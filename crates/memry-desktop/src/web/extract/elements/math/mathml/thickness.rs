//! `LineThickness.toLaTeX` of mathml-to-latex: `mfrac`'s `linethickness` to a TeX length.

use std::sync::LazyLock;

use regex::Regex;

use super::latex::DEFAULT_RULE_THICKNESS_PT;
use crate::web::extract::utils::js::{WS, to_lower, trim};
use crate::web::extract::utils::json::number_to_string;

const PT_PER_PX: f64 = 0.75;
const TEX_LENGTH_UNITS: [&str; 10] = ["pt", "pc", "in", "cm", "mm", "em", "ex", "bp", "dd", "cc"];

/// `Math.round`.
fn js_round(x: f64) -> f64 {
    let floor = x.floor();
    if x - floor >= 0.5 { floor + 1.0 } else { floor }
}

fn format_points(value: f64) -> String {
    format!(
        "{}pt",
        number_to_string(js_round(value * 10000.0) / 10000.0)
    )
}

/// `LineThickness.toLaTeX`: `None` is the default bar.
pub(super) fn line_thickness(raw: Option<&str>) -> Option<String> {
    static RE: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(&format!(r"^(-?[0-9]*\.?[0-9]+){WS}*([a-z%]*)$")).expect("thickness pattern")
    });
    let raw = raw.filter(|r| !r.is_empty())?;
    let value = to_lower(trim(raw));
    match value.as_str() {
        "medium" => return None,
        "thin" => return Some(format_points(DEFAULT_RULE_THICKNESS_PT * 0.5)),
        "thick" => return Some(format_points(DEFAULT_RULE_THICKNESS_PT * 2.0)),
        _ => {}
    }
    let caps = RE.captures(&value)?;
    let amount: f64 = caps[1].parse().ok()?;
    let unit = &caps[2];
    if amount == 0.0 {
        return Some("0pt".to_string());
    }
    match unit {
        "" => (amount != 1.0).then(|| format_points(amount * DEFAULT_RULE_THICKNESS_PT)),
        "px" => Some(format_points(amount * PT_PER_PX)),
        "%" => Some(format_points((amount / 100.0) * DEFAULT_RULE_THICKNESS_PT)),
        u if TEX_LENGTH_UNITS.contains(&u) => Some(format!("{}{u}", number_to_string(amount))),
        _ => None,
    }
}

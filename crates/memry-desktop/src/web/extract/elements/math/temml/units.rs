//! `units.js`.

use super::style::Style;
use super::val::{R, perr};

pub struct Size {
    pub number: f64,
    pub unit: &'static str,
}

const VALID_UNITS: [&str; 15] = [
    "em", "ex", "mu", "pt", "mm", "cm", "in", "px", "bp", "pc", "dd", "cc", "nd", "nc", "sp",
];

pub fn valid_unit(unit: &str) -> bool {
    VALID_UNITS.contains(&unit)
}

/// `Number#toFixed(digits)` (ties round up in magnitude, unlike Rust's formatter).
pub fn to_fixed(x: f64, digits: usize) -> String {
    if !x.is_finite() {
        return super::val::num_str(x);
    }
    let abs = x.abs();
    let exact = format!("{abs:.60}");
    let (int, frac) = exact.split_once('.').expect("fraction");
    let tail = &frac[digits..];
    let tie = tail.starts_with('5') && tail[1..].bytes().all(|b| b == b'0');
    let body = if tie {
        let scaled: u128 = format!("{int}{}", &frac[..digits]).parse().expect("digits");
        let up = (scaled + 1).to_string();
        let up = format!("{up:0>width$}", width = digits + 1);
        let (i, f) = up.split_at(up.len() - digits);
        if digits == 0 { i.to_string() } else { format!("{i}.{f}") }
    } else {
        format!("{abs:.digits$}")
    };
    if x < 0.0 { format!("-{body}") } else { body }
}

/// `utils.round(n)`: `+n.toFixed(4)`.
pub fn round(n: f64) -> f64 {
    to_fixed(n, 4).parse().unwrap_or(f64::NAN)
}

pub fn em_scale(style_level: i32) -> f64 {
    let script_level = (style_level - 1).max(0);
    [1.0, 0.7, 0.5][script_level as usize]
}

fn pt_per_unit(unit: &str) -> f64 {
    match unit {
        "pt" => 800.0 / 803.0,
        "pc" => (12.0 * 800.0) / 803.0,
        "dd" => ((1238.0 / 1157.0) * 800.0) / 803.0,
        "cc" => ((14856.0 / 1157.0) * 800.0) / 803.0,
        "nd" => ((685.0 / 642.0) * 800.0) / 803.0,
        "nc" => ((1370.0 / 107.0) * 800.0) / 803.0,
        "sp" => ((1.0 / 65536.0) * 800.0) / 803.0,
        "mm" => 25.4 / 72.0,
        "cm" => 2.54 / 72.0,
        "in" => 1.0 / 72.0,
        "px" => 96.0 / 72.0,
        _ => f64::NAN,
    }
}

pub fn calculate_size(number: f64, unit: &str, style: &Style) -> R<Size> {
    let mut number = number;
    if style.max_size[0] < 0.0 && number > 0.0 {
        return Ok(Size { number: 0.0, unit: "em" });
    }
    match unit {
        "mm" | "cm" | "in" | "px" => {
            let in_css_pts = number * pt_per_unit(unit);
            if in_css_pts > style.max_size[1] {
                return Ok(Size { number: style.max_size[1], unit: "pt" });
            }
            let unit = match unit {
                "mm" => "mm",
                "cm" => "cm",
                "in" => "in",
                _ => "px",
            };
            Ok(Size { number, unit })
        }
        "em" | "ex" => {
            if unit == "ex" {
                number *= 0.431;
            }
            number = (number / em_scale(style.level)).min(style.max_size[0]);
            Ok(Size { number: round(number), unit: "em" })
        }
        "bp" => {
            if number > style.max_size[1] {
                number = style.max_size[1];
            }
            Ok(Size { number, unit: "pt" })
        }
        "pt" | "pc" | "dd" | "cc" | "nd" | "nc" | "sp" => {
            number = (number * pt_per_unit(unit)).min(style.max_size[1]);
            Ok(Size { number: round(number), unit: "pt" })
        }
        "mu" => {
            number = (number / 18.0).min(style.max_size[0]);
            Ok(Size { number: round(number), unit: "em" })
        }
        _ => perr(format!("Invalid unit: '{unit}'")),
    }
}

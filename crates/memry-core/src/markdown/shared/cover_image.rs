//! The frontmatter keys of a note's cover and their value gates (`packages/shared/src/cover-image.ts`).
//!
//! A key is the cover's only while its value is one: a vault may hold `cover: Hardback` on a
//! book note, written long before the key meant anything, and that stays a user property.
//! Values are gray-matter's `data` read as JSON, as the TypeScript reads them.

use serde_json::Value;

pub const COVER_FRONTMATTER_KEY: &str = "cover";
pub const COVER_FOCUS_FRONTMATTER_KEY: &str = "coverFocus";
pub const COVER_FOCUS_X_FRONTMATTER_KEY: &str = "coverFocusX";
pub const COVER_ZOOM_FRONTMATTER_KEY: &str = "coverZoom";
pub const COVER_HEIGHT_FRONTMATTER_KEY: &str = "coverHeight";
pub const COVER_CREDIT_FRONTMATTER_KEY: &str = "coverCredit";
pub const COVER_CREDIT_URL_FRONTMATTER_KEY: &str = "coverCreditUrl";

const COVER_IMAGE_EXTENSIONS: [&str; 7] =
    [".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".avif"];
/// `COVER_WASHES` ids.
const COVER_WASH_IDS: [&str; 12] = [
    "sage", "sand", "lilac", "clay", "ash", "fog", "wheat", "moss", "slate", "bark", "mist", "plum",
];

fn is_http_url(text: &str) -> bool {
    let head = text.get(..8).unwrap_or(text).to_ascii_lowercase();
    head.starts_with("http://") || head.starts_with("https://")
}

fn is_image_ref(text: &str) -> bool {
    if text.is_empty() {
        return false;
    }
    if is_http_url(text) {
        return true;
    }
    let path = text
        .split(['?', '#'])
        .next()
        .unwrap_or_default()
        .to_lowercase();
    COVER_IMAGE_EXTENSIONS.iter().any(|ext| path.ends_with(ext))
}

/// `isCoverValue`: a known wash (`wash:<id>`), an http(s) URL or an image path.
pub fn is_cover_value(value: &Value) -> bool {
    let Some(text) = value.as_str() else {
        return false;
    };
    match text.strip_prefix("wash:") {
        Some(id) => COVER_WASH_IDS.contains(&id),
        None => is_image_ref(text),
    }
}

fn number_in(value: &Value, min: f64, max: f64) -> bool {
    value
        .as_f64()
        .is_some_and(|x| x.is_finite() && (min..=max).contains(&x))
}

/// Whether `value` is the cover's under `key`; `false` for any key that is not a cover key.
pub fn is_cover_key_value(key: &str, value: &Value) -> bool {
    match key {
        COVER_FRONTMATTER_KEY => is_cover_value(value),
        // `isCoverFocusValue`: a 0..100 number.
        COVER_FOCUS_FRONTMATTER_KEY | COVER_FOCUS_X_FRONTMATTER_KEY => number_in(value, 0.0, 100.0),
        // `isCoverZoomValue`: a 1..3 number.
        COVER_ZOOM_FRONTMATTER_KEY => number_in(value, 1.0, 3.0),
        // `isCoverHeightValue`: 120..480 pixels.
        COVER_HEIGHT_FRONTMATTER_KEY => number_in(value, 120.0, 480.0),
        // `isCoverCreditValue`: a non-empty string (JavaScript `trim`).
        COVER_CREDIT_FRONTMATTER_KEY => value
            .as_str()
            .is_some_and(|text| !crate::markdown::frontmatter::js::js_trim(text).is_empty()),
        // `isCoverCreditUrlValue`: an http(s) URL.
        COVER_CREDIT_URL_FRONTMATTER_KEY => value.as_str().is_some_and(is_http_url),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_cover_key_is_the_covers_only_while_its_value_is_one() {
        assert!(is_cover_key_value("cover", &json!("wash:sage")));
        assert!(is_cover_key_value("cover", &json!("HTTPS://x.test/a")));
        assert!(is_cover_key_value("cover", &json!("img/a.JPG?v=1")));
        assert!(!is_cover_key_value("cover", &json!("Hardback")));
        assert!(!is_cover_key_value("cover", &json!("wash:teal")));
        assert!(!is_cover_key_value("cover", &json!("")));
        assert!(is_cover_key_value("coverFocus", &json!(0)));
        assert!(!is_cover_key_value("coverFocus", &json!(101)));
        assert!(!is_cover_key_value("coverFocusX", &json!("top")));
        assert!(is_cover_key_value("coverZoom", &json!(1.5)));
        assert!(!is_cover_key_value("coverZoom", &json!(0.5)));
        assert!(is_cover_key_value("coverHeight", &json!(480)));
        assert!(!is_cover_key_value("coverHeight", &json!(481)));
        assert!(is_cover_key_value("coverCredit", &json!("Ann")));
        assert!(!is_cover_key_value("coverCredit", &json!(" \u{a0}")));
        assert!(is_cover_key_value("coverCreditUrl", &json!("http://x")));
        assert!(!is_cover_key_value("coverCreditUrl", &json!("ftp://x")));
        assert!(!is_cover_key_value("status", &json!("wash:sage")));
    }
}

//! The frontmatter keys of a note's cover and their value gates (`packages/shared/src/cover-image.ts`).
//!
//! A key is the cover's only while its value is one: a vault may hold `cover: Hardback` on a
//! book note, written long before the key meant anything, and that stays a user property.
//! Values are gray-matter's `data` read as JSON, as the TypeScript reads them.

use serde_json::{Map, Value};

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

/// `isCoverValue` of a string: a known wash (`wash:<id>`), an http(s) URL or an image path.
pub fn is_cover_text(text: &str) -> bool {
    match text.strip_prefix("wash:") {
        Some(id) => COVER_WASH_IDS.contains(&id),
        None => is_image_ref(text),
    }
}

/// `isCoverValue`: a string [`is_cover_text`] accepts.
pub fn is_cover_value(value: &Value) -> bool {
    value.as_str().is_some_and(is_cover_text)
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

/// `noteCoverFromFrontmatter` (`sync/item-handlers/note-cover-sync.ts`): the note's cover as the
/// push payload's `cover` field carries it (protocol 13.7.1.1), or `None` when the frontmatter
/// has none. Each key is read through the gate that reserves it from the user's properties, so
/// `cover: Hardback` is no cover here either. An image cover carries `focusX`, `zoom` and
/// `height` defaults included, so a receiver reads an omission as an older sender.
pub fn cover_sync(frontmatter: &Map<String, Value>) -> Option<Map<String, Value>> {
    let reference = frontmatter
        .get(COVER_FRONTMATTER_KEY)
        .filter(|value| is_cover_value(value))?
        .as_str()?;
    let gated = |key: &str| {
        frontmatter
            .get(key)
            .filter(|value| is_cover_key_value(key, value))
    };
    let mut out = Map::new();
    out.insert("ref".to_owned(), Value::from(reference));
    if let Some(focus) = gated(COVER_FOCUS_FRONTMATTER_KEY).and_then(Value::as_f64) {
        out.insert("focus".to_owned(), js_number(focus.round()));
    }
    // `parseCoverValue(ref).kind === 'image'`: a wash has nothing to frame.
    if !reference.starts_with("wash:") {
        let read = |key: &str, default: f64, clamp: fn(f64) -> f64| {
            js_number(gated(key).and_then(Value::as_f64).map_or(default, clamp))
        };
        out.insert(
            "focusX".to_owned(),
            read(COVER_FOCUS_X_FRONTMATTER_KEY, 50.0, f64::round),
        );
        out.insert(
            "zoom".to_owned(),
            read(COVER_ZOOM_FRONTMATTER_KEY, 1.0, |x| {
                (x * 100.0).round() / 100.0
            }),
        );
        out.insert(
            "height".to_owned(),
            read(COVER_HEIGHT_FRONTMATTER_KEY, 200.0, f64::round),
        );
    }
    for (key, field) in [
        (COVER_CREDIT_FRONTMATTER_KEY, "credit"),
        (COVER_CREDIT_URL_FRONTMATTER_KEY, "creditUrl"),
    ] {
        if let Some(value) = gated(key) {
            out.insert(field.to_owned(), value.clone());
        }
    }
    Some(out)
}

/// A number as JavaScript writes it in JSON: an integral value without a fraction.
fn js_number(x: f64) -> Value {
    #[allow(
        clippy::cast_possible_truncation,
        reason = "integral and within the gates' ranges"
    )]
    match x.fract() == 0.0 {
        true => Value::from(x as i64),
        false => Value::from(x),
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

    /// `noteCoverFromFrontmatter`'s answers, from Electron (`npx tsx`, 13q-2).
    #[test]
    fn a_cover_for_sync_reads_as_electron_reads_it() {
        let cases = json!([
            [{}, null],
            [{"cover": "Hardback", "coverFocus": 30}, null],
            [
                {"cover": "wash:sage", "coverFocus": 30, "coverZoom": 2, "coverCredit": "Ann",
                 "coverCreditUrl": "https://u.test/a"},
                {"ref": "wash:sage", "focus": 30, "credit": "Ann", "creditUrl": "https://u.test/a"}
            ],
            [{"cover": "wash:teal"}, null],
            [
                {"cover": "attachments/n1/a.png"},
                {"ref": "attachments/n1/a.png", "focusX": 50, "zoom": 1, "height": 200}
            ],
            [
                {"cover": "https://images.test/x", "coverFocus": 33.6, "coverFocusX": 12.4,
                 "coverZoom": 1.255, "coverHeight": 300.6, "coverCredit": "  Bo ",
                 "coverCreditUrl": "HTTPS://u.test/b"},
                {"ref": "https://images.test/x", "focus": 34, "focusX": 12, "zoom": 1.25,
                 "height": 301, "credit": "  Bo ", "creditUrl": "HTTPS://u.test/b"}
            ],
            [
                {"cover": "img/a.JPG?v=1", "coverFocus": 140, "coverFocusX": -1, "coverZoom": 4,
                 "coverHeight": 90, "coverCredit": "   ", "coverCreditUrl": "ftp://x"},
                {"ref": "img/a.JPG?v=1", "focusX": 50, "zoom": 1, "height": 200}
            ],
            [
                {"cover": "a.webp", "coverFocus": "20", "coverZoom": "2", "coverHeight": "tall"},
                {"ref": "a.webp", "focusX": 50, "zoom": 1, "height": 200}
            ]
        ]);
        for case in cases.as_array().unwrap() {
            let frontmatter = case[0].as_object().unwrap();
            let got = cover_sync(frontmatter).map(Value::Object);
            assert_eq!(got.unwrap_or(Value::Null), case[1], "{}", case[0]);
        }
    }
}

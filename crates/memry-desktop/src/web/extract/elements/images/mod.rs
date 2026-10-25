//! `dist/elements/images.js`. The small-image removal asks whether a `src` is a placeholder.

use std::sync::LazyLock;

use regex::Regex;

use crate::web::extract::utils::js::utf16_len;

/// `b64DataUrlRegex`.
static B64_DATA_URL: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^data:image/([^;]+);base64,").expect("static pattern"));

/// `isBase64Placeholder(src)`: a base64 image data URL whose payload is under 133 characters
/// (about 100 bytes), unless it is an SVG, which stays meaningful at any size.
pub fn is_base64_placeholder(src: &str) -> bool {
    let Some(caps) = B64_DATA_URL.captures(src) else {
        return false;
    };
    if &caps[1] == "svg+xml" {
        return false;
    }
    let prefix = caps.get(0).map_or(0, |m| utf16_len(m.as_str()));
    utf16_len(src) - prefix < 133
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn placeholders() {
        assert!(is_base64_placeholder(
            "data:image/gif;base64,R0lGODlhAQABAAAAACw="
        ));
        assert!(!is_base64_placeholder(
            "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4="
        ));
        assert!(!is_base64_placeholder("https://x.test/a.png"));
        let at = |n: usize| format!("data:image/png;base64,{}", "A".repeat(n));
        assert!(is_base64_placeholder(&at(132)));
        assert!(!is_base64_placeholder(&at(133)));
    }
}

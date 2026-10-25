//! DOM helpers of `dist/utils/dom.js`.

/// `decodeHTMLEntities(doc, text)`: assigns `text` to a `<textarea>`'s `innerHTML` and reads its
/// `value`. linkedom's `TextElement` implements both as `textContent`, so no entity is decoded
/// and the text comes back unchanged (pinned by `schema_org` vectors that hold entities).
pub fn decode_html_entities(text: &str) -> String {
    text.to_string()
}

use std::sync::LazyLock;

use regex::Regex;

use super::js::is_js_whitespace;

/// `RESPONSIVE_SHOW_RE`: a Tailwind breakpoint prefix on a show utility.
static RESPONSIVE_SHOW_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^(?:sm|md|lg|xl|2xl|min-\[|max-\[):(?:block|flex|grid|inline|table|contents)")
        .expect("static pattern")
});

/// `hasResponsiveShowClass(className)`: some `className.split(/\s+/)` token is a responsive show
/// utility such as `sm:block`, so the element is visible at some breakpoints.
pub fn has_responsive_show_class(class_name: &str) -> bool {
    class_name
        .split(is_js_whitespace)
        .any(|token| RESPONSIVE_SHOW_RE.is_match(token))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn responsive_show_classes() {
        assert!(has_responsive_show_class("hidden sm:flex"));
        assert!(has_responsive_show_class("x  min-[:grid"));
        // The pattern has no room for the bracket content, so real arbitrary breakpoints miss.
        assert!(!has_responsive_show_class("min-[100px]:grid"));
        assert!(!has_responsive_show_class("hidden sm:hidden lg:invisible"));
        assert!(!has_responsive_show_class("xs:block"));
        assert!(!has_responsive_show_class(""));
    }
}

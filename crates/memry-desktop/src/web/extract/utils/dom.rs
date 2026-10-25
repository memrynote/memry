//! DOM helpers of `dist/utils/dom.js`.

/// `decodeHTMLEntities(doc, text)`: assigns `text` to a `<textarea>`'s `innerHTML` and reads its
/// `value`. linkedom's `TextElement` implements both as `textContent`, so no entity is decoded
/// and the text comes back unchanged (pinned by `schema_org` vectors that hold entities).
pub fn decode_html_entities(text: &str) -> String {
    text.to_string()
}

//! Port of `dist/removals/metadata-block.js`.

use std::sync::LazyLock;

use regex::Regex;

use crate::web::extract::dom::{Document, NodeId};
use crate::web::extract::error::ExtractError;
use crate::web::extract::utils::js::{WS, WS_BODY, trim, utf16_len};

const MONTHS: &str = "Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?";

/// `DATE_RE`: "March 24, 2026", "24 March 2026" or "2026-04-07".
static DATE_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(
        r"(?-u:\b)(?:(?i-u:(?:{MONTHS})){WS}+[0-9]{{1,2}}[{WS_BODY},]+[0-9]{{4}}|[0-9]{{1,2}}(?i-u:(?:st|nd|rd|th)?){WS}+(?i-u:(?:{MONTHS})){WS}+[0-9]{{4}}|[0-9]{{4}}[-/][0-9]{{1,2}}[-/][0-9]{{1,2}})(?-u:\b)"
    ))
    .expect("static pattern")
});

/// `removeMetadataBlock(mainContent)`: removes a short date block among the three siblings
/// after the `h1`.
pub fn remove_metadata_block(doc: &mut Document, main: NodeId) -> Result<(), ExtractError> {
    let Some(h1) = doc.query_selector(main, "h1")? else {
        return Ok(());
    };
    let mut sibling = doc.next_element_sibling(h1);
    for _ in 0..3 {
        let Some(current) = sibling else {
            break;
        };
        let next = doc.next_element_sibling(current);
        let text = trim(&doc.text_content(current).unwrap_or_default()).to_string();
        if !text.is_empty() && utf16_len(&text) < 300 {
            let mut has_date = DATE_RE.is_match(&text);
            if !has_date {
                for el in doc.query_selector_all(current, "p, time")? {
                    if DATE_RE.is_match(trim(&doc.text_content(el).unwrap_or_default())) {
                        has_date = true;
                        break;
                    }
                }
            }
            if has_date {
                doc.remove(current);
                break;
            }
        }
        sibling = next;
    }
    Ok(())
}

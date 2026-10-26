//! `dist/extractors/leetcode.js`.

use std::sync::LazyLock;

use regex::Regex;

use crate::web::extract::error::ExtractError;
use crate::web::extract::utils::js::WS;

use super::base::{Cx, Extracted, Extractor, Variables, sel_attr};

const DESCRIPTION: &str = r#"[data-track-load="description_content"]"#;

pub struct LeetCodeExtractor;

impl LeetCodeExtractor {
    pub fn new(_cx: &mut Cx) -> Result<Self, ExtractError> {
        Ok(Self)
    }
}

/// `title.replace(/\s*[-–—]\s*LeetCode\s*$/, '')`.
static SUFFIX: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!("{WS}*[-–—]{WS}*LeetCode{WS}*$")).expect("static pattern")
});

impl Extractor for LeetCodeExtractor {
    fn can_extract(&mut self, cx: &mut Cx) -> Result<bool, ExtractError> {
        Ok(cx.qs(DESCRIPTION)?.is_some())
    }

    fn extract(&mut self, cx: &mut Cx) -> Result<Extracted, ExtractError> {
        let og_title = sel_attr(cx.doc, cx.root, r#"meta[property="og:title"]"#, "content")?;
        let stripped = SUFFIX.replace(&og_title, "").into_owned();
        let title = if stripped.is_empty() {
            og_title
        } else {
            stripped
        };
        Ok(Extracted {
            content_html: String::new(),
            content_selector: Some(DESCRIPTION.to_string()),
            variables: Variables {
                title,
                site: "LeetCode".into(),
                ..Variables::default()
            },
        })
    }
}

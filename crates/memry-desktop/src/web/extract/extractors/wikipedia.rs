//! `dist/extractors/wikipedia.js`.

use std::sync::LazyLock;

use regex::Regex;

use crate::web::extract::error::ExtractError;
use crate::web::extract::utils::js::WS;

use super::base::{Cx, Extracted, Extractor, Variables, sel_attr};

pub struct WikipediaExtractor;

impl WikipediaExtractor {
    pub fn new(_cx: &mut Cx) -> Result<Self, ExtractError> {
        Ok(Self)
    }
}

/// `title.replace(/\s*[-–—]\s*Wikipedia\s*$/, '')`.
static SUFFIX: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!("{WS}*[-–—]{WS}*Wikipedia{WS}*$")).expect("static pattern")
});

impl Extractor for WikipediaExtractor {
    fn can_extract(&mut self, cx: &mut Cx) -> Result<bool, ExtractError> {
        Ok(cx.qs("#mw-content-text")?.is_some())
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
            content_selector: Some("#mw-content-text".to_string()),
            variables: Variables {
                title,
                author: "Wikipedia".into(),
                site: "Wikipedia".into(),
                ..Variables::default()
            },
        })
    }
}

//! `dist/extractors/bbcode-data.js`: Steam announcements carry their BBCode in a JSON
//! attribute of `#application_config`.

use crate::web::extract::error::ExtractError;
use crate::web::extract::utils::bbcode::bbcode_to_html;
use crate::web::extract::utils::date::iso_string;
use crate::web::extract::utils::json::{JsValue, parse};

use super::base::{Cx, Extracted, Extractor, Variables, attr_of};

pub struct BbcodeDataExtractor {
    event: Option<Option<JsValue>>,
}

impl BbcodeDataExtractor {
    pub fn new(_cx: &mut Cx) -> Result<Self, ExtractError> {
        Ok(Self { event: None })
    }

    /// `parseConfigAttr(attr)`: the JSON in the attribute, its first element when an array.
    fn parse_config_attr(cx: &Cx, attr: &str) -> Result<Option<JsValue>, ExtractError> {
        let Some(config) = cx.qs("#application_config")? else {
            return Ok(None);
        };
        let raw = attr_of(cx.doc, config, attr);
        if raw.is_empty() {
            return Ok(None);
        }
        Ok(match parse(&raw) {
            Ok(JsValue::Array(items)) => items.into_iter().next(),
            Ok(value) => Some(value),
            Err(_) => None,
        })
    }

    fn event_data(&mut self, cx: &Cx) -> Result<Option<JsValue>, ExtractError> {
        if self.event.is_none() {
            self.event = Some(Self::parse_config_attr(cx, "data-partnereventstore")?);
        }
        Ok(self.event.clone().flatten())
    }
}

/// `value || ''` for a JSON value used as text.
fn text_or_empty(value: Option<&JsValue>) -> String {
    value
        .filter(|v| v.truthy())
        .map(JsValue::to_js_string)
        .unwrap_or_default()
}

impl Extractor for BbcodeDataExtractor {
    fn can_extract(&mut self, cx: &mut Cx) -> Result<bool, ExtractError> {
        Ok(self
            .event_data(cx)?
            .and_then(|e| {
                e.get("announcement_body")
                    .and_then(|b| b.get("body"))
                    .cloned()
            })
            .is_some_and(|body| body.truthy()))
    }

    fn extract(&mut self, cx: &mut Cx) -> Result<Extracted, ExtractError> {
        let event = self.event_data(cx)?.unwrap_or(JsValue::Null);
        let body = event
            .get("announcement_body")
            .cloned()
            .unwrap_or(JsValue::Null);
        let text = match body.get("body") {
            Some(JsValue::String(s)) => s.clone(),
            Some(v) if v.truthy() => {
                return Err(ExtractError::Js(
                    "TypeError: html.replace is not a function".into(),
                ));
            }
            _ => String::new(),
        };
        let content_html = bbcode_to_html(&text);
        let headline = text_or_empty(body.get("headline"));
        let title = if headline.is_empty() {
            text_or_empty(event.get("event_name"))
        } else {
            headline
        };
        let published = match body.get("posttime").filter(|v| v.truthy()) {
            Some(posttime) => iso_string(Some(posttime.to_number() * 1000.0))?,
            None => String::new(),
        };
        let author = match Self::parse_config_attr(cx, "data-groupvanityinfo")? {
            Some(info) => text_or_empty(info.get("group_name")),
            None => String::new(),
        };
        Ok(Extracted {
            content_html,
            content_selector: None,
            variables: Variables {
                title,
                author,
                published,
                ..Variables::default()
            },
        })
    }
}

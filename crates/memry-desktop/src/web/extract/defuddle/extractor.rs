//! Where `Defuddle` runs the site extractors: `findExtractor` inside `parseInternal`,
//! `tryAsyncExtractor` inside `parseAsync`, and `buildExtractorResponse`.

use crate::web::extract::error::ExtractError;
use crate::web::extract::extractors::{Cx, Extracted, Find, find_extractor};
use crate::web::extract::fetch::Fetcher;
use crate::web::extract::metadata::{self, Metadata};
use crate::web::extract::utils::json::JsValue;

use super::schema_org::{MetaTag, collect_meta_tags};
use super::settings::Settings;
use super::{Defuddle, DefuddleResponse, count_html_words};

/// `variables.x || fallback`: an empty string is falsy.
fn or(variable: &str, fallback: &str) -> String {
    if variable.is_empty() {
        fallback.to_string()
    } else {
        variable.to_string()
    }
}

/// The fields of `extracted.variables` laid over the metadata (`buildExtractorResponse` and
/// the `contentSelector` branch).
fn with_variables(metadata: &Metadata, extracted: &Extracted) -> Metadata {
    let v = &extracted.variables;
    Metadata {
        title: or(&v.title, &metadata.title),
        description: or(&v.description, &metadata.description),
        language: or(&v.language, &metadata.language),
        published: or(&v.published, &metadata.published),
        author: or(&v.author, &metadata.author),
        site: or(&v.site, &metadata.site),
        ..metadata.clone()
    }
}

impl Defuddle {
    /// The extractor branch of `parseInternal`. `None` means no extractor took the page and the
    /// generic pipeline runs.
    pub(crate) fn run_site_extractor(
        &mut self,
        schema: &JsValue,
    ) -> Result<Option<DefuddleResponse>, ExtractError> {
        if self.in_extractor_pipeline_run {
            return Ok(None);
        }
        let mut cx = Cx {
            doc: &mut self.doc,
            root: self.root,
            url: &self.url,
            schema,
        };
        let Some((name, mut extractor)) = find_extractor(&mut cx, Find::Sync) else {
            return Ok(None);
        };
        let extracted = extractor.extract(&mut cx)?;
        let metadata = self
            .metadata
            .clone()
            .unwrap_or_else(|| unreachable!("set by parse_internal"));
        let Some(selector) = extracted.content_selector.clone() else {
            return self
                .build_extractor_response(&extracted, &metadata, schema, name)
                .map(Some);
        };
        self.in_extractor_pipeline_run = true;
        let pipeline =
            self.parse_internal(Settings::default().extractor_pipeline(), Some(&selector));
        self.in_extractor_pipeline_run = false;
        let mut result = pipeline?;
        result.metadata = with_variables(&result.metadata, &extracted);
        result.extractor_type = Some(name);
        Ok(Some(result))
    }

    /// `buildExtractorResponse`: the extractor's own HTML, URLs resolved, with the metadata of
    /// the page under the extractor's variables.
    fn build_extractor_response(
        &mut self,
        extracted: &Extracted,
        metadata: &Metadata,
        schema: &JsValue,
        name: &'static str,
    ) -> Result<DefuddleResponse, ExtractError> {
        Ok(DefuddleResponse {
            content: self.resolve_content_urls(&extracted.content_html)?,
            metadata: with_variables(metadata, extracted),
            schema_org_data: schema.clone(),
            word_count: count_html_words(&extracted.content_html),
            extractor_type: Some(name),
        })
    }

    /// `tryAsyncExtractor(finder)`: an extractor that fetches, with the page metadata read
    /// afresh. Any failure is logged and gives `None`.
    pub(crate) fn try_async_extractor(
        &mut self,
        find: Find,
        fetcher: &dyn Fetcher,
    ) -> Option<DefuddleResponse> {
        match self.async_extraction(find, fetcher) {
            Ok(response) => response,
            Err(error) => {
                tracing::error!(%error, "Defuddle: error in async extraction");
                None
            }
        }
    }

    fn async_extraction(
        &mut self,
        find: Find,
        fetcher: &dyn Fetcher,
    ) -> Result<Option<DefuddleResponse>, ExtractError> {
        let schema = self.schema_org_data()?;
        let mut cx = Cx {
            doc: &mut self.doc,
            root: self.root,
            url: &self.url,
            schema: &schema,
        };
        let Some((name, mut extractor)) = find_extractor(&mut cx, find) else {
            return Ok(None);
        };
        let extracted = extractor.extract_async(&mut cx, fetcher)?;
        let meta_tags: Vec<MetaTag> = collect_meta_tags(&self.doc)?;
        let metadata = metadata::extract(&mut self.doc, &schema, &meta_tags)?;
        self.build_extractor_response(&extracted, &metadata, &schema, name)
            .map(Some)
    }
}

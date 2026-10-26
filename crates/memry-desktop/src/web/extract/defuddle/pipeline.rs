//! `parseInternal` (`dist/defuddle.js:677-905`): one pass over a clone of the page.

use crate::web::extract::dom::NodeId;
use crate::web::extract::elements::callouts::standardize_callouts;
use crate::web::extract::elements::footnotes::{FOOTNOTE_SECTION_RE, standardize_footnotes};
use crate::web::extract::error::ExtractError;
use crate::web::extract::removals::small_images::find_small_images;
use crate::web::extract::removals::{Removal, remove_metadata_block, run_all};
use crate::web::extract::standardize::standardize_content;
use crate::web::extract::utils::dom::tag_lower;
use crate::web::extract::utils::js::trim;
use crate::web::extract::utils::json::JsValue;

use super::schema_org::get_schema_text;
use super::settings::Settings;
use super::streamed::resolve_streamed_content;
use super::{Defuddle, DefuddleResponse, count_html_words, images};

impl Defuddle {
    fn response(&self, content: String, schema: JsValue) -> DefuddleResponse {
        DefuddleResponse {
            word_count: count_html_words(&content),
            content,
            metadata: self
                .metadata
                .clone()
                .unwrap_or_else(|| unreachable!("set by parse_internal")),
            schema_org_data: schema,
        }
    }

    /// `parseInternal(overrideOptions)`. The metadata is read once and cached across retries, as
    /// are the small images; an error inside the pipeline yields the sanitized body, as the
    /// `catch` of the JS does.
    pub(crate) fn parse_internal(
        &mut self,
        settings: Settings,
        content_selector: Option<&str>,
    ) -> Result<DefuddleResponse, ExtractError> {
        let schema = self.schema_org_data()?;
        let meta_tags = self.page_meta_tags()?;
        if self.metadata.is_none() {
            self.metadata = Some(crate::web::extract::metadata::extract(
                &mut self.doc,
                &schema,
                &meta_tags,
            )?);
        }
        // Stage 5 and 6 plug `ExtractorRegistry.findExtractor` in here; no extractor matches yet.
        match self.run_pipeline(&schema, settings, content_selector) {
            Ok(response) => Ok(response),
            Err(error) => {
                tracing::error!(%error, "Defuddle: error processing document");
                let content = self.serialize_fallback_body()?;
                Ok(self.response(content, schema))
            }
        }
    }

    fn run_pipeline(
        &mut self,
        schema: &JsValue,
        settings: Settings,
        content_selector: Option<&str>,
    ) -> Result<DefuddleResponse, ExtractError> {
        if self.small_images.is_none() {
            self.small_images = Some(find_small_images(&self.doc, self.root)?);
        }
        let small_images = self.small_images.clone().unwrap_or_default();

        let clone = self.doc.clone_node(self.root, true);
        // linkedom splits text at entities such as `&#39;`; merge before anything reads it.
        if let Some(body) = self.doc.body_of(clone) {
            self.doc.normalize(body);
        }
        resolve_streamed_content(&mut self.doc, clone)?;

        let Some(main) = self.locate_main_content(clone, schema, content_selector)? else {
            let content = self.serialize_fallback_body()?;
            return Ok(self.response(content, schema.clone()));
        };
        let metadata = self
            .metadata
            .clone()
            .unwrap_or_else(|| unreachable!("set by parse_internal"));

        // The byline block is extracted as metadata, but a wide container still holds it.
        remove_metadata_block(
            &mut self.doc,
            main,
            !metadata.published.is_empty() || !metadata.author.is_empty(),
        )?;
        if settings.standardize {
            self.adopt_external_footnotes(main, clone)?;
            standardize_footnotes(&mut self.doc, main)?;
            standardize_callouts(&mut self.doc, main)?;
        }
        let url = self.url.clone();
        run_all(
            &mut self.doc,
            &Removal {
                clone,
                main,
                settings,
                small_images: &small_images,
                url: &url,
                title: &metadata.title,
                description: &metadata.description,
            },
        )?;
        if settings.standardize {
            standardize_content(&mut self.doc, main, &metadata.title)?;
        }
        self.resolve_relative_urls(main)?;
        // After URL resolution, so lazy-load copies compare by their final URLs.
        images::deduplicate_images(&mut self.doc, main)?;
        let cover_image = self
            .metadata
            .as_ref()
            .map(|m| m.image.clone())
            .unwrap_or_default();
        if let Some(best) = images::remove_cover_image(&mut self.doc, main, &cover_image)?
            && !best.is_empty()
            && let Some(m) = self.metadata.as_mut()
        {
            m.image = best;
        }
        let content = self.doc.outer_html(main);
        Ok(self.response(content, schema.clone()))
    }

    /// The `findMainContent` step of `parseInternal`: the content selector of a retry or the
    /// finder, widened to an extractor container, with `<body>` narrowed by the schema.org text.
    fn locate_main_content(
        &mut self,
        clone: NodeId,
        schema: &JsValue,
        content_selector: Option<&str>,
    ) -> Result<Option<NodeId>, ExtractError> {
        let mut found = match content_selector {
            Some(selector) => self.doc.query_selector(clone, selector)?,
            None => None,
        };
        if found.is_none() {
            found = self.find_main_content(clone)?;
        }
        // Keep a post and its comments together when inside extractor output.
        if let Some(el) = found
            && let Some(ancestor) = self.doc.closest(el, "[data-defuddle]")?
        {
            found = Some(ancestor);
        }
        if let Some(el) = found
            && tag_lower(&self.doc, el) == "body"
        {
            let text = get_schema_text(schema, 0);
            if !text.is_empty()
                && let Some(body) = self.doc.body_of(clone)
                && let Some(inner) = self.find_element_by_schema_text(body, &text)?
            {
                found = Some(inner);
            }
        }
        Ok(found)
    }

    /// `adoptExternalFootnotes(mainContent, root)`: footnote sections outside the content move
    /// into it.
    fn adopt_external_footnotes(&mut self, main: NodeId, root: NodeId) -> Result<(), ExtractError> {
        let Some(body) = self.doc.body_of(root) else {
            return Ok(());
        };
        if main == body {
            return Ok(());
        }
        for el in self.doc.query_selector_all(body, "div, section, aside")? {
            let class = self.doc.class_name(el).to_ascii_lowercase();
            let id = self.doc.id_attr(el).to_ascii_lowercase();
            if !class.contains("footnote") && !id.contains("footnote") {
                continue;
            }
            if self.doc.contains(main, el) || self.doc.contains(el, main) {
                continue;
            }
            let Some(heading) = self.doc.query_selector(el, "h1, h2, h3, h4, h5, h6")? else {
                continue;
            };
            let text = self.doc.text_content(heading).unwrap_or_default();
            if !FOOTNOTE_SECTION_RE.is_match(trim(&text)) {
                continue;
            }
            self.doc.append_child(main, el)?;
        }
        Ok(())
    }
}

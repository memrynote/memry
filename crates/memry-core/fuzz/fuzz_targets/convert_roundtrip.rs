//! Seed a document from arbitrary markdown and read it back every way the
//! write path does. Asserts what holds for any input: nothing panics (the
//! public API catches panics and answers `None`, so a panic that escapes is a
//! bug in the guard), and no output is more than eight times its input.
//! Whether the converter matches the Electron one is the differential test's
//! job, not this target's.

#![no_main]

use std::sync::Arc;

use libfuzzer_sys::fuzz_target;
use memry_core::crdt::DocumentRegistry;
use memry_core::crdt::registry::UpdateSink;
use memry_core::markdown::convert::NoEmbeds;
use memry_core::markdown::convert::api::Converter;
use memry_core::markdown::convert::restore::SerializeOptions;
use memry_core::markdown::schema::callout_types::CalloutTypes;

const FRAGMENT: &str = "prosemirror";

fuzz_target!(|markdown: &str| {
    if markdown.len() > 64 * 1024 {
        return;
    }
    let sink: UpdateSink = Arc::new(|_, _| {});
    let registry = DocumentRegistry::new("device-fuzz", sink);
    let document = registry.get_or_open("abc123def456").expect("open");
    let converter = Converter::new(CalloutTypes::new(Vec::new()));
    if !converter.seed_body(&document, markdown, None, None, &NoEmbeds) {
        return;
    }
    let limit = 8 * markdown.len() + 64;
    let options = SerializeOptions::default();
    if let Some(body) = converter.doc_to_markdown(&document, FRAGMENT, &options) {
        assert!(body.markdown.len() <= limit, "markdown grew past 8x");
    }
    if let Some(canonical) = converter.doc_to_canonical_markdown(&document, FRAGMENT) {
        assert!(canonical.len() <= limit, "canonical grew past 8x");
    }
    let _ = converter.serialize_note_body(&document, FRAGMENT, &options);
    let _ = converter.blocks(&document, FRAGMENT);
    let _ = converter.find_unrepresentable_nodes(&document, FRAGMENT);
});

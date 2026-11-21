//! What an open note's document holds, read as markdown for the e2e build: desktop's
//! `getCrdtDocMarkdown` and `getCrdtMarkdownSourceState` (`apps/desktop/src/main/test-hooks.ts:552`,
//! `:576`). The state comes from [`EditorHost::open_state`]; it is applied to a copy, so the read
//! never touches the live document.

use std::sync::Arc;

use memry_core::api::vault::Vault;
use memry_core::crdt::registry::{Document, DocumentRegistry};
use memry_core::markdown::convert::canonical::BODY_FRAGMENT;
use memry_core::markdown::convert::restore::SerializeOptions;
use memry_core::markdown::convert::roots::read_markdown_source_record;
use memry_core::seams::secure_store::SecureStore;

use crate::editor::EditorHost;
use crate::vault::consumer::converter_for;

/// The author's bytes kept beside the document and the house style it serializes to now.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MarkdownSource {
    pub source: String,
    pub current: Option<String>,
}

fn open_copy(host: &EditorHost, note_id: &str) -> Result<Option<Arc<Document>>, String> {
    let Some(state) = host
        .open_state(note_id)
        .map_err(|error| error.to_string())?
    else {
        return Ok(None);
    };
    let copy = DocumentRegistry::new("e2e-reader", Arc::new(|_: &str, _: &[u8]| {}))
        .get_or_open(note_id)
        .map_err(|error| error.to_string())?;
    copy.apply_durable_update(&state)
        .map_err(|error| error.to_string())?;
    Ok(Some(copy))
}

/// `yDocToMarkdown` of the open document, `None` when no window has the note open.
pub fn doc_markdown(
    host: &EditorHost,
    vault: &Vault,
    store: Arc<dyn SecureStore>,
    note_id: &str,
) -> Result<Option<String>, String> {
    let Some(document) = open_copy(host, note_id)? else {
        return Ok(None);
    };
    let settings = vault.app_settings(store).ok();
    converter_for(settings.as_ref())
        .doc_to_markdown(&document, BODY_FRAGMENT, &SerializeOptions::default())
        .map(|body| Some(body.markdown))
        .ok_or_else(|| "the document did not serialize".to_owned())
}

/// The source record of the open document, `None` when no window has the note open or the
/// document keeps no record.
pub fn markdown_source(
    host: &EditorHost,
    vault: &Vault,
    store: Arc<dyn SecureStore>,
    note_id: &str,
) -> Result<Option<MarkdownSource>, String> {
    let Some(document) = open_copy(host, note_id)? else {
        return Ok(None);
    };
    let record = document
        .read(|txn| read_markdown_source_record(txn))
        .map_err(|error| error.to_string())?;
    let Some(record) = record else {
        return Ok(None);
    };
    let settings = vault.app_settings(store).ok();
    let current =
        converter_for(settings.as_ref()).doc_to_canonical_markdown(&document, BODY_FRAGMENT);
    Ok(Some(MarkdownSource {
        source: record.source,
        current,
    }))
}

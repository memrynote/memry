//! The converter as the rest of the core uses it: [`Converter`] over a
//! [`Document`]. Every entry runs under `catch_unwind` and answers `None` (or
//! [`ReplaceOutcome::Failed`]) instead of panicking across the API, the
//! fail-closed answer of the TypeScript's `null`: the caller keeps the file.
//!
//! Serialization reads a detached copy of the document, never the live one.

use std::panic::{AssertUnwindSafe, catch_unwind};

use serde_json::Value as Json;
use yrs::{TransactionMut, XmlFragmentRef};

use super::apply::{self, ReplaceOutcome};
use super::canonical::{self, BODY_FRAGMENT};
use super::note_body::{NoteBody, serialize_note_body};
use super::restore::{SerializeOptions, SerializedBody, doc_to_markdown};
use super::seed::{PreparedSeed, SeedEnv, prepare_fragment_seed};
use super::serialize::BlockNoteSerializer;
use super::{EmbedResolver, Env, NoEmbeds};
use crate::crdt::registry::Document;
use crate::markdown::bn::block_to_node::{IdSource, UuidIds};
use crate::markdown::bn::node_to_block::canonical_blocks;
use crate::markdown::schema::callout_types::CalloutTypes;
use crate::markdown::shared::writing_tools::WritingFrontmatter;

/// What `replace_body` needs besides the markdown.
#[derive(Default)]
pub struct ReplaceOptions<'a> {
    pub note_path: Option<&'a str>,
    /// The file's `writing` frontmatter, when the caller read the whole file.
    pub writing: Option<WritingFrontmatter>,
    /// The fragment's [`apply::fragment_snapshot`] when the caller read the
    /// body: the replace happens only if the fragment still holds exactly that.
    pub unless_changed_from: Option<&'a str>,
    pub embeds: Option<&'a dyn EmbedResolver>,
}

/// Stateless and `Send + Sync`: callers run it inside `spawn_blocking`.
pub struct Converter {
    callout_types: CalloutTypes,
    ids: Box<dyn IdSource>,
}

fn guard<T>(f: impl FnOnce() -> Option<T>) -> Option<T> {
    catch_unwind(AssertUnwindSafe(f)).ok().flatten()
}

impl Converter {
    /// `callout_types` come from the synced setting `editor.calloutTypes`: a
    /// name is claimed only while defined (protocol 12.6.2).
    pub fn new(callout_types: CalloutTypes) -> Self {
        Self::with_ids(callout_types, Box::new(UuidIds))
    }

    /// A converter with its own block id source (tests inject a counter).
    pub fn with_ids(callout_types: CalloutTypes, ids: Box<dyn IdSource>) -> Self {
        Self { callout_types, ids }
    }

    fn env<'a>(&'a self, embeds: Option<&'a dyn EmbedResolver>) -> Env<'a> {
        Env {
            callout_types: &self.callout_types,
            embeds: embeds.unwrap_or(&NoEmbeds),
            ids: self.ids.as_ref(),
        }
    }

    /// `prepareFragmentSeed`.
    pub fn prepare_seed(
        &self,
        markdown: &str,
        note_path: Option<&str>,
        writing: Option<WritingFrontmatter>,
        embeds: &dyn EmbedResolver,
    ) -> Option<PreparedSeed> {
        guard(|| {
            let env = SeedEnv {
                callout_types: &self.callout_types,
                embeds,
                serializer: &BlockNoteSerializer,
                html_comments: true,
            };
            prepare_fragment_seed(&env, markdown, note_path, writing).ok()
        })
    }

    /// `applyFragmentSeed` into an empty fragment.
    pub fn apply_seed(
        &self,
        prepared: &PreparedSeed,
        txn: &mut TransactionMut,
        fragment: &XmlFragmentRef,
    ) -> bool {
        catch_unwind(AssertUnwindSafe(|| {
            apply::apply_fragment_seed(&self.env(None), prepared, txn, fragment)
        }))
        .unwrap_or(false)
    }

    /// `markdownToYFragment`: seed an empty document body from markdown and
    /// record the source beside it.
    pub fn seed_body(
        &self,
        doc: &Document,
        markdown: &str,
        note_path: Option<&str>,
        writing: Option<WritingFrontmatter>,
        embeds: &dyn EmbedResolver,
    ) -> bool {
        let seeded = doc.write(|txn| {
            catch_unwind(AssertUnwindSafe(|| {
                let fragment = yrs::WriteTxn::get_or_insert_xml_fragment(txn, BODY_FRAGMENT);
                apply::seed_fragment(
                    &self.env(Some(embeds)),
                    markdown,
                    note_path,
                    writing,
                    txn,
                    &fragment,
                    true,
                )
            }))
            .unwrap_or(false)
        });
        seeded.unwrap_or(false)
    }

    /// `yDocToMarkdown`.
    pub fn doc_to_markdown(
        &self,
        doc: &Document,
        fragment: &str,
        options: &SerializeOptions,
    ) -> Option<SerializedBody> {
        guard(|| {
            doc.read(|txn| doc_to_markdown(&self.env(options.embeds), txn, fragment, options))
                .ok()
                .flatten()
        })
    }

    /// `yDocToCanonicalMarkdown`: house style, nothing of the source kept.
    pub fn doc_to_canonical_markdown(&self, doc: &Document, fragment: &str) -> Option<String> {
        guard(|| {
            doc.read(|txn| canonical::serialize_canonical(txn, fragment, None))
                .ok()
                .flatten()
        })
    }

    /// `serializeNoteBody`.
    pub fn serialize_note_body(
        &self,
        doc: &Document,
        fragment: &str,
        options: &SerializeOptions,
    ) -> Option<NoteBody> {
        guard(|| {
            doc.read(|txn| serialize_note_body(&self.env(options.embeds), txn, fragment, options))
                .ok()
                .flatten()
        })
    }

    /// `findUnrepresentableNodes`.
    pub fn find_unrepresentable_nodes(&self, doc: &Document, fragment: &str) -> Vec<String> {
        guard(|| {
            doc.read(|txn| canonical::find_unrepresentable_nodes(txn, fragment))
                .ok()
        })
        .unwrap_or_default()
    }

    /// `yFragmentToBlocks`, as the vectors' block JSON (ids dropped).
    pub fn blocks(&self, doc: &Document, fragment: &str) -> Option<Vec<Json>> {
        guard(|| {
            doc.read(|txn| {
                let fragment = yrs::ReadTxn::get_xml_fragment(txn, fragment)?;
                let blocks = canonical::y_fragment_to_blocks(txn, &fragment)?;
                match canonical_blocks(&blocks) {
                    Json::Array(items) => Some(items),
                    _ => None,
                }
            })
            .ok()
            .flatten()
        })
    }

    /// `replaceDocBody`: swap a note's body for new markdown in one transaction.
    pub fn replace_body(
        &self,
        doc: &Document,
        markdown: &str,
        options: ReplaceOptions,
    ) -> ReplaceOutcome {
        let outcome = doc.write(|txn| {
            catch_unwind(AssertUnwindSafe(|| {
                apply::replace_doc_body(
                    &self.env(options.embeds),
                    txn,
                    markdown,
                    options.note_path,
                    options.writing,
                    options.unless_changed_from,
                )
            }))
            .unwrap_or(ReplaceOutcome::Failed)
        });
        outcome.unwrap_or(ReplaceOutcome::Failed)
    }

    /// `recordMarkdownSourceInYDoc`.
    pub fn record_markdown_source(&self, doc: &Document, source: &str, fragment: &str) {
        let _ = doc.write(|txn| {
            let _ = catch_unwind(AssertUnwindSafe(|| {
                apply::record_markdown_source(&self.env(None), txn, source, fragment);
            }));
        });
    }

    /// `repairEmptyBlockIds`: returns how many blocks got a fresh id.
    pub fn repair_empty_block_ids(&self, doc: &Document, fragment: &str) -> usize {
        doc.write(|txn| {
            let frag = yrs::WriteTxn::get_or_insert_xml_fragment(txn, fragment);
            catch_unwind(AssertUnwindSafe(|| {
                apply::repair_empty_block_ids(&self.env(None), txn, &frag)
            }))
            .unwrap_or(0)
        })
        .unwrap_or(0)
    }
}

//! The write half of a seed: `applyFragmentSeed`, `recordMarkdownSourceInYDoc`,
//! `replaceDocBody` (`crdt-feed.ts`), `repairEmptyBlockIds` and
//! `emptyDocumentBlocks`.

use serde_json::{Value as Json, json};
use yrs::{
    Any, GetString as _, ReadTxn, StateVector, TransactionMut, Xml as _, XmlFragment,
    XmlFragmentRef, XmlOut,
};

use super::Env;
use super::canonical::{BODY_FRAGMENT, serialize_canonical};
use super::roots::{write_critic_marks, write_link_references, write_markdown_source};
use super::seed::{PreparedSeed, SeedEnv, prepare_fragment_seed};
use super::serialize::BlockNoteSerializer;
use super::writing_seed::apply_writing_seed;
use crate::markdown::bn::block_to_node::{blocks_to_doc, ensure_block_ids};
use crate::markdown::pm::{Node, Schema};
use crate::markdown::shared::markdown_class::{MarkdownClassThresholds, classify_markdown_content};
use crate::markdown::shared::writing_tools::WritingFrontmatter;
use crate::markdown::yxml::write_fragment;
use crate::protocol::envelope::NOTE_SYNC_MAX_BYTES;

/// How much of the pushable snapshot a freshly seeded doc plus its source
/// record may occupy: half of `NOTE_SYNC_MAX_BYTES` (`MARKDOWN_SOURCE_SNAPSHOT_BUDGET_BYTES`).
pub const MARKDOWN_SOURCE_SNAPSHOT_BUDGET_BYTES: usize = NOTE_SYNC_MAX_BYTES / 2;

/// The ProseMirror document `prepared` becomes: every step of
/// [`apply_fragment_seed`] that can fail, before any of it touches a Y.Doc.
pub fn build_seed_doc(env: &Env, prepared: &PreparedSeed) -> Option<Node> {
    let schema = Schema::memry();
    let mut blocks = prepared.blocks.clone();
    ensure_block_ids(&mut blocks, env.ids);
    blocks_to_doc(schema, &blocks, env.ids).ok()
}

/// `blocksToYFragment`, the three side-channel writes of `applyFragmentSeed`
/// and `applyWritingSeed`. `fragment` must be empty (clear it first for a
/// replace). `false` is the TypeScript's `false`: the caller keeps the file.
///
/// The document is built before the first write, but a `false` from a later
/// step leaves what was written. A caller that must keep the document intact
/// on failure runs this on a copy first (`Converter::replace_body`).
pub fn apply_fragment_seed(
    env: &Env,
    prepared: &PreparedSeed,
    txn: &mut TransactionMut,
    fragment: &XmlFragmentRef,
) -> bool {
    let Some(doc) = build_seed_doc(env, prepared) else {
        return false;
    };
    apply_built_seed(prepared, &doc, txn, fragment)
}

fn apply_built_seed(
    prepared: &PreparedSeed,
    doc: &Node,
    txn: &mut TransactionMut,
    fragment: &XmlFragmentRef,
) -> bool {
    if write_fragment(Schema::memry(), txn, fragment, doc).is_err() {
        return false;
    }
    write_critic_marks(txn, &prepared.marks);
    write_link_references(txn, &prepared.definitions, &prepared.usages);
    apply_writing_seed(
        txn,
        fragment,
        &prepared.writing_sentinels,
        prepared.writing.as_ref(),
    )
}

/// `recordMarkdownSourceInYDoc`: remember what the document was just built
/// from, so the write-back can give the author's spelling back. Stores
/// nothing when the source already is house style, or when doc plus source
/// would not fit the snapshot budget.
pub fn record_markdown_source(env: &Env, txn: &mut TransactionMut, source: &str, fragment: &str) {
    let _ = env;
    let canonical = serialize_canonical(&*txn, fragment, None);
    if canonical.as_deref().is_none_or(|c| c == source) {
        write_markdown_source(txn, None);
        return;
    }
    let doc_bytes = txn.encode_state_as_update_v1(&StateVector::default()).len();
    if doc_bytes + source.len() > MARKDOWN_SOURCE_SNAPSHOT_BUDGET_BYTES {
        write_markdown_source(txn, None);
        return;
    }
    write_markdown_source(txn, Some(source));
}

/// `seedFragment` with `recordSource`: parse `markdown`, write it into the
/// empty `fragment`, and record the source.
pub fn seed_fragment(
    env: &Env,
    markdown: &str,
    note_path: Option<&str>,
    writing: Option<WritingFrontmatter>,
    txn: &mut TransactionMut,
    fragment: &XmlFragmentRef,
    record_source: bool,
) -> bool {
    let seed_env = SeedEnv {
        callout_types: env.callout_types,
        embeds: env.embeds,
        serializer: &BlockNoteSerializer,
        html_comments: true,
    };
    let Ok(prepared) = prepare_fragment_seed(&seed_env, markdown, note_path, writing) else {
        return false;
    };
    if !apply_fragment_seed(env, &prepared, txn, fragment) {
        return false;
    }
    if record_source {
        record_markdown_source(env, txn, &prepared.plain_text, BODY_FRAGMENT);
    }
    true
}

/// What `replaceDocBody` did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReplaceOutcome {
    Replaced,
    /// Large-file-class markdown (more than 1 MB or a blank-line-free run over 128 KB).
    RefusedLargeFile,
    /// `unlessChangedFrom` no longer matched the fragment.
    Changed,
    /// The markdown did not convert; the document is untouched.
    Failed,
}

/// BlockNote's empty document: the one empty paragraph a fresh editor holds.
pub fn empty_document_blocks() -> Vec<Json> {
    vec![json!({"type": "paragraph", "props": {}, "content": [], "children": []})]
}

/// The fragment's XML string (`fragment.toJSON()`), which `unless_changed_from`
/// of [`replace_doc_body`] compares.
pub fn fragment_snapshot<T: ReadTxn>(txn: &T, fragment: &str) -> Option<String> {
    txn.get_xml_fragment(fragment).map(|f| f.get_string(txn))
}

/// `replaceDocBody` over the converter: swap a note's body for new markdown in
/// one transaction. `unless_changed_from` is [`fragment_snapshot`] taken when
/// the caller read the body.
pub fn replace_doc_body(
    env: &Env,
    txn: &mut TransactionMut,
    markdown: &str,
    note_path: Option<&str>,
    writing: Option<WritingFrontmatter>,
    unless_changed_from: Option<&str>,
) -> ReplaceOutcome {
    if classify_markdown_content(markdown, MarkdownClassThresholds::default())
        .large_file
        .is_some()
    {
        return ReplaceOutcome::RefusedLargeFile;
    }
    let seed_env = SeedEnv {
        callout_types: env.callout_types,
        embeds: env.embeds,
        serializer: &BlockNoteSerializer,
        html_comments: true,
    };
    let Ok(mut prepared) = prepare_fragment_seed(&seed_env, markdown, note_path, writing) else {
        return ReplaceOutcome::Failed;
    };
    // An open editor always holds at least one block, and its binding stops
    // following the doc once the fragment is emptied under it.
    if prepared.blocks.is_empty() {
        prepared.blocks = empty_document_blocks();
    }
    // Everything that can fail runs before the first write; the fragment is
    // cleared last, so a failure leaves the body as it was.
    let Some(doc) = build_seed_doc(env, &prepared) else {
        return ReplaceOutcome::Failed;
    };
    let fragment = yrs::WriteTxn::get_or_insert_xml_fragment(txn, BODY_FRAGMENT);
    if let Some(expected) = unless_changed_from
        && fragment.get_string(&*txn) != expected
    {
        return ReplaceOutcome::Changed;
    }
    let length = fragment.len(&*txn);
    if length > 0 {
        fragment.remove_range(txn, 0, length);
    }
    if !apply_built_seed(&prepared, &doc, txn, &fragment) {
        return ReplaceOutcome::Failed;
    }
    // The file's new bytes are the source from here on. Without the writing
    // markers: a source still holding them would put a deleted range's
    // comments back on the next write.
    record_markdown_source(env, txn, &prepared.plain_text, BODY_FRAGMENT);
    ReplaceOutcome::Replaced
}

/// `repairEmptyBlockIds`: a fresh id on every block container, column list and
/// column whose id is missing or empty. Returns how many were repaired.
pub fn repair_empty_block_ids(
    env: &Env,
    txn: &mut TransactionMut,
    fragment: &XmlFragmentRef,
) -> usize {
    fn visit<F: XmlFragment>(env: &Env, txn: &mut TransactionMut, node: &F, repaired: &mut usize) {
        let children: Vec<XmlOut> = node.children(&*txn).collect();
        for child in children {
            let XmlOut::Element(element) = child else {
                continue;
            };
            let tag = element.tag().to_string();
            if matches!(tag.as_str(), "blockContainer" | "columnList" | "column") {
                let missing = match element.get_attribute(&*txn, "id") {
                    None => true,
                    Some(out) => match out {
                        yrs::Out::Any(Any::String(s)) => s.is_empty(),
                        yrs::Out::Any(Any::Null | Any::Undefined) => true,
                        yrs::Out::Any(Any::Bool(b)) => !b,
                        yrs::Out::Any(Any::Number(n)) => n == 0.0 || n.is_nan(),
                        _ => false,
                    },
                };
                if missing {
                    element.insert_attribute(txn, "id", env.ids.next_id());
                    *repaired += 1;
                }
            }
            visit(env, txn, &element, repaired);
        }
    }
    if crate::markdown::limits::fragment_too_deep(&*txn, fragment) {
        return 0;
    }
    let mut repaired = 0;
    visit(env, txn, fragment, &mut repaired);
    repaired
}

use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;

use memry_test_kit::ydoc::doc_json;
use memry_test_kit::{assert_steps_at_most, on_small_stack, output_bound, proptest_config};
use proptest::prelude::*;
use rusty_leveldb::{DB, Options};
use yrs::updates::decoder::Decode as _;
use yrs::{
    Any, Array as _, ArrayPrelim, Doc, Map as _, ReadTxn as _, StateVector, Text as _,
    Transact as _, Update, XmlFragment as _, XmlTextPrelim,
};

use super::update_depth::{self, MAX_ANY_DEPTH, MAX_TYPE_DEPTH, Refusal};
use super::*;
use crate::electron_import::tests::{synthetic, test_scratch};
use crate::electron_import::ystore::SNAPSHOT_WATERMARK_KEY;

struct StoredDoc<'a> {
    name: &'a str,
    updates: Vec<Vec<u8>>,
    watermark: Option<u64>,
    meta: Vec<(&'a str, Any)>,
}

fn doc<'a>(name: &'a str, updates: Vec<Vec<u8>>) -> StoredDoc<'a> {
    StoredDoc {
        name,
        updates,
        watermark: None,
        meta: Vec::new(),
    }
}

/// A y-leveldb store at `dir`, keys as y-leveldb writes them.
fn write_store(dir: &Path, docs: &[StoredDoc<'_>]) {
    std::fs::create_dir_all(dir).unwrap();
    let mut db = DB::open(dir, Options::default()).unwrap();
    for stored in docs {
        for (clock, update) in stored.updates.iter().enumerate() {
            db.put(&synthetic::update_key(stored.name, clock as u32), update)
                .unwrap();
        }
        if let Some(sequence) = stored.watermark {
            let object =
                HashMap::from([("appliedSequence".to_owned(), Any::Number(sequence as f64))]);
            let mut value = Vec::new();
            Any::from(object).encode(&mut value);
            let key = synthetic::string_keys(&["v1", stored.name, "meta", SNAPSHOT_WATERMARK_KEY]);
            db.put(&key, &value).unwrap();
        }
        for (name, any) in &stored.meta {
            let mut value = Vec::new();
            any.encode(&mut value);
            db.put(
                &synthetic::string_keys(&["v1", stored.name, "meta", name]),
                &value,
            )
            .unwrap();
        }
    }
    db.flush().unwrap();
}

fn fold_docs(docs: &[StoredDoc<'_>], partition_owed: bool) -> YStoreFold {
    let (dir, scratch) = test_scratch();
    let store_dir = dir.path().join("store");
    write_store(&store_dir, docs);
    let store = YStoreReader::open_dir(&store_dir, &scratch)
        .unwrap()
        .unwrap();
    fold_store(&store, partition_owed)
}

/// Three edits of one body, each an update against the state before it.
fn edits() -> Vec<Vec<u8>> {
    let doc = Doc::with_client_id(7);
    let text = doc.get_or_insert_text("t");
    let mut out = Vec::new();
    for edit in 0..3 {
        let before = doc.transact().state_vector();
        {
            let mut txn = doc.transact_mut();
            match edit {
                0 => text.insert(&mut txn, 0, "hello world"),
                1 => text.insert(&mut txn, 5, ","),
                _ => text.remove_range(&mut txn, 0, 1),
            }
        }
        out.push(doc.transact().encode_state_as_update_v1(&before));
    }
    out
}

fn empty_state() -> Vec<u8> {
    Doc::new()
        .transact()
        .encode_state_as_update_v1(&StateVector::default())
}

/// One item in the root array `a` holding `[[[ ... null ... ]]]`, `depth` arrays deep, as lib0
/// v1 bytes: one client, one block (info 8: `Any`, parent named), an empty delete set.
fn nested_any_update(depth: usize) -> Vec<u8> {
    let mut out = vec![1, 1, 1, 0, 8, 1, 1, b'a', 1];
    for _ in 0..depth {
        out.extend([117, 1]);
    }
    out.extend([126, 0]);
    out
}

#[test]
fn folds_every_update_in_clock_order_into_one_state() {
    let updates = edits();
    let fold = fold_docs(&[doc("abcdefghijkl", updates.clone())], false);
    assert_eq!(fold.docs.len(), 1);
    let folded = &fold.docs[0];
    assert_eq!(folded.doc_id, "abcdefghijkl");
    assert_eq!(
        doc_json(std::slice::from_ref(&folded.state)),
        doc_json(&updates)
    );
    assert!(fold.skipped.is_empty() && fold.incomplete.is_empty());
}

#[test]
fn carries_the_watermark_as_the_cursor() {
    let mut with = doc("withcursor01", edits());
    with.watermark = Some(7);
    let fold = fold_docs(&[with, doc("nocursor0001", edits())], false);
    let cursors: Vec<_> = fold
        .docs
        .iter()
        .map(|d| (d.doc_id.as_str(), d.watermark))
        .collect();
    assert_eq!(cursors, [("nocursor0001", None), ("withcursor01", Some(7))]);
}

#[test]
fn pseudo_set_aside_and_empty_documents_are_listed_not_imported() {
    let mut meta_only = doc("metaonly0001", Vec::new());
    meta_only.watermark = Some(3);
    let fold = fold_docs(
        &[
            doc("__memry_crdt_store__", edits()),
            doc("__memry_owed_compactions__", edits()),
            doc("__memry_unattributable__/abcdefghijkl", edits()),
            meta_only,
            doc("emptystate01", vec![empty_state()]),
            doc("j2025-01-01", edits()),
            doc("note_-0QKFMSbJ-18", edits()),
        ],
        false,
    );
    let ids: Vec<_> = fold.docs.iter().map(|d| d.doc_id.as_str()).collect();
    assert_eq!(ids, ["j2025-01-01", "note_-0QKFMSbJ-18"]);
    let skipped: Vec<_> = fold
        .skipped
        .iter()
        .map(|s| (s.doc_id.as_str(), s.reason))
        .collect();
    assert_eq!(
        skipped,
        [
            ("__memry_crdt_store__", SkipReason::Reserved),
            ("__memry_owed_compactions__", SkipReason::Reserved),
            (
                "__memry_unattributable__/abcdefghijkl",
                SkipReason::Unattributable
            ),
            ("emptystate01", SkipReason::Empty),
            ("metaonly0001", SkipReason::Empty),
        ]
    );
}

#[test]
fn an_owed_partition_sets_journal_days_aside() {
    let fold = fold_docs(
        &[
            doc("j2025-01-01", edits()),
            doc("j2025-1-01xx", edits()),
            doc("abcdefghijkl", edits()),
        ],
        true,
    );
    let ids: Vec<_> = fold.docs.iter().map(|d| d.doc_id.as_str()).collect();
    assert_eq!(ids, ["abcdefghijkl", "j2025-1-01xx"]);
    assert_eq!(
        fold.skipped,
        [SkippedDoc {
            doc_id: "j2025-01-01".into(),
            reason: SkipReason::AmbiguousLegacy
        }]
    );
}

#[test]
fn an_update_waiting_on_a_missing_one_is_folded_and_listed() {
    let updates = edits();
    let fold = fold_docs(&[doc("gap000000001", vec![updates[1].clone()])], false);
    assert_eq!(fold.incomplete, ["gap000000001"]);
    assert_eq!(fold.docs.len(), 1);
}

fn unreadable(fold: &YStoreFold) -> Vec<&str> {
    fold.skipped
        .iter()
        .filter(|s| s.reason == SkipReason::Unreadable)
        .map(|s| s.doc_id.as_str())
        .collect()
}

/// Electron opens such a note from its markdown (`crdt-provider.ts:944-950`), so the rest of
/// the vault imports.
#[test]
fn every_unreadable_document_is_skipped_by_name_and_the_rest_fold() {
    let mut not_utf8 = nested_any_update(0);
    // The parent name `a` becomes a lone continuation byte.
    not_utf8[7] = 0x80;
    let fold = fold_docs(
        &[
            doc("garbage00001", vec![vec![0xff, 0xff, 0xff]]),
            doc("readable0001", edits()),
            doc("toodeep00001", vec![nested_any_update(MAX_ANY_DEPTH)]),
            doc("notutf800001", vec![not_utf8]),
        ],
        false,
    );
    assert_eq!(
        unreadable(&fold),
        ["garbage00001", "notutf800001", "toodeep00001"]
    );
    let ids: Vec<_> = fold.docs.iter().map(|d| d.doc_id.as_str()).collect();
    assert_eq!(ids, ["readable0001"]);
}

#[test]
fn the_owed_compactions_marker_is_carried() {
    let mut marker = doc("__memry_owed_compactions__", Vec::new());
    marker.meta.push((
        "owedCompactions",
        Any::from(vec![
            Any::from("abcdefghijkl"),
            Any::from(5.0),
            Any::from("mnopqrstuvwx"),
        ]),
    ));
    let fold = fold_docs(&[marker, doc("abcdefghijkl", edits())], false);
    assert_eq!(fold.owed_compactions, ["abcdefghijkl", "mnopqrstuvwx"]);
    assert_eq!(fold.docs.len(), 1);
}

#[test]
fn the_walk_accepts_the_deepest_any_yrs_decodes_on_a_spawned_threads_stack() {
    let deepest = nested_any_update(MAX_ANY_DEPTH - 1);
    assert_eq!(update_depth::check(&[&deepest]), Ok(()));
    let fold = on_small_stack(move || {
        fold_docs(&[doc("deepest00001", vec![deepest])], false)
            .docs
            .len()
    });
    assert_eq!(fold, 1);
    assert_eq!(
        update_depth::check(&[&nested_any_update(MAX_ANY_DEPTH)]),
        Err(Refusal::TooDeep)
    );
}

/// Red without the guard: drop the `update_depth::check` loop in `fold_doc` and `yrs`'s
/// recursive `Any::decode` overflows the fold thread's 2 MiB stack, which aborts the binary.
#[test]
fn a_deeply_nested_any_fails_closed_on_a_small_stack() {
    let fold = on_small_stack(|| {
        fold_docs(
            &[doc("bomb00000001", vec![nested_any_update(200_000)])],
            false,
        )
    });
    assert_eq!(unreadable(&fold), ["bomb00000001"]);
}

/// `depth` arrays nested in the root array `a` by client 7, then a delete of the outermost:
/// deleting a type makes `yrs` recurse once per level below it.
fn nested_types_then_delete(depth: usize) -> Vec<Vec<u8>> {
    let doc = Doc::with_client_id(7);
    let root = doc.get_or_insert_array("a");
    {
        let mut txn = doc.transact_mut();
        let mut array = root.insert(&mut txn, 0, ArrayPrelim::default());
        for _ in 1..depth {
            array = array.insert(&mut txn, 0, ArrayPrelim::default());
        }
    }
    let state = doc
        .transact()
        .encode_state_as_update_v1(&StateVector::default());
    // No blocks; a delete set of client 7, one range: clock 0, length 1.
    vec![state, vec![0, 1, 7, 1, 0, 1]]
}

/// Red without the guard: `yrs` deletes 20,000 nested arrays by recursion and overflows the
/// fold worker's stack, which aborts the binary.
#[test]
fn types_nested_past_the_cap_are_refused_before_yrs_deletes_them() {
    let updates = nested_types_then_delete(20_000);
    let fold = on_small_stack(move || fold_docs(&[doc("nested000001", updates)], false));
    assert_eq!(unreadable(&fold), ["nested000001"]);
    assert!(fold.docs.is_empty());
}

#[test]
fn the_deepest_accepted_type_nesting_deletes_on_a_spawned_threads_stack() {
    let cap = MAX_TYPE_DEPTH as usize;
    let deepest = nested_types_then_delete(cap);
    let slices: Vec<&[u8]> = deepest.iter().map(Vec::as_slice).collect();
    assert_eq!(update_depth::check(&slices), Ok(()));
    let fold = on_small_stack(move || fold_docs(&[doc("deepest00001", deepest)], false));
    assert_eq!(fold.docs.len(), 1, "{:?}", fold.skipped);

    let deeper = nested_types_then_delete(cap + 1);
    let slices: Vec<&[u8]> = deeper.iter().map(Vec::as_slice).collect();
    assert_eq!(update_depth::check(&slices), Err(Refusal::TooDeep));
}

/// The nesting is counted across updates: each one adds a level under the type the previous
/// one made, and none of them is deep on its own.
#[test]
fn type_nesting_is_counted_across_updates() {
    let doc = Doc::with_client_id(7);
    let root = doc.get_or_insert_array("a");
    let mut updates = Vec::new();
    let mut array: Option<yrs::ArrayRef> = None;
    for _ in 0..=MAX_TYPE_DEPTH {
        let before = doc.transact().state_vector();
        {
            let mut txn = doc.transact_mut();
            array = Some(match &array {
                None => root.insert(&mut txn, 0, ArrayPrelim::default()),
                Some(parent) => parent.insert(&mut txn, 0, ArrayPrelim::default()),
            });
        }
        updates.push(doc.transact().encode_state_as_update_v1(&before));
    }
    let slices: Vec<&[u8]> = updates.iter().map(Vec::as_slice).collect();
    assert_eq!(update_depth::check(&slices[..1]), Ok(()));
    assert_eq!(update_depth::check(&slices), Err(Refusal::TooDeep));
}

/// 100,000 items each placed before the previous one: a chain of right origins as long as the
/// document, resolved without recursion and once per item.
#[test]
fn a_long_origin_chain_resolves_on_a_small_stack_in_linear_steps() {
    let doc = Doc::with_client_id(3);
    let array = doc.get_or_insert_array("a");
    {
        let mut txn = doc.transact_mut();
        for i in 0..100_000 {
            array.insert(&mut txn, 0, Any::from(f64::from(i)));
        }
    }
    let update = doc
        .transact()
        .encode_state_as_update_v1(&StateVector::default());
    let bound = 4 * update.len() + 10;
    on_small_stack(move || {
        assert_steps_at_most("type depth", update_depth::steps, bound, || {
            assert_eq!(update_depth::check(&[&update]), Ok(()));
        });
    });
}

#[test]
fn an_over_long_signed_varint_is_refused_before_yrs_shifts_past_63_bits() {
    // An `Any` integer (125) with ten continuation bytes: `read_var_i64` would shift by 69.
    let mut update = vec![1, 1, 1, 0, 8, 1, 1, b'a', 1, 125];
    update.extend([0x80; 10]);
    update.extend([0x01, 0]);
    assert_eq!(update_depth::check(&[&update]), Err(Refusal::Malformed));
}

#[test]
fn the_walk_visits_each_block_and_value_once() {
    let doc = Doc::with_client_id(3);
    let array = doc.get_or_insert_array("a");
    {
        let mut txn = doc.transact_mut();
        for i in 0..2_000 {
            array.insert(
                &mut txn,
                0,
                Any::from(vec![Any::from(i as f64), Any::from("x")]),
            );
        }
    }
    let update = doc
        .transact()
        .encode_state_as_update_v1(&StateVector::default());
    // Each block is walked, inserted and resolved; each value is walked.
    assert_steps_at_most(
        "update depth walk",
        update_depth::steps,
        2 * update.len() + 10,
        || assert_eq!(update_depth::check(&[&update]), Ok(())),
    );
}

/// Bodies with elements, attributes holding nested values, text with marks, map entries and
/// deletions, edited in random steps; and the union of the updates' state vectors, which is
/// the editing document's last one.
fn random_updates(script: &[(u8, u16, u8)]) -> (Vec<Vec<u8>>, StateVector) {
    let doc = Doc::with_client_id(11);
    let fragment = doc.get_or_insert_xml_fragment("prosemirror");
    let meta = doc.get_or_insert_map("meta");
    let mut out = Vec::new();
    for &(op, at, n) in script {
        let before = doc.transact().state_vector();
        {
            let mut txn = doc.transact_mut();
            let len = fragment.len(&txn);
            match op % 4 {
                0 => {
                    let text = fragment.insert(&mut txn, len, XmlTextPrelim::new("block text"));
                    let mut attrs = HashMap::new();
                    attrs.insert(Arc::from("bold"), Any::Bool(true));
                    text.format(&mut txn, 0, u32::from(n % 5), attrs);
                }
                1 if len > 0 => fragment.remove_range(&mut txn, u32::from(at) % len, 1),
                2 => {
                    let mut value = Any::from(f64::from(n));
                    for _ in 0..(n % 8) {
                        value = Any::from(vec![
                            value.clone(),
                            Any::from(HashMap::from([("k".to_owned(), value)])),
                        ]);
                    }
                    meta.insert(&mut txn, format!("key{}", at % 4), value);
                }
                _ => {
                    meta.remove(&mut txn, &format!("key{}", at % 4));
                }
            }
        }
        out.push(doc.transact().encode_state_as_update_v1(&before));
    }
    let union = doc.transact().state_vector();
    (out, union)
}

proptest! {
    #![proptest_config(proptest_config(256))]

    #[test]
    fn every_update_yrs_writes_folds_to_the_same_document(
        script in prop::collection::vec((any::<u8>(), any::<u16>(), any::<u8>()), 1..24)
    ) {
        let (updates, union) = random_updates(&script);
        let slices: Vec<&[u8]> = updates.iter().map(Vec::as_slice).collect();
        prop_assert_eq!(update_depth::check(&slices), Ok(()));
        let input: usize = updates.iter().map(Vec::len).sum();
        let fold = fold_docs(&[doc("random000001", updates.clone())], false);
        if let Some(folded) = fold.docs.first() {
            prop_assert_eq!(doc_json(std::slice::from_ref(&folded.state)), doc_json(&updates));
            prop_assert_eq!(Update::decode_v1(&folded.state).unwrap().state_vector(), union);
            prop_assert!(folded.state.len() <= output_bound(input));
        }
    }

    #[test]
    fn damaged_updates_fold_or_fail_closed_never_panic(
        script in prop::collection::vec((any::<u8>(), any::<u16>(), any::<u8>()), 1..8),
        flips in prop::collection::vec((any::<usize>(), any::<u8>()), 1..4),
        cut in any::<usize>(),
    ) {
        let (mut updates, _) = random_updates(&script);
        let last = updates.last_mut().unwrap();
        for (at, byte) in flips {
            let i = at % last.len();
            last[i] ^= byte;
        }
        last.truncate(cut % (last.len() + 1));
        let fold = fold_docs(&[doc("damaged00001", updates)], false);
        prop_assert_eq!(fold.docs.len() + fold.skipped.len(), 1);
    }
}

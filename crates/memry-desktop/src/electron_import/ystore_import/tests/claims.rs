//! The two bounds that do not trust the depth tracker: an item sent twice must be the same
//! item at every clock, and the fold's stack follows the document's type-item count.

use memry_test_kit::{assert_steps_at_most, on_small_stack, proptest_config};
use proptest::prelude::*;
use yrs::updates::decoder::Decode as _;
use yrs::{Doc, ReadTxn as _, StateVector, Transact as _, Update};

use super::super::fold_on_sized_stack;
use super::super::update_depth::{self, MAX_TYPE_ITEMS, Refusal};
use super::{doc, fold_docs, nested_types_then_delete, random_updates, unreadable};
use memry_test_kit::ydoc::doc_json;

fn var(mut n: usize, out: &mut Vec<u8>) {
    while n >= 0x80 {
        out.push((n as u8 & 0x7f) | 0x80);
        n >>= 7;
    }
    out.push(n as u8);
}

/// The review's repro (VERIFY-5034): client 7's clock 0 is first claimed by a string whose
/// origin `(8, 0)` never arrives, so `yrs` never integrates it and gives the clock to the root
/// array of the second update, under which 20,000 arrays nest; the third deletes that array.
/// Red without the duplicate-claim refusal and the sized stack: the tracker follows the first
/// claimant, passes the document, and `yrs`'s recursive delete aborts the binary.
#[test]
fn a_never_integrated_first_claimant_does_not_hide_a_deep_chain() {
    let blocker = vec![1, 1, 7, 0, 0x84, 8, 0, 1, b'x', 0];
    let mut chain = nested_types_then_delete(20_001);
    chain.insert(0, blocker);
    let fold = on_small_stack(move || fold_docs(&[doc("blocker00001", chain)], false));
    assert_eq!(unreadable(&fold), ["blocker00001"]);
    assert!(fold.docs.is_empty());
}

/// Nesting the tracker does not see still deletes, because the fold's stack holds one level
/// per type item. Red without the sizing (a 2 MiB fold thread): the delete overflows it and
/// aborts the binary, in debug and release alike.
#[test]
fn nesting_the_tracker_misses_deletes_on_a_stack_sized_from_the_type_count() {
    let updates = nested_types_then_delete(20_000);
    let folded = on_small_stack(move || {
        let slices: Vec<(u32, &[u8])> = updates.iter().map(|u| (0, u.as_slice())).collect();
        fold_on_sized_stack("deep00000001", &slices, 20_000).map(|fold| fold.missing)
    });
    assert_eq!(folded, Ok(false));
}

/// `n` arrays named under the root `a`, each one block of client 9.
fn root_types(n: usize) -> Vec<u8> {
    let mut out = vec![1];
    var(n, &mut out);
    out.extend([9, 0]);
    for _ in 0..n {
        out.extend([7, 1, 1, b'a', 0]);
    }
    out.push(0);
    out
}

/// Red without the cap: the document folds on a stack sized past a gigabyte in debug.
#[test]
fn a_document_past_the_type_item_cap_is_unreadable() {
    assert_eq!(
        update_depth::check(&[&root_types(MAX_TYPE_ITEMS)]),
        Ok(MAX_TYPE_ITEMS)
    );
    assert_eq!(
        update_depth::check(&[&root_types(MAX_TYPE_ITEMS + 1)]),
        Err(Refusal::TooManyTypes)
    );
    let fold = fold_docs(
        &[doc("toomany00001", vec![root_types(MAX_TYPE_ITEMS + 1)])],
        false,
    );
    assert_eq!(unreadable(&fold), ["toomany00001"]);
}

#[test]
fn a_clock_two_different_items_claim_is_refused() {
    // Client 7's clock 0: a string under `a`, then a string placed after `(8, 0)`.
    let first = vec![1, 1, 7, 0, 4, 1, 1, b'a', 1, b'x', 0];
    let second = vec![1, 1, 7, 0, 0x84, 8, 0, 1, b'y', 0];
    assert_eq!(
        update_depth::check(&[&first, &second]),
        Err(Refusal::Malformed)
    );
    assert_eq!(update_depth::check(&[&first, &first]), Ok(0));
}

/// `pieces` one-value items of client 3, each after the one before, then `resends` copies of
/// one deleted item over all of them: the same clocks, sent as `yrs` sends a merged item.
#[test]
fn a_long_item_sent_again_checks_each_earlier_piece_once() {
    let (pieces, resends) = (20_000, 2_000);
    let mut items = vec![1];
    var(pieces, &mut items);
    items.extend([3, 0, 8, 1, 1, b'a', 1, 126]);
    for clock in 1..pieces {
        items.extend([0x88, 3]);
        var(clock - 1, &mut items);
        items.extend([1, 126]);
    }
    items.push(0);
    let mut deleted = vec![1, 1, 3, 0, 1, 1, 1, b'a'];
    var(pieces, &mut deleted);
    deleted.push(0);
    let mut updates = vec![items.as_slice()];
    updates.extend(std::iter::repeat_n(deleted.as_slice(), resends));
    let input: usize = updates.iter().map(|u| u.len()).sum();
    assert_steps_at_most("resent items", update_depth::steps, 4 * input + 10, || {
        assert_eq!(update_depth::check(&updates), Ok(0));
    });
}

proptest! {
    #![proptest_config(proptest_config(128))]

    /// `yrs` resends items split, merged and deleted when it encodes a document from an older
    /// state vector; those copies agree with the first, before or after it.
    #[test]
    fn items_yrs_resends_are_the_same_items(
        script in prop::collection::vec((any::<u8>(), any::<u16>(), any::<u8>()), 1..24),
        from in any::<usize>(),
    ) {
        let (updates, _) = random_updates(&script);
        let whole = Doc::new();
        let older = Doc::new();
        let from = from % updates.len();
        for (i, update) in updates.iter().enumerate() {
            whole.transact_mut().apply_update(Update::decode_v1(update).unwrap()).unwrap();
            if i < from {
                older.transact_mut().apply_update(Update::decode_v1(update).unwrap()).unwrap();
            }
        }
        let since: StateVector = older.transact().state_vector();
        let resent = whole.transact().encode_state_as_update_v1(&since);
        for order in [
            [updates.clone(), vec![resent.clone()]].concat(),
            [vec![resent.clone()], updates.clone()].concat(),
        ] {
            let slices: Vec<&[u8]> = order.iter().map(Vec::as_slice).collect();
            prop_assert!(update_depth::check(&slices).is_ok());
            let fold = fold_docs(&[doc("resent000001", order.clone())], false);
            if let Some(folded) = fold.docs.first() {
                prop_assert_eq!(doc_json(std::slice::from_ref(&folded.state)), doc_json(&updates));
            }
        }
    }
}

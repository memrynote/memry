// S2 yrs ↔ Yjs interop integration tests.
//
// Prereq: fixtures generated via
//   pnpm tsx scripts/generate-yjs-fixtures.ts
//   cargo run --bin yrs_fixture_gen
//
// Tests:
//   - Test 2: Yjs-emitted v1 update decodes + applies in yrs (semantic text equality)
//   - Test 2b: Yjs with delete/re-insert sequence still decodes correctly in yrs
//   - Test 5 (Rust side): yrs merges Yjs concurrent update with own edit, both contributions preserved

use std::fs;
use std::path::PathBuf;
use yrs::updates::decoder::Decode;
use yrs::{Doc, GetString, Options, Text, Transact, Update};

fn fixtures_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../tests/fixtures")
}

fn read_bin(name: &str) -> Vec<u8> {
    let path = fixtures_dir().join(format!("{name}.bin"));
    fs::read(&path).unwrap_or_else(|_| {
        panic!(
            "fixture missing: {} — run `pnpm tsx scripts/generate-yjs-fixtures.ts && cargo run --bin yrs_fixture_gen`",
            path.display()
        )
    })
}

fn read_txt(name: &str) -> String {
    let path = fixtures_dir().join(format!("{name}.expected.txt"));
    fs::read_to_string(&path)
        .unwrap_or_else(|_| panic!("fixture missing: {}", path.display()))
}

#[test]
fn test_2_yjs_update_applies_to_yrs() {
    let bytes = read_bin("yjs_hello_world");
    let expected = read_txt("yjs_hello_world");

    let doc = Doc::new();
    let update = Update::decode_v1(&bytes).expect("decode v1");
    doc.transact_mut().apply_update(update).expect("apply");

    let text = doc.get_or_insert_text("t");
    assert_eq!(text.get_string(&doc.transact()), expected);
}

#[test]
fn test_2b_yjs_edit_sequence_applies_to_yrs() {
    let bytes = read_bin("yjs_edit_sequence");
    let expected = read_txt("yjs_edit_sequence");

    let doc = Doc::new();
    let update = Update::decode_v1(&bytes).expect("decode v1");
    doc.transact_mut().apply_update(update).expect("apply");

    let text = doc.get_or_insert_text("t");
    assert_eq!(text.get_string(&doc.transact()), expected);
}

#[test]
fn test_5_yrs_applies_yjs_update_then_own_edit_sequentially() {
    // Sequential: yrs applies Yjs's update, then inserts its own text at position 0.
    // Exercises the code path used in production (renderer edits → Rust applies →
    // Rust has option to make local edits on top).
    let yjs_a = read_bin("yjs_concurrent_a");

    let opts = Options {
        client_id: 2222,
        ..Default::default()
    };
    let doc = Doc::with_options(opts);
    let text = doc.get_or_insert_text("t");

    let update = Update::decode_v1(&yjs_a).expect("decode");
    doc.transact_mut().apply_update(update).expect("apply");

    {
        let mut txn = doc.transact_mut();
        text.insert(&mut txn, 0, "beta_");
    }

    let final_text = text.get_string(&doc.transact());
    assert!(
        final_text.contains("alpha_"),
        "missing alpha_ in final text: {final_text}"
    );
    assert!(
        final_text.contains("beta_"),
        "missing beta_ in final text: {final_text}"
    );
}

#[test]
fn test_5b_yrs_merges_yjs_and_yrs_concurrent_updates() {
    // True CONCURRENT merge: fresh yrs doc receives two updates that didn't
    // see each other — yjs_a (client 1111) and yrs_b (client 2222). Expect
    // both contributions present in final text, order per CRDT tie-break.
    let yjs_a = read_bin("yjs_concurrent_a");
    let yrs_b = read_bin("yrs_concurrent_b");

    let doc = Doc::new();
    let text = doc.get_or_insert_text("t");

    let update_a = Update::decode_v1(&yjs_a).expect("decode yjs_a");
    doc.transact_mut().apply_update(update_a).expect("apply a");
    let update_b = Update::decode_v1(&yrs_b).expect("decode yrs_b");
    doc.transact_mut().apply_update(update_b).expect("apply b");

    let final_text = text.get_string(&doc.transact());
    assert!(
        final_text.contains("alpha_"),
        "missing alpha_ in concurrent merge: {final_text}"
    );
    assert!(
        final_text.contains("beta_"),
        "missing beta_ in concurrent merge: {final_text}"
    );
}

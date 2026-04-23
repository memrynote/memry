// S2 yrs fixture generator.
//
// Writes binary yrs update fixtures + expected-text sidecars into
// ../tests/fixtures/ (shared with Yjs fixtures). Consumed by Node vitest
// tests (decode via Yjs) and by the heterogeneous merge test.
//
// Run: cargo run --bin yrs_fixture_gen
// Prereq: pnpm tsx scripts/generate-yjs-fixtures.ts must have run first —
//         the heterogeneous merge requires yjs_concurrent_a.bin.

use std::fs;
use std::path::PathBuf;
use yrs::updates::decoder::Decode;
use yrs::{Doc, GetString, Options, ReadTxn, StateVector, Text, Transact, Update};

fn fixtures_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../tests/fixtures")
}

fn write_bin(name: &str, bytes: &[u8]) {
    let path = fixtures_dir().join(format!("{name}.bin"));
    fs::write(&path, bytes).expect("write fixture bin");
    println!("[yrs-fix] {}.bin ({} bytes)", name, bytes.len());
}

fn write_txt(name: &str, text: &str) {
    let path = fixtures_dir().join(format!("{name}.expected.txt"));
    fs::write(&path, text).expect("write expected txt");
}

fn main() {
    fs::create_dir_all(fixtures_dir()).expect("mkdir fixtures");

    // Fixture: yrs-emitted text "greetings from yrs" (for Test 3 Node verification)
    {
        let doc = Doc::new();
        let text = doc.get_or_insert_text("t");
        {
            let mut txn = doc.transact_mut();
            text.insert(&mut txn, 0, "greetings from yrs");
        }
        let bytes = doc
            .transact()
            .encode_state_as_update_v1(&StateVector::default());
        write_bin("yrs_greeting", &bytes);
        write_txt("yrs_greeting", "greetings from yrs");
    }

    // Fixture: yrs client clientID=2222 with "beta_" (raw, for Node to apply alongside yjs_a)
    {
        let opts = Options {
            client_id: 2222,
            ..Default::default()
        };
        let doc = Doc::with_options(opts);
        let text = doc.get_or_insert_text("t");
        {
            let mut txn = doc.transact_mut();
            text.insert(&mut txn, 0, "beta_");
        }
        let bytes = doc
            .transact()
            .encode_state_as_update_v1(&StateVector::default());
        write_bin("yrs_concurrent_b", &bytes);
    }

    // Fixture: heterogeneous CONCURRENT converged. Fresh yrs doc merges TWO
    // pre-emitted updates — Yjs's yjs_concurrent_a (alpha_, client 1111) and
    // yrs's yrs_concurrent_b (beta_, client 2222). Neither saw the other; this
    // is a true concurrent merge. Node-side merge with the same two updates
    // must yield the same final text (CRDT determinism across libs).
    {
        let yjs_a_path = fixtures_dir().join("yjs_concurrent_a.bin");
        let yrs_b_path = fixtures_dir().join("yrs_concurrent_b.bin");
        let yjs_a = fs::read(&yjs_a_path).unwrap_or_else(|_| {
            panic!(
                "missing {}; run 'pnpm tsx scripts/generate-yjs-fixtures.ts' first",
                yjs_a_path.display()
            )
        });
        let yrs_b = fs::read(&yrs_b_path).expect("yrs_concurrent_b.bin must be generated above");

        let doc = Doc::new();
        let text = doc.get_or_insert_text("t");

        let update_a = Update::decode_v1(&yjs_a).expect("decode yjs_a");
        doc.transact_mut().apply_update(update_a).expect("apply yjs_a");

        let update_b = Update::decode_v1(&yrs_b).expect("decode yrs_b");
        doc.transact_mut().apply_update(update_b).expect("apply yrs_b");

        let converged_text = text.get_string(&doc.transact());
        let bytes = doc
            .transact()
            .encode_state_as_update_v1(&StateVector::default());
        write_bin("yrs_heterogeneous_converged", &bytes);
        write_txt("yrs_heterogeneous_converged", &converged_text);
    }

    println!("[yrs-fix] done");
}

//! The core's embedder against desktop's transformers.js vectors for the #4437
//! spike's 20 shaped inputs (`fixtures/embedding_parity.json`). Every input
//! must reach cosine 0.9999. No CI job has the 207 MB model, so this runs by
//! hand on a Mac:
//!
//! ```sh
//! ort=~/Library/Caches/memry/onnxruntime/$(sed -n 's/^sha256=//p' crates/memry-core/onnxruntime.lock)
//! mkdir -p /tmp/ort-macos && lipo -thin arm64 \
//!   "$ort/onnxruntime.xcframework/macos-arm64_x86_64/onnxruntime.framework/onnxruntime" \
//!   -output /tmp/ort-macos/libonnxruntime.a
//! cd crates && ORT_LIB_PATH=/tmp/ort-macos \
//!   RUSTFLAGS="-C link-arg=$(xcrun clang --print-runtime-dir)/libclang_rt.osx.a" \
//!   MEMRY_MODEL_DIR=<dir holding tokenizer.json and onnx/model_q4.onnx{,_data}> \
//!   cargo test -p memry-core --features semantic --test embedding_parity -- --ignored --nocapture
//! ```
#![cfg(feature = "semantic")]

use std::path::PathBuf;

use memry_core::semantic::{Threads, load, truncate_renormalize};

#[derive(serde::Deserialize)]
struct Case {
    id: String,
    text: String,
    vector: Vec<f32>,
}

#[test]
#[ignore = "needs MEMRY_MODEL_DIR and ONNX Runtime; see the module docs"]
fn core_vectors_match_desktop() {
    let dir = PathBuf::from(std::env::var("MEMRY_MODEL_DIR").expect("MEMRY_MODEL_DIR"));
    let cases: Vec<Case> =
        serde_json::from_str(include_str!("fixtures/embedding_parity.json")).expect("fixture");
    assert_eq!(cases.len(), 20);

    let embedder = load(&dir, Threads::Foreground).expect("load");
    let mut worst = f32::MAX;
    for case in &cases {
        let desktop = truncate_renormalize(&case.vector).expect("desktop vector");
        let cosine = embedder.embed(&case.text).expect("embed").dot(&desktop);
        println!("{:<24} cosine {cosine:.7}", case.id);
        worst = worst.min(cosine);
    }
    println!("worst cosine {worst:.7}");
    assert!(worst >= 0.9999, "worst cosine {worst}");

    drop(embedder);
    let reloaded =
        load(&dir, Threads::Background).expect("a reload reuses the process environment");
    let desktop = truncate_renormalize(&cases[0].vector).expect("desktop vector");
    assert!(reloaded.embed(&cases[0].text).expect("embed").dot(&desktop) >= 0.9999);
}

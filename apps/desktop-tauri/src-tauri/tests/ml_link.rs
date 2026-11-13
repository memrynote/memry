//! The app links ONNX Runtime through memry-ml with tauri-build's static VC runtime
//! (`staticVCRuntime`, `/NODEFAULTLIB:msvcrt.lib /DEFAULTLIB:libcmt.lib`), and the Windows
//! archives of `build-ort-static.yml` are built `/MT` to match. Cargo links this test with this
//! crate's build-script link arguments, the app's, so it embeds through the app's link. A
//! mismatched runtime fails the link (LNK2005, LNK2038). rust-ci's full tier runs it with the
//! pinned text files and lists the binary's DLLs: no ONNX Runtime and no VC++ redistributable.
#![cfg(windows)]

use std::path::PathBuf;

use memry_ml::{EMBEDDING_DIMENSION, EmbeddingEngine, LoadOptions};

#[test]
#[ignore = "needs the downloaded model in MEMRY_ML_MODEL_DIR"]
fn embeds_through_the_app_link() {
    let dir = PathBuf::from(std::env::var_os("MEMRY_ML_MODEL_DIR").expect("MEMRY_ML_MODEL_DIR"));
    let mut engine = EmbeddingEngine::load(&dir, LoadOptions::default()).expect("load");
    let embedding = engine
        .embed_text("task: search result | query: kedi")
        .expect("embed");
    assert_eq!(embedding.len(), EMBEDDING_DIMENSION);
    assert!(embedding.iter().all(|value| value.is_finite()));
}

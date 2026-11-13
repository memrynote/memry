//! The linked ONNX Runtime runs the real text graph. Needs the pinned text files in the directory
//! `MEMRY_ML_MODEL_DIR` names (the `embeddinggemma-2-ONNX` folder); CI downloads them on the full
//! tier only. Run: `cargo test -p memry-ml --test smoke -- --ignored`.

use std::path::PathBuf;

use memry_ml::{EMBEDDING_DIMENSION, Embedding, EmbeddingEngine, LoadOptions, MlError, ModelGroup};

fn cosine(a: &Embedding, b: &Embedding) -> f64 {
    a.iter()
        .zip(b)
        .map(|(&x, &y)| f64::from(x) * f64::from(y))
        .sum()
}

#[test]
#[ignore = "needs the downloaded model in MEMRY_ML_MODEL_DIR"]
fn embeds_text_with_the_downloaded_model() {
    let dir = PathBuf::from(std::env::var_os("MEMRY_ML_MODEL_DIR").expect("MEMRY_ML_MODEL_DIR"));
    memry_ml::verify(&dir, ModelGroup::Text).expect("the pinned text files");
    let mut engine = EmbeddingEngine::load(&dir, LoadOptions::default()).expect("load");

    let query = engine
        .embed_text("task: search result | query: kedi")
        .expect("embed");
    assert_eq!(query.len(), EMBEDDING_DIMENSION);
    assert!(query.iter().all(|value| value.is_finite()));
    assert!((cosine(&query, &query) - 1.0).abs() < 1e-5, "unit length");
    assert_eq!(
        engine
            .embed_text("task: search result | query: kedi")
            .expect("embed"),
        query
    );

    let related = engine
        .embed_text("title: Kediler | text: Kedim bütün gün pencerenin önünde uyuyor.")
        .expect("embed");
    let unrelated = engine
        .embed_text("title: Taxes | text: The quarterly VAT return is due on the 26th.")
        .expect("embed");
    assert!(
        cosine(&query, &related) > cosine(&query, &unrelated),
        "related {} unrelated {}",
        cosine(&query, &related),
        cosine(&query, &unrelated)
    );

    let placeholder = engine
        .embed_text("<|image|>")
        .expect_err("placeholder without an image");
    assert!(matches!(placeholder, MlError::Input(_)), "{placeholder}");
}

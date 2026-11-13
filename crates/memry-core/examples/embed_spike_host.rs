//! #4437 spike: run the core's embedder on the Mac over the parity inputs.
//! `cargo run --release -p memry-core --features embed-spike --example embed_spike_host -- <model-dir> <inputs.json> <out.json>`
use memry_core::embed_spike::SpikeEmbedder;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let embedder = SpikeEmbedder::load(args[1].clone(), 2).expect("load");
    let inputs: Vec<serde_json::Value> =
        serde_json::from_str(&std::fs::read_to_string(&args[2]).expect("read")).expect("json");
    let mut vectors = Vec::new();
    for input in inputs {
        let e = embedder
            .embed(input["text"].as_str().unwrap_or_default().to_string())
            .expect("embed");
        eprintln!(
            "{} tokens={} infer_ms={:.1}",
            input["id"], e.tokens, e.infer_ms
        );
        vectors
            .push(serde_json::json!({"id": input["id"], "tokens": e.tokens, "vector": e.vector}));
    }
    std::fs::write(
        &args[3],
        serde_json::json!({ "vectors": vectors }).to_string(),
    )
    .expect("write");
}

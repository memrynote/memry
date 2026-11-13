# EmbedSpike (#4437, throwaway)

Bench app for the on-device embedding spike. Not the Memry app: no vault, no
account, no network. Never merged.

## What it links

`memry-core` built with `--features embed-spike` (`crates/memry-core/src/embed_spike.rs`):
`ort` 2.0.0-rc.15 plus `tokenizers` 0.23.2 (`onig`), with Microsoft's
`onnxruntime-c` 1.30.0 iOS archive merged into each `libmemry_core.a` slice by
`build-xcframework.sh`. ONNX Runtime 1.30.0 is the version desktop's
`@huggingface/transformers` 4.3.1 runs.

## Reproduce

```bash
curl -LO https://download.onnxruntime.ai/pod-archive-onnxruntime-c-1.30.0.zip
unzip pod-archive-onnxruntime-c-1.30.0.zip -d /tmp/ort-ios
cd crates/memry-core
MEMRY_CORE_FEATURES=embed-spike ORT_XCFWK=/tmp/ort-ios/onnxruntime.xcframework \
  ./build-xcframework.sh --release
cd ../../apps/ios/EmbedSpike && xcodegen generate
xcodebuild -project EmbedSpike.xcodeproj -scheme EmbedSpike -configuration Release \
  -destination 'generic/platform=iOS' -derivedDataPath build/dd -allowProvisioningUpdates build
xcrun devicectl device install app --device <udid> build/dd/Build/Products/Release-iphoneos/EmbedSpike.app
# model: tokenizer.json, config.json, onnx/model_q4.onnx, onnx/model_q4.onnx_data
xcrun devicectl device copy to --device <udid> --domain-type appDataContainer \
  --domain-identifier com.memrynote.embedspike --source <model dir> --destination Documents/model
xcrun devicectl device copy to ... --source results/parity-inputs.json --destination Documents/parity-inputs.json
xcrun devicectl device process launch --device <udid> --terminate-existing \
  com.memrynote.embedspike -- --mode load --threads 2      # also: parity, corpus, background
xcrun devicectl device copy from ... --source Documents --destination <out>
```

Modes write `Documents/result-<mode>*.json`; `Documents/log.txt` has progress.
`background` waits until another app is brought forward
(`devicectl device process launch ... com.apple.Preferences`).

## Parity

`apps/desktop/scripts/spike-4437-desktop-vectors.ts` shapes the 20 inputs with
desktop's `embedding-input.ts` and embeds them with transformers.js as
`embedding-worker.ts` does. `python3 cosine.py results/desktop-vectors.json <other>.json`
prints per-input cosines. `crates/memry-core/examples/embed_spike_host.rs` runs the
core path on the Mac (`ORT_LIB_PATH` = the thin macOS arm64 archive from the same
pod; link `libclang_rt.osx.a` through `RUSTFLAGS`).

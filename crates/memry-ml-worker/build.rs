//! The worker ships next to the app on Windows, which links the VC runtime statically
//! (tauri-build's `staticVCRuntime`). The worker does the same, so no binary needs the VC++
//! redistributable.

fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    let target_os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    let target_env = std::env::var("CARGO_CFG_TARGET_ENV").unwrap_or_default();
    if target_os == "windows" && target_env == "msvc" {
        static_vcruntime::metabuild();
    }
}

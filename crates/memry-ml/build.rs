//! Link fixes for the static ONNX Runtime archives (crates/AGENTS.md, ONNX Runtime).
//!
//! - Apple Silicon: links the compiler runtime's `__isPlatformVersionAtLeast`. The CoreML
//!   provider in ort-sys's prebuilt archive calls it (an `@available` check). Rust's std defines
//!   it too, but fat LTO, the release profile, drops that definition and the link fails.
//! - Windows: ort-sys 2.0.0-rc.15 misses two libraries of a Visual Studio build tree, which keeps
//!   each library in a `Release` folder: it looks for `model_package` under `Release/` and for
//!   `utf8_validity.lib`, where protobuf names it `libutf8_validity.lib`. This links them from
//!   the `build-ort-static.yml` archive in `ORT_LIB_LOCATION`. That archive links the VC runtime
//!   statically (/MT), as the app does through tauri-build's `staticVCRuntime`, so this crate's own
//!   test binaries link the same way (`static_vcruntime`, which tauri-build calls). A binary of
//!   another crate that links memry-ml needs the same link arguments, which a build script cannot
//!   pass on to its dependents.

use std::path::{Path, PathBuf};
use std::process::Command;

fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-env-changed=ORT_LIB_LOCATION");
    let target = std::env::var("TARGET").expect("TARGET");
    if target == "aarch64-apple-darwin" {
        link_clang_runtime();
    } else if target.ends_with("-pc-windows-msvc") {
        // Without ORT_LIB_LOCATION only check and clippy work, and they link nothing.
        if let Ok(location) = std::env::var("ORT_LIB_LOCATION") {
            link_windows_leftovers(Path::new(&location));
        }
        static_vcruntime::metabuild();
    }
}

fn link_clang_runtime() {
    // Apple's clang, the one rustc links with: a `cc` from Homebrew LLVM or GCC has another
    // resource directory or none.
    let output = Command::new("xcrun")
        .args(["clang", "--print-resource-dir"])
        .output()
        .expect("run `xcrun clang --print-resource-dir`");
    assert!(
        output.status.success(),
        "`xcrun clang --print-resource-dir` failed"
    );
    let resource_dir = String::from_utf8(output.stdout).expect("utf-8 resource dir");
    let runtime_dir = PathBuf::from(resource_dir.trim())
        .join("lib")
        .join("darwin");
    let runtime = runtime_dir.join("libclang_rt.osx.a");
    assert!(runtime.is_file(), "{} is missing", runtime.display());
    println!("cargo:rustc-link-search=native={}", runtime_dir.display());
    println!("cargo:rustc-link-lib=static=clang_rt.osx");
}

fn link_windows_leftovers(location: &Path) {
    // The ARM64 archive has no `libutf8_range`; ort-sys links it when present, so this does too.
    let utf8_range = location.join("_deps/protobuf-build/third_party/utf8_range/Release");
    for (dir, lib, required) in [
        (
            location.join("model_package/Release"),
            "model_package",
            true,
        ),
        (utf8_range.clone(), "libutf8_validity", true),
        (utf8_range, "libutf8_range", false),
    ] {
        let file = dir.join(format!("{lib}.lib"));
        if !file.is_file() {
            assert!(
                !required,
                "{} is missing from ORT_LIB_LOCATION",
                file.display()
            );
            continue;
        }
        println!("cargo:rustc-link-search=native={}", dir.display());
        println!("cargo:rustc-link-lib=static={lib}");
    }
}

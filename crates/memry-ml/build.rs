//! Links the compiler runtime's `__isPlatformVersionAtLeast` on Apple Silicon. The CoreML
//! provider in ort-sys's prebuilt archive calls it (an `@available` check). Rust's std defines it
//! too, but fat LTO, the release profile, drops that definition and the link fails.

use std::path::PathBuf;
use std::process::Command;

fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    if std::env::var("TARGET").as_deref() != Ok("aarch64-apple-darwin") {
        return;
    }
    let output = Command::new("cc")
        .arg("--print-resource-dir")
        .output()
        .expect("run `cc --print-resource-dir`");
    assert!(output.status.success(), "`cc --print-resource-dir` failed");
    let resource_dir = String::from_utf8(output.stdout).expect("utf-8 resource dir");
    let runtime_dir = PathBuf::from(resource_dir.trim())
        .join("lib")
        .join("darwin");
    println!("cargo:rustc-link-search=native={}", runtime_dir.display());
    println!("cargo:rustc-link-lib=static=clang_rt.osx");
}

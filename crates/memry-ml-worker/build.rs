//! The worker ships next to the app on Windows, which links the VC runtime statically
//! (tauri-build's `staticVCRuntime`). The worker does the same, so no binary needs the VC++
//! redistributable.
//!
//! With the `ocr` feature it also builds Leptonica and Tesseract with cmake and links both
//! statically (#3542, R1): Tesseract reads untrusted images, so it runs only in this process. The
//! sources come from `scripts/fetch-tesseract-sources.mjs`, which pins them; cargo never fetches
//! them. They are built once per machine, target and [`BUILD_KEY`] under `<root>/build`, shared by
//! every checkout, and always in Release: Rust links the release C runtime in every profile.
//! Without the sources this warns and links nothing, so `cargo check` and clippy pass and a link
//! of the worker fails on the missing `TessBaseAPI*` symbols (as `memry-ml` without ONNX Runtime).

use std::path::{Path, PathBuf};

/// Bump when a cmake option below changes, so every machine and CI cache builds again.
const BUILD_KEY: &str = "b1";
const LEPTONICA: &str = "leptonica-1.87.0";
const TESSERACT: &str = "tesseract-5.5.2";

fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-env-changed=MEMRY_TESSERACT_DIR");
    let target_os = env("CARGO_CFG_TARGET_OS");
    let target_env = env("CARGO_CFG_TARGET_ENV");
    let msvc = target_os == "windows" && target_env == "msvc";
    if msvc {
        static_vcruntime::metabuild();
    }
    if std::env::var_os("CARGO_FEATURE_OCR").is_some() {
        tesseract(&target_os, msvc);
    }
}

fn env(name: &str) -> String {
    std::env::var(name).unwrap_or_default()
}

/// Keep in step with `defaultRoot` in `scripts/fetch-tesseract-sources.mjs`.
fn default_root() -> PathBuf {
    if let Some(dir) = std::env::var_os("MEMRY_TESSERACT_DIR") {
        return PathBuf::from(dir);
    }
    let home = || PathBuf::from(std::env::var_os("HOME").unwrap_or_default());
    if cfg!(windows) {
        std::env::var_os("LOCALAPPDATA")
            .map_or_else(
                || PathBuf::from(env("USERPROFILE")).join("AppData/Local"),
                PathBuf::from,
            )
            .join("memry-tesseract")
    } else if cfg!(target_os = "macos") {
        home().join("Library/Caches/memry-tesseract")
    } else {
        std::env::var_os("XDG_CACHE_HOME")
            .map_or_else(|| home().join(".cache"), PathBuf::from)
            .join("memry-tesseract")
    }
}

fn tesseract(target_os: &str, msvc: bool) {
    let root = default_root();
    let src = root.join("src");
    let pins: Vec<String> = [LEPTONICA, TESSERACT]
        .iter()
        .filter_map(|name| {
            let pin = src.join(name).join(".pin");
            println!("cargo:rerun-if-changed={}", pin.display());
            std::fs::read_to_string(pin).ok()
        })
        .collect();
    if pins.len() != 2 {
        println!(
            "cargo:warning=The Tesseract sources are missing under {}: run `node scripts/fetch-tesseract-sources.mjs`. memry-ml-worker will not link.",
            src.display()
        );
        return;
    }
    let deployment = (target_os == "macos")
        .then(|| std::env::var("MACOSX_DEPLOYMENT_TARGET").unwrap_or_else(|_| "11.0".into()));
    println!("cargo:rerun-if-env-changed=MACOSX_DEPLOYMENT_TARGET");
    let key = format!(
        "{}-{BUILD_KEY}-{}-{}{}",
        env("TARGET"),
        &pins[0][..12],
        &pins[1][..12],
        deployment
            .as_deref()
            .map_or(String::new(), |d| format!("-macos{d}"))
    );
    let build = root.join("build").join(&key);
    let done = build.join(".done");
    if !done.is_file() {
        std::fs::create_dir_all(root.join("build")).expect("create the Tesseract build dir");
        // Two checkouts building the same key at once wait for each other.
        let lock = std::fs::File::create(root.join("build").join(format!("{key}.lock")))
            .expect("create the Tesseract build lock");
        lock.lock().expect("lock the Tesseract build");
        if !done.is_file() {
            let _ = std::fs::remove_dir_all(&build);
            let leptonica = cmake_config(
                &src.join(LEPTONICA),
                &build.join("leptonica"),
                msvc,
                &deployment,
            )
            .define("BUILD_PROG", "OFF")
            .define("SW_BUILD", "OFF")
            .define("ENABLE_ZLIB", "OFF")
            .define("ENABLE_PNG", "OFF")
            .define("ENABLE_GIF", "OFF")
            .define("ENABLE_JPEG", "OFF")
            .define("ENABLE_TIFF", "OFF")
            .define("ENABLE_WEBP", "OFF")
            .define("ENABLE_OPENJPEG", "OFF")
            .build();
            cmake_config(
                &src.join(TESSERACT),
                &build.join("tesseract"),
                msvc,
                &deployment,
            )
            .define("CMAKE_PREFIX_PATH", &leptonica)
            .define("SW_BUILD", "OFF")
            .define("WIN32_MT_BUILD", "ON")
            .define("OPENMP_BUILD", "OFF")
            .define("GRAPHICS_DISABLED", "ON")
            // The legacy engine stays compiled (5.5.2 does not build without it); the app reads
            // with OEM 1 (LSTM only).
            .define("DISABLED_LEGACY_ENGINE", "OFF")
            .define("ENABLE_NATIVE", "OFF")
            .define("ENABLE_LTO", "OFF")
            .define("ENABLE_CCACHE", "OFF")
            .define("BUILD_TRAINING_TOOLS", "OFF")
            .define("BUILD_TESTS", "OFF")
            .define("DISABLE_TIFF", "ON")
            .define("DISABLE_ARCHIVE", "ON")
            .define("DISABLE_CURL", "ON")
            .define("INSTALL_CONFIGS", "OFF")
            .build();
            std::fs::write(&done, "").expect("mark the Tesseract build done");
        }
    }
    let leptonica = link(&build.join("leptonica/lib"), "leptonica");
    let tesseract = link(&build.join("tesseract/lib"), "tesseract");
    // Tesseract first: it needs Leptonica's symbols.
    println!("cargo:rustc-link-lib=static={tesseract}");
    println!("cargo:rustc-link-lib=static={leptonica}");
    match target_os {
        "macos" => println!("cargo:rustc-link-lib=c++"),
        "linux" => println!("cargo:rustc-link-lib=stdc++"),
        _ => {}
    }
}

fn cmake_config(src: &Path, out: &Path, msvc: bool, deployment: &Option<String>) -> cmake::Config {
    let mut config = cmake::Config::new(src);
    config
        .out_dir(out)
        .profile("Release")
        .define("BUILD_SHARED_LIBS", "OFF")
        .define("CMAKE_INSTALL_LIBDIR", "lib")
        .define("CMAKE_POSITION_INDEPENDENT_CODE", "ON")
        .define("CMAKE_POLICY_VERSION_MINIMUM", "3.5");
    if msvc {
        // The worker links the static VC runtime (`static_vcruntime` above); objects built for the
        // DLL runtime would not link into it.
        config
            .static_crt(true)
            .define("CMAKE_POLICY_DEFAULT_CMP0091", "NEW")
            .define("CMAKE_MSVC_RUNTIME_LIBRARY", "MultiThreaded");
    }
    if let Some(deployment) = deployment {
        config.define("CMAKE_OSX_DEPLOYMENT_TARGET", deployment);
    }
    config
}

/// The static library in `dir` whose name starts with `stem` (MSVC adds the version, as in
/// `leptonica-1.87.0.lib` and `tesseract55.lib`), as a `rustc-link-lib` name.
fn link(dir: &Path, stem: &str) -> String {
    println!("cargo:rustc-link-search=native={}", dir.display());
    let names = std::fs::read_dir(dir)
        .unwrap_or_else(|error| panic!("{}: {error}", dir.display()))
        .filter_map(|entry| entry.ok()?.file_name().into_string().ok());
    for name in names {
        let base = name
            .strip_suffix(".lib")
            .or_else(|| name.strip_suffix(".a").and_then(|n| n.strip_prefix("lib")));
        if let Some(base) = base.filter(|base| base.starts_with(stem)) {
            return base.to_owned();
        }
    }
    panic!("no {stem} library in {}", dir.display());
}

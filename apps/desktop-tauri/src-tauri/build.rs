use std::path::Path;

#[path = "build_env.rs"]
mod build_env;

fn main() {
    let manifest_dir = std::env::var("CARGO_MANIFEST_DIR").expect("cargo sets CARGO_MANIFEST_DIR");
    let manifest_dir = Path::new(&manifest_dir);

    // The directory that holds `apps/desktop-tauri/package.json`. An unpackaged `dev` device
    // hashes it into its profile identifier, the way Electron hashes `app.getAppPath()`.
    let checkout_dir = manifest_dir
        .parent()
        .expect("src-tauri sits inside apps/desktop-tauri");
    println!(
        "cargo:rustc-env=MEMRY_CHECKOUT_DIR={}",
        checkout_dir.display()
    );

    // `tauri::generate_context!` embeds `build.frontendDist` and fails when it is missing. A
    // plain `cargo clippy` or `cargo test` has not built the renderer, so make the directory
    // exist; `tauri build` fills it through `beforeBuildCommand` before this runs.
    let dist = checkout_dir.join("dist").join("renderer");
    std::fs::create_dir_all(&dist).expect("create the renderer output directory");

    // Test executables link the whole Tauri runtime, which needs Common Controls v6 on Windows.
    // `tauri_build` embeds that manifest in the app binary only, so a test executable would
    // exit with STATUS_ENTRYPOINT_NOT_FOUND. Embed the same dependency in the test targets.
    // `-tests` reaches `tests/*.rs` only; Cargo has no link arg for the lib's unit tests, so a
    // test that links the runtime (`tauri::test::mock_app`) lives under `tests/`.
    let target_os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    let target_env = std::env::var("CARGO_CFG_TARGET_ENV").unwrap_or_default();
    if target_os == "windows" && target_env == "msvc" {
        let manifest = manifest_dir.join("windows-test.manifest");
        println!("cargo:rerun-if-changed={}", manifest.display());
        println!("cargo:rustc-link-arg-tests=/MANIFEST:EMBED");
        println!(
            "cargo:rustc-link-arg-tests=/MANIFESTINPUT:{}",
            manifest.display()
        );
    }

    compile_runtime_config(checkout_dir);

    // Rehearsal builds bake their feed in (`updater/velopack_backend.rs`, `option_env!`).
    println!("cargo:rerun-if-env-changed={}", build_env::UPDATE_FEED);

    tauri_build::build();
}

/// Compiles the sync server URL and the client ids into the binary (`memry_desktop::config`).
fn compile_runtime_config(checkout_dir: &Path) {
    for name in build_env::NAMES.iter().chain(["MEMRY_ENV"].iter()) {
        println!("cargo:rerun-if-env-changed={name}");
    }
    println!("cargo:rerun-if-env-changed=PROFILE");
    let process_env = |name: &str| std::env::var(name).ok();
    let env_file = |env: &str| {
        let path = checkout_dir.join(format!(".env.{env}"));
        println!("cargo:rerun-if-changed={}", path.display());
        std::fs::read_to_string(path).ok()
    };
    let profile = std::env::var("PROFILE").unwrap_or_default();
    let inputs = build_env::Inputs {
        profile: &profile,
        e2e: std::env::var_os("CARGO_FEATURE_E2E").is_some(),
        process_env: &process_env,
        env_file: &env_file,
    };
    match build_env::resolve(&inputs) {
        Ok(pairs) => {
            for (name, value) in pairs {
                println!("cargo:rustc-env={name}={value}");
            }
        }
        Err(message) => {
            println!("cargo:warning={message}");
            panic!("{message}");
        }
    }
}

use std::path::Path;

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

    tauri_build::build();
}

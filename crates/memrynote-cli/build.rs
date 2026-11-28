use std::path::Path;

fn main() {
    let manifest_dir = std::env::var("CARGO_MANIFEST_DIR").expect("cargo sets CARGO_MANIFEST_DIR");
    // `apps/desktop-tauri`: the directory memry-tauri's build script hashes into the profile
    // identifier of an unpackaged `dev` device. Built from the same parts, so the hash agrees.
    let checkout_dir = Path::new(&manifest_dir)
        .parent()
        .and_then(Path::parent)
        .expect("crates/memrynote-cli sits two levels below the repo root")
        .join("apps")
        .join("desktop-tauri");
    println!(
        "cargo:rustc-env=MEMRY_CHECKOUT_DIR={}",
        checkout_dir.display()
    );

    // The app's bundle identifier, read from the file Tauri builds the app with, so the command
    // line and the app resolve one app data folder and cannot drift apart.
    let conf = checkout_dir.join("src-tauri").join("tauri.conf.json");
    println!("cargo:rerun-if-changed={}", conf.display());
    let text = std::fs::read_to_string(&conf).expect("read tauri.conf.json");
    let json: serde_json::Value = serde_json::from_str(&text).expect("parse tauri.conf.json");
    let identifier = json["identifier"]
        .as_str()
        .expect("tauri.conf.json names an identifier");
    println!("cargo:rustc-env=MEMRYNOTE_BASE_IDENTIFIER={identifier}");
}

use memry_tauri::registry;
use specta_typescript::Typescript;

fn export() -> String {
    let dir = tempfile::tempdir().expect("temp dir");
    let path = dir.path().join("bindings.ts");
    registry::builder()
        .export(Typescript::default(), &path)
        .expect("export bindings");
    std::fs::read_to_string(&path).expect("read bindings")
}

#[test]
fn bindings_export_app_info_and_command_error() {
    let ts = export();
    assert!(ts.contains("appInfo"), "bindings were: {ts}");
    assert!(ts.contains("export type CommandError"));
    assert!(ts.contains("export type StartupState"));
}

#[test]
fn error_kind_has_exactly_fourteen_variants() {
    let ts = export();
    let line = ts
        .lines()
        .find(|l| l.starts_with("export type ErrorKind"))
        .expect("ErrorKind is exported");
    let variants: Vec<&str> = line
        .split('=')
        .nth(1)
        .expect("union")
        .trim_end_matches(';')
        .split('|')
        .map(str::trim)
        .collect();
    assert_eq!(variants.len(), 14, "variants: {variants:?}");
    for expected in [
        "storage",
        "propertyWrite",
        "secureStore",
        "notFound",
        "internal",
    ] {
        assert!(variants.contains(&format!("\"{expected}\"").as_str()));
    }
}

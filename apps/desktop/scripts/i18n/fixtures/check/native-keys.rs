// The Tauri shell names its copy with full `ns:key` literals.
fn copy(locale: &str) -> (String, String) {
    (
        text(locale, "system:startup.failed.title"),
        text(locale, "system:startup.noSuchKey"),
    )
}

//! Flat local keys stored as bare text, the way Electron's `setSetting` writes them.

use super::failed;
use super::tests::open;

/// Electron's bare `ai.summarizeAgent` text is not JSON: the text accessors read and write it as
/// stored, where the JSON read sees nothing.
#[test]
fn local_text_reads_and_writes_electrons_bare_rows() {
    let (app, _dir) = open("ai-agent-text");
    assert_eq!(app.get_local_text("ai.summarizeAgent").expect("read"), None);
    app.db
        .call_blocking(|conn| {
            conn.execute(
                "INSERT INTO local_settings (key, value, updated_at) VALUES ('ai.summarizeAgent', 'codex_cli', 0)",
                [],
            )
            .map_err(failed)
        })
        .expect("seed");
    assert_eq!(
        app.get_local_text("ai.summarizeAgent")
            .expect("read")
            .as_deref(),
        Some("codex_cli")
    );
    assert_eq!(app.get_local("ai.summarizeAgent").expect("read"), None);

    app.set_local_text("ai.summarizeAgent", "local_openai_compatible")
        .expect("write");
    let stored: String = app
        .db
        .read_blocking(|conn| {
            conn.query_row(
                "SELECT value FROM local_settings WHERE key = 'ai.summarizeAgent'",
                [],
                |row| row.get(0),
            )
            .map_err(failed)
        })
        .expect("row");
    assert_eq!(stored, "local_openai_compatible");
    assert!(app.set_local_text("bad key", "x").is_err());
}

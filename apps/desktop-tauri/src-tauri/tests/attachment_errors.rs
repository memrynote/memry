//! `attachment_error`, the answer and log line an attachment command gives a refused or failed
//! write (#3531 14f-2b-b). A mock app test lives here, not in the lib's unit tests: the lib test
//! exe has no Common Controls v6 manifest on Windows (#3842).

use std::io::Write;
use std::sync::{Arc, Mutex};

use memry_desktop::attachments::AttachmentError;
use memry_desktop::locale::LocaleService;
use memry_tauri::commands::attachments::attachment_error;
use tauri::Manager;
use tauri::test::mock_app;
use tracing_subscriber::fmt::MakeWriter;

#[derive(Clone, Default)]
struct Logged(Arc<Mutex<Vec<u8>>>);

impl Write for Logged {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .extend_from_slice(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

impl MakeWriter<'_> for Logged {
    type Writer = Self;

    fn make_writer(&self) -> Self {
        self.clone()
    }
}

/// A disk failure's log line names the command that hit it, a rename as a rename.
#[test]
fn a_disk_failure_is_logged_with_its_command() {
    let app = mock_app();
    app.manage(Arc::new(LocaleService::new("en")));
    let logged = Logged::default();
    let subscriber = tracing_subscriber::fmt()
        .with_writer(logged.clone())
        .with_ansi(false)
        .finish();
    tracing::subscriber::with_default(subscriber, || {
        tracing::callsite::rebuild_interest_cache();
        let answer = attachment_error(
            app.handle(),
            "notes_attachment_rename",
            &AttachmentError::NotAFolder,
        );
        assert_eq!(answer.code, "attachment_write_failed");
    });
    let text = String::from_utf8(logged.0.lock().unwrap().clone()).unwrap();
    assert!(
        text.contains("notes_attachment_rename failed on disk"),
        "{text}"
    );
}

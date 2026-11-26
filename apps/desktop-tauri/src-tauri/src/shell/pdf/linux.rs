//! WebKitGTK: a `PrintOperation` sent to GTK's file printer, with no dialog (`print`, not
//! `run_dialog`).

use std::cell::RefCell;
use std::path::Path;
use std::rc::Rc;

use gtk::glib;
use gtk::{PageOrientation, PageSetup, PaperSize, PrintSettings, Unit};
use tauri::webview::PlatformWebview;
use webkit2gtk::{PrintOperation, PrintOperationExt, SettingsExt, WebViewExt};

use super::{Done, MARGIN_INCHES, Paper};

/// The answer channel and the operation it waits on, taken once by whichever answers first.
type Pending = Rc<RefCell<Option<(Done, Option<PrintOperation>)>>>;

pub fn start(webview: &PlatformWebview, paper: Paper, target: &Path, done: Done) {
    // The operation is held here until it answers, so it outlives this call.
    let pending: Pending = Rc::new(RefCell::new(Some((done, None))));
    let answer = {
        let pending = Rc::clone(&pending);
        move |outcome: Result<(), String>| {
            if let Some((done, _operation)) = pending.borrow_mut().take() {
                let _ = done.send(outcome);
            }
        }
    };
    let uri = match glib::filename_to_uri(target, None) {
        Ok(uri) => uri,
        Err(error) => return answer(Err(error.to_string())),
    };
    let view = webview.inner();
    if let Some(settings) = WebViewExt::settings(&view) {
        settings.set_print_backgrounds(true);
    }

    let settings = PrintSettings::new();
    // GTK names its file printer in the user's language (`gtk30` domain).
    settings.set_printer(&glib::dgettext(Some("gtk30"), "Print to File"));
    settings.set("output-file-format", Some("pdf"));
    settings.set("output-uri", Some(&uri));
    let setup = PageSetup::new();
    setup.set_paper_size(&PaperSize::new(Some(paper.pwg_name())));
    setup.set_orientation(PageOrientation::Portrait);
    setup.set_top_margin(MARGIN_INCHES, Unit::Inch);
    setup.set_bottom_margin(MARGIN_INCHES, Unit::Inch);
    setup.set_left_margin(MARGIN_INCHES, Unit::Inch);
    setup.set_right_margin(MARGIN_INCHES, Unit::Inch);

    let operation = PrintOperation::builder().web_view(&view).build();
    operation.set_print_settings(&settings);
    operation.set_page_setup(&setup);
    // `failed` comes before `finished`; the first answer wins.
    let failed = answer.clone();
    operation.connect_failed(move |_, error| failed(Err(error.to_string())));
    operation.connect_finished(move |_| answer(Ok(())));
    if let Some((_, held)) = pending.borrow_mut().as_mut() {
        *held = Some(operation.clone());
    }
    operation.print();
}

//! WKWebView: `printOperationWithPrintInfo:` saved to a file, with no panel.
//! `createPDFWithConfiguration` would give one unpaginated page, so it is not used.

use std::ffi::c_void;
use std::path::Path;

use objc2::rc::Retained;
use objc2::runtime::{AnyObject, Bool, NSObject};
use objc2::{AnyThread, define_class, msg_send, sel};
use objc2_app_kit::{
    NSPaperOrientation, NSPrintInfo, NSPrintJobSavingURL, NSPrintOperation, NSPrintSaveJob,
    NSPrintingPaginationMode, NSWindow,
};
use objc2_foundation::{NSCopying, NSPoint, NSSize, NSString, NSURL};
use objc2_web_kit::WKWebView;
use tauri::webview::PlatformWebview;

use super::{Done, MARGIN_INCHES, Paper};

define_class!(
    // SAFETY: NSObject has no subclassing requirements, and the class implements no `Drop`.
    #[unsafe(super(NSObject))]
    #[name = "MemryPdfPrintDelegate"]
    struct Delegate;

    impl Delegate {
        /// `didRunSelector` of `runOperationModalForWindow:`; `context` is the `Done` that
        /// [`start`] boxed for this operation.
        #[unsafe(method(printOperationDidRun:success:contextInfo:))]
        fn did_run(&self, _operation: &NSPrintOperation, success: Bool, context: *mut c_void) {
            // SAFETY: `start` passes a `Box<Done>` it leaked, and AppKit calls this once per
            // operation.
            let done = unsafe { Box::from_raw(context.cast::<Done>()) };
            let _ = done.send(if success.as_bool() {
                Ok(())
            } else {
                Err("the print operation did not finish".to_owned())
            });
        }
    }
);

thread_local! {
    /// One delegate for every operation: it keeps no state, and AppKit does not retain it.
    static DELEGATE: Retained<Delegate> = unsafe { msg_send![Delegate::alloc(), init] };
}

pub fn prepare(webview: &PlatformWebview) {
    // SAFETY: the print window's live NSWindow, on the main thread `with_webview` runs on.
    let window: &NSWindow = unsafe { &*webview.ns_window().cast() };
    window.setIgnoresMouseEvents(true);
    window.setFrameOrigin(NSPoint::new(-20_000.0, -20_000.0));
    window.orderBack(None);
}

pub fn start(webview: &PlatformWebview, paper: Paper, target: &Path, done: Done) {
    // SAFETY: `inner()` and `ns_window()` are the print window's live WKWebView and NSWindow, used
    // on the main thread that `with_webview` runs on.
    let view: &WKWebView = unsafe { &*webview.inner().cast() };
    let window: &NSWindow = unsafe { &*webview.ns_window().cast() };

    let info = NSPrintInfo::sharedPrintInfo().copy();
    let (width, height) = paper.points();
    let margin = MARGIN_INCHES * 72.0;
    info.setPaperSize(NSSize::new(width, height));
    info.setOrientation(NSPaperOrientation::Portrait);
    info.setScalingFactor(1.0);
    info.setTopMargin(margin);
    info.setBottomMargin(margin);
    info.setLeftMargin(margin);
    info.setRightMargin(margin);
    info.setHorizontalPagination(NSPrintingPaginationMode::Automatic);
    info.setVerticalPagination(NSPrintingPaginationMode::Automatic);
    info.setHorizontallyCentered(false);
    info.setVerticallyCentered(false);
    let url = NSURL::fileURLWithPath(&NSString::from_str(&target.to_string_lossy()));
    // SAFETY: `NSPrintJobSavingURL` takes an NSURL, and `NSPrintSaveJob` is a disposition value.
    unsafe {
        info.setJobDisposition(NSPrintSaveJob);
        let saving: &AnyObject = &url;
        info.dictionary().insert(NSPrintJobSavingURL, saving);
    }

    // SAFETY: the print info is a configured copy, owned here.
    let operation = unsafe { view.printOperationWithPrintInfo(&info) };
    operation.setShowsPrintPanel(false);
    operation.setShowsProgressPanel(false);
    if let Some(printed) = operation.view() {
        printed.setFrame(view.bounds());
    }
    let context = Box::into_raw(Box::new(done)).cast::<c_void>();
    DELEGATE.with(|delegate| {
        let delegate: &AnyObject = delegate;
        // SAFETY: the selector matches `Delegate::did_run`, which takes back `context`.
        unsafe {
            operation.runOperationModalForWindow_delegate_didRunSelector_contextInfo(
                window,
                Some(delegate),
                Some(sel!(printOperationDidRun:success:contextInfo:)),
                context,
            );
        }
    });
}

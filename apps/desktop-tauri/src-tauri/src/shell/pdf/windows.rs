//! WebView2: `ICoreWebView2_7::PrintToPdf` with print settings from the environment, in a
//! webview whose requests and frame navigations are held to its page.

use std::path::Path;
use std::sync::{Arc, Mutex, PoisonError};

use tauri::webview::PlatformWebview;
use url::Url;
use webview2_com::Microsoft::Web::WebView2::Win32::{
    COREWEBVIEW2_PRINT_ORIENTATION_PORTRAIT, COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL,
    COREWEBVIEW2_WEB_RESOURCE_REQUEST_SOURCE_KINDS_ALL, ICoreWebView2_7, ICoreWebView2_22,
    ICoreWebView2Environment6,
};
use webview2_com::{
    NavigationStartingEventHandler, PrintToPdfCompletedHandler, WebResourceRequestedEventHandler,
    take_pwstr,
};
use windows_core::{HSTRING, Interface, PWSTR};

use super::{Done, MARGIN_INCHES, Paper, may_load};

/// The status a refused request is answered with: a navigation that gets `204 No Content` does
/// not commit, so the page stays the note.
const REFUSED: i32 = 204;

fn allows(raw: &str, page: &Url) -> bool {
    Url::parse(raw).is_ok_and(|to| may_load(&to, page))
}

/// Holds `webview` to `page`: every request from any of its documents, frames or workers that
/// [`may_load`] refuses gets an empty `204`, and every frame navigation it refuses is cancelled.
/// wry's `NavigationStarting` handler (`on_navigation`) sees the main frame only, and a cancel
/// there did not keep a `<meta http-equiv="refresh">` off the network. wry's custom-protocol
/// handler still serves the page, which this lets through.
pub fn guard(webview: &PlatformWebview, page: &Url) -> Result<(), String> {
    let env = webview.environment();
    let requests = page.clone();
    let frames = page.clone();
    // SAFETY: the controller, its core and the environment are live COM objects owned by the
    // print window's webview, used on the main thread that `with_webview` runs on.
    let guarded = unsafe {
        (|| -> windows_core::Result<()> {
            let core = webview.controller().CoreWebView2()?;
            let filter = HSTRING::from("*");
            match core.cast::<ICoreWebView2_22>() {
                Ok(core) => core.AddWebResourceRequestedFilterWithRequestSourceKinds(
                    &filter,
                    COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL,
                    COREWEBVIEW2_WEB_RESOURCE_REQUEST_SOURCE_KINDS_ALL,
                )?,
                Err(_) => core.AddWebResourceRequestedFilter(
                    &filter,
                    COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL,
                )?,
            }
            let mut token = 0_i64;
            core.add_WebResourceRequested(
                &WebResourceRequestedEventHandler::create(Box::new(move |_, args| {
                    let Some(args) = args else { return Ok(()) };
                    let mut uri = PWSTR::null();
                    args.Request()?.Uri(&mut uri)?;
                    if !allows(&take_pwstr(uri), &requests) {
                        let refused = env.CreateWebResourceResponse(
                            None,
                            REFUSED,
                            &HSTRING::from("No Content"),
                            &HSTRING::new(),
                        )?;
                        args.SetResponse(&refused)?;
                    }
                    Ok(())
                })),
                &mut token,
            )?;
            core.add_FrameNavigationStarting(
                &NavigationStartingEventHandler::create(Box::new(move |_, args| {
                    let Some(args) = args else { return Ok(()) };
                    let mut uri = PWSTR::null();
                    args.Uri(&mut uri)?;
                    args.SetCancel(!allows(&take_pwstr(uri), &frames))
                })),
                &mut token,
            )
        })()
    };
    guarded.map_err(|error| error.to_string())
}

pub fn start(webview: &PlatformWebview, paper: Paper, target: &Path, done: Done) {
    let done = Arc::new(Mutex::new(Some(done)));
    let answer = {
        let done = Arc::clone(&done);
        move |outcome: Result<(), String>| {
            if let Some(done) = done.lock().unwrap_or_else(PoisonError::into_inner).take() {
                let _ = done.send(outcome);
            }
        }
    };
    let finish = answer.clone();
    let handler = PrintToPdfCompletedHandler::create(Box::new(move |result, ok| {
        finish(match result {
            Err(error) => Err(error.to_string()),
            // webview2-com hands the `BOOL` over as `bool` (`ClosureArg for BOOL`).
            Ok(()) if ok => Ok(()),
            Ok(()) => Err("WebView2 did not write the PDF".to_owned()),
        });
        Ok(())
    }));
    let (width, height) = paper.inches();
    // SAFETY: the environment and controller are live COM objects owned by the print window's
    // webview, used on the main thread that `with_webview` runs on.
    let started = unsafe {
        (|| -> windows_core::Result<()> {
            let settings = webview
                .environment()
                .cast::<ICoreWebView2Environment6>()?
                .CreatePrintSettings()?;
            settings.SetOrientation(COREWEBVIEW2_PRINT_ORIENTATION_PORTRAIT)?;
            settings.SetPageWidth(width)?;
            settings.SetPageHeight(height)?;
            settings.SetMarginTop(MARGIN_INCHES)?;
            settings.SetMarginBottom(MARGIN_INCHES)?;
            settings.SetMarginLeft(MARGIN_INCHES)?;
            settings.SetMarginRight(MARGIN_INCHES)?;
            settings.SetScaleFactor(1.0)?;
            settings.SetShouldPrintBackgrounds(true)?;
            settings.SetShouldPrintHeaderAndFooter(false)?;
            settings.SetShouldPrintSelectionOnly(false)?;
            let core = webview
                .controller()
                .CoreWebView2()?
                .cast::<ICoreWebView2_7>()?;
            core.PrintToPdf(&HSTRING::from(target.as_os_str()), &settings, &handler)
        })()
    };
    if let Err(error) = started {
        answer(Err(error.to_string()));
    }
}

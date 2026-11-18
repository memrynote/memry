//! WebView2: `ICoreWebView2_7::PrintToPdf` with print settings from the environment.

use std::path::Path;
use std::sync::{Arc, Mutex, PoisonError};

use tauri::webview::PlatformWebview;
use webview2_com::Microsoft::Web::WebView2::Win32::{
    COREWEBVIEW2_PRINT_ORIENTATION_PORTRAIT, ICoreWebView2_7, ICoreWebView2Environment6,
};
use webview2_com::PrintToPdfCompletedHandler;
use windows_core::{HSTRING, Interface};

use super::{Done, MARGIN_INCHES, Paper};

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
            Ok(()) if ok.as_bool() => Ok(()),
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

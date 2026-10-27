//! Deny-by-default web permissions on the engines that ask. The decision is
//! `memry_desktop::shell::permissions`; this file maps each engine's request to it.
//!
//! - Windows: `ICoreWebView2::add_PermissionRequested`. Every request is answered, allow or
//!   deny, so none reaches WebView2's own prompt.
//! - Linux: WebKitGTK's `permission-request`. Audio-only user media and notifications for a
//!   trusted origin are allowed; everything else is denied.
//! - macOS: WKWebView grants media capture through wry. The app's Info.plist names the
//!   microphone, and the page's origin is the app's own, so there is nothing to install.

#[cfg(any(windows, target_os = "linux"))]
use memry_desktop::shell::permissions::{Permission, allowed};
use tauri::{WebviewWindow, Wry};

/// The dev server's origin in a `tauri dev` run, `None` in a packaged or plain debug build.
pub fn dev_origin(app: &tauri::AppHandle<Wry>) -> Option<String> {
    if !tauri::is_dev() {
        return None;
    }
    let url = app.config().build.dev_url.as_ref()?;
    Some(url.origin().ascii_serialization())
}

#[cfg(any(windows, target_os = "linux"))]
fn log_denied(permission: Permission, origin: Option<&str>) {
    tracing::warn!(
        scope = "Permissions",
        ?permission,
        ?origin,
        "denied a web permission request"
    );
}

/// Installs the permission handler on `window`.
pub fn install(window: &WebviewWindow<Wry>, dev_origin: Option<String>) {
    #[cfg(windows)]
    windows_impl::install(window, dev_origin);
    #[cfg(target_os = "linux")]
    linux_impl::install(window, dev_origin);
    #[cfg(target_os = "macos")]
    {
        let _ = (window, dev_origin);
    }
}

#[cfg(windows)]
mod windows_impl {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        COREWEBVIEW2_PERMISSION_KIND, COREWEBVIEW2_PERMISSION_KIND_CAMERA,
        COREWEBVIEW2_PERMISSION_KIND_CLIPBOARD_READ, COREWEBVIEW2_PERMISSION_KIND_MICROPHONE,
        COREWEBVIEW2_PERMISSION_KIND_NOTIFICATIONS, COREWEBVIEW2_PERMISSION_STATE_ALLOW,
        COREWEBVIEW2_PERMISSION_STATE_DENY,
    };
    use webview2_com::{PermissionRequestedEventHandler, take_pwstr};
    use windows::core::PWSTR;

    use super::{Permission, WebviewWindow, Wry, allowed, log_denied};

    fn permission_of(kind: COREWEBVIEW2_PERMISSION_KIND) -> Permission {
        match kind {
            COREWEBVIEW2_PERMISSION_KIND_MICROPHONE => Permission::Media {
                audio: true,
                video: false,
            },
            COREWEBVIEW2_PERMISSION_KIND_CAMERA => Permission::Media {
                audio: false,
                video: true,
            },
            COREWEBVIEW2_PERMISSION_KIND_CLIPBOARD_READ => Permission::ClipboardRead,
            COREWEBVIEW2_PERMISSION_KIND_NOTIFICATIONS => Permission::Notifications,
            _ => Permission::Other,
        }
    }

    pub fn install(window: &WebviewWindow<Wry>, dev_origin: Option<String>) {
        let result = window.with_webview(move |webview| {
            let handler = PermissionRequestedEventHandler::create(Box::new(move |_, args| {
                let Some(args) = args else { return Ok(()) };
                // SAFETY: `args` is the live event argument of this callback, on the UI thread.
                unsafe {
                    let mut uri = PWSTR::null();
                    args.Uri(&mut uri)?;
                    let origin = take_pwstr(uri);
                    let mut kind = COREWEBVIEW2_PERMISSION_KIND::default();
                    args.PermissionKind(&mut kind)?;
                    let permission = permission_of(kind);
                    let ok = allowed(permission, Some(&origin), dev_origin.as_deref());
                    if !ok {
                        log_denied(permission, Some(&origin));
                    }
                    args.SetState(if ok {
                        COREWEBVIEW2_PERMISSION_STATE_ALLOW
                    } else {
                        COREWEBVIEW2_PERMISSION_STATE_DENY
                    })
                }
            }));
            let mut token = 0i64;
            // SAFETY: the controller is alive for this closure, which runs on the UI thread.
            let added = unsafe {
                webview
                    .controller()
                    .CoreWebView2()
                    .and_then(|core| core.add_PermissionRequested(&handler, &mut token))
            };
            if let Err(error) = added {
                // Without the handler WebView2 shows its own prompt: say so.
                tracing::error!(
                    scope = "Permissions",
                    "the permission handler was not installed: {error}"
                );
            }
        });
        if let Err(error) = result {
            tracing::error!(
                scope = "Permissions",
                "the webview was not reached: {error}"
            );
        }
    }
}

#[cfg(target_os = "linux")]
mod linux_impl {
    use webkit2gtk::glib::prelude::Cast;
    use webkit2gtk::{
        NotificationPermissionRequest, PermissionRequestExt, UserMediaPermissionRequest,
        UserMediaPermissionRequestExt, WebViewExt,
    };

    use super::{Permission, WebviewWindow, Wry, allowed, log_denied};

    pub fn install(window: &WebviewWindow<Wry>, dev_origin: Option<String>) {
        let result = window.with_webview(move |webview| {
            webview
                .inner()
                .connect_permission_request(move |view, request| {
                    let origin = view.uri().map(|uri| uri.to_string());
                    let permission =
                        if let Some(media) = request.downcast_ref::<UserMediaPermissionRequest>() {
                            Permission::Media {
                                audio: media.is_for_audio_device(),
                                video: media.is_for_video_device(),
                            }
                        } else if request.is::<NotificationPermissionRequest>() {
                            Permission::Notifications
                        } else {
                            Permission::Other
                        };
                    if allowed(permission, origin.as_deref(), dev_origin.as_deref()) {
                        request.allow();
                    } else {
                        log_denied(permission, origin.as_deref());
                        request.deny();
                    }
                    true
                });
        });
        if let Err(error) = result {
            tracing::error!(
                scope = "Permissions",
                "the webview was not reached: {error}"
            );
        }
    }
}

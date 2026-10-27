//! Back and forward from the trackpad. Windows browser keys arrive as `WM_APPCOMMAND` in
//! `win32_caption`; Linux relies on the renderer's mouse buttons 3 and 4 (WebKitGTK reports
//! buttons 8 and 9 as those).

use tauri::{AppHandle, Wry};

#[cfg(target_os = "macos")]
pub fn install(app: &AppHandle<Wry>) {
    use std::ptr::NonNull;

    use block2::RcBlock;
    use memry_desktop::shell::nav_input::swipe_direction;
    use objc2_app_kit::{NSEvent, NSEventMask};

    use super::MAIN_LABEL;
    use crate::events::{AppNavigationRequestedEvent, send_to};

    let app = app.clone();
    let handler = RcBlock::new(move |event: NonNull<NSEvent>| -> *mut NSEvent {
        // SAFETY: AppKit passes a live event for the duration of the block.
        let delta_x = unsafe { event.as_ref() }.deltaX();
        if let Some(direction) = swipe_direction(delta_x) {
            send_to(
                &app,
                MAIN_LABEL,
                AppNavigationRequestedEvent {
                    direction: direction.name().to_owned(),
                },
            );
        }
        event.as_ptr()
    });
    // SAFETY: the block returns the event it was given, a valid pointer. The monitor lives for
    // the process, so the returned token is not kept.
    let monitor = unsafe {
        NSEvent::addLocalMonitorForEventsMatchingMask_handler(NSEventMask::Swipe, &handler)
    };
    if monitor.is_none() {
        tracing::warn!(scope = "Window", "the swipe monitor was not installed");
    }
    std::mem::forget(handler);
}

#[cfg(not(target_os = "macos"))]
pub fn install(_app: &AppHandle<Wry>) {}

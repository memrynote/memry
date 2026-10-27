//! `NSWorkspace` notifications: the observers live for the whole process.

use std::ptr::NonNull;

use block2::RcBlock;
use memry_desktop::shell::power::PowerEvent;
use objc2_app_kit::{
    NSWorkspace, NSWorkspaceDidWakeNotification, NSWorkspaceWillPowerOffNotification,
    NSWorkspaceWillSleepNotification,
};
use objc2_foundation::NSNotification;
use tokio::sync::broadcast::Sender;

pub fn start(sender: &Sender<PowerEvent>) {
    let center = NSWorkspace::sharedWorkspace().notificationCenter();
    // SAFETY: the notification names are AppKit's constants.
    let names = unsafe {
        [
            (NSWorkspaceWillSleepNotification, PowerEvent::Suspend),
            (NSWorkspaceDidWakeNotification, PowerEvent::Resume),
            (
                NSWorkspaceWillPowerOffNotification,
                PowerEvent::SessionEnding,
            ),
        ]
    };
    for (name, event) in names {
        let sender = sender.clone();
        let block = RcBlock::new(move |_: NonNull<NSNotification>| {
            super::publish(&sender, event);
        });
        // SAFETY: no object filter and no queue (the block runs on the posting thread); the
        // block only sends on a broadcast channel, which is `Send`.
        let observer = unsafe {
            center.addObserverForName_object_queue_usingBlock(Some(name), None, None, &block)
        };
        // The center holds the observer by token: dropping it here would remove it.
        std::mem::forget(observer);
    }
}

/// Posts the notification AppKit posts for `event`, for the e2e commands.
#[cfg(feature = "e2e")]
pub fn post_workspace_notification(event: PowerEvent) {
    let center = NSWorkspace::sharedWorkspace().notificationCenter();
    // SAFETY: AppKit's notification names.
    let name = unsafe {
        match event {
            PowerEvent::Suspend => NSWorkspaceWillSleepNotification,
            PowerEvent::Resume => NSWorkspaceDidWakeNotification,
            PowerEvent::SessionEnding => NSWorkspaceWillPowerOffNotification,
        }
    };
    // SAFETY: a notification with no object or user info.
    unsafe { center.postNotificationName_object(name, None) };
}

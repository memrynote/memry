//! macOS notifications through `UNUserNotificationCenter`. The official plugin posts through the
//! deprecated `NSUserNotificationCenter`, and macOS refuses a legacy client for a bundle id that
//! already talked to the modern center, which the Electron app (Electron 42+) did for
//! `com.memrynote.memry`: the post "succeeds" and no banner shows. Like Electron, this asks for
//! permission at the first notification, shows banners while the app is in front, and withdraws a
//! delivered notification that a newer one with the same key replaces.
//!
//! The center exists only for an app bundle: in an unbundled binary (`tauri dev`, the e2e build)
//! `currentNotificationCenter` raises, so nothing here touches it there and every post fails
//! with [`UNBUNDLED`].

use std::ptr::NonNull;
use std::sync::{Mutex, OnceLock, PoisonError};

use block2::RcBlock;
use memry_desktop::shell::notifications::{id_from_platform_identifier, platform_identifier};
use objc2::rc::Retained;
use objc2::runtime::{Bool, ProtocolObject};
use objc2::{AnyThread, define_class, msg_send};
use objc2_foundation::{NSArray, NSBundle, NSError, NSObject, NSObjectProtocol, NSString};
use objc2_user_notifications::{
    UNAuthorizationOptions, UNAuthorizationStatus, UNMutableNotificationContent, UNNotification,
    UNNotificationDefaultActionIdentifier, UNNotificationPresentationOptions,
    UNNotificationRequest, UNNotificationResponse, UNNotificationSettings, UNNotificationSound,
    UNUserNotificationCenter, UNUserNotificationCenterDelegate,
};
use tauri::{AppHandle, Wry};
use tokio::sync::oneshot;

use super::NotificationPermission;

pub const UNBUNDLED: &str =
    "macOS shows notifications only for an app bundle, and this build runs unbundled";
const DENIED: &str =
    "notifications are turned off for MemryNote in System Settings > Notifications";

static APP: OnceLock<AppHandle<Wry>> = OnceLock::new();

/// Names this launch's notifications, so a click on one left in Notification Center by an
/// earlier launch is not taken for this launch's notification with the same number.
static LAUNCH: OnceLock<String> = OnceLock::new();

fn launch() -> &'static str {
    LAUNCH.get_or_init(|| {
        let millis = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |since| since.as_millis());
        format!("memry-{millis}")
    })
}

pub fn is_bundled() -> bool {
    NSBundle::mainBundle()
        .bundlePath()
        .to_string()
        .ends_with(".app")
}

define_class!(
    // SAFETY: NSObject has no subclassing requirements, and the class implements no `Drop`.
    #[unsafe(super(NSObject))]
    #[name = "MemryNotificationDelegate"]
    struct Delegate;

    unsafe impl NSObjectProtocol for Delegate {}

    unsafe impl UNUserNotificationCenterDelegate for Delegate {
        /// The app is in front: show the banner anyway, as Electron does.
        #[unsafe(method(userNotificationCenter:willPresentNotification:withCompletionHandler:))]
        fn will_present(
            &self,
            _center: &UNUserNotificationCenter,
            _notification: &UNNotification,
            completion_handler: &block2::DynBlock<dyn Fn(UNNotificationPresentationOptions)>,
        ) {
            completion_handler.call((UNNotificationPresentationOptions::Banner
                | UNNotificationPresentationOptions::List
                | UNNotificationPresentationOptions::Sound,));
        }

        #[unsafe(method(userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:))]
        fn did_receive(
            &self,
            _center: &UNUserNotificationCenter,
            response: &UNNotificationResponse,
            completion_handler: &block2::DynBlock<dyn Fn()>,
        ) {
            // SAFETY: a constant of the framework.
            let default_action = unsafe { UNNotificationDefaultActionIdentifier };
            if &*response.actionIdentifier() == default_action
                && let Some(app) = APP.get()
            {
                let identifier = response.notification().request().identifier().to_string();
                super::route_click(app, id_from_platform_identifier(launch(), &identifier));
            }
            completion_handler.call(());
        }
    }
);

/// Becomes the center's delegate before the app finishes launching, so a click that launched
/// the app is delivered too.
pub fn init(app: &AppHandle<Wry>) {
    let _ = APP.set(app.clone());
    if !is_bundled() {
        tracing::info!(scope = "Notifications", "{UNBUNDLED}");
        return;
    }
    let delegate: Retained<Delegate> = {
        let this = Delegate::alloc().set_ivars(());
        // SAFETY: NSObject's `init` on a freshly allocated instance.
        unsafe { msg_send![super(this), init] }
    };
    UNUserNotificationCenter::currentNotificationCenter()
        .setDelegate(Some(ProtocolObject::from_ref(&*delegate)));
    // The center holds its delegate weakly; this one lives as long as the process.
    std::mem::forget(delegate);
}

pub async fn permission() -> Result<NotificationPermission, String> {
    if !is_bundled() {
        return Ok(NotificationPermission::Denied);
    }
    Ok(match status().await? {
        UNAuthorizationStatus::NotDetermined => NotificationPermission::Prompt,
        UNAuthorizationStatus::Denied => NotificationPermission::Denied,
        _ => NotificationPermission::Granted,
    })
}

/// Posts notification `id`. Asks for permission first when the user was never asked, and waits
/// for the answer, so the first notification shows once the user allows it. Fails when the user
/// turned notifications off or macOS refuses the post.
pub async fn post(id: i32, title: String, body: String, silent: bool) -> Result<(), String> {
    if !is_bundled() {
        return Err(UNBUNDLED.to_owned());
    }
    let allowed = match status().await? {
        UNAuthorizationStatus::Denied => false,
        UNAuthorizationStatus::NotDetermined => request_authorization().await?,
        _ => true,
    };
    if !allowed {
        return Err(DENIED.to_owned());
    }
    add(&platform_identifier(launch(), id), &title, &body, silent).await
}

/// Takes delivered notifications out of Notification Center.
pub fn withdraw(ids: &[i32]) {
    if !is_bundled() {
        return;
    }
    let identifiers: Vec<Retained<NSString>> = ids
        .iter()
        .map(|id| NSString::from_str(&platform_identifier(launch(), *id)))
        .collect();
    UNUserNotificationCenter::currentNotificationCenter()
        .removeDeliveredNotificationsWithIdentifiers(&NSArray::from_retained_slice(&identifiers));
}

/// The first answer of a completion handler the framework may call on any thread. The blocks are
/// built and handed over in plain functions, so no future holds one across an await.
fn once<T: Send + 'static>() -> (impl Fn(T) + 'static, oneshot::Receiver<T>) {
    let (sender, receiver) = oneshot::channel();
    let sender = Mutex::new(Some(sender));
    let send = move |value| {
        if let Some(sender) = sender.lock().unwrap_or_else(PoisonError::into_inner).take() {
            let _ = sender.send(value);
        }
    };
    (send, receiver)
}

async fn answer<T>(receiver: oneshot::Receiver<T>) -> Result<T, String> {
    receiver
        .await
        .map_err(|_| "macOS did not answer the notification request".to_owned())
}

fn describe(error: *mut NSError) -> Option<String> {
    // SAFETY: the framework passes a valid error or null.
    unsafe { error.as_ref() }.map(|error| error.localizedDescription().to_string())
}

async fn status() -> Result<UNAuthorizationStatus, String> {
    let receiver = {
        let (send, receiver) = once();
        let block = RcBlock::new(move |settings: NonNull<UNNotificationSettings>| {
            // SAFETY: the framework passes live settings.
            send(unsafe { settings.as_ref() }.authorizationStatus());
        });
        UNUserNotificationCenter::currentNotificationCenter()
            .getNotificationSettingsWithCompletionHandler(&block);
        receiver
    };
    answer(receiver).await
}

/// macOS shows its prompt and answers once the user chose.
async fn request_authorization() -> Result<bool, String> {
    let receiver = {
        let (send, receiver) = once();
        let block = RcBlock::new(move |granted: Bool, error: *mut NSError| {
            send(describe(error).map_or(Ok(granted.as_bool()), Err));
        });
        UNUserNotificationCenter::currentNotificationCenter()
            .requestAuthorizationWithOptions_completionHandler(
                UNAuthorizationOptions::Alert
                    | UNAuthorizationOptions::Sound
                    | UNAuthorizationOptions::Badge,
                &block,
            );
        receiver
    };
    answer(receiver).await?
}

async fn add(identifier: &str, title: &str, body: &str, silent: bool) -> Result<(), String> {
    let receiver = {
        let content = UNMutableNotificationContent::new();
        content.setTitle(&NSString::from_str(title));
        content.setBody(&NSString::from_str(body));
        if !silent {
            content.setSound(Some(&UNNotificationSound::defaultSound()));
        }
        let request = UNNotificationRequest::requestWithIdentifier_content_trigger(
            &NSString::from_str(identifier),
            &content,
            None,
        );
        let (send, receiver) = once();
        let block = RcBlock::new(move |error: *mut NSError| send(describe(error)));
        UNUserNotificationCenter::currentNotificationCenter()
            .addNotificationRequest_withCompletionHandler(&request, Some(&block));
        receiver
    };
    match answer(receiver).await? {
        None => Ok(()),
        Some(error) => Err(error),
    }
}

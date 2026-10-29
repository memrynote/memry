//! macOS notifications through `UNUserNotificationCenter`. The official plugin posts through the
//! deprecated `NSUserNotificationCenter`, and macOS refuses a legacy client for a bundle id that
//! already talked to the modern center, which the Electron app (Electron 42+) did for
//! `com.memrynote.memry`: the post "succeeds" and no banner shows. Like Electron, this asks for
//! permission at the first notification and shows banners while the app is in front. A
//! notification shown again under the same key withdraws the earlier one, delivered or still on
//! its way. Each post gets its own identifier: macOS drops both requests when one replaces a
//! request with the same identifier that it is still processing.
//!
//! The center exists only for an app bundle: in an unbundled binary (`tauri dev`, the e2e build)
//! `currentNotificationCenter` raises, so nothing here touches it there and every post fails
//! with [`UNBUNDLED`].

use std::ptr::NonNull;
use std::sync::{Mutex, OnceLock, PoisonError};
use std::time::Duration;

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

/// Whether the process runs from an app bundle, the only place the center exists. A binary next
/// to an `Info.plist`-less `.app` folder has no bundle id, and the center would raise there too.
pub fn is_bundled() -> bool {
    let bundle = NSBundle::mainBundle();
    bundle.bundleIdentifier().is_some() && bundle.bundlePath().to_string().ends_with(".app")
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

/// Posts notification `id` in place of the `replaced` ones. When the user was never asked, it
/// asks first and waits for the answer, with no time limit, so the first notification shows once
/// the user allows it. Fails when the user turned notifications off or macOS refuses the post.
pub async fn post(
    id: i32,
    replaced: &[i32],
    title: &str,
    body: &str,
    silent: bool,
) -> Result<(), String> {
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
    if !replaced.is_empty() {
        withdraw(replaced);
    }
    add(&platform_identifier(launch(), id), title, body, silent).await
}

/// Takes notifications out of Notification Center, also those macOS has not shown yet.
fn withdraw(ids: &[i32]) {
    let identifiers: Vec<Retained<NSString>> = ids
        .iter()
        .map(|id| NSString::from_str(&platform_identifier(launch(), *id)))
        .collect();
    let identifiers = NSArray::from_retained_slice(&identifiers);
    let center = UNUserNotificationCenter::currentNotificationCenter();
    center.removePendingNotificationRequestsWithIdentifiers(&identifiers);
    center.removeDeliveredNotificationsWithIdentifiers(&identifiers);
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

/// How long macOS may take to answer a request that does not wait for the user. Posts run one at
/// a time, so an answer that never came would hold up every later notification.
const ANSWER_TIMEOUT: Duration = Duration::from_secs(10);

async fn answer<T>(receiver: oneshot::Receiver<T>) -> Result<T, String> {
    receiver
        .await
        .map_err(|_| "macOS did not answer the notification request".to_owned())
}

async fn answer_soon<T>(receiver: oneshot::Receiver<T>) -> Result<T, String> {
    tokio::time::timeout(ANSWER_TIMEOUT, answer(receiver))
        .await
        .map_err(|_| {
            format!(
                "macOS did not answer the notification request within {} s",
                ANSWER_TIMEOUT.as_secs()
            )
        })?
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
    answer_soon(receiver).await
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

/// Hands the request to macOS. An error after [`ANSWER_TIMEOUT`] means macOS did not answer in
/// time, not that it dropped the request: the notification may still show later.
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
    match answer_soon(receiver).await? {
        None => Ok(()),
        Some(error) => Err(error),
    }
}

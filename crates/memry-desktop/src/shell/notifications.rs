//! The bookkeeping of desktop notifications. The plugin reports a click by numeric id, so every
//! shown notification gets one, remembered with its key and where a click goes. Only the newest
//! 50 are kept (`MAX_LIVE_NOTIFICATIONS`, `apps/desktop/src/main/lib/reminders.ts`), and a
//! notification shown again under the same key replaces the earlier ones.

use std::collections::VecDeque;

/// Notifications remembered at once.
pub const MAX_LIVE: usize = 50;

/// Where a click on a notification goes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Route {
    /// Bring the window forward.
    Focus,
    /// Bring the window forward, then route a `memry://` link.
    DeepLink(String),
    /// Bring the window forward, then run the closure registered under this name.
    Handler(String),
}

/// What the renderer may ask a click to run: the handlers Steps 21 (#3538) and 27 (#3544)
/// register.
pub const RENDERER_HANDLERS: [&str; 3] =
    ["reminder-clicked", "inbox-review-open", "inbox-open-item"];

/// A route the renderer is allowed to request: `Focus`, or one of [`RENDERER_HANDLERS`].
pub fn renderer_route_allowed(route: &Route) -> bool {
    match route {
        Route::Focus => true,
        Route::Handler(name) => RENDERER_HANDLERS.contains(&name.as_str()),
        Route::DeepLink(_) => false,
    }
}

#[derive(Debug, Default)]
pub struct LiveNotifications {
    next_id: i32,
    live: VecDeque<(i32, String, Route)>,
}

impl LiveNotifications {
    /// Registers a notification about to be shown. Returns its id and the ids shown earlier under
    /// the same key, which the caller closes where the platform can.
    pub fn register(&mut self, key: &str, route: Route) -> (i32, Vec<i32>) {
        self.next_id = self.next_id.wrapping_add(1).max(1);
        let id = self.next_id;
        let replaced: Vec<i32> = self
            .live
            .iter()
            .filter(|(_, existing, _)| existing == key)
            .map(|(id, _, _)| *id)
            .collect();
        self.live.retain(|(_, existing, _)| existing != key);
        self.live.push_back((id, key.to_owned(), route));
        while self.live.len() > MAX_LIVE {
            self.live.pop_front();
        }
        (id, replaced)
    }

    /// The route of a clicked notification, `None` when it is no longer remembered.
    pub fn route_of(&self, id: i32) -> Option<Route> {
        self.live
            .iter()
            .find(|(existing, _, _)| *existing == id)
            .map(|(_, _, route)| route.clone())
    }

    pub fn len(&self) -> usize {
        self.live.len()
    }

    pub fn is_empty(&self) -> bool {
        self.live.is_empty()
    }
}

/// Whether a notification daemon owns `org.freedesktop.Notifications` on the session bus. macOS
/// and Windows always have one.
#[cfg(target_os = "linux")]
pub fn daemon_available() -> bool {
    use zbus::blocking::{Connection, fdo::DBusProxy};
    use zbus::names::BusName;

    let Ok(connection) = Connection::session() else {
        return false;
    };
    let Ok(proxy) = DBusProxy::new(&connection) else {
        return false;
    };
    let Ok(name) = BusName::try_from("org.freedesktop.Notifications") else {
        return false;
    };
    proxy.name_has_owner(name).unwrap_or(false)
}

#[cfg(not(target_os = "linux"))]
pub fn daemon_available() -> bool {
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_click_finds_the_route_of_its_notification() {
        let mut live = LiveNotifications::default();
        let (a, _) = live.register("reminder:1", Route::Handler("reminder-clicked".into()));
        let (b, _) = live.register("inbox", Route::Focus);
        assert_ne!(a, b);
        assert_eq!(
            live.route_of(a),
            Some(Route::Handler("reminder-clicked".into()))
        );
        assert_eq!(live.route_of(b), Some(Route::Focus));
        assert_eq!(live.route_of(999), None);
    }

    #[test]
    fn showing_a_key_again_replaces_and_names_the_old_ones() {
        let mut live = LiveNotifications::default();
        let (first, none) = live.register("k", Route::Focus);
        assert!(none.is_empty());
        let (second, replaced) = live.register("k", Route::Focus);
        assert_eq!(replaced, [first]);
        assert_eq!(live.route_of(first), None);
        assert!(live.route_of(second).is_some());
        assert_eq!(live.len(), 1);
    }

    #[test]
    fn only_the_newest_fifty_are_remembered() {
        let mut live = LiveNotifications::default();
        let ids: Vec<i32> = (0..60)
            .map(|n| live.register(&format!("k{n}"), Route::Focus).0)
            .collect();
        assert_eq!(live.len(), MAX_LIVE);
        assert_eq!(live.route_of(ids[0]), None);
        assert_eq!(live.route_of(ids[9]), None);
        assert!(live.route_of(ids[10]).is_some());
        assert!(live.route_of(ids[59]).is_some());
    }

    #[test]
    fn ids_are_positive_and_wrap_without_zero() {
        let mut live = LiveNotifications {
            next_id: i32::MAX - 1,
            ..Default::default()
        };
        assert_eq!(live.register("a", Route::Focus).0, i32::MAX);
        assert_eq!(live.register("b", Route::Focus).0, 1);
    }

    #[test]
    fn the_renderer_may_not_ask_for_a_deep_link_or_an_unknown_handler() {
        assert!(renderer_route_allowed(&Route::Focus));
        assert!(renderer_route_allowed(&Route::Handler(
            "inbox-open-item".into()
        )));
        assert!(!renderer_route_allowed(&Route::Handler("rm-rf".into())));
        assert!(!renderer_route_allowed(&Route::DeepLink(
            "memry://pair".into()
        )));
    }
}

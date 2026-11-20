//! Which draft the sticky opens on, and whether an open sticky is kept, focused or replaced
//! (`showStickyWindow`, `sticky-window.ts:58-75`), plus the window's lifecycle: one sticky at a
//! time under one label, so a replacement is built only once the window it replaces is gone.

/// What asked for the sticky.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OpenRequest {
    /// The global shortcut: the latest draft, or blank when there is none.
    Shortcut,
    /// The edge tab: that draft, or blank for `None`.
    Draft(Option<String>),
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum OpenAction {
    /// The open sticky stays and takes focus.
    Focus,
    /// A new sticky opens on `draft_id`, replacing an open one (it saved as it went).
    Open { draft_id: Option<String> },
}

/// `open` is the draft of the sticky on screen, `None` when none is; `latest` the most recently
/// edited draft.
fn resolve(request: OpenRequest, open: Option<Option<&str>>, latest: Option<&str>) -> OpenAction {
    let next = match &request {
        OpenRequest::Shortcut => latest.map(str::to_owned),
        OpenRequest::Draft(id) => id.clone(),
    };
    match open {
        Some(_) if request == OpenRequest::Shortcut => OpenAction::Focus,
        Some(current) if current == next.as_deref() => OpenAction::Focus,
        _ => OpenAction::Open { draft_id: next },
    }
}

/// What the window adapter does for an open request.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Step {
    /// The open sticky stays and takes focus.
    Focus,
    /// Build the sticky window: there is none yet.
    Build,
    /// Load the sticky page again in the hidden window, on the new draft, near the cursor.
    Reload,
    /// As `Reload`, over a sticky on screen: its page writes its pending text first.
    Replace,
    /// The window is being destroyed: [`StickySession::destroyed`] hands the request back once
    /// the runtime has removed it, and only then is a window of the same label built.
    Defer,
}

/// What putting the sticky away does with its window.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Tuck {
    Hide,
    /// No other app window exists and the app does not outlive its windows (Windows, Linux): a
    /// hidden sticky would keep a process with no window, tray or taskbar entry running, with the
    /// vault open. Electron closes it and `window-all-closed` quits (`index.ts:2395`).
    Destroy,
}

/// An open request that arrived while the window was being destroyed, with the latest draft
/// read for it.
pub type Deferred = (OpenRequest, Option<String>);

/// The sticky as the shell tracks it. One window serves every open: tucking hides it and the
/// next open loads its page again. A new window under the same label would race the old one's
/// teardown, which drops the label's protocol handler on macOS (wry `WEBVIEW_STATE`). Off macOS a
/// hidden sticky is destroyed once it is the last app window, and an open during that teardown
/// waits for it.
#[derive(Debug, Default)]
pub struct StickySession {
    draft_id: Option<String>,
    /// A sticky is on screen or about to be.
    open: bool,
    /// `destroy` was called on the window and its `Destroyed` has not arrived.
    destroying: bool,
    deferred: Option<Deferred>,
}

impl StickySession {
    /// The draft the open sticky shows (`sticky:get-session`).
    pub fn draft_id(&self) -> Option<String> {
        self.draft_id.clone()
    }

    /// `latest` is the most recently edited draft; `window_exists` says the sticky's window was
    /// built (shown or tucked away).
    pub fn request(
        &mut self,
        request: OpenRequest,
        latest: Option<&str>,
        window_exists: bool,
    ) -> Step {
        if self.destroying {
            self.deferred = Some((request, latest.map(str::to_owned)));
            return Step::Defer;
        }
        let on_screen = self.open.then_some(self.draft_id.as_deref());
        let OpenAction::Open { draft_id } = resolve(request, on_screen, latest) else {
            return Step::Focus;
        };
        self.draft_id = draft_id;
        let was_open = std::mem::replace(&mut self.open, true);
        match (window_exists, was_open) {
            (false, _) => Step::Build,
            (true, false) => Step::Reload,
            (true, true) => Step::Replace,
        }
    }

    /// The renderer tucked the sticky (`tuckStickyWindow`). `other_app_window`: another window
    /// that shows app content exists; `app_outlives_windows`: the app stays alive with no window
    /// (macOS, through the Dock).
    pub fn tuck(&mut self, other_app_window: bool, app_outlives_windows: bool) -> Tuck {
        self.open = false;
        if other_app_window || app_outlives_windows {
            return Tuck::Hide;
        }
        self.destroying = true;
        Tuck::Destroy
    }

    /// The last other app window was destroyed while the sticky's window exists: true when the
    /// sticky must be destroyed too, which it must when it is hidden and the app does not outlive
    /// its windows. A sticky on screen stays, and its tuck ends the app.
    pub fn last_other_window_gone(&mut self, app_outlives_windows: bool) -> bool {
        let release = !self.open && !app_outlives_windows;
        self.destroying |= release;
        release
    }

    /// Whether a page that finished loading shows and focuses its window. A crash recovery
    /// reloads a tucked sticky too, and that one stays hidden.
    pub fn shows_on_load(&self) -> bool {
        self.open
    }

    /// The build failed, or a destroy did not go through: no sticky is open.
    pub fn closed(&mut self) {
        self.open = false;
        self.destroying = false;
        self.deferred = None;
    }

    /// The window is gone. Returns the open request that waited for it.
    pub fn destroyed(&mut self) -> Option<Deferred> {
        self.open = false;
        self.destroying = false;
        self.deferred.take()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn open(draft_id: Option<&str>) -> OpenAction {
        OpenAction::Open {
            draft_id: draft_id.map(str::to_owned),
        }
    }

    #[test]
    fn the_shortcut_resumes_the_latest_draft_and_then_focuses_rather_than_reopens() {
        assert_eq!(
            resolve(OpenRequest::Shortcut, None, Some("newest")),
            open(Some("newest"))
        );
        assert_eq!(
            resolve(OpenRequest::Shortcut, Some(Some("older")), Some("newest")),
            OpenAction::Focus
        );
    }

    #[test]
    fn the_shortcut_starts_blank_when_there_are_no_drafts() {
        assert_eq!(resolve(OpenRequest::Shortcut, None, None), open(None));
    }

    #[test]
    fn unfolding_another_draft_replaces_the_open_sticky_and_the_same_one_focuses() {
        let b = OpenRequest::Draft(Some("b".into()));
        assert_eq!(
            resolve(b.clone(), Some(Some("a")), Some("a")),
            open(Some("b"))
        );
        assert_eq!(resolve(b, Some(Some("b")), Some("a")), OpenAction::Focus);
        assert_eq!(
            resolve(OpenRequest::Draft(None), Some(Some("a")), Some("a")),
            open(None)
        );
    }

    fn unfold(id: Option<&str>) -> OpenRequest {
        OpenRequest::Draft(id.map(str::to_owned))
    }

    /// The live defect: unfolding a draft over an open sticky destroyed the window and built a
    /// new one under the same label, whose page never loaded. The window is reused instead, and
    /// its page writes its pending text before the reload (Electron's `open.destroy()` lost it).
    #[test]
    fn replacing_the_open_sticky_reloads_its_window_instead_of_building_another() {
        let mut session = StickySession::default();
        assert_eq!(session.request(unfold(Some("a")), None, false), Step::Build);
        assert_eq!(
            session.request(unfold(Some("b")), None, true),
            Step::Replace
        );
        assert_eq!(session.draft_id().as_deref(), Some("b"));
        assert_eq!(session.request(unfold(Some("b")), None, true), Step::Focus);
    }

    #[test]
    fn after_a_tuck_the_shortcut_reopens_the_same_window_on_the_latest_draft() {
        let mut session = StickySession::default();
        assert_eq!(
            session.request(OpenRequest::Shortcut, Some("a"), false),
            Step::Build
        );
        assert_eq!(
            session.request(OpenRequest::Shortcut, Some("a"), true),
            Step::Focus
        );
        assert_eq!(session.tuck(true, false), Tuck::Hide);
        assert_eq!(
            session.request(OpenRequest::Shortcut, Some("b"), true),
            Step::Reload
        );
        assert_eq!(session.draft_id().as_deref(), Some("b"));
    }

    #[test]
    fn a_closed_window_is_built_again() {
        let mut session = StickySession::default();
        session.request(unfold(None), None, false);
        session.closed();
        assert_eq!(session.request(unfold(None), None, false), Step::Build);
    }

    /// REVIEW-4999 item 1: Tauri asks to exit only once no window is left, and a hidden sticky is
    /// one. Tucking the last app window away off macOS destroys it, so the app quits.
    #[test]
    fn tucking_with_no_other_app_window_destroys_it() {
        let mut session = StickySession::default();
        session.request(OpenRequest::Shortcut, None, false);
        assert_eq!(session.tuck(false, false), Tuck::Destroy);

        let mut session = StickySession::default();
        session.request(OpenRequest::Shortcut, None, false);
        assert_eq!(session.tuck(true, false), Tuck::Hide);

        // macOS: the Dock keeps the app reachable, and the window is reused.
        let mut session = StickySession::default();
        session.request(OpenRequest::Shortcut, None, false);
        assert_eq!(session.tuck(false, true), Tuck::Hide);
    }

    /// REVIEW-4999 item 1, the other order: main closes while the sticky is tucked away.
    #[test]
    fn the_last_other_window_closing_destroys_a_hidden_sticky_but_not_a_shown_one() {
        let mut hidden = StickySession::default();
        hidden.request(OpenRequest::Shortcut, None, false);
        hidden.tuck(true, false);
        assert!(hidden.last_other_window_gone(false));

        let mut on_mac = StickySession::default();
        on_mac.request(OpenRequest::Shortcut, None, false);
        on_mac.tuck(true, true);
        assert!(!on_mac.last_other_window_gone(true));

        // A sticky on screen stays; tucking it later finds no other window and destroys it.
        let mut shown = StickySession::default();
        shown.request(OpenRequest::Shortcut, None, false);
        assert!(!shown.last_other_window_gone(false));
        assert_eq!(shown.tuck(false, false), Tuck::Destroy);
    }

    /// No window is built under the label of one being destroyed: the open waits for
    /// `Destroyed`, and is built only after the runtime removed the old window.
    #[test]
    fn an_open_during_the_destroy_waits_for_the_window_to_go() {
        let mut session = StickySession::default();
        session.request(OpenRequest::Shortcut, Some("a"), false);
        session.tuck(false, false);
        assert_eq!(
            session.request(OpenRequest::Shortcut, Some("b"), true),
            Step::Defer
        );
        let (request, latest) = session.destroyed().expect("the deferred open");
        assert_eq!(session.destroyed(), None);
        assert_eq!(
            session.request(request, latest.as_deref(), false),
            Step::Build
        );
        assert_eq!(session.draft_id().as_deref(), Some("b"));
    }

    /// REVIEW-4999 item 2: crash recovery reloads the page of a tucked sticky, whose load must not
    /// put it back on screen over the user's work.
    #[test]
    fn a_tucked_sticky_reloaded_by_recovery_stays_hidden() {
        let mut session = StickySession::default();
        session.request(OpenRequest::Shortcut, None, false);
        assert!(session.shows_on_load());
        session.tuck(true, false);
        assert!(!session.shows_on_load());
        assert_eq!(
            session.request(OpenRequest::Shortcut, None, true),
            Step::Reload
        );
        assert!(session.shows_on_load());
    }
}

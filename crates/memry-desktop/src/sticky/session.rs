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
    /// Load the sticky page again in the existing window, on the new draft, near the cursor.
    Reload,
}

/// The sticky as the shell tracks it. One window serves every open: tucking hides it and the
/// next open loads its page again. A new window under the same label would race the old one's
/// teardown, which drops the label's protocol handler on macOS (wry `WEBVIEW_STATE`).
#[derive(Debug, Default)]
pub struct StickySession {
    draft_id: Option<String>,
    /// A sticky is on screen or about to be.
    open: bool,
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
        let on_screen = self.open.then_some(self.draft_id.as_deref());
        let OpenAction::Open { draft_id } = resolve(request, on_screen, latest) else {
            return Step::Focus;
        };
        self.draft_id = draft_id;
        self.open = true;
        if window_exists {
            Step::Reload
        } else {
            Step::Build
        }
    }

    /// Tucked (`tuckStickyWindow`), closed from outside, or its build failed: no sticky is open.
    pub fn closed(&mut self) {
        self.open = false;
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
    /// new one under the same label, whose page never loaded. The window is reused instead.
    #[test]
    fn replacing_the_open_sticky_reloads_its_window_instead_of_building_another() {
        let mut session = StickySession::default();
        assert_eq!(session.request(unfold(Some("a")), None, false), Step::Build);
        assert_eq!(session.request(unfold(Some("b")), None, true), Step::Reload);
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
        session.closed();
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
}

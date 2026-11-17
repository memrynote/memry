//! Which draft the sticky opens on, and whether an open sticky is kept, focused or replaced
//! (`showStickyWindow`, `sticky-window.ts:58-75`).

/// What asked for the sticky.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OpenRequest {
    /// The global shortcut: the latest draft, or blank when there is none.
    Shortcut,
    /// The edge tab: that draft, or blank for `None`.
    Draft(Option<String>),
}

/// What the window adapter does.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OpenAction {
    /// The open sticky stays and takes focus.
    Focus,
    /// A new sticky opens on `draft_id`, replacing an open one (it saved as it went).
    Open { draft_id: Option<String> },
}

/// `open` is the draft of the sticky on screen, `None` when none is; `latest` the most recently
/// edited draft.
pub fn resolve(
    request: OpenRequest,
    open: Option<Option<&str>>,
    latest: Option<&str>,
) -> OpenAction {
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
        assert_eq!(resolve(OpenRequest::Shortcut, None, Some("newest")), open(Some("newest")));
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
        assert_eq!(resolve(b.clone(), Some(Some("a")), Some("a")), open(Some("b")));
        assert_eq!(resolve(b, Some(Some("b")), Some("a")), OpenAction::Focus);
        assert_eq!(
            resolve(OpenRequest::Draft(None), Some(Some("a")), Some("a")),
            open(None)
        );
    }
}

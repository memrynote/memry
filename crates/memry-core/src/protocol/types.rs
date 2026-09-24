//! Item-type negotiation, chapter 05 §5.3 and chapter 13 §13.1 (FR-032).
//!
//! Negotiation is a **header, not a query parameter**, and the server's
//! resolution has three branches:
//!
//! | Header state                           | Resolved set                        |
//! | -------------------------------------- | ----------------------------------- |
//! | absent                                 | the frozen legacy 15                |
//! | present, at least one entry recognised | the recognised entries, deduplicated, first-seen order |
//! | present, **nothing** recognised        | the **empty set**, serving zero rows |
//!
//! The empty-set branch is deliberate: falling back to legacy would hand a
//! negotiating client fifteen types it never asked for, which is the
//! convergence loss this feature exists to prevent. It is also the trap this
//! module exists to close — a typo in a declared name costs one type, and a
//! typo in every declared name costs the whole vault and looks exactly like an
//! account with no data.
//!
//! So the two rules pull in opposite directions and both are required:
//! **an unrecognised name is dropped silently**, because the client cannot
//! know which types a future server knows; **a declaration that drops to
//! nothing is a hard error**, and so is a zero-row first page on a vault known
//! to hold items (FR-032). The second is what keeps the first from being
//! silent all the way to an empty screen.

use thiserror::Error;

/// The negotiation header, chapter 05 §5.2.
///
/// TitleCase, unlike `x-memry-client`, which is lowercase. HTTP header names
/// are case-insensitive so the asymmetry is cosmetic, but a client that
/// string-matches its own constants has to match the right spelling.
pub const SYNC_TYPES_HEADER: &str = "X-Memry-Sync-Types";

/// The fourteen types this client subscribes to, chapter 13 §13.1.
///
/// The set spec.md's Assumptions name, in the chapter's order, plus `filter`
/// (saved task filters, spec 004 TP022) appended last. Adding
/// a type here without a projector that understands it is worse than omitting
/// it: the server would start serving rows this client cannot apply.
pub const SUBSCRIBED_ITEM_TYPES: [&str; 14] = [
    "note",
    "journal",
    "folder_config",
    "custom_icon",
    "tag_definition",
    "tag_category",
    "property_definition",
    "template",
    "task",
    "project",
    "task_activity",
    "reminder",
    "settings",
    "filter",
];

/// The eleven record types the server serves and this client does **not**
/// subscribe to, chapter 13 §13.1.
///
/// Listed rather than implied because "recognised" and "subscribed" are
/// different questions: these are recognised names a declaration may legally
/// carry, and omitting them from the header is what stops them arriving.
pub const UNSUBSCRIBED_RECORD_ITEM_TYPES: [&str; 11] = [
    "inbox",
    "calendar_event",
    "calendar_source",
    "calendar_binding",
    "calendar_external_event",
    "agent_conversation",
    "agent_message",
    "canvas",
    "canvas_folder",
    "bookmark",
    "home_page",
];

/// `attachment` is a `SYNC_ITEM_TYPES` member and **not** a record type
/// (chapter 00 §0.7, chapter 13 §13.8): attachment bytes travel their own
/// channel and never appear as a record.
pub const ATTACHMENT_ITEM_TYPE: &str = "attachment";

/// The number of record types the server knows, chapter 00 §0.7.
pub const RECORD_SYNC_ITEM_TYPE_COUNT: usize =
    SUBSCRIBED_ITEM_TYPES.len() + UNSUBSCRIBED_RECORD_ITEM_TYPES.len();

/// Failures of type negotiation (FR-032).
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum TypeNegotiationError {
    /// Every declared name was dropped, which the server answers with zero
    /// rows for every page. A client MUST NOT send such a header: the response
    /// is indistinguishable from an account with no data.
    #[error("no declared item type was recognised: {declared}")]
    NothingRecognised { declared: String },

    /// A first page came back empty for a vault known to hold items.
    ///
    /// **Report it; never render it as an empty vault** (FR-032). The
    /// plausible causes — a mis-spelled declaration, a resolved set the server
    /// narrowed, a vault routed to the wrong id — all look identical from
    /// here, and all of them are wrong answers to show a user who has data.
    #[error("the first page of a vault known to hold items came back empty")]
    EmptyFirstPage,
}

/// What to do with a type that arrived, chapter 05 §5.3.1.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ArrivingItemType {
    /// Declared: apply it.
    Subscribed,
    /// Not declared. The server filters on the resolved set, so the record feed
    /// cannot produce this today; it is a defensive rule, not a live path.
    ///
    /// The client MUST record it as corrupt, MUST NOT apply it, and MUST NOT
    /// advance its cursor **on that basis alone** — the page's own cursor still
    /// advances (chapter 05 §5.14).
    Undeclared,
}

/// The resolved declaration this client sends on every request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Declaration {
    types: Vec<String>,
}

impl Declaration {
    /// The fourteen subscribed types, chapter 13 §13.1.
    pub fn subscribed() -> Self {
        Self::declare(&SUBSCRIBED_ITEM_TYPES).expect("the subscribed fourteen are all recognised")
    }

    /// Resolves a declaration the way the server will resolve it.
    ///
    /// Entries are trimmed and deduplicated because the header is unbounded
    /// client input, and kept in first-seen order. **An unrecognised name is
    /// dropped silently**: a client cannot know which types a server two
    /// versions ahead knows, and refusing the whole declaration over one name
    /// would turn a harmless forward reference into a dead client.
    ///
    /// Dropping to nothing is the one case that is not silent, because the
    /// server serves zero rows for it rather than falling back.
    pub fn declare(requested: &[&str]) -> Result<Self, TypeNegotiationError> {
        let mut types: Vec<String> = Vec::with_capacity(requested.len());
        for name in requested {
            let name = name.trim();
            if !is_record_item_type(name) {
                continue;
            }
            if types.iter().any(|kept| kept == name) {
                continue;
            }
            types.push(name.to_owned());
        }

        if types.is_empty() {
            return Err(TypeNegotiationError::NothingRecognised {
                declared: requested.join(","),
            });
        }
        Ok(Self { types })
    }

    /// The `X-Memry-Sync-Types` value: comma-separated, **no spaces**.
    pub fn header_value(&self) -> String {
        self.types.join(",")
    }

    /// The resolved names, in the order they will be sent.
    pub fn types(&self) -> &[String] {
        &self.types
    }

    /// Whether an arriving item is one this client asked for.
    pub fn accepts(&self, item_type: &str) -> bool {
        self.types.iter().any(|declared| declared == item_type)
    }

    /// Chapter 05 §5.3.1's disposition for a type that arrived.
    pub fn classify(&self, item_type: &str) -> ArrivingItemType {
        if self.accepts(item_type) {
            ArrivingItemType::Subscribed
        } else {
            ArrivingItemType::Undeclared
        }
    }
}

/// Whether a name is one of the record types the server serves
/// (chapter 00 §0.7, chapter 13 §13.1).
///
/// `attachment` is excluded on purpose: it is a sync item type but never a
/// record, so declaring it on the record feed asks for something that cannot
/// arrive.
pub fn is_record_item_type(name: &str) -> bool {
    SUBSCRIBED_ITEM_TYPES.contains(&name) || UNSUBSCRIBED_RECORD_ITEM_TYPES.contains(&name)
}

/// Whether this client subscribes to a name, chapter 13 §13.1.
pub fn is_subscribed_item_type(name: &str) -> bool {
    SUBSCRIBED_ITEM_TYPES.contains(&name)
}

/// FR-032's first-page rule.
///
/// A zero-row first page is legitimate for an account with no data and is a
/// **failure to report** for a vault known to hold items. The caller supplies
/// the second fact — a vault listed with a non-zero item count, or one this
/// device has synced before — because the page itself cannot distinguish the
/// two, and guessing in favour of "empty" silently discards a user's vault.
pub fn check_first_page(
    rows: usize,
    vault_known_to_hold_items: bool,
) -> Result<(), TypeNegotiationError> {
    if rows == 0 && vault_known_to_hold_items {
        return Err(TypeNegotiationError::EmptyFirstPage);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_unrecognised_name_is_dropped_silently() {
        let declaration = Declaration::declare(&["note", "hologram", " task "]).unwrap();
        assert_eq!(declaration.types(), ["note", "task"]);
        assert_eq!(declaration.header_value(), "note,task");
    }

    #[test]
    fn entries_are_deduplicated_in_first_seen_order() {
        let declaration = Declaration::declare(&["task", "note", "task"]).unwrap();
        assert_eq!(declaration.types(), ["task", "note"]);
    }

    #[test]
    fn a_declaration_that_drops_to_nothing_is_an_error() {
        // The server answers this header with the empty set rather than with
        // the legacy fallback, so every page comes back empty and the client
        // cannot tell it from an account with no data.
        assert_eq!(
            Declaration::declare(&["hologram", "attachment"]),
            Err(TypeNegotiationError::NothingRecognised {
                declared: "hologram,attachment".to_owned()
            })
        );
    }

    #[test]
    fn the_subscribed_declaration_is_the_fourteen_in_chapter_order() {
        let declaration = Declaration::subscribed();
        assert_eq!(declaration.types(), SUBSCRIBED_ITEM_TYPES);
        assert_eq!(
            declaration.header_value(),
            "note,journal,folder_config,custom_icon,tag_definition,tag_category,\
property_definition,template,task,project,task_activity,reminder,settings,filter"
        );
        assert!(!declaration.header_value().contains(' '));
        assert_eq!(RECORD_SYNC_ITEM_TYPE_COUNT, 25);
    }

    #[test]
    fn an_undeclared_type_is_not_applied() {
        let declaration = Declaration::subscribed();
        assert_eq!(declaration.classify("note"), ArrivingItemType::Subscribed);
        // Served, recognised, and deliberately not subscribed to.
        assert_eq!(declaration.classify("canvas"), ArrivingItemType::Undeclared);
        assert_eq!(
            declaration.classify("hologram"),
            ArrivingItemType::Undeclared
        );
    }

    #[test]
    fn a_zero_row_first_page_is_a_failure_only_when_the_vault_holds_items() {
        assert_eq!(
            check_first_page(0, true),
            Err(TypeNegotiationError::EmptyFirstPage)
        );
        assert!(check_first_page(0, false).is_ok());
        assert!(check_first_page(1, true).is_ok());
    }
}

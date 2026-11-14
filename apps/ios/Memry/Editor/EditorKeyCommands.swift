//
//  EditorKeyCommands.swift
//  The note editor's hardware keyboard (#4354).
//
//  Bindings are desktop's defaults (`packages/contracts/src/commands/editor.ts`
//  and BlockNote's Tab handling), with substitutes where the iPad app keeps a
//  key for itself: ⌘K is global search (epic #4334's keyboard decisions), so
//  a link is ⇧⌘K. Every command runs the session operation the keyboard
//  toolbar already runs, so a key writes exactly what the matching button
//  writes. ⌘Z and ⇧⌘Z reach the session through the block's undo
//  manager (`BlockUndoManager`), not a key command: the system takes them
//  before any key command.
//

import GameController
import Observation
import UIKit

/// One key the editor answers while a block has the caret.
enum EditorKeyCommand: String, CaseIterable {
    case indent, outdent
    case bold, italic, underline, strikethrough, code, link
    /// Suggestion menus (`/`, `[[`, `@`, `#`): only while one is open, so
    /// the caret keeps its arrow keys and the page keeps Esc otherwise.
    case menuUp, menuDown, menuClose, menuCancel

    var input: String {
        switch self {
        case .indent, .outdent: "\t"
        case .bold: "b"
        case .italic: "i"
        case .underline: "u"
        case .strikethrough: "s"
        case .code: "e"
        case .link: "k"
        case .menuUp: UIKeyCommand.inputUpArrow
        case .menuDown: UIKeyCommand.inputDownArrow
        case .menuClose: UIKeyCommand.inputEscape
        case .menuCancel: "."
        }
    }

    var modifiers: UIKeyModifierFlags {
        switch self {
        case .indent, .menuUp, .menuDown, .menuClose: []
        case .outdent: .shift
        case .bold, .italic, .underline, .code, .menuCancel: .command
        case .strikethrough, .link: [.command, .shift]
        }
    }

    /// The name the hold-⌘ overlay lists; `nil` keeps a key out of it.
    var title: String? {
        switch self {
        case .indent: "Indent"
        case .outdent: "Outdent"
        case .bold: "Bold"
        case .italic: "Italic"
        case .underline: "Underline"
        case .strikethrough: "Strikethrough"
        case .code: "Code"
        case .link: "Link"
        case .menuUp, .menuDown, .menuClose, .menuCancel: nil
        }
    }

    var isMenuKey: Bool {
        switch self {
        case .menuUp, .menuDown, .menuClose, .menuCancel: true
        default: false
        }
    }

    /// The keys that apply now: menu keys only over an open menu.
    static func active(menuOpen: Bool) -> [EditorKeyCommand] {
        allCases.filter { !$0.isMenuKey || menuOpen }
    }

    func keyCommand(action: Selector) -> UIKeyCommand {
        let command = UIKeyCommand(
            title: title ?? "", action: action, input: input, modifierFlags: modifiers, propertyList: rawValue
        )
        // Tab, the arrows and Esc otherwise go to the system first (focus
        // movement, the caret).
        command.wantsPriorityOverSystemBehavior = true
        if title == nil { command.attributes = .hidden }
        return command
    }
}

/// Whether a hardware keyboard is attached, which the toolbar and the menus
/// adapt to.
@MainActor
@Observable
final class HardwareKeyboard {
    static let shared = HardwareKeyboard()

    private(set) var attached: Bool
    // `nonisolated(unsafe)`: written once in `init`; the shared instance
    // lives for the whole process.
    @ObservationIgnored private nonisolated(unsafe) var observers: [NSObjectProtocol] = []

    init(attached: Bool = GCKeyboard.coalesced != nil) {
        self.attached = attached
        for (name, value) in [(Notification.Name.GCKeyboardDidConnect, true), (.GCKeyboardDidDisconnect, false)] {
            observers.append(NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.attached = value }
            })
        }
    }
}

extension EditorSession {
    var menuOpen: Bool { !suggestions.isEmpty || !tagSuggestions.isEmpty }

    /// The menus answer the keyboard as desktop's do (a highlighted row,
    /// Return picks it) with a hardware keyboard attached, or once the
    /// arrows moved the highlight, which only a hardware keyboard can.
    var menuFollowsKeys: Bool { hardwareKeyboard.attached || highlightMoved }

    /// Runs a key command against the focused block, through the operation
    /// the toolbar's matching button uses.
    func perform(_ command: EditorKeyCommand) {
        switch command {
        // The toolbar disables these where the core refuses the move; a
        // refused move recorded as a step would undo into a wrong one.
        case .indent: if canIndent { nest(true) }
        case .outdent: if canOutdent { nest(false) }
        case .bold: toggleMark("bold")
        case .italic: toggleMark("italic")
        case .underline: toggleMark("underline")
        case .strikethrough: toggleMark("strike")
        case .code: toggleMark("code")
        case .link: editLink()
        case .menuUp: moveHighlight(-1)
        case .menuDown: moveHighlight(1)
        case .menuClose, .menuCancel: closeMenu()
        }
    }

    /// The link over the selection: removed when it carries one, otherwise
    /// asked for by address (`linkPrompt`).
    func editLink() {
        guard hasSelection else { return }
        if selectionMarks.contains("link") {
            toggleMark("link")
        } else {
            linkPrompt = true
        }
    }

    func addLink(_ address: String) {
        let trimmed = address.trimmingCharacters(in: .whitespaces)
        if !trimmed.isEmpty { toggleMark("link", value: trimmed) }
    }

    private func moveHighlight(_ step: Int) {
        let count = suggestions.isEmpty ? tagSuggestions.count : suggestions.count
        guard count > 0 else { return }
        highlightMoved = true
        highlighted = ((highlighted + step) % count + count) % count
    }

    /// Return over an open menu picks its highlighted row, as Enter does on
    /// desktop. The slash menu always took Return; the others take it with a
    /// hardware keyboard, so Return on the on-screen keyboard keeps making a
    /// new block there.
    func pickHighlighted() -> Bool {
        let slash = if case .slash = trigger { true } else { false }
        if !suggestions.isEmpty {
            guard slash || menuFollowsKeys else { return false }
            choose(suggestions[min(highlighted, suggestions.count - 1)])
            return true
        }
        guard !tagSuggestions.isEmpty, menuFollowsKeys else { return false }
        chooseTag(tagSuggestions[min(highlighted, tagSuggestions.count - 1)])
        return true
    }
}

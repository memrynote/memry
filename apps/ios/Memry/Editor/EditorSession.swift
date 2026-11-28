//
//  EditorSession.swift
//  The page-wide editing state behind the keyboard toolbar: which block has
//  the caret, which panel is open, the `[[` / `@` menu, undo, and every
//  toolbar action, applied in order through `NoteEditorViewModel`.
//
//  One per editor model, so the note page and the journal day page share it
//  through `NotePageContent` without either owning a toolbar of its own.
//

import Combine
import MemryCore
import Observation
import SwiftUI
import UIKit

@MainActor
@Observable
final class EditorSession {
    enum Panel: Equatable {
        case none
        /// The `+` grid: `BlockCatalog`, desktop's slash menu.
        case insert
        /// The block chip: turn into, and the block's own colours.
        case block
    }

    // MARK: Wiring

    @ObservationIgnored weak var model: NoteEditorViewModel? {
        didSet { if let model { noteId = model.noteId } }
    }
    /// The note being edited, kept past the model: a page torn down drops
    /// its model as its focused block leaves the window (#4457).
    @ObservationIgnored private(set) var noteId: String?
    /// Re-reads the page after a write (`didChange`).
    @ObservationIgnored var reload: () async -> Void = {}
    /// Notes for the `[[` and `@` menus, most recently modified first.
    @ObservationIgnored var linkNotes: [NoteSummary] = []
    /// Each note's emoji by lowercased title, for the `[[` / `@` rows.
    @ObservationIgnored var icons: [String: String] = [:]
    @ObservationIgnored var titleExists: ((String) -> Bool)?
    /// Every vault tag, most used first, for the `#` menu.
    @ObservationIgnored var tags: [String] = []
    /// Each tag's chosen colour by lowercased name, for the `hashTag` node.
    @ObservationIgnored var tagColors: [String: String] = [:]
    /// Opens an attachment picker; `nil` hides the paperclip menu and the
    /// catalog's media rows.
    var attach: ((EditorAttachmentSource) -> Void)?
    /// Uploads files dropped on a block, each into a block after it (#4357),
    /// through the pickers' path. `nil` where `attach` is: no drop is taken.
    @ObservationIgnored var attachDropped: (([NSItemProvider], _ after: String) -> Void)?
    /// The page's blocks, flat with `depth`, as the page draws them: what the
    /// toolbar's indent and move buttons read the focused block's place from.
    /// Read through the page's observable model, so the toolbar redraws when
    /// the body does.
    @ObservationIgnored var blocks: () -> [Block] = { [] }
    /// Points a moved task line's task at its new note: task id, target note.
    @ObservationIgnored var relinkTask: ((String, String) async -> Void)?
    /// Turns a checklist item the user typed and left into a task, as
    /// desktop's editor does (`textViewDidEndEditing`). `nil` on a page that
    /// cannot write tasks.
    @ObservationIgnored var convertTypedChecklist: ((String) async -> Void)?
    /// Opens a tag's notes, for a tap on a `#tag` in a block. `nil` leaves the
    /// tap to place the caret, as on a page with no stack to push onto.
    @ObservationIgnored var openTag: ((String) -> Void)?
    /// Opens a wiki link's target, for a tap on a link in a block. `nil`
    /// leaves the tap to place the caret.
    @ObservationIgnored var openWikiTarget: ((String) -> Void)?
    /// Opens a wiki link's target in the pane beside this note (#4377), for
    /// a `⌘`-tap and the link's menu. `nil` where no pane can show beside
    /// it: a tap opens the link here, and the link has no menu.
    @ObservationIgnored var openWikiTargetToSide: ((String) -> Void)?
    /// Schedules a vault sync pass (`requestVaultSync`, debounced), so a
    /// write reaches other devices without waiting for the next foreground
    /// or launch. `didChange` calls it after every committed write.
    @ObservationIgnored var requestSync: (@MainActor () -> Void)?
    /// The vault's canvases, for the Whiteboard row and the board editor.
    @ObservationIgnored var whiteboards: (any WhiteboardBoards)?
    /// The note's title, which names a new whiteboard.
    @ObservationIgnored var noteTitle: () -> String? = { nil }

    // MARK: State the toolbar draws

    private(set) var panel: Panel = .none
    /// The block with the caret.
    private(set) var focusedKind: String?
    /// Its id, observed so the block can draw its action handle.
    private(set) var focusedBlockId: String?
    private(set) var focusedLevel: Int?
    private(set) var focusedProps: [String: String] = [:]
    /// Marks every character of the selection carries.
    private(set) var selectionMarks: Set<String> = []
    private(set) var hasSelection = false
    private(set) var trigger: InlineTrigger?
    private(set) var suggestions: [EditorSuggestion] = [] {
        didSet { menuChanged() }
    }
    /// The open `#` menu, when no `[[` / `@` menu is.
    private(set) var tagTrigger: HashTagTrigger?
    private(set) var tagSuggestions: [TagSuggestion] = [] {
        didSet { menuChanged() }
    }
    /// The open menu's row that Return picks, moved by the arrow keys.
    var highlighted = 0
    /// The arrow keys moved `highlighted` in the open menu
    /// (`menuFollowsKeys`).
    var highlightMoved = false
    /// The trigger the user typed, by its character and where it starts: its
    /// menu shows while the caret stays in it, until Esc. Only typing a
    /// trigger (`willType`) or a toolbar button (`openMenu`) sets it, as
    /// only desktop's `handleTextInput` and `openSuggestionMenu` open one.
    @ObservationIgnored private var openedMenu: MenuAnchor?

    private struct MenuAnchor: Equatable {
        let trigger: Character
        let location: Int
    }
    /// Seam for tests; the app reads the attached keyboard.
    @ObservationIgnored var hardwareKeyboard = HardwareKeyboard.shared
    /// The toolbar shows the format slide (`Aa`) rather than the main row.
    private(set) var formatting = false
    /// A block waiting for the note picker (the `...` menu's Move to).
    private(set) var moveRequest: BlockMoveRequest?
    /// Why the last Move to, or the last new whiteboard, did not land, for
    /// the page's alert.
    var failure: UserFacingError?
    /// A tapped date chip whose editor is open.
    private(set) var dateEdit: DateMentionEditRequest?
    /// The block that chip is in, which need not have the caret.
    @ObservationIgnored private weak var dateEditField: BlockField?
    private(set) var linkRequest: LinkBlockRequest?
    /// A block whose source sheet is open (`BlockSourceSheet`).
    private(set) var sourceEdit: BlockSourceRequest?
    /// A view block whose query sheet is open (`ViewQuerySheet`).
    private(set) var viewEdit: ViewQueryRequest?
    /// A whiteboard open in its editor (`WhiteboardEditor`) or the drawing
    /// surface (`InkSurface`).
    private(set) var whiteboardEdit: WhiteboardEditRequest?
    /// Bumped when a whiteboard editor closes, so the block re-reads its board.
    private(set) var whiteboardRevision = 0
    let history = EditorUndoStack()

    @ObservationIgnored weak var field: BlockField?
    /// A block to put the caret in once it is drawn.
    @ObservationIgnored var pendingFocus: String?
    /// Each drawn block's field by block id, so the caret can move into a
    /// block whose row does not redraw (`focus`).
    @ObservationIgnored private let drawnFields = NSMapTable<NSString, BlockField>.strongToWeakObjects()
    /// The field a block shortcut fired in, held until the row its type
    /// change redraws takes the caret (`BlockField.takeOver`).
    @ObservationIgnored var shortcutField: BlockField?
    /// The kind `shortcutField`'s block is turning into.
    @ObservationIgnored var shortcutKind = "paragraph"
    /// Keys typed after a Return, held for the block it makes (#4692).
    @ObservationIgnored var returnBurst: ReturnBurst?
    /// The block whose Return a Backspace took back before the core made
    /// the new block: the Return's write merges it back (#4834).
    @ObservationIgnored var withdrawnReturn: String?
    /// The block a Return split off: the caret goes to its start, where the
    /// text after the old caret begins (#4834).
    @ObservationIgnored var caretAtStart: String?
    /// Keys typed after the title's Return, held for the body (#4705).
    @ObservationIgnored var titleBurst: TitleBurst?
    /// The keys the title's Return put back in its line that the keyboard
    /// may still deliver to the block that took the caret (#4823).
    @ObservationIgnored var lateKeys: (blockId: String, keys: LateKeys)?
    /// A column list just inserted, by its `id` prop: the caret goes to its
    /// first block once a redraw shows the ids the core minted for it
    /// (`resolveColumnFocus`).
    @ObservationIgnored var pendingColumnFocus: String?
    @ObservationIgnored var keyboardHeight: CGFloat = 300
    @ObservationIgnored private(set) var tail: Task<Void, Never>?
    /// Each run `enqueue` queues is one write generation, numbered from 1
    /// (#4738). A run's writes count as landed once it re-reads the page
    /// (`didChange`) or ends. A read taken now includes `landedWrites`.
    @ObservationIgnored private var queuedWrites = 0
    @ObservationIgnored private(set) var landedWrites = 0
    /// Each block's last typing commit from this session that failed,
    /// until one lands (#4773): the text it sent (`typed`), the row's base
    /// with its chips drawn (`drawn`), the draws whose chips the core never
    /// got (`draws`), the text it left the block at (`held`), and the runs
    /// queued by then (`queued`). A commit queued by then on top of `typed`
    /// or `drawn` sends its change from `held`, with those chips back to
    /// the text they replaced, so the failed one's typing goes with it
    /// (REVIEW-4784). Any other commit was drawn or typed from what the row
    /// showed, and goes from its own base: a clean redraw since puts the
    /// core's text there.
    @ObservationIgnored private var unlanded: [String: (typed: String, drawn: String, draws: Set<Int>, held: String, queued: Int)] = [:]
    /// The generation the run this task is in was queued as.
    @TaskLocal private static var running: Int?
    /// The generation the page's drawn blocks include: `landedWrites` as
    /// they were read (`NoteReadViewModel.blocksGeneration`).
    @ObservationIgnored var drawnGeneration: () -> Int = { 0 }
    /// The field whose editing just ended, and its selection, until the turn
    /// ends (`editingEnded`).
    @ObservationIgnored var endedField: (field: BlockField, selection: NSRange)?
    /// A remembered caret is on its way back (`restoreFocus`).
    @ObservationIgnored var restoringFocus = false
    /// Seam for tests; the app keeps one memory (`EditorFocusMemory`).
    @ObservationIgnored var focusMemory = EditorFocusMemory.shared
    /// The Reduce Motion panel swap in flight (`show`). The generation lets a
    /// later swap retire an earlier swap's fallback timer.
    @ObservationIgnored private var panelSwap: (generation: Int, observer: NSObjectProtocol)?
    @ObservationIgnored private var panelSwapGeneration = 0
    // `nonisolated(unsafe)`: written once in `init`, read only by `deinit`,
    // which runs after the last reference is gone.
    @ObservationIgnored private nonisolated(unsafe) var keyboardObservers: [NSObjectProtocol] = []
    /// Looks again while anything is presented over the page (`syncToolbar`).
    @ObservationIgnored private var coveredWatch: Timer?
    @ObservationIgnored private var leaving: AnyCancellable?
    /// Background tasks held until their resign's writes land. Each resign
    /// ends only its own, so a later resign's write stays protected.
    @ObservationIgnored private var heldTasks: Set<UIBackgroundTaskIdentifier> = []
    /// Seam for tests; the app holds tasks from `UIApplication`.
    @ObservationIgnored var beginBackgroundTask: (@escaping () -> Void) -> UIBackgroundTaskIdentifier = {
        UIApplication.shared.beginBackgroundTask(withName: "editor-commit", expirationHandler: $0)
    }
    @ObservationIgnored var endBackgroundTask: (UIBackgroundTaskIdentifier) -> Void = {
        UIApplication.shared.endBackgroundTask($0)
    }

    /// `notifications`: the center the lifecycle notifications are posted
    /// to, a seam for tests: the app-wide one reaches every suite's editors.
    init(notifications: NotificationCenter = .default) {
        // The toolbar can still be out of its window as the keys are about
        // to show; it is placed by the time they have shown.
        let shows = [UIResponder.keyboardWillShowNotification, UIResponder.keyboardDidShowNotification]
        keyboardObservers = shows.map {
            NotificationCenter.default.addObserver(forName: $0, object: nil, queue: .main) { [weak self] note in
                guard let frame = note.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? CGRect else { return }
                let screen = note.object as? UIScreen
                let isLocal = note.userInfo?[UIResponder.keyboardIsLocalUserInfoKey] as? Bool != false
                MainActor.assumeIsolated {
                    // #4344: a keyboard on another screen, or another app's
                    // on this one (Split View, Stage Manager), says nothing
                    // about this window's.
                    guard isLocal, let self, self.panel == .none, let screen, self.accessory.window != nil,
                          screen === self.field?.textView.window?.windowScene?.screen
                    else { return }
                    // The keys are what lies below the toolbar on screen. The
                    // frame's height minus the toolbar's overstated them: iOS
                    // 26 gives the first frame a bottom inset more than the
                    // toolbar and keys, and a hardware keyboard's runs off the
                    // screen.
                    let toolbar = self.accessory.convert(self.accessory.bounds, to: screen.coordinateSpace)
                    let keys = min(frame.maxY, screen.bounds.maxY) - toolbar.maxY
                    if keys > 200 { self.keyboardHeight = keys }
                }
            }
        }
        let moves = [UIResponder.keyboardWillChangeFrameNotification, UIResponder.keyboardDidChangeFrameNotification]
        keyboardObservers += moves.map { name in
            NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { [weak self] note in
                let screen = note.object as? UIScreen
                let isLocal = note.userInfo?[UIResponder.keyboardIsLocalUserInfoKey] as? Bool != false
                MainActor.assumeIsolated {
                    guard let self else { return }
                    self.syncToolbar()
                    self.placeToolbar()
                    // #4344, as for the keys showing: only this window's keys.
                    guard name == UIResponder.keyboardDidChangeFrameNotification, isLocal, self.panel == .none,
                          let screen, screen === self.field?.textView.window?.windowScene?.screen
                    else { return }
                    DispatchQueue.main.async { [weak self] in self?.revealCaret() }
                }
            }
        }
        // #2820: typing is committed when editing ends, and leaving the app
        // does not end editing. A kill from the app switcher then dropped
        // everything typed since the caret went in, so the focused block is
        // committed as the app stops being active. Entering the background is
        // too late: a kill within a second of going home beats it, and
        // swiping straight into the switcher never backgrounds the app.
        // The block's own iPad window resigning counts too (#5820).
        leaving = SceneLeaving.publisher(
            of: { [weak self] in self?.field?.textView.window?.windowScene }, center: notifications
        )
            .filter { $0 == .resign }
            .sink { [weak self] _ in MainActor.assumeIsolated { self?.commitBeforeLeaving() } }
    }

    deinit {
        keyboardObservers.forEach(NotificationCenter.default.removeObserver)
    }

    /// With a hardware keyboard the toolbar floats in the keyboard's window,
    /// above anything the page presents. UIKit hides it as a menu opens and
    /// lays the menu out to the screen's bottom edge, then shows the toolbar
    /// again over the menu's last rows. So it steps aside while a menu, alert
    /// or sheet is over the page. The keys come back while a sheet is still
    /// on its way out, so that one counts as closed, but a swipe-down can
    /// snap the sheet back. Only the page with the caret decides; another
    /// page's toolbar is not on screen. UIKit says nothing as a presentation
    /// ends or snaps back, and the keys need not move then, so the toolbar
    /// looks again every tenth of a second while anything is presented.
    private func syncToolbar() {
        guard focusedBlockId != nil, let window = field?.textView.window else { return stopWatchingCover() }
        accessory.alpha = PresentingWindow.keepsPresenting(over: window) ? 0 : 1
        guard PresentingWindow.isPresenting(over: window) else { return stopWatchingCover() }
        guard coveredWatch == nil else { return }
        let watch = Timer(timeInterval: 0.1, repeats: true) { [weak self] timer in
            guard let self else { return timer.invalidate() }
            MainActor.assumeIsolated { self.syncToolbar() }
        }
        watch.tolerance = 0.05
        // Common modes, so it also looks during a sheet's swipe-down drag.
        RunLoop.main.add(watch, forMode: .common)
        coveredWatch = watch
    }

    /// Scrolls the page until the line with the caret clears the toolbar.
    /// The reveals UIKit runs for each keyboard change leave the line under
    /// the toolbar or the keys: on an iPad mini in landscape, a new note's
    /// first line after Return in the title. This one runs after them, a turn
    /// later: one of them still reveals the title's caret. The page's bottom
    /// inset counts the keys and, once UIKit has sized it, the toolbar too.
    /// Only a line inside the page that the toolbar or the keys cover moves:
    /// a page the user scrolled away from the caret stays where it is as the
    /// keys change.
    private func revealCaret() {
        guard let textView = field?.textView, textView.isFirstResponder, accessory.window != nil,
              let caret = textView.selectedTextRange?.end
        else { return }
        var ancestor = textView.superview
        while let view = ancestor, !Self.scrollsVertically(view) { ancestor = view.superview }
        guard let page = ancestor as? UIScrollView else { return }
        var line = textView.convert(textView.caretRect(for: caret), to: page)
        let toolbarTop = accessory.convert(accessory.bounds, to: page).minY
        let insets = page.adjustedContentInset
        let inside = page.bounds.inset(by: UIEdgeInsets(top: insets.top, left: 0, bottom: 0, right: 0))
        guard inside.minY <= line.minY, line.maxY <= inside.maxY, line.maxY > toolbarTop else { return }
        line.size.height += max(0, page.bounds.maxY - insets.bottom - toolbarTop)
        page.scrollRectToVisible(line, animated: true)
    }

    private static func scrollsVertically(_ view: UIView) -> Bool {
        guard let scrollView = view as? UIScrollView else { return false }
        return scrollView.alwaysBounceVertical || scrollView.contentSize.height > scrollView.bounds.height
    }

    private func stopWatchingCover() {
        coveredWatch?.invalidate()
        coveredWatch = nil
    }

    /// Commits the focused block's typing, and holds a background task until
    /// the queued writes land, so suspension cannot cut them off.
    private func commitBeforeLeaving() {
        // Resigning also fires for Control Center and incoming calls, and the
        // commit's reload would cancel an IME composition, so marked text
        // waits for the next trigger.
        if let field, field.dirty, field.textView.markedTextRange == nil { commit(field) }
        guard let tail else { return }
        var id = UIBackgroundTaskIdentifier.invalid
        id = beginBackgroundTask {
            MainActor.assumeIsolated { self.release(id) }
        }
        guard id != .invalid else { return }
        heldTasks.insert(id)
        Task { @MainActor in
            await tail.value
            self.release(id)
        }
    }

    /// Ends `id` once, whichever of expiry or the landed write gets here first.
    private func release(_ id: UIBackgroundTaskIdentifier) {
        guard heldTasks.remove(id) != nil else { return }
        endBackgroundTask(id)
    }

    // MARK: Input views

    @ObservationIgnored lazy var accessory: AccessoryStrip = floatingAccessory(EditorKeyboardToolbar(session: self))
    /// Held here: an interaction holds its delegate weakly.
    @ObservationIgnored private lazy var toolbarDrop = ToolbarNoteDrop(session: self)
    @ObservationIgnored private lazy var panelView: UIInputView = host(EditorPanelView(session: self), height: keyboardHeight)

    private func host<Content: View>(_ content: Content, height: CGFloat?) -> UIInputView {
        let input = UIInputView(
            frame: CGRect(x: 0, y: 0, width: 320, height: height ?? Tokens.Size.minimumHitArea + Tokens.Space.small),
            inputViewStyle: .keyboard
        )
        input.allowsSelfSizing = true
        input.autoresizingMask = [.flexibleWidth]
        input.translatesAutoresizingMaskIntoConstraints = height != nil
        let hosting = UIHostingController(rootView: content)
        hosting.sizingOptions = height == nil ? .intrinsicContentSize : []
        hosting.view.backgroundColor = .clear
        hosting.view.translatesAutoresizingMaskIntoConstraints = false
        input.addSubview(hosting.view)
        NSLayoutConstraint.activate([
            hosting.view.leadingAnchor.constraint(equalTo: input.leadingAnchor),
            hosting.view.trailingAnchor.constraint(equalTo: input.trailingAnchor),
            hosting.view.topAnchor.constraint(equalTo: input.topAnchor),
            hosting.view.bottomAnchor.constraint(equalTo: input.bottomAnchor),
        ])
        objc_setAssociatedObject(input, &Self.hostingKey, hosting, .OBJC_ASSOCIATION_RETAIN)
        return input
    }

    /// A plain clear view, not a `.keyboard` `UIInputView`: on iOS 26 that
    /// style paints its own soft blur band above the accessory, which reads as
    /// a shadow over the note behind the glass toolbar.
    ///
    /// Hosted without a view controller. UIKit puts the accessory back in
    /// its window on every input-view reload, and a hosting controller
    /// appearing there with Liquid Glass in it redraws the page under the
    /// caret. A context menu open on the page sends its rows again on that
    /// redraw, which reloads the input views: the main thread never rested,
    /// and the menu took no tap. Auto Layout sizes the view from its content,
    /// which says when its height changes, as when a `[[` menu opens.
    private func floatingAccessory<Content: View>(_ content: Content) -> AccessoryStrip {
        weak var hosted: UIView?
        weak var strip: AccessoryStrip?
        let view = UIHostingConfiguration {
            content.onGeometryChange(for: CGFloat.self) { $0.size.height } action: { _ in
                hosted?.invalidateIntrinsicContentSize()
                strip?.invalidateIntrinsicContentSize()
            }
        }
        .margins(.all, 0)
        .makeContentView()
        hosted = view
        // The strip as a whole, padding included, for UI tests.
        view.accessibilityIdentifier = "editor.keyboardToolbar"
        view.backgroundColor = .clear
        view.translatesAutoresizingMaskIntoConstraints = false
        let accessory = AccessoryStrip(toolbar: view)
        accessory.addInteraction(UIDropInteraction(delegate: toolbarDrop))
        strip = accessory
        return accessory
    }

    nonisolated(unsafe) private static var hostingKey: UInt8 = 0

    func show(_ next: Panel) {
        panel = panel == next ? .none : next
        guard let textView = field?.textView else { return }
        if panel == .none {
            textView.inputView = nil
        } else {
            panelView.frame.size.height = EditorPanelView.height(
                keyboard: keyboardHeight, window: textView.window?.bounds.height
            )
            textView.inputView = panelView
        }
        guard reduceMotion() else { return textView.reloadInputViews() }
        // Reduce Motion: the panel swaps in place and fades in, instead of
        // sliding up like a keyboard. UIKit builds that slide a few run-loop
        // turns after `reloadInputViews`, in the turn it posts
        // `keyboardWillChangeFrame`, so `performWithoutAnimation` cannot reach
        // it. The slide is taken off the keyboard's own windows in this scene
        // before that turn commits (`stillKeyboard`); the rest of the app
        // keeps its animations (#4344). Only this screen's keyboard, and
        // not another app's on it, ends the swap. Without the notification
        // the panel fades in after half a second.
        if panel != .none { panelView.alpha = 0 }
        if let panelSwap { NotificationCenter.default.removeObserver(panelSwap.observer) }
        panelSwapGeneration += 1
        let generation = panelSwapGeneration
        let editorWindow = textView.window
        let observer = NotificationCenter.default.addObserver(
            forName: UIResponder.keyboardWillChangeFrameNotification,
            object: editorWindow?.windowScene?.screen, queue: .main
        ) { [weak self, weak editorWindow] note in
            guard note.userInfo?[UIResponder.keyboardIsLocalUserInfoKey] as? Bool != false else { return }
            MainActor.assumeIsolated {
                Self.stillKeyboard(of: editorWindow) { self?.finishPanelSwap(generation) }
            }
        }
        panelSwap = (generation, observer)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
            self?.finishPanelSwap(generation)
        }
        textView.reloadInputViews()
    }

    /// Seam for tests; the app reads the accessibility setting.
    @ObservationIgnored var reduceMotion: () -> Bool = { UIAccessibility.isReduceMotionEnabled }

    /// Drops the animations added to the keyboard windows of `editorWindow`'s
    /// scene during this run-loop turn, just before Core Animation commits
    /// them, then calls `done`. The editor's own window is left alone.
    private static func stillKeyboard(of editorWindow: UIWindow?, then done: @escaping @MainActor () -> Void) {
        let observer = CFRunLoopObserverCreateWithHandler(nil, CFRunLoopActivity.beforeWaiting.rawValue, false, 0) { _, _ in
            MainActor.assumeIsolated {
                for window in editorWindow?.windowScene?.windows ?? [] where window !== editorWindow {
                    removeAnimations(window.layer)
                }
                done()
            }
        }
        CFRunLoopAddObserver(CFRunLoopGetMain(), observer, .commonModes)
    }

    private static func removeAnimations(_ layer: CALayer) {
        layer.removeAllAnimations()
        layer.sublayers?.forEach(removeAnimations)
    }

    /// The end of Reduce Motion panel swap `generation` (`show`): the panel
    /// fades in. A stale generation does nothing.
    private func finishPanelSwap(_ generation: Int) {
        guard let panelSwap, panelSwap.generation == generation else { return }
        NotificationCenter.default.removeObserver(panelSwap.observer)
        self.panelSwap = nil
        UIView.animate(withDuration: Tokens.Motion.normal.duration) { self.panelView.alpha = 1 }
    }

    // MARK: Focus and selection

    func drawn(_ field: BlockField) {
        drawnFields.setObject(field, forKey: field.blockId as NSString)
    }

    /// The row drawing `blockId` now, if any.
    func drawnRow(_ blockId: String) -> BlockField? {
        drawnFields.object(forKey: blockId as NSString).flatMap { $0.blockId == blockId ? $0 : nil }
    }

    /// Puts the caret at the end of `blockId`: now when its row is on
    /// screen, else once it is drawn (`pendingFocus`). A row the page drew
    /// before the request (a reload that raced the write) never reads
    /// `pendingFocus` again. A field that has since moved on to another
    /// block is not this block's.
    func focus(_ blockId: String) {
        guard let field = drawnRow(blockId), field.textView.window != nil
        else {
            pendingFocus = blockId
            return
        }
        takeCaret(field)
    }

    func focusChanged(to field: BlockField?) {
        focusedBlockId = field?.blockId
        openedMenu = nil
        if let field {
            focusMemory.forget()
            self.field = field
            placeToolbar()
            readFocusedBlock(of: field)
            selectionChanged(in: field)
        } else {
            if panel != .none {
                panel = .none
                // The block the panel was open in gets its keys back: the
                // panel, closed, is blank the next time it takes the caret.
                self.field?.textView.inputView = nil
            }
            formatting = false
            // A caret back over a selection brings the format slide back
            // (`selectionChanged`), as after the Link prompt (#4667).
            hasSelection = false
            trigger = nil
            suggestions = []
            tagTrigger = nil
            tagSuggestions = []
        }
    }

    /// The type, level and props the toolbar shows, from the block the
    /// focused row holds: as it takes the caret, and as it takes a new read
    /// of its block. An undo, a redo or another pane's edit can change the
    /// type under a row that keeps its text view (a bullet to a numbered
    /// item, one heading level to another).
    func readFocusedBlock(of field: BlockField) {
        guard field === self.field else { return }
        focusedKind = field.block.kind
        focusedLevel = field.value("level").flatMap(Int.init)
        focusedProps = Dictionary(field.block.props.map { ($0.name, $0.value) }) { $1 }
    }

    /// A key about to replace `range` with `text`: one that types a trigger
    /// opens its menu, as desktop's `handleTextInput` does. Pasting,
    /// dictating, deleting and moving the caret open none.
    func willType(_ text: String, replacing range: NSRange, in field: BlockField) {
        guard text.count == 1, "/@#[".contains(text) else { return }
        let after = (field.textView.text as NSString).replacingCharacters(in: range, with: text)
        if let typed = Self.freshTrigger(in: after, at: range.location + (text as NSString).length) {
            openedMenu = typed
        }
    }

    /// Opens the menu of the trigger just inserted before the caret, as
    /// desktop's `openSuggestionMenu`: the toolbar's `/`, `@` and `#`, and
    /// the slash menu's link row.
    private func openMenu(in field: BlockField) {
        openedMenu = Self.freshTrigger(in: field.textView.text, at: field.textView.selectedRange.location)
        selectionChanged(in: field)
    }

    /// The trigger the caret is right after, with no query typed yet.
    private static func freshTrigger(in text: String, at caret: Int) -> MenuAnchor? {
        if let trigger = InlineTrigger.active(in: text, caret: caret), trigger.query.isEmpty {
            return anchor(trigger)
        }
        if let tag = HashTagTrigger.active(in: text, caret: caret), tag.query.isEmpty {
            return MenuAnchor(trigger: "#", location: tag.range.location)
        }
        return nil
    }

    func selectionChanged(in field: BlockField) {
        guard field === self.field else { return }
        syncToolbar()
        refreshTypingState()
        let textView = field.textView
        let range = textView.selectedRange
        let selected = range.length > 0
        // Selecting brings up the format slide, and collapsing the selection
        // takes it away again; `Aa` and its back chevron switch it by hand.
        if selected != hasSelection { formatting = selected }
        hasSelection = selected
        var marks: Set<String>?
        if range.length > 0 {
            textView.attributedText.enumerateAttribute(.memryMarks, in: range) { value, _, _ in
                let here = Set(value as? [String] ?? [])
                marks = marks.map { $0.intersection(here) } ?? here
            }
        }
        selectionMarks = marks ?? []
        // A code block keeps `[[`, `@`, `/` and `#` as literal text, as
        // desktop's does: no menu opens there.
        let inCode = field.block.kind == "codeBlock"
        let typed = range.length == 0 && !inCode ? InlineTrigger.active(in: textView.text, caret: range.location) : nil
        let typedTag = range.length == 0 && !inCode
            ? HashTagTrigger.active(in: textView.text, caret: range.location) : nil
        // The caret left the opened trigger, or the trigger went: its menu
        // stays closed, even with the caret back beside it.
        let typedMenu = typed.map(Self.anchor)
        let typedTagMenu = typedTag.map { MenuAnchor(trigger: "#", location: $0.range.location) }
        if typedMenu != openedMenu, typedTagMenu != openedMenu { openedMenu = nil }
        let next = typedMenu == openedMenu ? typed : nil
        if next != trigger {
            let leftWiki: Bool = if case .wiki = trigger { next == nil } else { false }
            trigger = next
            suggestions = switch next {
            case let .wiki(_, query): EditorSuggestions.wiki(query: query, notes: linkNotes)
            case let .mention(_, query): EditorSuggestions.mention(query: query, titles: linkNotes.map(\.title))
            case let .slash(_, query): slashSuggestions(query: query)
            case nil: []
            }
            // A `@` query nothing answers closes the menu, as desktop's does.
            if case .mention = next, suggestions.isEmpty { trigger = nil }
            if case .slash = next, suggestions.isEmpty { trigger = nil }
            // The caret left a finished `[[target]]`: it becomes a link.
            // Not in keys held for a Return's new block (#4692): drawn here,
            // the link would reach that block as a bare placeholder.
            if leftWiki, !holdsKeys(field), !WikiLinkText.typed(in: textView.text, since: field.base).isEmpty {
                commit(field)
            }
        }
        let nextTag = trigger == nil && typedTagMenu == openedMenu ? typedTag : nil
        if nextTag != tagTrigger {
            tagTrigger = nextTag
            tagSuggestions = nextTag.map { TagSuggestions.rank(query: $0.query, tags: tags) } ?? []
            if tagSuggestions.isEmpty { tagTrigger = nil }
        }
    }

    /// Esc over an open menu: it closes until its trigger is typed again.
    func closeMenu() {
        openedMenu = nil
        trigger = nil
        suggestions = []
        tagTrigger = nil
        tagSuggestions = []
    }

    private static func anchor(_ trigger: InlineTrigger) -> MenuAnchor {
        let character: Character = switch trigger {
        case .wiki: "["
        case .mention: "@"
        case .slash: "/"
        }
        return MenuAnchor(trigger: character, location: trigger.range.location)
    }

    /// A menu's rows changed: the highlight goes back to the first, and a
    /// closed menu forgets the arrows, so on-screen Return makes a block
    /// again once the keyboard is detached.
    private func menuChanged() {
        highlighted = 0
        if !menuOpen { highlightMoved = false }
    }

    // MARK: Ordered writes

    /// Every committed write ends here: a sync pass is scheduled, then the
    /// page re-reads the document.
    func didChange() async {
        if let generation = Self.running { landed(generation) }
        requestSync?()
        await reload()
    }

    /// Runs `work` after every write queued before it: a mark must land after
    /// the commit of the text it marks. Answers its write generation.
    @discardableResult
    func enqueue(_ work: @escaping @MainActor () async -> Void) -> Int {
        queuedWrites += 1
        let generation = queuedWrites
        let previous = tail
        tail = Task { @MainActor [weak self] in
            await previous?.value
            await Self.$running.withValue(generation) { await work() }
            self?.landed(generation)
        }
        return generation
    }

    private func landed(_ generation: Int) {
        landedWrites = max(landedWrites, generation)
    }

    /// Writes what the user typed in `field`, then turns a `[[target]]` typed
    /// since the last commit into a link node (desktop's input rule). Never
    /// in a code block, whose text stays literal. Answers where a UTF-16
    /// location in `field` before the commit is after it, with each such
    /// link drawn as its one-character node. `nodes` puts zero-width inline
    /// nodes in after the typing and answers the ones that landed, which join
    /// the typing's undo step. `over` puts nodes over text in `field`, such
    /// as a `#tag`, as the typed links go (`NoteEditorViewModel.insert`).
    /// `typing` is the text without what `nodes` and `over` brought: the
    /// typing up to it is its own undo step, so undo takes back the nodes
    /// and not the typing before them (#4796). `drawing` draws chips for the
    /// nodes in the row once the typed links are drawn, given where a
    /// location before them is after them.
    @discardableResult
    func commit(
        _ field: BlockField,
        then: (@MainActor () async -> Void)? = nil,
        typing: String? = nil,
        over: [EditorUndoStep.TextNode] = [],
        drawing: ((Int) -> Int) -> Void = { _ in },
        inserting nodes: (@MainActor (NoteEditorViewModel) async -> [EditorUndoStep.PlacedNode])? = nil
    ) -> (Int) -> Int {
        // Keys held for a Return's new block commit here instead (Tab, ⌘B,
        // leaving the app): moved on later, they would leave undo steps that
        // write them twice.
        keepHeldKeys(in: field)
        // Held by the queued write, not read when it runs: a page torn down
        // (a split view swapping notes, Back, a size-class re-host) drops
        // the model before its last typing lands.
        guard let model else {
            Log.storage.error("a block commit had no editor model")
            return { $0 }
        }
        let attributed = field.textView.attributedText ?? NSAttributedString()
        let text = attributed.string
        let blockId = field.blockId
        let dirty = field.dirty
        let base = field.base
        let links = dirty && field.block.kind != "codeBlock" ? WikiLinkText.typed(in: text, since: base) : []
        let overText = links.map { link in
            NoteEditorViewModel.wikiLinkNode(
                WikiLinkText.Typed(
                    start: BlockText.coreOffset(in: attributed, utf16: link.range.location),
                    literal: (text as NSString).substring(with: link.range),
                    target: link.target, alias: link.alias
                ),
                in: blockId
            )
        } + over
        let length = BlockText.coreOffset(in: attributed, utf16: attributed.length)
        field.dirty = false
        if dirty {
            field.base = text
            field.textView.forgetTyping()
        }
        if field === self.field { refreshTypingState() }
        // The literal text goes now, not when the page reloads: typing that
        // lands before the reload would keep it, and the next commit's base
        // would still spell a link the core already holds as a node.
        let draw = BlockField.beginDraw()
        let moved = links.isEmpty ? { $0 } : field.drawLinks(links)
        drawing(moved)
        // The row's base with this commit's chips drawn: `text` when it
        // drew none.
        let drawn = field.base
        let wrote = dirty && text != base
        // The session too, so the write still schedules its sync pass.
        let generation = enqueue {
            // Queued behind a commit that failed, `base` holds typing the
            // core never got: the change goes from what it holds (#4773).
            let failed = self.unlanded[blockId].flatMap {
                dirty && ($0.typed == base || $0.drawn == base) && (Self.running ?? 0) <= $0.queued ? $0 : nil
            }
            let from = failed?.held ?? base
            // Its chips the core never got go as the text they replaced.
            let carried = failed?.draws ?? []
            let sent = carried.isEmpty ? text : BlockField.undrawn(attributed, draws: carried)
            let sends = dirty && sent != from
            let (landed, held) = sends ? await model.commit(sent, for: blockId, base: from) : (true, sent)
            if dirty {
                self.unlanded[blockId] = landed
                    ? nil : (typed: text, drawn: drawn, draws: carried.union([draw]), held: held, queued: self.queuedWrites)
            }
            // Not written: the block's row keeps its text unsaved, so a
            // redraw keeps it and the next commit sends it again
            // (REVIEW-4700). The row that took this one's typing over
            // (`BlockField.takeOver`) is the block's row now. A row whose
            // base a later commit moved on has that commit queued, which
            // sends this typing too.
            let row = self.drawnFields.object(forKey: blockId as NSString).flatMap { $0.blockId == blockId ? $0 : nil } ?? field
            // A row still on this commit's drawn chips gets back the text
            // they replaced, and keeps it unsaved the same way (REVIEW-4784).
            if !landed, row.base == text || (drawn != text && row.base == drawn) {
                row.undraw(carried.union([draw]))
                row.base = held
                row.dirty = true
            }
            // Not after a failed write: their places hold typing the core
            // never got, and they would go at the block's end (REVIEW-4784).
            let converted = !landed || overText.isEmpty
                ? [] : await model.insert(overText, over: blockId, typedLength: length)
            let added = landed ? await nodes?(model) ?? [] : []
            // From `from`, as the write: the block may hold another pane's
            // typing since, which undo and redo keep. To this pane's text
            // with the nodes in, so undo takes them back too. A node over
            // text, such as a `#tag`, keeps its literal for redo to find.
            // Only over a text write that landed: undo would replay a change
            // the core never had. Nor when a failed commit's chips were
            // swapped out of this text: its nodes' places count them.
            let placed = !converted.isEmpty || !added.isEmpty
            if landed, placed, sent == text {
                let spans = converted.map { $0.start ..< $0.start + $0.literal.utf8.count } + added.compactMap { Self.span($0.edit) }
                let typed = typing ?? from
                if typed != from { self.history.record(.text(blockId: blockId, from: from, to: typed)) }
                self.history.record(.text(
                    blockId: blockId, from: typed, typed: text, typedLength: length, overText: converted,
                    nodes: added, to: BlockText.placingNodes(spans, in: attributed),
                    caret: (field.pendingSelection ?? field.textView.selectedRange).location
                ))
            } else if landed, sends, !placed {
                self.history.record(.text(blockId: blockId, from: from, to: sent))
            }
            await then?()
            if dirty || !overText.isEmpty || nodes != nil || then != nil {
                await self.didChange()
                self.caughtUp(blockId)
            }
        }
        // A commit that sends nothing holds back no read.
        if wrote || !overText.isEmpty || nodes != nil { field.written = generation }
        return moved
    }

    /// The core range an `insertInline` replaced.
    private static func span(_ edit: BlockEdit) -> Range<Int>? {
        guard case let .insertInline(_, start, end, _, _, _) = edit else { return nil }
        return Int(start) ..< Int(max(start, end))
    }

    /// Commits the focused block (if any), then runs `work` against it.
    private func withFocused(_ work: @escaping @MainActor (NoteEditorViewModel, String) async -> Void) {
        guard let field else { return }
        let blockId = field.blockId
        commit(field) { [weak self] in
            guard let model = self?.model else { return }
            await work(model, blockId)
        }
    }

    // MARK: Blocks

    func turnInto(_ block: InsertableBlock) {
        withFocused { [weak self] model, blockId in
            await self?.turn(model, blockId, into: block)
        }
    }

    func turn(_ model: NoteEditorViewModel, _ blockId: String, into block: InsertableBlock) async {
        let previous = focusedKind ?? "paragraph"
        history.record(await model.turnIntoStep(blockId, into: block, from: previous))
        focusedKind = block.kind
        focusedLevel = block.level
    }

    /// `textColor` or `backgroundColor` on the block itself, as desktop's
    /// side-menu colour picker writes them.
    func setBlockColor(_ prop: String, _ name: String) {
        let previous = focusedProps[prop] ?? "default"
        focusedProps[prop] = name
        withFocused { [weak self] model, blockId in
            await model.setProp(blockId, prop, name)
            self?.history.record(.prop(blockId: blockId, name: prop, from: previous, to: name, label: "Colour"))
        }
    }

    // MARK: Marks

    /// Toggles a boolean mark, or sets a valued one, over the selection.
    func toggleMark(_ mark: String, value: String? = nil) {
        guard let field else { return }
        let range = field.textView.selectedRange
        guard range.length > 0 else { return }
        let text = field.textView.attributedText ?? NSAttributedString()
        let start = BlockText.coreOffset(in: text, utf16: range.location)
        let end = BlockText.coreOffset(in: text, utf16: NSMaxRange(range))
        let removing = value == nil && selectionMarks.contains(mark) || value == "default"
        // What undo puts back: a plain mark carries no value, and a valued
        // one's value is read from the drawn block, when the selection holds
        // one value throughout. Otherwise the removal is not undoable here.
        let restore: String?? = if !removing {
            nil
        } else if !Self.valuedMarks.contains(mark) {
            selectionMarks.contains(mark) ? .some(nil) : nil
        } else if !field.dirty {
            Self.markValue(mark, in: field.block.inline, from: start, to: end)
        } else {
            nil
        }
        field.pendingSelection = range
        withFocused { [weak self] model, blockId in
            if removing {
                await model.unmark(blockId, from: start, to: end, mark)
                if case let .some(previous) = restore {
                    let lower = UInt32(max(0, start))
                    let upper = UInt32(max(0, end))
                    self?.history.record(EditorUndoStep(
                        name: "Formatting",
                        backward: .setMark(blockId: blockId, start: lower, end: upper, mark: mark, value: previous),
                        forward: .removeMark(blockId: blockId, start: lower, end: upper, mark: mark)
                    ))
                }
            } else {
                await model.mark(blockId, from: start, to: end, mark, value: value)
                self?.history.record(.mark(blockId: blockId, start: start, end: end, mark: mark, value: value))
            }
        }
    }

    /// Marks whose value is part of what they say.
    private static let valuedMarks: Set<String> = ["textColor", "backgroundColor", "link"]

    /// The value `mark` holds over every core byte of `start..<end`: `nil`
    /// when a byte lacks the mark or the values differ, `.some(nil)` for a
    /// mark with no value.
    static func markValue(_ mark: String, in runs: [InlineRun], from start: Int, to end: Int) -> String?? {
        var values = Set<String?>()
        var offset = 0
        for run in runs {
            let length = run.text.utf8.count
            defer { offset += length }
            guard length > 0, offset < end, offset + length > start else { continue }
            guard run.marks.contains(mark) else { return nil }
            values.insert(run.markAttrs[mark])
        }
        return values.count == 1 ? values.first : nil
    }

    // MARK: Inline nodes

    /// The slash menu's link row: `[[]]` with the caret between, which opens
    /// the menu.
    func startWikiLink() {
        guard let textView = field?.textView else { return }
        show(.none)
        textView.insertText("[[]]")
        let caret = textView.selectedRange.location
        textView.selectedRange = NSRange(location: max(0, caret - 2), length: 0)
        if let field { openMenu(in: field) }
    }

    /// The `@` and `#` buttons: the trigger at the caret, after a space when
    /// the caret ends a word, so the menu opens as if typed.
    func startTrigger(_ character: String) {
        guard let field else { return }
        let textView = field.textView
        // Commit the composition before `show` reloads the input views. The
        // commit writes the composed text back over its own range: with the
        // Japanese keyboard, `unmarkText()` and the reload can both drop it.
        if let marked = textView.markedTextRange, let composed = textView.text(in: marked) {
            textView.replace(marked, withText: composed)
            // Ends the keyboard's composition too, or it composes `にほn` again into the next keys.
            textView.inputDelegate?.selectionWillChange(textView)
            textView.inputDelegate?.selectionDidChange(textView)
        }
        show(.none)
        let caret = textView.selectedRange.location
        let string = textView.text as NSString
        let before = caret > 0 && caret <= string.length ? string.character(at: caret - 1) : 32
        let wordEnds = before != 32 && before != 9 && before != 10 && before != 0xA0 && before != 0xFFFC
        textView.insertText(wordEnds ? " " + character : character)
        openMenu(in: field)
    }

    /// Replaces the open `#query` with a `hashTag` node and a space, as
    /// desktop's tag menu does. Undo takes back the tag and not the typing
    /// before it (#4804), as `insertInline`.
    func chooseTag(_ suggestion: TagSuggestion) {
        guard let field, let tagTrigger else { return }
        let textView = field.textView
        let range = tagTrigger.range
        let typing = Self.typing(without: range, in: field, query: true)
        let after = NSMaxRange(range)
        let string = textView.text as NSString
        if after >= string.length || string.character(at: after) != 32 {
            textView.textStorage.insert(
                NSAttributedString(string: " ", attributes: BlockText.baseAttributes(field.style)), at: after
            )
            field.dirty = true
        }
        let attributed = textView.attributedText ?? NSAttributedString()
        let start = BlockText.coreOffset(in: attributed, utf16: range.location)
        let end = BlockText.coreOffset(in: attributed, utf16: after)
        field.pendingSelection = NSRange(location: range.location + 2, length: 0)
        self.tagTrigger = nil
        tagSuggestions = []
        let edit = BlockEdit.insertInline(
            blockId: field.blockId, start: UInt32(start), end: UInt32(end), kind: "hashTag", text: "",
            attrs: HashTagAttrs.attrs(tag: suggestion.tag, colors: tagColors)
        )
        commit(field, typing: typing, over: [.init(start: start, literal: string.substring(with: range), edit: edit)])
    }

    // MARK: The focused block's place

    /// The block with the caret, as the page last drew it.
    var focusedBlock: Block? {
        guard let focusedBlockId else { return nil }
        return blocks().first { $0.id == focusedBlockId }
    }

    /// Its neighbours at its own depth, which Move up and Move down swap it
    /// with and indent nests it under.
    var focusedSiblings: BlockSiblings {
        let blocks = blocks()
        guard let focusedBlockId, let index = blocks.firstIndex(where: { $0.id == focusedBlockId }) else {
            return BlockSiblings()
        }
        return BlockSiblings.of(index, in: blocks)
    }

    var canIndent: Bool { focusedSiblings.canIndent }
    var canOutdent: Bool { focusedSiblings.canOutdent }

    /// The block menu's actions for the focused block.
    var focusedRunner: BlockActionRunner? {
        guard let block = focusedBlock else { return nil }
        return BlockActionRunner(session: self, target: BlockActionTarget(block: block, siblings: focusedSiblings))
    }

    /// The toolbar's scrolling items for the focused block.
    var toolbarItems: [EditorToolbarItem] { EditorToolbarItem.scrolling(for: focusedKind) }

    func showFormatting(_ on: Bool) {
        formatting = on
    }

    /// The `...` menu's Copy text: the block's text, inline nodes as they read.
    func copyFocusedText() {
        guard let field else { return }
        UIPasteboard.general.string = field.dirty
            ? field.textView.text.replacingOccurrences(of: BlockText.placeholder, with: "")
            : Self.plainText(field.block.inline)
    }

    static func plainText(_ runs: [InlineRun]) -> String {
        runs.map(\.text).joined()
    }

    // MARK: Move to another note

    /// Desktop hides Move to on a block that owns an attachment
    /// (`ATTACHMENT_BLOCK_TYPES` and `carriesAttachment` in
    /// `block-side-menu.tsx`): the bytes live under the owning note, and the
    /// embed would break on every other device. The nested blocks move too,
    /// so they are checked as well.
    static let attachmentKinds: Set<String> = ["file", "image", "video", "audio"]

    static func carriesAttachment(at index: Int, in blocks: [Block]) -> Bool {
        subtree(at: index, in: blocks).contains { block in
            attachmentKinds.contains(block.kind) || block.inline.contains { $0.marks.contains("inlineImage") }
        }
    }

    /// The block at `index` and every block nested under it.
    static func subtree(at index: Int, in blocks: [Block]) -> ArraySlice<Block> {
        guard blocks.indices.contains(index) else { return [] }
        let depth = blocks[index].depth
        let end = blocks[(index + 1)...].firstIndex { $0.depth <= depth } ?? blocks.endIndex
        return blocks[index..<end]
    }

    /// Task ids of the task lines that move with the block at `index`
    /// (desktop's `taskIdsInBlocks`).
    static func taskIds(at index: Int, in blocks: [Block]) -> [String] {
        subtree(at: index, in: blocks).compactMap { block in
            guard block.kind == "taskBlock",
                  let id = block.props.first(where: { $0.name == "taskId" })?.value, !id.isEmpty else { return nil }
            return id
        }
    }

    var canMoveToNote: Bool {
        guard model?.canMoveBlocks == true, let focusedBlockId else { return false }
        let blocks = blocks()
        guard let index = blocks.firstIndex(where: { $0.id == focusedBlockId }) else { return false }
        return !Self.carriesAttachment(at: index, in: blocks)
    }

    /// The `...` menu's Move to: the keyboard goes first, so the block's
    /// typing is committed before the picker opens.
    func requestMoveToNote() {
        guard let focusedBlockId else { return }
        dismissKeyboard()
        moveRequest = BlockMoveRequest(blockId: focusedBlockId)
    }

    func cancelMoveToNote() {
        moveRequest = nil
    }

    // MARK: Dates

    /// Opens the editor for a tapped date or reminder chip.
    func requestDateEdit(_ chip: DateMentionChip, in field: BlockField) {
        dismissKeyboard()
        dateEditField = field
        dateEdit = DateMentionEditRequest(blockId: field.blockId, anchorId: chip.anchorId, value: chip.value)
    }

    func cancelDateEdit() {
        dateEdit = nil
        dateEditField = nil
    }

    /// Rewrites the open chip. An update rewrites the node under the same
    /// anchor where the block holds it (`NoteEditorViewModel.rewriteDate`),
    /// after the block's typing, as one undo step; the text view keeps the
    /// chip, so the page's re-read draws the new date (#4762). A conversion
    /// or a removal swaps the chip's character in the text view for the
    /// date's words, or nothing, and commits it like typing.
    func applyDateEdit(_ edit: DateMentionEdit) {
        guard let request = dateEdit, let field = dateEditField, field.blockId == request.blockId,
              let range = field.dateChipRange(anchorId: request.anchorId)
        else { return cancelDateEdit() }
        cancelDateEdit()
        let replacement: String
        switch edit {
        case let .update(value):
            return rewriteDate(request, at: range, in: field, to: value)
        case .convertToText:
            replacement = DateMentionRemind.plainText(request.value)
        case .remove:
            replacement = ""
        }
        let attributes = BlockText.baseAttributes(field.style)
        field.textView.textStorage.replaceCharacters(
            in: range, with: NSAttributedString(string: replacement, attributes: attributes)
        )
        field.dirty = true
        commit(field)
    }

    private func rewriteDate(_ request: DateMentionEditRequest, at range: NSRange, in field: BlockField, to value: DateMentionValue) {
        // Done with nothing changed: no write, and no empty undo step (#4764).
        guard value != request.value else { return }
        // Held now, as `commit` holds it: a page torn down drops its model.
        guard let model else {
            Log.storage.error("a date edit had no editor model")
            return
        }
        let blockId = field.blockId
        // The chip's place once the commit has drawn a typed `[[…]]` as its
        // node, as the core holds it when the chip is rewritten.
        let moved = commit(field)
        let chip = DateChipAnchor(
            anchorId: request.anchorId,
            place: NodeAnchor.at(moved(range.location), in: field.textView.attributedText ?? NSAttributedString(), replaces: true)
        )
        field.written = enqueue { [weak self] in
            if await model.rewriteDate(chip, in: blockId, to: value) {
                self?.history.record(.date(blockId: blockId, chip: chip, from: request.value, to: value))
            }
            await self?.didChange()
            self?.caughtUp(blockId)
        }
    }

    /// The row of `blockId` takes the page's blocks once its run has
    /// re-read them. A run that left the block as it was (a refused date
    /// edit, nodes that did not land) re-reads the block the row skipped
    /// as older while the run was queued, and SwiftUI does not update a
    /// row whose block did not change, so the skipped read is drawn here.
    private func caughtUp(_ blockId: String) {
        guard let field = drawnFields.object(forKey: blockId as NSString), field.blockId == blockId,
              let block = blocks().first(where: { $0.id == blockId })
        else { return }
        field.receive(block, generation: drawnGeneration())
    }

    // MARK: Source blocks

    /// Opens the source sheet for a math or diagram block.
    func editSource(_ request: BlockSourceRequest) {
        dismissKeyboard()
        sourceEdit = request
    }

    func cancelSourceEdit() {
        sourceEdit = nil
    }

    /// The sheet's Done: the source is written once, as desktop writes it
    /// when its popover closes, and only when it changed.
    func saveSource(_ text: String) {
        guard let request = sourceEdit else { return }
        sourceEdit = nil
        guard text != request.source else { return }
        runBlockAction { [weak self] model in
            switch request.kind {
            case .math:
                await model.setProp(request.blockId, "latex", text)
                self?.history.record(.prop(
                    blockId: request.blockId, name: "latex", from: request.source, to: text, label: "Equation"
                ))
            case .diagram:
                // A diagram's source is its plain content: `ReplaceText`
                // edits it in place, so a peer's concurrent edit survives.
                await model.commit(text, for: request.blockId, base: request.source)
                self?.history.record(.text(blockId: request.blockId, from: request.source, to: text))
            }
        }
    }

    /// Moves the requested block to the end of `targetId`'s body, after every
    /// queued write. Not undoable here: the block now lives in another note.
    func moveToNote(_ targetId: String) {
        guard let request = moveRequest else { return }
        moveRequest = nil
        enqueue { [weak self] in
            guard let self, let model = self.model else { return }
            let blocks = self.blocks()
            let taskIds = blocks.firstIndex { $0.id == request.blockId }
                .map { Self.taskIds(at: $0, in: blocks) } ?? []
            if let failure = await model.moveBlock(request.blockId, toNote: targetId) {
                self.failure = failure
            } else if let relink = self.relinkTask {
                for taskId in taskIds { await relink(taskId, targetId) }
            }
            await self.didChange()
        }
    }

    // MARK: Nesting and attachments

    /// Nests the caret's block under its previous sibling (`true`), or lifts
    /// it out a level; the core refuses an indent with nothing to nest under.
    func nest(_ indent: Bool) {
        withFocused { [weak self] model, blockId in
            let step = EditorUndoStep.nest(blockId: blockId, indent: indent)
            await model.apply(step.forward)
            self?.history.record(step)
            self?.pendingFocus = blockId
        }
    }

    /// Opens an attachment picker once the open block's typing is written.
    /// That write ends in a page reload, which would tear down a picker
    /// already on screen.
    func openAttachment(_ source: EditorAttachmentSource) {
        guard let attach else { return }
        if let field { commit(field) }
        enqueue { attach(source) }
    }

    /// The link sheet for a Bookmark or YouTube row, for a block after the
    /// caret's. The keyboard goes first, so the block's typing is committed.
    func requestLink(_ kind: LinkBlock.Kind) {
        linkRequest = LinkBlockRequest(kind: kind, after: field?.blockId)
        if let field { commit(field) }
        dismissKeyboard()
    }

    func cancelLink() {
        linkRequest = nil
    }

    /// The View row: the query sheet for a new view block after the caret's.
    /// Nothing is written until Done, so Cancel leaves the note as it was.
    func requestView() {
        viewEdit = ViewQueryRequest(blockId: nil, after: field?.blockId, text: "")
        if let field { commit(field) }
        dismissKeyboard()
    }

    func editView(blockId: String, text: String) {
        dismissKeyboard()
        viewEdit = ViewQueryRequest(blockId: blockId, after: nil, text: text)
    }

    func cancelViewEdit() {
        viewEdit = nil
    }

    func editWhiteboard(_ request: WhiteboardEditRequest) {
        dismissKeyboard()
        whiteboardEdit = request
    }

    /// The editor closed: its saves are on the canvas, which the block
    /// re-reads and the next sync pass pushes.
    func finishWhiteboard() {
        whiteboardEdit = nil
        whiteboardRevision += 1
        requestSync?()
    }

    /// Done: a new `memry-view` code block, undone as one step, or the
    /// edited block's fence replaced in place (`ReplaceText`), so a peer's
    /// concurrent edit survives.
    func saveView(_ text: String) {
        guard let request = viewEdit else { return }
        viewEdit = nil
        if let blockId = request.blockId {
            guard text != request.text else { return }
            runBlockAction { [weak self] model in
                await model.commit(text, for: blockId, base: request.text)
                self?.history.record(.text(blockId: blockId, from: request.text, to: text))
            }
            return
        }
        enqueue { [weak self] in
            guard let self, let model = self.model,
                  let newId = await model.insert("codeBlock", after: request.after, text: text) else { return }
            let language = BlockEdit.setProp(blockId: newId, name: "language", value: ViewBlockFence.language)
            await model.apply(language)
            var step = EditorUndoStep.insert(blockId: newId, after: request.after, kind: "codeBlock", text: text)
            step.forwardProps = [language]
            self.history.record(step)
            await self.didChange()
        }
    }

    func insertLink(_ block: LinkBlock) {
        guard let request = linkRequest else { return }
        linkRequest = nil
        enqueue { [weak self] in
            guard let self, let model = self.model,
                  let newId = await model.insert(block.kind, after: request.after) else { return }
            let edits = block.edits(newId: newId, after: request.after)
            for edit in edits.dropFirst() { await model.apply(edit) }
            self.history.record(EditorUndoStep(
                name: "Insert block", backward: .delete(blockId: newId), forward: edits[0], forwardProps: Array(edits.dropFirst())
            ))
            await self.didChange()
        }
    }

    /// An uploaded attachment's block, after `target`: the block a file was
    /// dropped on. A picked file goes after the caret's block (or at the end
    /// of the body when none has had the caret). Undo removes the block and
    /// keeps the upload, as desktop's undo does. Answers the new block's id
    /// once it is written, so the next of a batch goes after it; `nil` when
    /// the insert failed, which the editor's status shows.
    @discardableResult
    func insertAttachment(_ block: AttachmentBlock, after target: String? = nil) async -> String? {
        let after = target ?? field?.blockId
        if let field { commit(field) }
        return await withCheckedContinuation { done in
            enqueue { [weak self] in
                guard let self, let model = self.model,
                      let newId = await model.insert(block.kind, after: after)
                else { return done.resume(returning: nil) }
                let props = block.props.map { BlockEdit.setProp(blockId: newId, name: $0.name, value: $0.value) }
                for prop in props { await model.apply(prop) }
                var step = EditorUndoStep.insert(blockId: newId, after: after, kind: block.kind, text: "")
                step.forwardProps = props
                self.history.record(step)
                await self.didChange()
                done.resume(returning: newId)
            }
        }
    }

    /// Replaces the open `[[` / `@` text with the chosen node and a space,
    /// as desktop's menus insert it.
    func choose(_ suggestion: EditorSuggestion) {
        if case let .slash(row) = suggestion.kind { return chooseSlash(row) }
        guard let field, let trigger else { return }
        insertInline([suggestion.kind], replacing: trigger.range, in: field, query: true)
    }

    /// `range` of the focused block replaced with a link or date node and a
    /// space.
    func insertInline(_ kind: EditorSuggestion.Kind, replacing range: NSRange) {
        guard let field else { return }
        insertInline([kind], replacing: range, in: field)
    }

    /// `range` of `field` replaced with each node, in order, each followed
    /// by a space: the menus' path, and a drop's (#4357). Typing not yet
    /// committed in `field` is written first, so the nodes land in it, as
    /// its own undo step: undo takes back the nodes and not the typing
    /// before them (#4796). The part of `range` that typing wrote goes with
    /// that step, and a part already committed with the nodes'. `query`:
    /// `range` is a typed trigger query, not a selection or a drop point.
    func insertInline(
        _ kinds: [EditorSuggestion.Kind], replacing range: NSRange, in field: BlockField, query: Bool = false
    ) {
        let textView = field.textView
        let typing = Self.typing(without: range, in: field, query: query)
        textView.textStorage.deleteCharacters(in: range)
        field.dirty = true
        // The trailing spaces go in as text first, so each node lands before
        // its own.
        let string = textView.text as NSString
        let spaced = range.location < string.length && string.character(at: range.location) == 32
        let spaces = spaced ? kinds.count - 1 : kinds.count
        if spaces > 0 {
            textView.textStorage.insert(
                NSAttributedString(string: String(repeating: " ", count: spaces), attributes: BlockText.baseAttributes(field.style)),
                at: range.location
            )
        }
        if field === self.field {
            trigger = nil
            suggestions = []
        }
        let blockId = field.blockId
        // Each node as the row draws it and the core gets it, a date under
        // the anchor its chip carries.
        let nodes: [(kind: EditorSuggestion.Kind, run: InlineRun?, anchorId: String?)] = kinds.map { kind in
            switch kind {
            case let .note(title, alias), let .create(title, alias):
                let attrs = WikiLinkAttrs.attrs(target: title, alias: alias)
                return (kind, Self.node("wikiLink", attrs), nil)
            case let .date(value):
                let anchorId = DateMentionValue.mintAnchorId()
                return (kind, Self.node("dateMention", value.attrs(anchorId: anchorId)), anchorId)
            case .slash:
                return (kind, nil, nil)
            }
        }
        // Read once the commit has drawn a typed `[[…]]` before `range` as
        // its node, as the core holds it when the nodes go in. Each node
        // goes before its own space.
        var anchors: [NodeAnchor] = []
        commit(field, typing: typing, drawing: { moved in
            let location = moved(range.location)
            let text = textView.attributedText ?? NSAttributedString()
            anchors = kinds.indices.map { NodeAnchor.at(location + $0, in: text, replaces: false) }
            // Drawn now, as `commit` draws a typed `[[…]]` (#4780): keys typed
            // before the nodes land leave the row dirty, a dirty row is never
            // redrawn, and the chips stayed off screen until its next commit.
            field.drawNodes(nodes.compactMap(\.run), at: location)
            field.pendingSelection = NSRange(location: location + 2 * kinds.count, length: 0)
        }, inserting: { model in
            var edits: [EditorUndoStep.PlacedNode] = []
            // Last first, so each node's offset still counts only the spaces
            // before it.
            for (node, at) in zip(nodes, anchors).reversed() {
                switch node.kind {
                case let .note(title, alias):
                    if let edit = await model.insertWikiLink(in: blockId, at: at, title: title, alias: alias) { edits.append(edit) }
                case let .create(title, alias):
                    await model.createNote(titled: title)
                    if let edit = await model.insertWikiLink(in: blockId, at: at, title: title, alias: alias) { edits.append(edit) }
                case let .date(value):
                    if let edit = await model.insertDateMention(in: blockId, at: at, value: value, anchorId: node.anchorId) {
                        edits.append(edit)
                    }
                case .slash:
                    break
                }
            }
            return edits
        })
    }

    /// `field`'s text without the part of `range` that typing wrote since
    /// its base: a pick's `typing` (`commit`).
    private static func typing(without range: NSRange, in field: BlockField, query: Bool) -> String {
        let text = field.textView.text ?? ""
        let span = Self.typed(since: field.base, in: text)
        // The prefix/suffix guess places typing that repeats the text beside
        // it at the wrong end (`#ta` typed before `#task`). `range` itself is
        // the typing when taking it out leaves exactly the rest (#4810). Only
        // a query is known to be typed: a selection can cover committed text
        // the typing repeats (REVIEW-4831).
        let removed = (text as NSString).replacingCharacters(in: range, with: "")
        if query, range.length > 0, Self.typed(since: field.base, in: removed).length == span.length - range.length {
            return removed
        }
        // No intersection leaves its location undefined.
        let typed = NSIntersectionRange(range, span)
        return typed.length == 0 ? text : (text as NSString).replacingCharacters(in: typed, with: "")
    }

    /// What typing changed in `text` since `base`: the span between their
    /// common prefix and common suffix.
    private static func typed(since base: String, in text: String) -> NSRange {
        let base = base as NSString, text = text as NSString
        var prefix = 0
        while prefix < min(base.length, text.length), base.character(at: prefix) == text.character(at: prefix) {
            prefix += 1
        }
        var suffix = 0
        while suffix < min(base.length, text.length) - prefix,
              base.character(at: base.length - 1 - suffix) == text.character(at: text.length - 1 - suffix) {
            suffix += 1
        }
        return NSRange(location: prefix, length: text.length - prefix - suffix)
    }

    /// An inline node run of `mark`, with `attrs` under the mark's prefix,
    /// as the core reads it back.
    private static func node(_ mark: String, _ attrs: [String: String]) -> InlineRun {
        InlineRun(
            text: "", marks: [mark],
            markAttrs: Dictionary(uniqueKeysWithValues: attrs.map { ("\(mark).\($0.key)", $0.value) }), target: nil
        )
    }

    // MARK: Undo

    /// What `undo()` and `redo()` would take: typing counts only while the
    /// block holds uncommitted typing, and nothing while an IME composition
    /// is open. Changed typing is a new edit: its commit records a step,
    /// which ends redo, so only its own typing redo is left.
    var canUndo: Bool {
        _ = typingState
        return !composing && (history.canUndo || typingChanged || pendingTyping?.canUndo == true)
    }

    var canRedo: Bool {
        _ = typingState
        return !composing && (pendingTyping?.canRedo == true || !typingChanged && history.canRedo)
    }

    /// What `canUndo` and `canRedo` read from the open text view, which
    /// nothing observes. They read this copy so the toolbars redraw as
    /// typing starts, composes or is committed, and the text view itself
    /// for the answer.
    private(set) var typingState = TypingState()

    struct TypingState: Equatable {
        var changed = false
        var composing = false
        var undo = false
        var redo = false
    }

    private func refreshTypingState() {
        let now = TypingState(
            changed: typingChanged, composing: composing,
            undo: pendingTyping?.canUndo == true, redo: pendingTyping?.canRedo == true
        )
        if now != typingState { typingState = now }
    }

    private var composing: Bool { field?.textView.markedTextRange != nil }

    /// The open block holds typing that its commit will record as a step
    /// (`commit`).
    private var typingChanged: Bool {
        guard let field, field.dirty else { return false }
        return field.textView.text != field.base
    }

    /// The text view's typing undo, while the open block's typing is not yet
    /// committed. After a commit, the typing is a history step.
    private var pendingTyping: UndoManager? {
        field?.dirty == true ? field?.textView.editorUndo.typing() : nil
    }

    /// The open block's text before the latest run of typing undos, which
    /// typing redo would bring back (`undo`).
    @ObservationIgnored private var undoneTyping: (blockId: String, text: String)?

    /// Typing in the open block first, through the text view's own undo;
    /// then the writes this session made, newest first. The toolbar, ⌘Z
    /// and the system's undo all land here (`BlockUndoManager`).
    func undo() {
        // An IME composition keeps its text: a replay's reload would cancel
        // it (#4659). The undo waits for the composition to end.
        guard !composing else { return }
        if let field, let typing = pendingTyping, typing.canUndo {
            if !typing.canRedo { undoneTyping = (field.blockId, field.textView.text) }
            typing.undo()
            return
        }
        guard canUndo else { return }
        // The block step's replay drops the text view's typing redo, so typing
        // undone before it is kept as a history step to redo after it.
        var kept: EditorUndoStep?
        if let field, let undone = undoneTyping, undone.blockId == field.blockId,
           pendingTyping?.canRedo == true, undone.text != field.textView.text {
            kept = .text(blockId: field.blockId, from: field.textView.text, to: undone.text)
        }
        undoneTyping = nil
        // The commit records the changed typing, and this undo takes it back
        // off: the core ends as the block was drawn before the typing, and
        // SwiftUI may not update a row whose block did not change, so the
        // replay redraws the text view itself (`redrawing`).
        replay(redrawing: typingChanged ? field : nil) { history in
            if let kept { history.keepRedo(kept) }
            guard let step = history.popUndo() else { return nil }
            return { model in await model.undo(step) }
        }
    }

    func redo() {
        guard !composing else { return }
        if let typing = pendingTyping, typing.canRedo {
            typing.redo()
            return
        }
        guard canRedo else { return }
        replay { [weak self] history in
            guard let step = history.popRedo() else { return nil }
            return { model in
                await model.redo(step)
                if let caret = step.caret, let field = self?.field,
                   case let .replaceText(blockId, _, _) = step.forward, field.blockId == blockId {
                    field.pendingSelection = NSRange(location: caret, length: 0)
                }
            }
        }
    }

    /// Takes a step with `take` and applies its edits once the open block's
    /// typing is written and recorded: the reload that follows redraws the
    /// block from the core, which would drop typing it does not hold
    /// (#4659), and a step taken before that record would replay over text
    /// it never saw, ahead of it in the history.
    private func replay(
        redrawing reverted: BlockField? = nil,
        _ take: @escaping @MainActor (EditorUndoStack) -> (@MainActor (NoteEditorViewModel) async -> Void)?
    ) {
        let apply: @MainActor () async -> Void = { [weak self] in
            guard let self, let model = self.model, let run = take(self.history) else { return }
            await run(model)
            // Never over typing that landed during the writes: its next
            // commit sends the change from `base` onto the reverted core.
            if reverted?.dirty == false { reverted?.render() }
        }
        if let field {
            commit(field, then: apply)
            return
        }
        enqueue { [weak self] in
            await apply()
            await self?.didChange()
        }
    }

    /// A block action (`BlockActions.swift`): after every queued write, the
    /// open block's typing first, then the page reloads.
    func runBlockAction(_ work: @escaping @MainActor (NoteEditorViewModel) async -> Void) {
        if let field { commit(field) }
        enqueue { [weak self] in
            guard let self, let model = self.model else { return }
            await work(model)
            await self.didChange()
        }
    }

    func dismissKeyboard() {
        if panel != .none { show(.none) }
        field?.textView.resignFirstResponder()
    }
}

/// A block the note picker is open for.
struct BlockMoveRequest: Identifiable, Equatable {
    let blockId: String
    var id: String { blockId }
}

import MemryCore
import SwiftUI

// RD03 / RD04. The composer (Paper artboards 03–04): "+" opens it docked above
// the keyboard (the list's bottom `safeAreaInset`), on system glass. A status
// ring and the title field, a Notes line, then a row of chips (Date, Priority,
// Project, #, …) and the send button.
//
// The title field is the quick-add field (TP042): `@date`, `every …`,
// `!priority`, `+project`, `#tag` and `[[note]]` are painted inline from the
// core's parse spans as you type, and the chips fill from them live (RD04).
// Ghost completion and the project / tag / note suggestions show above the
// chips while a trigger is at the caret. Return is "next": it creates the
// task and keeps the composer open for the next one.

struct TaskComposer: View {
    let store: TasksStore
    let request: TaskComposerRequest
    /// The title as typed. Owned by the screen, so a draft closed by a tap
    /// outside the composer is still there when it opens again.
    @Binding var text: String
    let close: () -> Void

    @State private var isFocused = false
    @FocusState private var notesFocused: Bool
    @State private var parse: QuickAddParse?
    @State private var parsedText = ""
    @State private var picks = QuickAddPicks()
    @State private var noteOptions: [RelatedItemRecord] = []
    @State private var focusRequest = 0
    @State private var isSubmitting = false
    @State private var draft = TaskComposerDraft()
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        VStack(alignment: .leading, spacing: Tokens.Space.small) {
            HStack(alignment: .top, spacing: Tokens.Space.medium) {
                TaskStatusIcon(statusType: statusType, isDone: false)
                    .frame(minHeight: Tokens.Size.minimumHitArea)
                QuickAddTextView(
                    text: $text,
                    isFocused: $isFocused,
                    spans: currentSpans,
                    priority: parsedText == text ? parse?.priority ?? 0 : 0,
                    ghost: ghost?.remainder,
                    placeholder: TasksCopy.composerTitlePlaceholder,
                    onSubmit: { Task { await submit() } },
                    onAcceptGhost: acceptGhost,
                    focusRequest: focusRequest,
                    returnKey: .next,
                    showsDismissBar: false,
                    identifier: "tasks.composer.title",
                    onEscape: close
                )
            }
            TextField(TasksCopy.composerNotes, text: $draft.notes, axis: .vertical)
                .font(Tokens.Typography.supporting.font)
                .foregroundStyle(Tokens.Text.primary.color)
                .lineLimit(1 ... 4)
                .focused($notesFocused)
                .padding(.leading, statusLane)
                .accessibilityIdentifier("tasks.composer.notes")
            suggestions
            HStack(spacing: Tokens.Space.small) {
                TaskComposerChips(
                    store: store,
                    values: values,
                    draft: $draft,
                    insertTag: insertTagTrigger,
                    showsHelp: { showsHelp = true },
                    pickSheet: { sheet = $0 }
                )
                sendButton
            }
        }
        .padding(.top, Tokens.Space.medium)
        .padding(.leading, Tokens.Space.inset)
        .padding(.trailing, Tokens.Space.medium)
        .padding(.bottom, Tokens.Space.medium)
        .taskGlass(in: .rect(cornerRadius: Tokens.Radius.container))
        .padding(.horizontal, Tokens.Space.small)
        .padding(.bottom, Tokens.Space.small)
        .task(id: text) { await reparse() }
        .onAppear { focusRequest += 1 }
        .background { escapeShortcut }
        .sheet(isPresented: $showsHelp) { QuickAddHelpSheet() }
        .sheet(item: $sheet) { which in TaskComposerSheet(store: store, which: which, values: values, draft: $draft) }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(TasksCopy.composerLabel)
        .accessibilityIdentifier("tasks.composer")
    }

    @State private var showsHelp = false
    @State private var sheet: TaskComposerSheet.Which?

    // MARK: Pieces

    /// The title's leading inset: the status ring and its gap.
    private var statusLane: CGFloat { Tokens.Space.section + Tokens.Space.medium }

    private var statusType: String? {
        guard let id = values.statusId else { return "todo" }
        return store.project(values.projectId)?.statuses.first { $0.id == id }?.statusType
    }

    @ViewBuilder private var suggestions: some View {
        let options = trigger.map(options(for:)) ?? []
        if ghost != nil || !options.isEmpty {
            ScrollView(.horizontal) {
                HStack(spacing: Tokens.Space.small) {
                    if let ghost {
                        Button(action: acceptGhost) {
                            TaskComposerChip(text: ghost.text) {
                                Image(systemName: "arrow.forward.to.line").accessibilityHidden(true)
                            }
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel(TasksCopy.quickAddAcceptSuggestion(ghost.text))
                        .accessibilityIdentifier("tasks.quickAdd.acceptGhost")
                    }
                    if let trigger {
                        QuickAddSuggestions(options: options) { pick($0, for: trigger) }
                    }
                }
            }
            .scrollIndicators(.hidden)
        }
    }

    private var sendButton: some View {
        Button {
            Task { await submit() }
        } label: {
            Image(systemName: "arrow.up")
                .font(Tokens.Typography.body.font.weight(.semibold))
                .foregroundStyle(Tokens.Tint.foreground.color)
        }
        .buttonStyle(.glassProminent)
        .buttonBorderShape(.circle)
        .tint(Tokens.Tint.base.color)
        .disabled(!values.canSubmit || isSubmitting)
        .frame(minWidth: Tokens.Size.minimumHitArea, minHeight: Tokens.Size.minimumHitArea)
        .accessibilityLabel(TasksCopy.quickAddSubmit)
        .accessibilityIdentifier("tasks.composer.send")
    }

    /// Esc closes the composer from a hardware keyboard.
    private var escapeShortcut: some View {
        Button(TasksCopy.composerClose, action: close)
            .keyboardShortcut(.escape, modifiers: [])
            .opacity(0)
            .allowsHitTesting(false)
            .accessibilityHidden(true)
    }

    // MARK: State

    private var currentSpans: [QuickAddSpan] { parsedText == text ? parse?.spans ?? [] : [] }

    private var trigger: QuickAddTrigger? { isFocused ? QuickAddTrigger.detect(text) : nil }

    private var ghost: QuickAddGhost? { QuickAddGhost.predict(text, trigger: trigger, now: store.localNow()) }

    var values: TaskComposerValues {
        let current = parsedText == text ? parse : nil
        let picked = pickedProjectId
        return TaskComposerValues.resolve(
            text: text,
            parse: current,
            draft: draft,
            request: request,
            fallbackDue: store.defaultDueDate(),
            resolveProject: { parsed, preferred in
                store.resolveProjectId(parsed: picked ?? parsed, preferred: preferred)
            }
        )
    }

    /// A project the suggestions handed out whose `+marker` is still typed.
    private var pickedProjectId: String? {
        text.lowercased().split(whereSeparator: \.isWhitespace)
            .filter { $0.hasPrefix("+") }
            .compactMap { picks.projects[String($0.dropFirst())] }
            .first
    }

    private func options(for trigger: QuickAddTrigger) -> [QuickAddOption] {
        switch trigger.kind {
        case .project:
            store.projectSuggestions(trigger.query).prefix(8).map {
                QuickAddOption(id: $0.id, label: $0.name, kind: .project, color: $0.color)
            }
        case .tag:
            store.tagSuggestions(trigger.query).prefix(8).map {
                QuickAddOption(id: $0, label: $0, kind: .tag, color: nil)
            }
        case .noteLink:
            noteOptions.map { QuickAddOption(id: $0.id, label: $0.title, kind: .noteLink, color: nil) }
        case .datePhrase, .priority, .repeat:
            []
        }
    }

    // MARK: Actions

    private func reparse() async {
        let value = text
        let current = QuickAddTrigger.detect(value)
        if current?.kind == .noteLink, let query = current?.query {
            noteOptions = await store.noteSuggestions(query)
        } else {
            noteOptions = []
        }
        guard !Task.isCancelled else { return }
        guard !value.isEmpty else {
            parse = nil
            parsedText = value
            return
        }
        let parsed = await store.parseQuickAdd(value)
        guard !Task.isCancelled, value == text else { return }
        parse = parsed
        parsedText = value
    }

    private func acceptGhost() {
        guard let ghost else { return }
        text = ghost.accept(in: text)
        focusRequest += 1
    }

    private func pick(_ option: QuickAddOption, for trigger: QuickAddTrigger) {
        switch option.kind {
        case .project:
            let marker = store.project(option.id)?.quickAddMarker ?? option.label
            picks.projects[marker.lowercased()] = option.id
            text = QuickAddTrigger.replace(text, start: trigger.start, with: "+\(marker)")
        case .tag:
            text = QuickAddTrigger.replace(text, start: trigger.start, with: "#\(option.label)")
        case .noteLink:
            picks.notes[option.label.lowercased()] = option.id
            text = QuickAddTrigger.replace(text, start: trigger.start, with: "[[\(option.label)]]")
        }
        focusRequest += 1
    }

    /// The "#" chip's "New tag…": start a `#` run at the end of the title.
    private func insertTagTrigger() {
        let spacer = text.isEmpty || text.hasSuffix(" ") ? "" : " "
        text += "\(spacer)#"
        focusRequest += 1
    }

    private func submit() async {
        guard values.canSubmit, !isSubmitting else { return }
        isSubmitting = true
        defer { isSubmitting = false }
        // The chips read the latest parse; submit reads the text as it is now.
        let parsed = await store.parseQuickAdd(text)
        let resolved = TaskComposerValues.resolve(
            text: text, parse: parsed, draft: draft, request: request,
            fallbackDue: store.defaultDueDate(),
            resolveProject: { parsedId, preferred in
                store.resolveProjectId(parsed: pickedProjectId ?? parsedId, preferred: preferred)
            }
        )
        let created = await store.createComposedTask(
            resolved, notes: draft.notes, noteTitles: parsed?.noteTitles ?? [], picks: picks
        )
        if created != nil {
            text = ""
            picks = QuickAddPicks()
            draft.resetForNext()
        }
        focusRequest += 1
    }
}

import MemryCore
import SwiftUI

// TP042. The quick-add capture field (desktop's `CaptureBar` with `quickAdd`,
// `components/capture-bar/capture-bar.tsx`): type a task with `@date`,
// `every …`, `!priority`, `+project`, `#tag` and `[[note]]`, see each run
// painted as a pill from the core's parse spans, finish dates and repeats
// with the ghost, pick projects, tags and notes from a list, and submit.
// Return submits what is on screen; the trailing suggestion (or Tab) accepts
// the ghost; the expand button opens the full Add Task sheet.

/// The quick-add capture field.
struct QuickAddBar: View {
    let store: TasksStore
    var defaultProjectId: String?

    @State private var text = ""
    @State private var isFocused = false
    @State private var parse: QuickAddParse?
    @State private var parsedText = ""
    @State private var picks = QuickAddPicks()
    @State private var noteOptions: [RelatedItemRecord] = []
    @State private var resolvedDate: ParsedDate?
    @State private var focusRequest = 0
    @State private var isSubmitting = false
    @State private var showsHelp = false
    @State private var detail: AddTaskPrefill?

    var body: some View {
        VStack(alignment: .leading, spacing: Tokens.Space.small) {
            HStack(alignment: .top, spacing: Tokens.Space.small) {
                Image(systemName: "plus.circle")
                    .font(Tokens.Typography.body.font)
                    .foregroundStyle(accent)
                    .frame(minHeight: Tokens.Size.minimumHitArea)
                    .accessibilityHidden(true)
                QuickAddTextView(
                    text: $text,
                    isFocused: $isFocused,
                    spans: currentSpans,
                    priority: parsedText == text ? parse?.priority ?? 0 : 0,
                    ghost: ghost?.remainder,
                    placeholder: TasksCopy.quickAddPlaceholder,
                    onSubmit: { Task { await submit() } },
                    onAcceptGhost: acceptGhost,
                    focusRequest: focusRequest
                )
                trailingButtons
            }
            .padding(.horizontal, Tokens.Space.medium)
            .background(Tokens.Canvas.surface.color, in: .rect(cornerRadius: Tokens.Radius.control))
            .overlay(
                RoundedRectangle(cornerRadius: Tokens.Radius.control)
                    .stroke(isFocused ? accent : Tokens.Line.border.color, lineWidth: Tokens.Size.hairline)
            )
            if isFocused { hints }
        }
        // The bar sits in the list's bottom inset: an opaque canvas behind it
        // keeps scrolled rows from showing through.
        .padding(.horizontal, Tokens.Space.inset)
        .padding(.vertical, Tokens.Space.small)
        .background(Tokens.Canvas.background.color)
        .calmAnimation(.fast, value: isFocused)
        .task(id: text) { await reparse() }
        .sheet(isPresented: $showsHelp) { QuickAddHelpSheet() }
        .sheet(item: $detail) { prefill in
            AddTaskSheet(store: store, initialTitle: prefill.title, projectId: prefill.projectId)
        }
    }

    // MARK: Pieces

    private var trailingButtons: some View {
        HStack(spacing: 0) {
            if let ghost {
                Button(action: acceptGhost) {
                    Text(ghost.text)
                        .font(Tokens.Typography.caption.font.weight(.medium))
                        .foregroundStyle(Tokens.Text.secondary.color)
                        .padding(.horizontal, Tokens.Space.small)
                        .frame(minHeight: Tokens.Size.minimumHitArea)
                }
                .accessibilityLabel(TasksCopy.quickAddAcceptSuggestion(ghost.text))
                .accessibilityIdentifier("tasks.quickAdd.acceptGhost")
            }
            if isFocused {
                iconButton(
                    "arrow.up.left.and.arrow.down.right",
                    TasksCopy.quickAddOpenDetail,
                    "tasks.quickAdd.openDetail"
                ) {
                    Task { await openDetail() }
                }
            } else {
                iconButton("questionmark.circle", TasksCopy.quickAddHelp, "tasks.quickAdd.help") { showsHelp = true }
            }
            iconButton("arrow.up.circle.fill", TasksCopy.quickAddSubmit, "tasks.quickAdd.submit") {
                Task { await submit() }
            }
            .disabled(!canSubmit)
        }
    }

    private func iconButton(
        _ symbol: String, _ label: String, _ identifier: String, action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(Tokens.Typography.body.font)
                .foregroundStyle(accent)
                .frame(minWidth: Tokens.Size.minimumHitArea, minHeight: Tokens.Size.minimumHitArea)
                .contentShape(.rect)
        }
        .accessibilityLabel(label)
        .accessibilityIdentifier(identifier)
    }

    @ViewBuilder private var hints: some View {
        if let resolvedDate {
            Label(TasksCopy.quickAddResolvedDate(resolvedDate.displayText), systemImage: "calendar")
                .font(Tokens.Typography.caption.font)
                .foregroundStyle(Tokens.Task.tokenDate.color)
                .accessibilityIdentifier("tasks.quickAdd.resolvedDate")
        }
        if let trigger, trigger.kind == .project || trigger.kind == .tag || trigger.kind == .noteLink {
            QuickAddSuggestions(options: options(for: trigger)) { pick($0, for: trigger) }
        }
        if targetProjectId == nil {
            Text(TasksCopy.quickAddNoProject)
                .font(Tokens.Typography.caption.font)
                .foregroundStyle(Tokens.Text.secondary.color)
        } else if let name = store.project(targetProjectId)?.name {
            Text(TasksCopy.quickAddProjectTarget(name))
                .font(Tokens.Typography.caption.font)
                .foregroundStyle(Tokens.Text.secondary.color)
        }
    }

    // MARK: State

    private var currentSpans: [QuickAddSpan] { parsedText == text ? parse?.spans ?? [] : [] }

    private var trigger: QuickAddTrigger? { isFocused ? QuickAddTrigger.detect(text) : nil }

    private var ghost: QuickAddGhost? {
        QuickAddGhost.predict(text, trigger: trigger, now: store.localNow())
    }

    /// Where the task would land, for the accent and the hint.
    private var targetProjectId: String? {
        let parsed = parsedText == text ? parse?.projectId : nil
        return store.resolveProjectId(parsed: parsed, preferred: defaultProjectId)
    }

    private var accent: Color {
        guard let color = store.project(targetProjectId)?.color else { return Tokens.Text.secondary.color }
        return Tokens.Palette.color(color)
    }

    private var canSubmit: Bool {
        guard !isSubmitting, targetProjectId != nil else { return false }
        guard parsedText == text, let parse else { return !text.trimmingCharacters(in: .whitespaces).isEmpty }
        return !parse.title.trimmingCharacters(in: .whitespaces).isEmpty
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
        let now = store.localNow()
        let current = QuickAddTrigger.detect(value)
        resolvedDate = QuickAddDateHint.resolve(trigger: current, now: now, previous: resolvedDate)
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

    private func submit() async {
        guard canSubmit else { return }
        isSubmitting = true
        defer { isSubmitting = false }
        let created = await store.submitQuickAdd(text, preferredProjectId: defaultProjectId, picks: picks)
        if created != nil {
            text = ""
            picks = QuickAddPicks()
            resolvedDate = nil
        }
        // Keep focus for rapid entry.
        focusRequest += 1
    }

    /// Opens the Add Task sheet with the parsed title (desktop's ⌘↵).
    private func openDetail() async {
        let parsed = text.isEmpty ? nil : await store.parseQuickAdd(text)
        detail = AddTaskPrefill(
            title: parsed?.title ?? text,
            projectId: store.resolveProjectId(parsed: parsed?.projectId, preferred: defaultProjectId)
        )
        text = ""
        picks = QuickAddPicks()
    }
}

/// What the expand button hands the Add Task sheet.
struct AddTaskPrefill: Identifiable, Equatable {
    let id = UUID()
    let title: String
    let projectId: String?
}

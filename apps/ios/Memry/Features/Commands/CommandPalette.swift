import SwiftUI

// #4379. The ⌘P command palette: the menu bar's commands (`AppCommand`,
// `VaultCommands`) in a list to type into, as desktop's `commands-palette.tsx`.
// At regular width it is the search palette's frame (`PaletteFrame`), at
// compact width a sheet. Each row runs through `VaultCommands.run`, after the
// palette is gone: a command that opens a sheet or search cannot open under
// it (REVIEW-4523).
//
// **Keyboard.** The field keeps focus. ↓ and ↑ move the highlighted row,
// Return runs it, and Esc (`⌘.` on the simulator) closes. A new list
// highlights its first row, so Return alone runs the best match.

/// One ⌘P press: the commands the palette lists and runs.
struct CommandPaletteRequest: Identifiable {
    let id = UUID()
    let commands: VaultCommands
}

extension View {
    /// Shows `request`'s palette the way `width` shows it, and runs the chosen
    /// command once it has closed.
    func commandPalette(_ request: Binding<CommandPaletteRequest?>, width: LayoutWidth) -> some View {
        modifier(CommandPalettePresenter(request: request, width: width))
    }
}

private struct CommandPalettePresenter: ViewModifier {
    @Binding var request: CommandPaletteRequest?
    let width: LayoutWidth
    /// The picked command, run on dismissal.
    @State private var chosen: (() -> Void)?

    func body(content: Content) -> some View {
        content
            .sheet(item: shown(.compact), onDismiss: runChosen) { request in
                palette(request, .sheet)
                    .presentationDetents([.medium, .large])
            }
            .fullScreenCover(item: shown(.regular), onDismiss: runChosen) { request in
                palette(request, .palette)
                    .presentationBackground(.clear)
            }
    }

    private func shown(_ shown: LayoutWidth) -> Binding<CommandPaletteRequest?> {
        Binding(get: { width == shown ? request : nil }, set: { request = $0 })
    }

    private func palette(_ request: CommandPaletteRequest, _ presentation: SearchPresentation) -> some View {
        CommandPalette(presentation: presentation, commands: request.commands) { command in
            chosen = { request.commands.run(command) }
        }
    }

    private func runChosen() {
        chosen?()
        chosen = nil
    }
}

struct CommandPalette: View {
    let presentation: SearchPresentation
    let commands: VaultCommands
    let choose: (AppCommand) -> Void

    @State private var query = ""
    @State private var highlighted: String?
    @FocusState private var isFocused: Bool
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        Group {
            switch presentation {
            case .palette:
                PaletteFrame(prefix: "commands", close: close) { windowHeight in
                    field
                    Divider()
                    list.frame(height: PaletteFrameHeight.list(in: windowHeight))
                }
            case .sheet:
                NavigationStack {
                    VStack(spacing: 0) {
                        field
                        Divider()
                        list
                    }
                    .navigationTitle(CommandCopy.paletteTitle)
                    .navigationBarTitleDisplayMode(.inline)
                }
            }
        }
        .onChange(of: rows.map(commands.id), initial: true) { _, ids in highlighted = ids.first }
        .onAppear { isFocused = true }
    }

    private var rows: [AppCommand] { commands.paletteCommands(matching: query) }

    private var field: some View {
        PaletteField(
            prefix: "commands", prompt: CommandCopy.prompt, submitLabel: .go,
            query: $query, isFocused: $isFocused, move: move, submit: submit, close: close
        ) { EmptyView() }
    }

    private var list: some View {
        let rows = rows
        let contextual = query.isEmpty ? rows.filter { $0.context != .app } : []
        return ScrollViewReader { proxy in
            List {
                if !contextual.isEmpty {
                    Section {
                        ForEach(contextual, id: \.self, content: row)
                    } header: {
                        Text(CommandCopy.thisJournal).accessibilityAddTraits(.isHeader)
                    }
                }
                ForEach(rows.filter { !contextual.contains($0) }, id: \.self, content: row)
                if rows.isEmpty {
                    Text(CommandCopy.empty(query.trimmingCharacters(in: .whitespaces)))
                        .foregroundStyle(Tokens.Text.secondary.color)
                        .listRowSeparator(.hidden)
                }
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .environment(\.searchHighlight, SearchPaletteHighlight(key: highlighted))
            .onChange(of: highlighted) { _, key in
                if let key { proxy.scrollTo(key) }
            }
        }
    }

    private func row(_ command: AppCommand) -> some View {
        Button { run(command) } label: {
            HStack {
                Text(commands.title(command))
                    .foregroundStyle(Tokens.Text.primary.color)
                Spacer()
                Text(command.shortcut.symbols)
                    .foregroundStyle(Tokens.Text.tertiary.color)
                    .monospaced()
            }
            .frame(minHeight: Tokens.Size.minimumHitArea)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("commands.row.\(commands.id(command))")
        .searchRow(commands.id(command))
    }

    private func move(_ step: Int) {
        let ids = rows.map(commands.id)
        guard !ids.isEmpty else { return }
        let index = highlighted.flatMap(ids.firstIndex(of:)).map { $0 + step } ?? 0
        highlighted = ids[min(max(index, 0), ids.count - 1)]
    }

    private func submit() {
        let rows = rows
        if let command = rows.first(where: { commands.id($0) == highlighted }) ?? rows.first { run(command) }
    }

    private func run(_ command: AppCommand) {
        choose(command)
        close()
    }

    /// The palette comes and goes in place, as on desktop; the sheet slides.
    private func close() {
        var transaction = Transaction()
        transaction.disablesAnimations = presentation == .palette
        withTransaction(transaction) { dismiss() }
    }
}

/// How the palette matches a query, as desktop's `rank-commands.ts`: a prefix
/// of the title, then a prefix of each of its words, then its letters in
/// order. 0 is no match.
enum CommandMatch {
    static func normalized(_ text: String) -> String {
        text.folding(options: [.diacriticInsensitive, .caseInsensitive], locale: nil)
            .split { !$0.isLetter && !$0.isNumber }
            .joined(separator: " ")
    }

    static func score(_ title: String, _ needle: String) -> Int {
        let text = normalized(title)
        if text.hasPrefix(needle) { return 3 }
        let words = text.split(separator: " ")
        if needle.split(separator: " ").allSatisfy({ token in words.contains { $0.hasPrefix(token) } }) { return 2 }
        var letters = needle.replacingOccurrences(of: " ", with: "")[...]
        for char in text where char == letters.first {
            letters = letters.dropFirst()
        }
        return letters.isEmpty ? 1 : 0
    }
}

extension KeyboardShortcut {
    /// The key as a menu shows it, such as ⇧⌘N.
    var symbols: String {
        let modifiers: [(EventModifiers, String)] = [(.control, "⌃"), (.option, "⌥"), (.shift, "⇧"), (.command, "⌘")]
        let held = modifiers.filter { self.modifiers.contains($0.0) }.map(\.1).joined()
        switch key {
        case .leftArrow: return held + "←"
        case .rightArrow: return held + "→"
        default: return held + String(key.character).uppercased()
        }
    }
}

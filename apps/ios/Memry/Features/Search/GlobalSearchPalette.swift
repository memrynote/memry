import MemryCore
import SwiftUI

// #4426 (D3, `DESIGN.md` › Tablet › Search): at regular width the global
// search is a palette about 600pt wide near the top of the window, as on
// desktop (`command-palette.tsx`), not a sheet. Only the chrome differs: the
// results, recents, filters and routes are `GlobalSearchSheet`'s.
//
// **Keyboard.** The field keeps focus. ↓ and ↑ move the highlighted row,
// Return opens it, and Esc (`⌘.` on the simulator) closes the palette. A
// new result list highlights its first row, so Return alone opens the best
// hit.

/// How the global search is shown: today's sheet at compact width, the
/// palette at regular width.
enum SearchPresentation {
    case sheet, palette
}

/// The palette's keyboard selection: the highlighted row's `SearchRowKey`,
/// `nil` while there is no row.
struct SearchPaletteHighlight {
    let key: String?
}

extension EnvironmentValues {
    /// `nil` in the sheet, which highlights nothing and keeps its row
    /// backgrounds.
    @Entry var searchHighlight: SearchPaletteHighlight?
}

/// The key the palette highlights a row by. Ids of different kinds may
/// coincide, so the kind is part of it.
enum SearchRowKey {
    static func of(_ hit: SearchResult) -> String { "\(hit.kind)/\(hit.id)" }
}

extension View {
    /// Marks a result or recent row for the palette's keyboard selection.
    func searchRow(_ key: String) -> some View {
        modifier(SearchRowHighlight(key: key))
    }
}

private struct SearchRowHighlight: ViewModifier {
    let key: String
    @Environment(\.searchHighlight) private var highlight

    func body(content: Content) -> some View {
        let isHighlighted = highlight?.key == key
        content
            .id(key)
            .listRowBackground(highlight.map { _ in
                ZStack {
                    Tokens.Canvas.background.color
                    if isHighlighted { SelectedRowFill() }
                }
            })
            .accessibilityAddTraits(isHighlighted ? .isSelected : [])
    }
}

/// The search palette: the field and the scope picker over the results, in
/// the palette family's frame.
struct SearchPaletteFrame<Results: View>: View {
    @Binding var query: String
    var isFocused: FocusState<Bool>.Binding
    @Binding var scope: SearchScope
    let model: VaultSearchViewModel?
    let move: (Int) -> Void
    let submit: () -> Void
    let close: () -> Void
    @ViewBuilder let results: () -> Results

    var body: some View {
        PaletteFrame(prefix: "search", close: close) { windowHeight in
            PaletteField(
                prefix: "search", prompt: GlobalSearchCopy.prompt, submitLabel: .search,
                query: $query, isFocused: isFocused, move: move, submit: submit, close: close
            ) {
                if let model {
                    SearchFilterMenu(filters: model.filters, apply: model.apply)
                        .labelStyle(.iconOnly)
                }
            }
            Picker(GlobalSearchCopy.scope, selection: $scope) {
                ForEach(SearchScope.allCases, id: \.self) { Text($0.title).tag($0) }
            }
            .pickerStyle(.segmented)
            .padding(.horizontal, Tokens.Space.inset)
            .padding(.bottom, Tokens.Space.small)
            Divider()
            results()
                .scrollContentBackground(.hidden)
                .frame(height: PaletteFrameHeight.list(in: windowHeight))
        }
    }
}

/// The palette family's frame (`DESIGN.md` › Tablet › Search): a dimmed
/// window, and a panel about 600pt wide centred near the top. Search and the
/// `⌘P` command palette (#4379) share it.
struct PaletteFrame<Panel: View>: View {
    /// Names the panel for accessibility: `<prefix>.palette`.
    let prefix: String
    let close: () -> Void
    /// The panel's rows, given the window's height to cap a list by.
    @ViewBuilder let panel: (CGFloat) -> Panel

    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        GeometryReader { proxy in
            ZStack(alignment: .top) {
                // Desktop's overlay: black at 20% in light, 50% in dark.
                Color.black.opacity(colorScheme == .dark ? 0.5 : 0.2)
                    .ignoresSafeArea()
                    .onTapGesture(perform: close)
                    .accessibilityHidden(true)
                VStack(spacing: 0) {
                    panel(proxy.size.height)
                }
                .frame(width: min(Tokens.Size.palette, proxy.size.width - 2 * Tokens.Space.inset))
                .background(Tokens.Canvas.background.color)
                .clipShape(.rect(cornerRadius: Tokens.Radius.card))
                .overlay {
                    RoundedRectangle(cornerRadius: Tokens.Radius.card)
                        .strokeBorder(Tokens.Line.border.color, lineWidth: Tokens.Size.hairline)
                }
                .shadow(color: .black.opacity(0.2), radius: 24, y: 8)
                .padding(.top, proxy.size.height * 0.14)
                .accessibilityElement(children: .contain)
                .accessibilityAddTraits(.isModal)
                .accessibilityAction(.escape, close)
                .accessibilityIdentifier("\(prefix).palette")
            }
        }
    }
}

enum PaletteFrameHeight {
    /// A palette list's height, desktop's `h-[min(452px,60vh)]`.
    static func list(in windowHeight: CGFloat) -> CGFloat {
        min(452, windowHeight * 0.6)
    }
}

/// A palette's field. It keeps focus: ↓ and ↑ move the highlighted row,
/// Return runs it, and Esc (`⌘.` on the simulator) closes.
struct PaletteField<Accessory: View>: View {
    /// Names the field `<prefix>.palette.field` and its close button
    /// `<prefix>.close`.
    let prefix: String
    let prompt: String
    let submitLabel: SubmitLabel
    @Binding var query: String
    var isFocused: FocusState<Bool>.Binding
    let move: (Int) -> Void
    let submit: () -> Void
    let close: () -> Void
    @ViewBuilder var accessory: () -> Accessory

    var body: some View {
        HStack(spacing: Tokens.Space.medium) {
            Image(systemName: "magnifyingglass")
                .foregroundStyle(Tokens.Text.tertiary.color)
                .accessibilityHidden(true)
            TextField(prompt, text: $query)
                .textFieldStyle(.plain)
                .font(Tokens.Typography.body.font)
                .autocorrectionDisabled()
                .submitLabel(submitLabel)
                .focused(isFocused)
                .onSubmit(submit)
                .onKeyPress(.downArrow) { move(1); return .handled }
                .onKeyPress(.upArrow) { move(-1); return .handled }
                .onKeyPress(.return) { submit(); return .handled }
                .accessibilityIdentifier("\(prefix).palette.field")
            accessory()
            Button(role: .close, action: close)
                .labelStyle(.iconOnly)
                .keyboardShortcut(.cancelAction)
                .accessibilityIdentifier("\(prefix).close")
        }
        .padding(.horizontal, Tokens.Space.inset)
        .frame(minHeight: Tokens.Size.minimumHitArea + Tokens.Space.medium)
    }
}

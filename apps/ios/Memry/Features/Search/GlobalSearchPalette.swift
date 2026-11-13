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
                isHighlighted ? Tokens.Canvas.surfaceActive.color : Tokens.Canvas.background.color
            })
            .accessibilityAddTraits(isHighlighted ? .isSelected : [])
    }
}

/// The palette's frame: a dimmed window, and the field over the results in a
/// panel centred near the top.
struct SearchPaletteFrame<Results: View>: View {
    @Binding var query: String
    var isFocused: FocusState<Bool>.Binding
    @Binding var scope: SearchScope
    let model: VaultSearchViewModel?
    let move: (Int) -> Void
    let submit: () -> Void
    let close: () -> Void
    @ViewBuilder let results: () -> Results

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
                    field
                    Picker(GlobalSearchCopy.scope, selection: $scope) {
                        ForEach(SearchScope.allCases, id: \.self) { Text($0.title).tag($0) }
                    }
                    .pickerStyle(.segmented)
                    .padding(.horizontal, Tokens.Space.inset)
                    .padding(.bottom, Tokens.Space.small)
                    Divider()
                    results()
                        .scrollContentBackground(.hidden)
                        .frame(height: min(Self.resultsHeight, proxy.size.height * 0.6))
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
                .accessibilityIdentifier("search.palette")
            }
        }
    }

    /// Desktop's `h-[min(452px,60vh)]`.
    private static var resultsHeight: CGFloat { 452 }

    private var field: some View {
        HStack(spacing: Tokens.Space.medium) {
            Image(systemName: "magnifyingglass")
                .foregroundStyle(Tokens.Text.tertiary.color)
                .accessibilityHidden(true)
            TextField(GlobalSearchCopy.prompt, text: $query)
                .textFieldStyle(.plain)
                .font(Tokens.Typography.body.font)
                .autocorrectionDisabled()
                .submitLabel(.search)
                .focused(isFocused)
                .onSubmit(submit)
                .onKeyPress(.downArrow) { move(1); return .handled }
                .onKeyPress(.upArrow) { move(-1); return .handled }
                .onKeyPress(.return) { submit(); return .handled }
                .accessibilityIdentifier("search.palette.field")
            if let model {
                SearchFilterMenu(filters: model.filters, apply: model.apply)
                    .labelStyle(.iconOnly)
            }
            Button(role: .close, action: close)
                .labelStyle(.iconOnly)
                .keyboardShortcut(.cancelAction)
                .accessibilityIdentifier("search.close")
        }
        .padding(.horizontal, Tokens.Space.inset)
        .frame(minHeight: Tokens.Size.minimumHitArea + Tokens.Space.medium)
    }
}

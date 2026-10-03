import MemryCore
import SwiftUI

/// One property row (desktop's `PropertyRow`): a fixed-width label column
/// with its glyph, then the value.
struct TaskPropertyRow<Value: View>: View {
    let title: String
    let symbol: String
    @ViewBuilder var value: () -> Value

    /// Grows with Dynamic Type so long labels keep one column.
    @ScaledMetric(relativeTo: .subheadline) private var labelWidth: CGFloat = 112

    init(_ title: String, symbol: String, @ViewBuilder value: @escaping () -> Value) {
        self.title = title
        self.symbol = symbol
        self.value = value
    }

    var body: some View {
        HStack(alignment: .center, spacing: Tokens.Space.small) {
            Label {
                Text(title).lineLimit(2)
            } icon: {
                Image(systemName: symbol).foregroundStyle(Tokens.Text.tertiary.color)
            }
            .font(Tokens.Typography.supporting.font)
            .foregroundStyle(Tokens.Text.secondary.color)
            .frame(width: labelWidth, alignment: .leading)
            .accessibilityHidden(true)
            value()
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .frame(minHeight: Tokens.Size.minimumHitArea)
    }
}

/// An unset property's value: quiet text where the pill would sit.
struct TaskPropertyEmpty: View {
    var text = TasksCopy.detailEmpty

    var body: some View {
        Text(text)
            .font(Tokens.Typography.supporting.font)
            .foregroundStyle(Tokens.Text.tertiary.color)
            .lineLimit(1)
            .padding(.horizontal, Tokens.Space.medium)
            .frame(minHeight: Tokens.Size.minimumHitArea, alignment: .leading)
            .contentShape(.rect)
    }
}

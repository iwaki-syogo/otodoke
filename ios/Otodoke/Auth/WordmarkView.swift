import SwiftUI

/// The cardboard box seen from above (BoxMark of src/components/wordmark.tsx, a 64 x 64 drawing).
struct BoxMarkView: View {
    var body: some View {
        Canvas { context, size in
            let k = min(size.width, size.height) / 64
            func rect(_ x: CGFloat, _ y: CGFloat, _ w: CGFloat, _ h: CGFloat, _ r: CGFloat, _ color: Color) {
                context.fill(Path(roundedRect: CGRect(x: x * k, y: y * k, width: w * k, height: h * k), cornerRadius: r * k), with: .color(color))
            }
            rect(8, 8, 48, 48, 9, OtodokeColor.hex("#c8894b"))
            rect(28, 8, 8, 48, 0, OtodokeColor.hex("#ecc896"))
            rect(39, 38, 12, 11, 2, .white)
            rect(41.5, 41, 7, 2.4, 1.2, OtodokeColor.hex("#dc2626"))
            rect(41.5, 44.6, 4.5, 2, 1, OtodokeColor.hex("#a8a29e"))
        }
        .aspectRatio(1, contentMode: .fit)
    }
}

/// "ot[box]doke" (Wordmark of src/components/wordmark.tsx). The Web uses Poppins 800; the app has no such
/// font, so the heaviest rounded system face stands in. Sized by `size` (scaled with Dynamic Type); the box is
/// 0.6 em. VoiceOver hears "Otodoke" once.
struct WordmarkView: View {
    @ScaledMetric private var size: CGFloat

    init(size: CGFloat) {
        _size = ScaledMetric(wrappedValue: size, relativeTo: .largeTitle)
    }

    var body: some View {
        HStack(spacing: 0) {
            Text("ot")
            BoxMarkView()
                .frame(width: size * 0.6, height: size * 0.6)
                .padding(.horizontal, size * 0.03)
                .offset(y: size * 0.03)
            Text("doke")
        }
        .font(.system(size: size, weight: .heavy, design: .rounded))
        .tracking(-size * 0.03)
        // The wordmark's own ink (#1c1917) in light mode; the label colour in dark mode.
        .foregroundStyle(OtodokeColor.adaptive(light: "#1c1917", dark: "#fafaf9"))
        .lineLimit(1)
        .fixedSize()
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Otodoke")
    }
}

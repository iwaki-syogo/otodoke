// 「メールの自動転送の設定」 on the 「メールの転送」 page: one folding card per mail service (Gmail, iCloud,
// Outlook, そのほか), each with numbered steps, a button that opens the service's own forwarding page in Safari,
// and the Gmail filter text with its copy button. The words are ForwardingGuideText's.

import SwiftUI

/// The numbered round badge the steps share (here and on 「うまく届かないとき」).
struct StepBadge: View {
    let number: Int

    var body: some View {
        Text(verbatim: "\(number)")
            .font(.caption.weight(.bold))
            .monospacedDigit()
            .foregroundStyle(.secondary)
            .frame(width: 24, height: 24)
            .background(Color(.systemGray5), in: Circle())
            .accessibilityHidden(true)
    }
}

/// A numbered list of steps; `start` is the number of the first.
struct StepList: View {
    let steps: [String]
    var start = 1
    /// Drawn under the step with this number.
    var after: (number: Int, content: AnyView)?

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            ForEach(Array(steps.enumerated()), id: \.offset) { index, step in
                let number = start + index
                VStack(alignment: .leading, spacing: 10) {
                    HStack(alignment: .firstTextBaseline, spacing: 12) {
                        StepBadge(number: number)
                        Text(step)
                            .fixedSize(horizontal: false, vertical: true)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .accessibilityLabel(Text(verbatim: "\(number). \(step)"))
                    }
                    if let after, after.number == number {
                        after.content.padding(.leading, 36)
                    }
                }
            }
        }
    }
}

struct ForwardingGuideView: View {
    typealias T = ForwardingGuideText
    @Environment(\.openURL) private var openURL
    @State private var opened: Set<String>
    /// Only the folding cards of the mail services (the first guide after registering shows nothing around them).
    private let servicesOnly: Bool

    /// `expanded`: every service starts open (the screen check).
    init(expanded: Bool = false, servicesOnly: Bool = false) {
        self.servicesOnly = servicesOnly
        _opened = State(initialValue: expanded ? Set(T.services.map(\.id)) : [])
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            if !servicesOnly {
                header
                before
            }
            VStack(spacing: 12) {
                ForEach(T.services) { service in
                    SettingsDisclosure(title: service.title, isExpanded: binding(service.id)) {
                        serviceBody(service)
                    }
                }
            }
            if !servicesOnly {
                verify
            }
        }
    }

    private func binding(_ id: String) -> Binding<Bool> {
        Binding(
            get: { opened.contains(id) },
            set: { if $0 { opened.insert(id) } else { opened.remove(id) } }
        )
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 8) {
            SettingsParts.heading(T.title)
            Text(T.lead)
                .font(.subheadline)
                .lineSpacing(3)
                .fixedSize(horizontal: false, vertical: true)
            Text(T.supplement)
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var before: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(T.beforeHeading)
                .font(.subheadline.weight(.semibold))
            ForEach(T.before, id: \.self) { line in
                bullet(line)
            }
        }
    }

    private var verify: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(T.verifyHeading)
                .font(.subheadline.weight(.semibold))
            ForEach(T.verify, id: \.self) { line in
                bullet(line)
            }
        }
    }

    private func bullet(_ text: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(verbatim: "•").foregroundStyle(.secondary).accessibilityHidden(true)
            Text(text)
                .font(.subheadline)
                .lineSpacing(3)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    // MARK: A service

    private func serviceBody(_ service: T.Service) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            if let meta = service.meta {
                Label {
                    Text(meta)
                } icon: {
                    Image(systemName: "clock")
                }
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            }
            if let link = service.link {
                VStack(alignment: .leading, spacing: 6) {
                    SettingsParts.linkCard(link.title) { open(link.url) }
                    if let note = service.linkNote {
                        SettingsParts.secondaryText(note).font(.caption)
                    }
                }
            }
            if let body = service.body {
                Text(body)
            }
            groups(service)
            ForEach(service.notes, id: \.self) { note in
                Text(note)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineSpacing(3)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private func groups(_ service: T.Service) -> some View {
        // The steps are numbered through all the groups of a service.
        var starts: [Int] = []
        var next = 1
        for group in service.groups {
            starts.append(next)
            next += group.steps.count
        }
        return VStack(alignment: .leading, spacing: 20) {
            ForEach(Array(service.groups.enumerated()), id: \.offset) { index, group in
                let first = starts[index]
                VStack(alignment: .leading, spacing: 12) {
                    if let heading = group.heading {
                        Text(heading).font(.subheadline.weight(.semibold))
                    }
                    StepList(steps: group.steps, start: first, after: filter(service, in: first..<(first + group.steps.count)))
                }
            }
        }
        .lineSpacing(3)
    }

    private func filter(_ service: T.Service, in range: Range<Int>) -> (number: Int, content: AnyView)? {
        guard let number = service.filterAfterStep, range.contains(number) else { return nil }
        return (number, AnyView(filterBox))
    }

    private var filterBox: some View {
        HStack(spacing: 8) {
            Text(SettingsModel.gmailFilter)
                .font(.caption.monospaced())
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
            CopyButton(text: SettingsModel.gmailFilter)
        }
        .padding(10)
        .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 10))
    }

    private func open(_ url: String) {
        guard let url = URL(string: url) else { return }
        SettingsWeb.openPage(url, openURL)
    }
}

/// The Web's <details> card: a title row that opens the body under a line.
struct SettingsDisclosure<Content: View>: View {
    let title: String
    @Binding var isExpanded: Bool
    @ViewBuilder let content: () -> Content

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button {
                withAnimation(.easeInOut(duration: 0.2)) { isExpanded.toggle() }
            } label: {
                HStack(spacing: 8) {
                    Image(systemName: "chevron.right")
                        .font(.caption.weight(.semibold))
                        .rotationEffect(.degrees(isExpanded ? 90 : 0))
                        .foregroundStyle(.secondary)
                    Text(title)
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(.primary)
                        .multilineTextAlignment(.leading)
                    Spacer(minLength: 0)
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 12)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityAddTraits(isExpanded ? [.isSelected] : [])
            if isExpanded {
                Divider()
                content()
                    .font(.subheadline)
                    .foregroundStyle(.primary)
                    .lineSpacing(3)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 12)
            }
        }
        .background(Color(.systemBackground), in: RoundedRectangle(cornerRadius: 16))
        .overlay(RoundedRectangle(cornerRadius: 16).stroke(Color(.separator)))
    }
}

/// The Web's CopyButton: 「コピー」, then 「コピーしました」 for 2 seconds.
struct CopyButton: View {
    let text: String
    @State private var copied = false
    @State private var reset: Task<Void, Never>?

    var body: some View {
        Button {
            UIPasteboard.general.string = text
            copied = true
            reset?.cancel()
            reset = Task {
                try? await Task.sleep(for: .seconds(2))
                guard !Task.isCancelled else { return }
                copied = false
            }
        } label: {
            Text(copied ? "コピーしました" : "コピー")
                .font(.subheadline.weight(.medium))
                .foregroundStyle(.primary)
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .background(Color(.systemBackground), in: RoundedRectangle(cornerRadius: 8))
                .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color(.separator)))
        }
        .buttonStyle(.plain)
        .fixedSize()
    }
}

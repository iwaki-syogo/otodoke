// 「自動転送の設定（最初の 1 回だけ）」 of src/app/app/settings/page.tsx (2541793): the Gmail steps with the
// filter text to copy, and iCloud / Outlook / その他, in the Web's words.

import SwiftUI

struct ForwardingGuideView: View {
    @State private var showsGmail: Bool
    @State private var showsOthers: Bool

    init(expanded: Bool = false) {
        _showsGmail = State(initialValue: expanded)
        _showsOthers = State(initialValue: expanded)
    }

    static let gmailSteps: [String] = [
        "パソコンのブラウザで Gmail を開き、設定 › すべての設定を表示 › 「メール転送と POP/IMAP」を開く",
        "「転送先アドレスを追加」で上のアドレスを入れる。本人確認を求められたら済ませて、もう一度入れる。「次へ」の後に開く小窓で「続行」を押す",
        "少し待つと、このページの上に承認ページへのボタンが出るので開いて承認する",
        "検索ボックスの検索オプションを開き、「含む」に次の文字列を貼って「フィルタを作成」を押す",
        "「転送する」に上のアドレスを選んで作成する",
    ]

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("自動転送の設定（最初の 1 回だけ）")
                .font(.headline)
            Text("店ごとの設定はいりません。新しい店で買っても、そのまま読み取ります。")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            VStack(spacing: 8) {
                SettingsDisclosure(title: "Gmail", isExpanded: $showsGmail) { gmail }
                SettingsDisclosure(title: "iCloud / Outlook / その他", isExpanded: $showsOthers) { others }
            }
            .padding(.top, 4)
        }
    }

    private var gmail: some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(Array(Self.gmailSteps.enumerated()), id: \.offset) { index, step in
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text("\(index + 1).")
                        .monospacedDigit()
                    VStack(alignment: .leading, spacing: 8) {
                        Text(step)
                        if index == 3 {
                            HStack(spacing: 8) {
                                Text(SettingsModel.gmailFilter)
                                    .font(.caption.monospaced())
                                    .textSelection(.enabled)
                                    .fixedSize(horizontal: false, vertical: true)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                CopyButton(text: SettingsModel.gmailFilter)
                            }
                            .padding(8)
                            .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 12))
                        }
                    }
                }
            }
            Text("転送するのは上の言葉を含むメールだけです。ただし、これらの言葉を含む私信（「到着したよ」など）も転送されます。届いたメールのうち、買い物に関係しないものは本文を保存せずに捨てます。")
                .font(.caption)
                .foregroundStyle(.secondary)
                .padding(.top, 4)
        }
        .fixedSize(horizontal: false, vertical: true)
    }

    private var others: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("メールの設定にある自動転送で、すべてのメールを上のアドレスへ転送してください。")
            Text("Outlook は 設定 › メール › 転送 にあります。広告など買い物に関係しないメールは、本文を保存せずに捨てます。判断に迷うメールだけ Claude が確認します。")
        }
        .fixedSize(horizontal: false, vertical: true)
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

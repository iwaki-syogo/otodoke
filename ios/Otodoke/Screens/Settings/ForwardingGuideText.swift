// The words of 「メールの自動転送の設定」, copied sentence for sentence from the source of the sentences
// (src/lib/forwarding-guide.ts, the Web source of truth, checked against each service's own help
// on 2026-11-07). No new sentence is written here: src/lib/__tests__/ios-forwarding-guide.test.ts reads this
// file and the source and fails when a sentence differs. The screens only draw what is listed here.

import Foundation

enum ForwardingGuideText {
    struct Link: Sendable {
        let title: String
        let url: String
    }

    struct Group: Sendable {
        let heading: String?
        let steps: [String]
    }

    /// An explainer video: the path under https://otodoke.app and its length (opened in Safari, not played here).
    struct Video: Sendable {
        let path: String
        let seconds: Int
    }

    struct Service: Identifiable, Sendable {
        let id: String
        let title: String
        /// The addresses of the service, under its title (iCloud, Outlook).
        let addresses: String?
        /// How long it takes and where (shown with a clock).
        let meta: String?
        let video: Video?
        let link: Link?
        let linkNote: String?
        let groups: [Group]
        /// A paragraph in place of steps (そのほかのメール).
        let body: String?
        /// After this step (counted through all groups) the Gmail filter text and its copy button are drawn.
        let filterAfterStep: Int?
        let notes: [String]
    }

    enum Block: Sendable {
        case text(String)
        case steps([String])
        case domains([String])
        case links([Link])
    }

    struct Pitfall: Identifiable, Sendable {
        let title: String
        let blocks: [Block]
        var id: String { title }
    }

    // MARK: ページの題と最初の一文

    static let title = "メールの自動転送の設定"
    static let lead = "設定は最初の 1 回だけです。あとは何もしなくても、荷物のメールが Otodoke に届きます。"
    static let supplement = "お使いのメールを選んでください。どれも 5 分ほどで終わります。"

    // MARK: 始める前に

    static let beforeHeading = "始める前に"
    static let before: [String] = [
        "Otodoke の設定の「メールの転送」で、あなた専用の転送先アドレスをコピーしておきます。",
        "アドレスは …@in.otodoke.app の形です。知らない人には教えないでください。",
    ]

    // MARK: Gmail / iCloud / Outlook / そのほか

    static let services: [Service] = [
        Service(
            id: "gmail",
            title: "Gmail",
            addresses: nil,
            meta: "5 分・パソコンのブラウザで。スマホの Gmail アプリでは設定できません",
            video: Video(path: "/guide/videos/otodoke-fwd-gmail-720.mp4", seconds: 131),
            link: Link(title: "転送の設定を開く", url: "https://mail.google.com/mail/u/0/#settings/fwdandpop"),
            linkNote: "Gmail を 2 つ以上使っている人は、開いた画面の右上で、荷物のメールが届くアカウントに切り替えてから、下の手順 1 から進めます。",
            groups: [
                Group(heading: "転送先を登録する", steps: [
                    "上の「転送の設定を開く」で「メール転送と POP/IMAP」の画面を開き(開かないときは、パソコンのブラウザで Gmail を開き、右上の歯車 › 「すべての設定を表示」 › 「メール転送と POP/IMAP」)、「転送先アドレスを追加」を押して Otodoke のアドレスを貼り付けます。",
                    "「次へ」 › 「続行」 › 「OK」の順に押します。本人確認を求められたら済ませて、もう一度アドレスを入れます。",
                    "Gmail からの確認メールは Otodoke に届きます。少し待つと、Otodoke の設定の「メールの転送」に「承認ページを開く」が出るので、押して承認し、Gmail の画面を読み込み直します。「転送」は「転送を無効にする」のままにします。全部のメールではなく、次のフィルタで荷物のメールだけを送ります。",
                ]),
                Group(heading: "荷物のメールだけを送るフィルタを作る", steps: [
                    "Gmail の上の検索ボックスの右端にある、横線が並んだアイコン「検索オプションを表示」を押します。",
                    "「含む」に次の文字列を貼り付けます。",
                    "下の「フィルタを作成」を押します。",
                    "「転送する」にチェックを入れ、横の欄で Otodoke のアドレスを選び、「フィルタを作成」を押します。",
                ]),
            ],
            body: nil,
            filterAfterStep: 5,
            notes: [
                "転送するのは上の言葉を含むメールだけです。ただし、これらの言葉を含む「到着したよ」のような私信も転送されます。広告など読まないと決めたメールの本文は保存しません。読み取って買い物に関係ないと分かったメールは消します。",
            ]
        ),
        Service(
            id: "icloud",
            title: "iCloud メール",
            addresses: "@icloud.com・@me.com・@mac.com",
            meta: "3 分・ブラウザで",
            video: Video(path: "/guide/videos/otodoke-fwd-icloud-720.mp4", seconds: 92),
            link: Link(title: "iCloud メールを開く", url: "https://www.icloud.com/mail/"),
            linkNote: nil,
            groups: [
                Group(heading: nil, steps: [
                    "ブラウザで iCloud メールを開き、Apple アカウントでサインインします。",
                    "メールボックスの一覧の上にある「設定」ボタンを押し、「設定」を選びます。",
                    "左の一覧で「メールの転送」を選びます。",
                    "「メールの転送先」にチェックを入れ、欄に Otodoke のアドレスを貼り付けます。",
                    "「転送後にメッセージを削除」にはチェックを入れません。入れると、iCloud にメールが残りません。",
                ]),
            ],
            body: nil,
            filterAfterStep: nil,
            notes: ["iCloud はすべてのメールを転送します。広告など読まないと決めたメールの本文は保存しません。読み取って買い物に関係ないと分かったメールは消します。"]
        ),
        Service(
            id: "outlook",
            title: "Outlook",
            addresses: "@outlook.jp・@outlook.com・@hotmail.co.jp など",
            meta: "3 分・ブラウザで",
            video: Video(path: "/guide/videos/otodoke-fwd-outlook-720.mp4", seconds: 99),
            link: Link(title: "転送の設定を開く", url: "https://outlook.live.com/mail/0/options/mail/forwarding"),
            linkNote: "サインインしていないと Outlook の紹介ページが開きます。サインインしてから、もう一度このボタンを押してください。",
            groups: [
                Group(heading: nil, steps: [
                    "ブラウザで Outlook.com を開き、サインインします。",
                    "右上の歯車「設定」 › 「メール」 › 「転送」を開きます。「転送と IMAP」と出ることもあります。本人確認を求められたら済ませます。",
                    "「転送を有効にする」をオンにし、Otodoke のアドレスを貼り付けます。",
                    "「転送されたメッセージのコピーを保持する」が出ていたら、チェックを入れます。Outlook にもメールが残ります。",
                    "「保存」を押します。",
                ]),
            ],
            body: nil,
            filterAfterStep: nil,
            notes: ["Outlook はすべてのメールを転送します。広告など読まないと決めたメールの本文は保存しません。読み取って買い物に関係ないと分かったメールは消します。会社や学校のアカウントは、決まりで転送できないことがあります。"]
        ),
        Service(
            id: "others",
            title: "そのほかのメール",
            addresses: nil,
            meta: nil,
            video: nil,
            link: nil,
            linkNote: nil,
            groups: [],
            body: "お使いのメールの設定にある「自動転送」で、Otodoke のアドレスへ転送してください。",
            filterAfterStep: nil,
            notes: [
                "転送したメールが元のメールにも残る設定か、先に確かめてください。",
                "Yahoo!メールは、自動転送したメールが Yahoo!メールに残らないので、おすすめしません。",
            ]
        ),
    ]

    // MARK: 設定できたか確かめる

    static let verifyHeading = "設定できたか確かめる"
    static let verify: [String] = [
        "次に買い物をしたら、Otodoke の一覧に荷物が出るか見てください。",
        "出ないときは、設定の「うまく届かないとき」を開いてください。",
    ]
    /// The Web's FORWARDING_CHECK_ACTION: the button under the lines, opening 「うまく届かないとき」.
    static let checkAction = "「うまく届かないとき」を開く"

    // MARK: 動画

    static let videoLabel = "動画で見る"
    static let videoCredit = "動画の画面はイメージです。声は AivisSpeech のまお、曲は Mixkit の素材です。"
}

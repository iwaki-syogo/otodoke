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

    // MARK: Gmail / iCloud / Outlook / そのほか

    static let services: [Service] = [
        Service(
            id: "gmail",
            title: "Gmail",
            addresses: nil,
            meta: "5 分・ブラウザで",
            video: Video(path: "/guide/videos/otodoke-fwd-gmail-720.mp4", seconds: 97),
            link: Link(title: "Gmail の設定を開く", url: "https://mail.google.com/mail/u/0/#settings/general"),
            linkNote: "iPhone では Safari で進めます。このボタンで Gmail のアプリが開いたときは、Safari で mail.google.com を開きます。画面の下のアドレス欄の左にある ≡ のボタンを押し、出てきたメニューを下へスクロールすると「デスクトップ用ウェブサイトを表示」があります。それを選ぶと、パソコン版の画面になります。見当たらないときは、メニューの「…」の中にあります。\n\nAndroid では Chrome で進めます。このボタンで Gmail のアプリが開いたときは、Chrome で mail.google.com を開きます。右上の ⋮ のメニューを下へ送り、「PC 版サイト」にチェックを入れると、パソコン版の画面になります。\n\nGmail を 2 つ以上使っている人は、開いた画面の右上で、荷物のメールが届くアカウントに切り替えてから、下の手順 1 から進めます。",
            groups: [
                Group(heading: "転送先を登録する", steps: [
                    "上の「Gmail の設定を開く」を押すと、Gmail の設定の画面が開きます。上に並んだタブの「メール転送と POP/IMAP」を押します。開かないときは、右上の歯車 › 「すべての設定を表示」 › 「メール転送と POP/IMAP」を開きます。「転送先アドレスを追加」を押し、Otodoke のアドレスを貼り付けます。",
                    "「次へ」 › 「続行」 › 「OK」の順に押します。本人確認を求められたら済ませて、もう一度アドレスを入れます。",
                    "Gmail からの確認メールは Otodoke に届きます。少し待つと、Otodoke の設定の「メールの転送」に「承認ページを開く」が出るので、押して承認し、Gmail の画面を読み込み直します。「転送」の欄は変えずに、次のフィルタへ進みます。荷物のメールだけを送るためです。",
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
                "転送するのは上の言葉を含むメールだけです。ただし、これらの言葉を含む「到着したよ」のような私信も転送されます。広告など読まないと決めたメールの本文は保存しません。読み取って買い物に関係ないと分かったメールは、Otodoke に残しません。",
            ]
        ),
        Service(
            id: "icloud",
            title: "iCloud メール",
            addresses: "@icloud.com・@me.com・@mac.com",
            meta: "3 分・ブラウザで",
            video: Video(path: "/guide/videos/otodoke-fwd-icloud-720.mp4", seconds: 76),
            link: Link(title: "iCloud メールを開く", url: "https://www.icloud.com/mail/"),
            linkNote: nil,
            groups: [
                Group(heading: nil, steps: [
                    "ブラウザで iCloud メールを開き、Apple アカウントでサインインします。",
                    "メールボックスの一覧の上にある歯車のボタンを押し、「設定」を選びます。一覧が見えないときは、左上の「メールボックス」を押すと出ます。",
                    "設定の項目の一覧で「メールの転送」を選びます。一覧が見えないときは、左上の一覧のボタンを押すと出ます。",
                    "「メールの転送先」にチェックを入れ、欄に Otodoke のアドレスを貼り付けます。下の「転送後にメッセージを削除」はチェックを入れないままで大丈夫です。入れたら、左上の「×」で閉じます。",
                ]),
            ],
            body: nil,
            filterAfterStep: nil,
            notes: ["iCloud はすべてのメールを転送します。広告など読まないと決めたメールの本文は保存しません。"]
        ),
        Service(
            id: "outlook",
            title: "Outlook",
            addresses: "@outlook.jp・@outlook.com・@hotmail.co.jp など",
            meta: "3 分・ブラウザで",
            video: Video(path: "/guide/videos/otodoke-fwd-outlook-720.mp4", seconds: 65),
            link: Link(title: "転送の設定を開く", url: "https://outlook.live.com/mail/0/options/mail/forwarding"),
            linkNote: "iPhone では Safari で進めます。スマホ用の画面が出たら、画面の下のアドレス欄の左にある ≡ のボタンを押し、出てきたメニューを下へスクロールすると「デスクトップ用ウェブサイトを表示」があります。それを選ぶと、パソコン版の画面になります。見当たらないときは、メニューの「…」の中にあります。\n\nAndroid では Chrome で進めます。スマホ用の画面が出たら、右上の ⋮ のメニューを下へ送り、「PC 版サイト」にチェックを入れると、パソコン版の画面になります。",
            groups: [
                Group(heading: nil, steps: [
                    "上の「転送の設定を開く」を押します。Outlook の紹介ページが開いたら、サインインしてから、もう一度このボタンを押します。転送の画面が開かないときは、右上の歯車の「設定」、歯車が見当たらないときは右上の「…」の中の「設定」から、「メール」 › 「転送」を開きます。「転送と IMAP」と出ることもあります。本人確認を求められたら済ませます。",
                    "「転送を有効にする」をオンにし、Otodoke のアドレスを貼り付けます。",
                    "「転送されたメッセージのコピーを保持する」が出ていたら、チェックを入れます。Outlook にもメールが残ります。",
                    "「保存」を押します。",
                ]),
            ],
            body: nil,
            filterAfterStep: nil,
            notes: ["Outlook はすべてのメールを転送します。広告など読まないと決めたメールの本文は保存しません。会社や学校のアカウントは、決まりで転送できないことがあります。"]
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
            body: "お使いのメールの設定にある「自動転送」で、Otodoke のアドレスへ転送してください。転送したメールが元のメールにも残る設定にします。",
            filterAfterStep: nil,
            notes: [
                "Yahoo!メールは、自動転送したメールが Yahoo!メールに残らないので、おすすめしません。",
            ]
        ),
    ]

    // MARK: 動画

    static let videoLabel = "動画で見る"
    static let videoCredit = "動画は実際の画面です。名前とアドレスは隠しています。声は AivisSpeech のまお、曲は Mixkit の素材です。"
}

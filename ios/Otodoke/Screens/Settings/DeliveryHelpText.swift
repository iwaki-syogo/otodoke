// 「うまく届かないとき」: the three pitfalls that keep a parcel from showing up, copied sentence for sentence
// from 「届かない人が多い落とし穴」 of src/lib/forwarding-guide.ts (the Web source of truth), checked
// against the carriers' own help on 2026-11-07. The screen only draws what is listed here, and
// src/lib/__tests__/ios-forwarding-guide.test.ts fails when a sentence differs from the source.

import Foundation

enum DeliveryHelpText {
    static let heading = "届かない人が多い落とし穴（必ず確かめてください）"
    static let lead = "Otodoke は、あなたのメールボックスに届いたメールしか読めません。次のどれかに当てはまると、荷物が出ません。"

    static let pitfalls: [ForwardingGuideText.Pitfall] = [
        .init(title: "ヤマト運輸などのお届け予定メールを受け取っていない", blocks: [
            .text("ヤマト運輸の「お届け予定メール」は、クロネコメンバーズに登録した人にだけ届きます。いつ届くかは、このメールで分かることが多いです。"),
            .text("確かめ方:"),
            .steps([
                "クロネコメンバーズにログインします（未登録なら登録して、本人認証まで済ませます）。",
                "左上のメニュー › 「荷物に関する通知設定」を開きます。",
                "メールを「利用する」にして、「通知設定を保存する」を押します。LINE やアプリだけにしていると、メールが届きません。",
            ]),
            .text("迷惑メールの設定でドメインを指定して受け取っている人は、次の 3 つを受け取る側に足します:"),
            .domains(["@kuronekoyamato.co.jp", "@ml.kuronekoyamato.co.jp", "@ml2.kuronekoyamato.co.jp"]),
            .text("佐川急便・日本郵便も、会員サービスでメールの通知を受け取る設定にしておくと、届く日が分かりやすくなります。"),
            .links([
                .init(title: "お届け予定通知（ヤマト運輸）", url: "https://www.kuronekoyamato.co.jp/ytc/customer/redelivery/members/schedule_notice/"),
                .init(title: "受け取るドメイン（ヤマト運輸のよくある質問）", url: "https://faq.kuronekoyamato.co.jp/app/answers/detail/a_id/7935"),
            ]),
        ]),
        .init(title: "ショップの「発送のお知らせ」メールを止めている", blocks: [
            .text("ショップの会員ページの「メール配信設定」や「通知設定」で、注文確認・発送のお知らせ・お届けのお知らせのチェックを外していると、メールが届きません。"),
            .text("確かめ方: 最近買った店のメールを、メールボックスで「発送」と検索します。見つからなければ、その店の会員ページでチェックを入れ直します。"),
            .text("アプリの通知だけにしている店も、メールを受け取る設定にします。"),
        ]),
        .init(title: "荷物のメールが迷惑メールに入っている", blocks: [
            .text("迷惑メールのフォルダに入ったメールは、転送されないことがあります。見つけたら「迷惑メールではない」にします。"),
        ]),
    ]
}

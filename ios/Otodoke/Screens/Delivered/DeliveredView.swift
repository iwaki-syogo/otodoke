// TDD-STUB(task 21): 「届いた荷物」: the heading with the number, the search box, the shop / category / month
// pickers, 「クリア」, the month groups of cards; a parcel opens its detail. As the Web's page.

import SwiftUI

struct DeliveredView<Detail: View>: View {
    @Bindable var model: DeliveredModel
    @ViewBuilder let detail: (String) -> Detail

    var body: some View {
        EmptyView() // TDD-STUB(task 21)
    }
}

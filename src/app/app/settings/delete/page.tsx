import { AccountDeletion } from "../account-deletion";
import { SubPage } from "../sub-page";

export const metadata = { title: "アカウントの削除" };

export default function DeleteAccountPage() {
  return (
    <SubPage title="アカウントの削除">
      <AccountDeletion />
    </SubPage>
  );
}

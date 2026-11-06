import { getUser } from "@/lib/supabase/server";
import { AccountDeletion } from "../account-deletion";
import { LoggedInAs, SubPage } from "../sub-page";

export const metadata = { title: "アカウントの削除" };

export default async function DeleteAccountPage() {
  const user = (await getUser())!;
  return (
    <SubPage title="アカウントの削除">
      {/* Whose account goes, before the button that deletes it. */}
      <LoggedInAs email={user.email} />
      <AccountDeletion />
    </SubPage>
  );
}

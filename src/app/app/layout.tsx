import { redirect } from "next/navigation";
import { getUser } from "@/lib/supabase/server";
import { TabBar } from "./tab-bar";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await getUser();
  if (!user) redirect("/login");
  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-md flex-col">
      <main className="flex-1 px-4 pb-28 pt-6">{children}</main>
      <TabBar />
    </div>
  );
}

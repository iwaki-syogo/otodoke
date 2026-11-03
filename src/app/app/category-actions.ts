"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { CATEGORIES, type Category } from "@/lib/category";
import { createClient } from "@/lib/supabase/server";

const Input = z.object({ id: z.uuid(), category: z.enum(CATEGORIES) });

/**
 * The person picks a parcel's category. Recorded as theirs (category_source = "user") so no
 * reading replaces it later. Runs with the user's own session, so row-level security limits it
 * to their parcels; works for parcels from mails and typed-in ones alike.
 */
export async function setCategory(id: string, category: Category): Promise<{ ok: true } | { ok: false; error: string }> {
  const parsed = Input.safeParse({ id, category });
  if (!parsed.success) return { ok: false, error: "選べない分類です" };

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "ログインしてください" };

  const { data, error } = await supabase
    .from("parcels")
    .update({ category: parsed.data.category, category_source: "user" })
    .eq("id", parsed.data.id)
    .select("id");
  if (error) {
    console.error("setCategory:", error.message);
    return { ok: false, error: "保存できませんでした" };
  }
  if (!data || data.length !== 1) return { ok: false, error: "見つかりません" };
  revalidatePath("/app", "layout");
  return { ok: true };
}

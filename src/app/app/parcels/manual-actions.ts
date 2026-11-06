"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { MANUAL_DELETE_UNCHECKED, ManualParcelSchema, manualParcelFields, manualParcelRow, manualParcelSchemaFor, type ManualFormState } from "@/lib/manual-parcel";
import { createClient } from "@/lib/supabase/server";

// Parcels typed in by hand. Writes go through the user's own session (row-level security), and
// are also limited to the session's user_id, which never comes from the form. source = 'manual'
// is how the app tells these apart from parcels built from mails, so only those can be edited or
// deleted here.

const NOT_SIGNED_IN = "ログインしてください";
const NOT_FOUND = "見つかりません";
const FAILED = "保存できませんでした";
const Id = z.uuid();

function valuesOf(formData: FormData): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of formData.entries()) {
    if (typeof v === "string" && !k.startsWith("$ACTION")) out[k] = v;
  }
  return out;
}

function invalid(error: z.ZodError): string {
  return error.issues[0]?.message ?? "入力を確かめてください";
}

async function signedIn() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user ? { supabase, userId: user.id } : null;
}

export async function createManualParcel(_prev: ManualFormState, formData: FormData): Promise<ManualFormState> {
  const values = valuesOf(formData);
  const session = await signedIn();
  if (!session) return { error: NOT_SIGNED_IN, values };
  const parsed = ManualParcelSchema.safeParse(values);
  if (!parsed.success) return { error: invalid(parsed.error), values };

  const { data, error } = await session.supabase
    .from("parcels")
    .insert({ ...manualParcelRow(parsed.data, new Date()), user_id: session.userId })
    .select("id")
    .single();
  if (error || !data) {
    console.error("createManualParcel:", error?.message);
    return { error: FAILED, values };
  }
  revalidatePath("/app", "layout");
  redirect(`/app/parcels/${data.id}`);
}

export async function updateManualParcel(_prev: ManualFormState, formData: FormData): Promise<ManualFormState> {
  const values = valuesOf(formData);
  const session = await signedIn();
  if (!session) return { error: NOT_SIGNED_IN, values };
  const id = Id.safeParse(values.id);
  if (!id.success) return { error: NOT_FOUND, values };

  // What is stored decides what the form may send (a cancelled parcel may stay cancelled) and
  // what an unchanged field keeps (see manualParcelFields).
  const { data: saved, error: readError } = await session.supabase
    .from("parcels")
    .select("status, total_amount, category, ordered_at, expected_date, tracking_number, carrier, requires_presence")
    .eq("id", id.data)
    .eq("user_id", session.userId)
    .eq("source", "manual")
    .maybeSingle();
  if (readError) {
    console.error("updateManualParcel:", readError.message);
    return { error: FAILED, values };
  }
  if (!saved) return { error: NOT_FOUND, values };
  const parsed = manualParcelSchemaFor(saved.status, saved.total_amount).safeParse(values);
  if (!parsed.success) return { error: invalid(parsed.error), values };

  // Editing keeps when the parcel last heard from a mail; source stays as it is.
  const { data, error } = await session.supabase
    .from("parcels")
    .update(manualParcelFields(parsed.data, new Date(), saved))
    .eq("id", id.data)
    .eq("user_id", session.userId)
    .eq("source", "manual")
    .select("id");
  if (error) {
    console.error("updateManualParcel:", error.message);
    return { error: FAILED, values };
  }
  if (!data || data.length !== 1) return { error: NOT_FOUND, values };
  revalidatePath("/app", "layout");
  redirect(`/app/parcels/${id.data}`);
}

export async function deleteManualParcel(_prev: ManualFormState, formData: FormData): Promise<ManualFormState> {
  const values = valuesOf(formData);
  const session = await signedIn();
  if (!session) return { error: NOT_SIGNED_IN, values };
  const id = Id.safeParse(values.id);
  if (!id.success) return { error: NOT_FOUND, values };
  // The browser's required is not enough: a request made by hand must not delete without the check.
  if (values.confirm !== "yes") return { error: MANUAL_DELETE_UNCHECKED, values };

  const { data, error } = await session.supabase.from("parcels").delete().eq("id", id.data).eq("user_id", session.userId).eq("source", "manual").select("id");
  if (error) {
    console.error("deleteManualParcel:", error.message);
    return { error: "削除できませんでした", values };
  }
  if (!data || data.length !== 1) return { error: NOT_FOUND, values };
  revalidatePath("/app", "layout");
  redirect("/app");
}

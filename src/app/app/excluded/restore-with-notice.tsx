"use client";

import { useContext } from "react";
import { RESTORED_RULE_TOAST, RESTORED_TOAST } from "@/lib/not-parcel-text";
import { ToastContext } from "../delivered-controls";
import { RestoreExcludedButton } from "./restore-button";

/**
 * 一覧に戻す with the sentence after it worked, in the notice (the row is gone by then, so the notice cannot live in it).
 * A parcel the app took out by itself gets the sentence that also says the app stops doing it for that sender.
 * Put it inside the notice provider.
 */
export function RestoreWithNotice({ id, kind }: { id: string; kind: string }) {
  const showToast = useContext(ToastContext);
  return <RestoreExcludedButton id={id} onRestored={() => showToast({ text: kind === "rule" ? RESTORED_RULE_TOAST : RESTORED_TOAST, undo: null })} />;
}

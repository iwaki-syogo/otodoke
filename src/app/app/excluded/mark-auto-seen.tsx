"use client";

import { useEffect, useRef } from "react";
import { markAutoExcludedSeen } from "../parcel-actions";

/**
 * Says "seen" once, after the page of 外した荷物 is on the screen. It is drawn only when at least one parcel the app took
 * out by itself (and that has not arrived) is listed, and it is given the newest of their marks, so a mark made after the
 * page was read stays unseen. It draws nothing. A failure changes nothing on the screen: the row under the list stays.
 * The server part of the page never calls this, so a render or a link's prefetch writes nothing.
 */
export function MarkAutoSeen({ seenUntil }: { seenUntil: string }) {
  const sent = useRef(false);
  useEffect(() => {
    if (sent.current) return;
    sent.current = true;
    void markAutoExcludedSeen(seenUntil).catch(() => {});
  }, [seenUntil]);
  return null;
}

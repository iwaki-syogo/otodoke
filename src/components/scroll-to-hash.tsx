"use client";

import { useEffect } from "react";

/** The element a URL's #fragment names, or null (none, or a fragment that does not decode). */
export function hashTarget(hash: string): HTMLElement | null {
  if (hash.length < 2) return null;
  let id: string;
  try {
    id = decodeURIComponent(hash.slice(1));
  } catch {
    return null;
  }
  return document.getElementById(id);
}

/**
 * Inside a loading screen. A link such as /app/settings#demo first draws the loading screen,
 * where the #demo section is not yet: the router finds no target then and drops the scroll. When
 * the page replaces the loading screen, this one is removed, and its cleanup (run after the page
 * is in the document) scrolls to the URL's #fragment, if it names an element.
 */
export function ScrollToHashOnReady() {
  useEffect(
    () => () => {
      hashTarget(window.location.hash)?.scrollIntoView();
    },
    [],
  );
  return null;
}

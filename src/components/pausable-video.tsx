"use client";

import { useEffect, useRef, type VideoHTMLAttributes } from "react";

/**
 * A <video> that pauses when the <details> card around it is closed (a closed card hides the video but
 * does not stop it). Outside a <details> (/guide/forwarding) it does nothing extra.
 */
export function PausableVideo(props: VideoHTMLAttributes<HTMLVideoElement>) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const video = ref.current;
    const details = video?.closest("details");
    if (!video || !details) return;
    const onToggle = () => {
      if (!details.open) video.pause();
    };
    details.addEventListener("toggle", onToggle);
    return () => details.removeEventListener("toggle", onToggle);
  }, []);
  return <video ref={ref} {...props} />;
}

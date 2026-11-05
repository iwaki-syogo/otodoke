import { Poppins } from "next/font/google";

// The wordmark's letters only. Body text keeps the system font stack from globals.css.
const poppins = Poppins({ weight: "800", subsets: ["latin"], display: "swap" });

/** The cardboard box seen from above. It stands in for the second "o" of the wordmark and is the app icon. */
export function BoxMark(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg" {...props}>
      <rect x="8" y="8" width="48" height="48" rx="9" fill="#c8894b" />
      <rect x="28" y="8" width="8" height="48" fill="#ecc896" />
      <rect x="39" y="38" width="12" height="11" rx="2" fill="#fff" />
      <rect x="41.5" y="41" width="7" height="2.4" rx="1.2" fill="#dc2626" />
      <rect x="41.5" y="44.6" width="4.5" height="2" rx="1" fill="#a8a29e" />
    </svg>
  );
}

/**
 * "ot[box]doke". Size it with the font size (e.g. a `text-xl` class); every measure is in em.
 * Screen readers hear "Otodoke" once: the wrapper is the image, its parts are hidden.
 */
export function Wordmark({ className }: { className?: string }) {
  return (
    <span
      role="img"
      aria-label="Otodoke"
      className={`${poppins.className} inline-block whitespace-nowrap leading-none ${className ?? ""}`}
      style={{ fontWeight: 800, letterSpacing: "-0.03em", color: "#1c1917" }}
    >
      <span aria-hidden="true">ot</span>
      {/* Baseline-aligned, then nudged down: the box's middle lines up with the middle of "o". */}
      <BoxMark
        aria-hidden="true"
        focusable="false"
        style={{ display: "inline-block", width: "0.6em", height: "0.6em", margin: "0 0.03em", transform: "translateY(0.03em)", verticalAlign: "baseline" }}
      />
      <span aria-hidden="true">doke</span>
    </span>
  );
}

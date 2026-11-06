const SIZE = { sm: "h-3 w-3", md: "h-3.5 w-3.5", lg: "h-4 w-4" } as const;
const TONE = { dark: "border-neutral-300 border-t-neutral-700", light: "border-white/40 border-t-white" } as const;

/**
 * The app's one spinner: a small turning ring. Hidden from screen readers, so the words next to
 * it say what is happening (「保存しています…」). `light` is for dark buttons.
 */
export function Spinner({ size = "sm", tone = "dark" }: { size?: keyof typeof SIZE; tone?: keyof typeof TONE }) {
  return <span aria-hidden className={`inline-block shrink-0 animate-spin rounded-full border-2 ${SIZE[size]} ${TONE[tone]}`} />;
}

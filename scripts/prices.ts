/** USD per million tokens: input, output, cache read, cache write. Shared by the scripts that call Claude. */
export type Price = [number, number, number, number];

export const PRICES: Record<string, Price> = {
  "claude-opus-5-5": [4, 20, 0.2, 5],
  "claude-sonnet-5-5": [2, 10, 0.1, 2.5],
  "claude-haiku-5-5": [0.1, 0.5, 0.01, 0.125],
};

/**
 * The dearer card of a model whose price depends on the prompt's length: used when the prompt (input, cache read and
 * cache write tokens together) is longer than `abovePromptTokens`. Cache reads are 0.1x and 5-minute cache writes 1.25x
 * of that card's input rate, as on the base card. Models not listed have one card. Check the pricing page when adding.
 */
export const LONG_PROMPT_PRICES: Record<string, { abovePromptTokens: number; price: Price }> = {
  "claude-haiku-5-5": { abovePromptTokens: 100_000, price: [0.5, 2.5, 0.05, 0.625] },
};

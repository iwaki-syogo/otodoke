/** USD per million tokens: input, output, cache read, cache write. Shared by the scripts that call Claude. */
export type Price = [number, number, number, number];

export const PRICES: Record<string, Price> = {
  "claude-opus-5-5": [4, 20, 0.2, 5],
  "claude-sonnet-5-5": [2, 10, 0.1, 2.5],
  "claude-haiku-5-5": [0.1, 0.5, 0.01, 0.125],
};

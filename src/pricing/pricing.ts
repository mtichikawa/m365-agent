/**
 * Azure OpenAI token prices, keyed by the model actually served.
 *
 * The deployment names are historical: the deployment called "gpt-4o" serves
 * gpt-5.1-2025-11-13 and "gpt-4o-mini" serves gpt-4.1-mini-2025-04-14 (the
 * response `model` field, checked 2026-10-13). So prices are keyed by the
 * served model, never the deployment name.
 *
 * Source: Azure retail prices API (prices.azure.com, "Foundry Models"),
 * read 2026-10-13. Where Global and regional/Data Zone prices differ, the
 * higher is used, so a figure here is a ceiling for either deployment type.
 * USD per 1M tokens.
 */

export interface TokenPrice {
  input: number;
  cachedInput: number;
  output: number;
}

export const MODEL_PRICES: Record<string, TokenPrice> = {
  'gpt-5.1': { input: 1.5, cachedInput: 0.15, output: 12 },
  'gpt-4.1-mini': { input: 0.44, cachedInput: 0.11, output: 1.76 },
};

/** Price for a model as the API reports it ("gpt-5.1-2025-11-13" → "gpt-5.1"), or undefined. */
export function priceFor(model: string): TokenPrice | undefined {
  return MODEL_PRICES[model] ?? MODEL_PRICES[model.replace(/-\d{4}-\d{2}-\d{2}$/, '')];
}

/** Dollar cost of one set of token counts, discounting cached input. */
export function tokenCostUsd(
  price: TokenPrice,
  promptTokens: number,
  cachedTokens: number,
  completionTokens: number,
): number {
  const uncached = promptTokens - cachedTokens;
  return (uncached * price.input + cachedTokens * price.cachedInput + completionTokens * price.output) / 1e6;
}

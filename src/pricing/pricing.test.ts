import { describe, expect, it } from 'vitest';
import { priceFor, tokenCostUsd } from './pricing.js';

describe('pricing', () => {
  it('finds a price by the model name the API reports, dated or not', () => {
    expect(priceFor('gpt-5.1-2025-11-13')).toEqual(priceFor('gpt-5.1'));
    expect(priceFor('gpt-4.1-mini-2025-04-14')?.input).toBe(0.44);
  });

  it('has no price for a deployment name or an unknown model', () => {
    expect(priceFor('gpt-4o')).toBeUndefined();
    expect(priceFor('')).toBeUndefined();
  });

  it('discounts cached input', () => {
    // 0.5M × 1.5 + 0.5M × 0.15 + 0.1M × 12 = 2.025
    expect(tokenCostUsd(priceFor('gpt-5.1')!, 1_000_000, 500_000, 100_000)).toBeCloseTo(2.025, 6);
  });
});

import { describe, expect, it } from 'vitest';
import {
  analyticsPageLocation,
  isGaMeasurementId,
} from '@/app/analytics';

describe('privacy-preserving analytics helpers', () => {
  it('accepts GA4 measurement IDs and rejects unrelated values', () => {
    expect(isGaMeasurementId('G-ABC123XYZ9')).toBe(true);
    expect(isGaMeasurementId(' g-abc123 ')).toBe(true);
    expect(isGaMeasurementId('UA-12345-1')).toBe(false);
    expect(isGaMeasurementId(undefined)).toBe(false);
  });

  it('removes query parameters and share fragments from page locations', () => {
    expect(
      analyticsPageLocation(
        'https://chesspermutations.com/play?source=private#pgn-secret',
      ),
    ).toBe('https://chesspermutations.com/play');
  });
});

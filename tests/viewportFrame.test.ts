import { describe, expect, it } from 'vitest';
import { perspectiveFitDistance } from '../src/app/viewport';

describe('perspective frame fit', () => {
  it.each([
    ['desktop canvas', 1.04],
    ['tablet landscape canvas', 1.55],
    ['narrow canvas', 0.42]
  ])('fits the complete focus sphere in a %s aspect', (_name, aspect) => {
    const radius = 1.42;
    const fov = 36;
    const distance = perspectiveFitDistance(radius, fov, aspect);
    const halfVertical = (fov * Math.PI) / 360;
    const halfHorizontal = Math.atan(Math.tan(halfVertical) * aspect);
    const projectedSphereHalfAngle = Math.asin(radius / distance);
    expect(projectedSphereHalfAngle).toBeLessThan(Math.min(halfVertical, halfHorizontal));
  });

  it('rejects invalid framing inputs rather than producing NaN camera state', () => {
    expect(() => perspectiveFitDistance(0, 36, 1)).toThrow(/Invalid perspective framing/);
    expect(() => perspectiveFitDistance(1, 36, 0)).toThrow(/Invalid perspective framing/);
  });
});

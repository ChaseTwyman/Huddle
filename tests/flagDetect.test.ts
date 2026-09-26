import { describe, expect, it } from 'vitest';
import { FlagDetector, isFlagYellow, yellowRatio } from '../shared/flagDetect';

/** A w×h RGBA frame: dark scorebug with an optional yellow box covering `fraction` of it. */
function frame(fraction: number, yellow: [number, number, number] = [245, 197, 24], w = 60, h = 20) {
  const data = new Uint8ClampedArray(w * h * 4);
  const cut = Math.round(w * h * fraction);
  for (let p = 0; p < w * h; p++) {
    const [r, g, b] = p < cut ? yellow : [20, 30, 45];
    data.set([r, g, b, 255], p * 4);
  }
  return data;
}

describe('F14 camera flag detection', () => {
  it('recognizes broadcast flag yellow, including warm and dim camera renderings', () => {
    expect(isFlagYellow(245, 197, 24)).toBe(true); // Huddle's own --flag
    expect(isFlagYellow(255, 214, 0)).toBe(true); // typical broadcast FLAG box
    expect(isFlagYellow(230, 170, 40)).toBe(true); // warm white balance
    expect(isFlagYellow(200, 190, 60)).toBe(true); // dimmer, greener camera
    expect(isFlagYellow(255, 255, 255)).toBe(false); // white text
    expect(isFlagYellow(220, 60, 50)).toBe(false); // red team color
    expect(isFlagYellow(60, 200, 90)).toBe(false); // green turf
    expect(isFlagYellow(100, 90, 20)).toBe(false); // too dark
    expect(isFlagYellow(40, 120, 250)).toBe(false); // blue line
  });

  it('measures the yellow share of the region', () => {
    expect(yellowRatio(frame(0))).toBe(0);
    expect(yellowRatio(frame(0.25))).toBeCloseTo(0.25, 2);
    expect(yellowRatio(frame(0.25), 2)).toBeCloseTo(0.25, 1);
  });

  it('fires on a FLAG box after two confirming samples, then cools down', () => {
    const d = new FlagDetector();
    let t = 0;
    for (let i = 0; i < 30; i++) expect(d.sample(yellowRatio(frame(0.01)), (t += 500)).fired).toBe(false);
    expect(d.sample(yellowRatio(frame(0.2)), (t += 500)).fired).toBe(false); // one frame could be a glitch
    expect(d.sample(yellowRatio(frame(0.2)), (t += 500)).fired).toBe(true);
    // The box stays up for a while: no second trigger during the cooldown.
    for (let i = 0; i < 20; i++) expect(d.sample(yellowRatio(frame(0.2)), (t += 500)).fired).toBe(false);
  });

  it('ignores a scorebug that is always a bit yellow (team colors) and single-frame flicker', () => {
    const d = new FlagDetector();
    let t = 0;
    for (let i = 0; i < 40; i++) expect(d.sample(yellowRatio(frame(0.05)), (t += 500)).fired).toBe(false); // a yellow team chip, from the first frame
    const s = d.sample(yellowRatio(frame(0.1)), (t += 500));
    expect(s.baseline).toBeCloseTo(0.05, 2);
    expect(s.fired).toBe(false); // 0.10 < 0.05 × 3 + 0.02
    for (let i = 0; i < 5; i++) {
      expect(d.sample(yellowRatio(frame(0.4)), (t += 500)).fired).toBe(false);
      expect(d.sample(yellowRatio(frame(0.05)), (t += 500)).fired).toBe(false);
    }
    d.sample(yellowRatio(frame(0.4)), (t += 500));
    expect(d.sample(yellowRatio(frame(0.4)), (t += 500)).fired).toBe(true);
  });
});

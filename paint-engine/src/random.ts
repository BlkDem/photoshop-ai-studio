/**
 * Deterministic randomness.
 *
 * A painting that is different every time it is rendered cannot be tested, and
 * cannot be debugged: "the foam looks wrong" is unactionable if the same plan
 * paints a different foam each time. Everything stochastic in the engine draws
 * from here, seeded from `PaintingPlan.seed`, so one plan always produces one
 * picture.
 *
 * `Math.random` is deliberately not used anywhere in this package.
 */

/** A small, fast, well-distributed PRNG (mulberry32). */
export class Rng {
  private state: number;

  constructor(seed: number) {
    // Any integer seed is accepted; the mix keeps neighbouring seeds far apart,
    // so stage 1 and stage 2 of one plan do not produce visibly similar noise.
    this.state = (seed >>> 0) ^ 0x9e3779b9;
  }

  /** Uniform in [0, 1). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Uniform in [min, max). */
  range(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  /** Integer in [min, max]. */
  int(min: number, max: number): number {
    return Math.floor(this.range(min, max + 1));
  }

  /** True with probability p. */
  chance(p: number): boolean {
    return this.next() < p;
  }

  /** Uniform in [-amount, amount). */
  jitter(amount: number): number {
    return this.range(-amount, amount);
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error('Rng.pick called with an empty list');
    const item = items[this.int(0, items.length - 1)];
    // `noUncheckedIndexedAccess` cannot see that `int` is in range.
    return item as T;
  }

  /**
   * Roughly normal, by the sum of three uniforms.
   *
   * Used for mark jitter and pressure noise, where a flat distribution shows as
   * visible banding: too many marks at exactly the same offset.
   */
  gaussian(): number {
    return (this.next() + this.next() + this.next()) / 1.5 - 1;
  }
}
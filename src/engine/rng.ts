/**
 * 确定性随机源。整个 Run 的随机性都必须经过它——同一 seed 加同一串输入
 * 必须得到同一个 Run，否则 headless 测试无法断言。
 */
export interface Rng {
  readonly state: number;
}

export function createRng(seed: number): Rng {
  return { state: seed | 0 };
}

/** mulberry32，纯函数形式：吃进一个 Rng，吐出新的 Rng 和一个 [0,1) 的值。 */
function next(rng: Rng): readonly [Rng, number] {
  let a = (rng.state + 0x6d2b79f5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  const value = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  return [{ state: a }, value];
}

export function nextInt(rng: Rng, maxExclusive: number): readonly [Rng, number] {
  const [nextRng, value] = next(rng);
  return [nextRng, Math.floor(value * maxExclusive)];
}

/** Fisher-Yates。返回新数组，不改动入参。 */
export function shuffle<T>(rng: Rng, items: readonly T[]): readonly [Rng, readonly T[]] {
  const out = [...items];
  let current = rng;
  for (let i = out.length - 1; i > 0; i--) {
    const [nextRng, j] = nextInt(current, i + 1);
    current = nextRng;
    const a = out[i];
    const b = out[j];
    if (a === undefined || b === undefined) continue;
    out[i] = b;
    out[j] = a;
  }
  return [current, out];
}

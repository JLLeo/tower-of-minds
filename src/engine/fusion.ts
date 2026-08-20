import { MAX_ATOMS_PER_CARD, atomOf, cardTypeOf, costOf } from './atoms.js';
import { fusionTasteOf } from './content.js';
import type { CardDefinition, CardType, ExecutionSpec } from './types.js';

/**
 * Fusion 与 Mutation。
 *
 * 合并规则、费用与类别全部是引擎的固定资产；Agent 只在**合法集里**做两个选择：
 * 超出上限时丢掉哪一个 Atom（或过载时塞进哪个 Forbidden Atom），以及新 Card 叫什么
 * （ADR-0005）。它答不上来时引擎按该 Faction 的性格替它选——所以「找不同派系融会得到
 * 不同的牌」不依赖模型可用性。
 */

/** 合并两张牌的 Atom。重复的 Atom 保留，它们是叠加而不是抵消。 */
export function mergeAtoms(a: readonly string[], b: readonly string[]): readonly string[] {
  return [...a, ...b];
}

export function exceedsCapacity(atoms: readonly string[]): boolean {
  return atoms.length > MAX_ATOMS_PER_CARD;
}

/** 超出上限时，这一方会先舍弃哪个 Atom。合法集就是这些 Atom 本身。 */
export function preferredDrop(factionId: string, atoms: readonly string[]): string | undefined {
  const taste = fusionTasteOf(factionId);
  const ranked = [...atoms].sort((left, right) => {
    const a = atomOf(left);
    const b = atomOf(right);
    const axisA = a ? taste.sheds.indexOf(a.axis) : -1;
    const axisB = b ? taste.sheds.indexOf(b.axis) : -1;
    if (axisA !== axisB) return axisA - axisB; // 越靠前越先舍弃
    return (a?.weight ?? 0) - (b?.weight ?? 0); // 同轴则先舍弃更轻的
  });
  return ranked[0];
}

/** 过载时这一方会塞进来的 Forbidden Atom。 */
export function preferredForbidden(factionId: string): string {
  return fusionTasteOf(factionId).forbidden;
}

/** 名字兜底：模型没给或给了不像话的东西时用。 */
export function fallbackName(a: string, b: string, mutated: boolean): string {
  const head = a.slice(0, 1);
  const tail = b.slice(-1);
  return mutated ? `${head}${tail}·变异` : `${head}${tail}`;
}

export interface ForgeInput {
  readonly atoms: readonly string[];
  readonly name: string;
  readonly factionId: string;
  /** 过载产物：它不受 Atom 上限约束，那正是「过载」的意思。 */
  readonly mutated: boolean;
  readonly executionByType: Partial<Record<CardType, ExecutionSpec>>;
  readonly seq: number;
}

/**
 * 把一组 Atom 锻成一张真正的 Card。费用与类别照常推出——玩家因此仍然能读懂它，
 * 哪怕这张牌从来没有出现过。
 */
export function forgeCard(input: ForgeInput): CardDefinition {
  const type = cardTypeOf(input.atoms);
  const execution = input.executionByType[type];
  return {
    id: `forged-${input.seq}`,
    name: input.name,
    faction: input.factionId,
    atoms: input.atoms,
    cost: costOf(input.atoms),
    type,
    ...(execution ? { execution } : {}),
  };
}

/** 名字来自模型，所以要洗一遍：去掉空白、截断，空的就交给兜底。 */
export function sanitizeName(raw: unknown, fallback: string): string {
  if (typeof raw !== 'string') return fallback;
  const trimmed = raw.trim().replace(/\s+/g, '');
  if (trimmed.length === 0) return fallback;
  return trimmed.slice(0, 8);
}

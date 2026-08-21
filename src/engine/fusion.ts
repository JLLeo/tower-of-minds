import { MAX_ATOMS_PER_CARD, atomOf, cardTypeOf, costOf } from './atoms.js';
import { executionFor, fusionTasteOf } from './content.js';
import type { CardDefinition, RunState } from './types.js';

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

/**
 * 超出上限时，这一方会先舍弃哪个 Atom。合法集就是这些 Atom 本身。
 *
 * sheds 里没列到的轴表示「这一方舍不得」，排到最后——**不能用 indexOf 的 -1**，
 * 那会让没列到的轴反而排在最前面，于是赤环第一个丢掉的是伤害原子，与它的性格完全相反。
 */
export function preferredDrop(factionId: string, atoms: readonly string[]): string | undefined {
  const taste = fusionTasteOf(factionId);
  const rankOf = (axis: string): number => {
    const index = taste.sheds.indexOf(axis as never);
    return index >= 0 ? index : Number.MAX_SAFE_INTEGER;
  };

  const ranked = [...atoms].sort((left, right) => {
    const a = atomOf(left);
    const b = atomOf(right);
    const axisA = a ? rankOf(a.axis) : -1;
    const axisB = b ? rankOf(b.axis) : -1;
    if (axisA !== axisB) return axisA - axisB; // 越靠前越先舍弃
    return (a?.weight ?? 0) - (b?.weight ?? 0); // 同轴则先舍弃更轻的
  });
  return ranked[0];
}

/**
 * 按这一方的偏好一路丢到装得下为止。
 *
 * 只丢一个是不够的：一张已经顶到上限的融合产物再融一次会有 6 个 Atom，
 * 丢掉一个还剩 5——这样反复融下去 Card 会无限膨胀，而 ADR-0005 把「单卡至多 4 个 Atom」
 * 定成了引擎的固定资产。
 */
export function trimToCapacity(
  factionId: string,
  atoms: readonly string[],
  capacity = MAX_ATOMS_PER_CARD,
): readonly string[] {
  let kept = [...atoms];
  while (kept.length > capacity) {
    const drop = preferredDrop(factionId, kept);
    const index = drop ? kept.indexOf(drop) : -1;
    if (index < 0) break;
    kept = kept.filter((_, i) => i !== index);
  }
  return kept;
}

/** 过载时这一方会塞进来的 Forbidden Atom。 */
export function preferredForbidden(factionId: string): string {
  return fusionTasteOf(factionId).forbidden;
}

/**
 * 过载后这张牌能装多少个 Atom：比上限多一个。
 *
 * 「过载」不是「一个都不丢」——那样反复融合会无限膨胀。它换来的是**一个额外的位置**，
 * 而那个位置装的正是禁忌 Atom。
 */
export const OVERLOAD_CAPACITY = MAX_ATOMS_PER_CARD + 1;

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
  readonly seq: number;
}

/**
 * 把一组 Atom 锻成一张真正的 Card。费用与类别照常推出——玩家因此仍然能读懂它，
 * 哪怕这张牌从来没有出现过。
 */
export function forgeCard(input: ForgeInput): CardDefinition {
  return {
    id: `forged-${input.seq}`,
    name: input.name,
    faction: input.factionId,
    atoms: input.atoms,
    cost: costOf(input.atoms),
    type: cardTypeOf(input.atoms),
    // 判定同样从 Atom 推出——融进来一个 steady，这张牌的窗口当场就变宽。
    execution: executionFor(input.atoms),
  };
}

/**
 * 锻好一张牌，把被融掉的那张从 Deck 里换出去。
 *
 * 玩家那条 Fusion 有两条路进来——不超上限时引擎自己锻，超了则由 Agent 取舍后再锻——
 * 但落地只有这一处，免得两边各自维护一份 Deck 交换与编号逻辑。
 * 对手自己的融合不换玩家的 Deck，因此走 forgeCard 而不经过这里。
 */
export function applyForge(
  state: RunState,
  input: {
    readonly atoms: readonly string[];
    readonly name: string;
    readonly factionId: string;
    readonly deckInstanceId: string;
    readonly note: string;
  },
): RunState {
  const forged = forgeCard({
    atoms: input.atoms,
    name: input.name,
    factionId: input.factionId,
    seq: state.forged.length,
  });

  return {
    ...state,
    phase: 'choosing_favor',
    favor: { factionId: input.factionId, tier: 'high', choices: [] },
    forged: [...state.forged, forged],
    deck: [
      ...state.deck.filter((card) => card.instanceId !== input.deckInstanceId),
      { instanceId: `${forged.id}#${state.nextCardSeq}`, definitionId: forged.id },
    ],
    nextCardSeq: state.nextCardSeq + 1,
    journal: [...state.journal, input.note.replace('{name}', forged.name)],
  };
}

/** 名字来自模型，所以要洗一遍：去掉空白、截断，空的就交给兜底。 */
export function sanitizeName(raw: unknown, fallback: string): string {
  if (typeof raw !== 'string') return fallback;
  const trimmed = raw.trim().replace(/\s+/g, '');
  if (trimmed.length === 0) return fallback;
  return trimmed.slice(0, 8);
}

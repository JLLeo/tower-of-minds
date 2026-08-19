import type { CardType, Effect } from './types.js';

/**
 * Atom 是效果的最小单位，也是这个游戏全部内容的来源（ADR-0005）。
 *
 * Base Card 很少而且固定，一局之内的多样性全部来自 Fusion 与 Mutation 对 Atom 的
 * 重新组合。LLM 可以组合这张表里的 Atom，永远不能发明新的——所以玩家看到一张没见过
 * 的融合卡时，读的是已知 Atom 的组合，而不是一段新规则。
 */
export type AtomAxis = 'damage' | 'defense' | 'resource' | 'status' | 'execution' | 'faction';

export interface AtomDefinition {
  readonly id: string;
  readonly name: string;
  readonly axis: AtomAxis;
  /** 费用由权重推出。Forbidden Atom 的权重为负，所以突变产物更强也更便宜。 */
  readonly weight: number;
  readonly description: string;
  /** 只有 Mutation 能产出。Fusion 与 Base Card 都拿不到。 */
  readonly forbidden?: true;
  /**
   * 这个 Atom 的效果由哪张票落地。未落地的 Atom 允许出现在表里（Fusion 需要完整的
   * 表来算费用），但不会出现在任何 Base Card 上。
   */
  readonly pendingTicket?: string;
}

export const ATOMS: readonly AtomDefinition[] = [
  // 伤害轴
  { id: 'strike', name: '劈', axis: 'damage', weight: 3, description: '造成 6 点伤害' },
  { id: 'pierce', name: '穿', axis: 'damage', weight: 3, description: '造成 4 点伤害，无视格挡' },
  { id: 'multi', name: '连', axis: 'damage', weight: 2, description: '造成 3 段各 2 点伤害' },
  { id: 'burn', name: '灼', axis: 'damage', weight: 3, description: '灼烧 3，持续 2 回合' },

  // 防御轴
  { id: 'guard', name: '挡', axis: 'defense', weight: 3, description: '获得 5 点格挡' },
  { id: 'thorns', name: '棘', axis: 'defense', weight: 2, description: '获得 3 点反伤' },
  { id: 'endure', name: '忍', axis: 'defense', weight: 2, description: '本回合受到的伤害 -2' },

  // 资源轴
  { id: 'draw', name: '汲', axis: 'resource', weight: 2, description: '抽 1 张牌' },
  { id: 'surge', name: '涌', axis: 'resource', weight: 3, description: '获得 1 点能量' },
  { id: 'recall', name: '拾', axis: 'resource', weight: 3, description: '从弃牌堆取回 1 张牌' },

  // 状态轴
  { id: 'expose', name: '破', axis: 'status', weight: 3, description: '目标易伤：下次受到的伤害 +50%' },
  { id: 'weaken', name: '弱', axis: 'status', weight: 3, description: '目标虚弱：下次造成的伤害 -50%' },

  // 判定轴 —— 让 Execution Check 成为构筑的一部分。效果在 #5 落地。
  { id: 'steady', name: '稳', axis: 'execution', weight: 2, description: '本次判定窗口 ×1.5', pendingTicket: '#5' },
  { id: 'focus', name: '专', axis: 'execution', weight: 3, description: '本次 Perfect 倍率提到 2.0', pendingTicket: '#5' },
  { id: 'reflex', name: '应', axis: 'execution', weight: 3, description: '本次即使 Miss 也按 Good 结算', pendingTicket: '#5' },

  // 派系轴 —— 效果在 #8 随 Standing 落地。
  { id: 'parley', name: '交', axis: 'faction', weight: 3, description: '目标 Faction 的 Standing +1', pendingTicket: '#8' },

  // 禁忌 Atom —— 只有 Mutation 能拿到（#13）。权重为负，因此更强也更便宜。
  { id: 'sacrifice', name: '献', axis: 'damage', weight: -2, description: '失去 5 点生命，本卡其余 Atom 效果翻倍', forbidden: true, pendingTicket: '#13' },
  { id: 'wild', name: '狂', axis: 'damage', weight: -2, description: '目标随机', forbidden: true, pendingTicket: '#13' },
  { id: 'contagion', name: '疫', axis: 'status', weight: -1, description: '效果同时作用于场上所有单位，包括你偏袒的一方', forbidden: true, pendingTicket: '#13' },
  { id: 'greed', name: '贪', axis: 'resource', weight: -2, description: '本局中每打出一次，费用 +1', forbidden: true, pendingTicket: '#13' },
];

/** 单张 Card 至多容纳这么多 Atom。超过时 Fusion 必须丢弃，或过载触发 Mutation。 */
export const MAX_ATOMS_PER_CARD = 4;

const BY_ID = new Map(ATOMS.map((atom) => [atom.id, atom]));

export function atomOf(id: string): AtomDefinition | undefined {
  return BY_ID.get(id);
}

/** 一张牌的 Atom 印记，例如「劈穿」。玩家靠它一眼看出这张牌由什么组成。 */
export function atomGlyphs(atomIds: readonly string[]): string {
  return atomIds.map((id) => atomOf(id)?.name ?? '?').join('');
}

/** 一张牌的完整说明，由它的 Atom 拼出来——牌面文字不是手写的。 */
export function describeAtoms(atomIds: readonly string[]): string {
  return atomIds
    .map((id) => atomOf(id)?.description)
    .filter((text): text is string => text !== undefined)
    .join('；');
}

/** 费用由 Atom 权重推出，不是手写的。这是融合结果可预估的前提。 */
export function costOf(atomIds: readonly string[]): number {
  const total = atomIds.reduce((sum, id) => sum + (atomOf(id)?.weight ?? 0), 0);
  return Math.max(1, Math.ceil(total / 3));
}

/**
 * Card Type 由主导轴推出：伤害轴最多就是攻击，防御轴最多就是盾牌，其余是法术。
 * Card Type 进而决定这张牌触发哪种 Execution Check 原型，所以类别不能与 Atom 矛盾。
 */
export function cardTypeOf(atomIds: readonly string[]): CardType {
  let damage = 0;
  let defense = 0;
  for (const id of atomIds) {
    const axis = atomOf(id)?.axis;
    if (axis === 'damage') damage++;
    else if (axis === 'defense') defense++;
  }
  if (damage > defense) return 'attack';
  if (defense > damage) return 'shield';
  if (damage > 0) return 'attack'; // 平手且都有伤害：按攻击算
  return 'spell';
}

/**
 * 把 Atom 展开成引擎认识的效果。
 *
 * 尚未落地的 Atom（pendingTicket）在这里被跳过——它们已经在表里参与费用计算，
 * 但还不产生效果。这样 Fusion 的费用规则可以先成立，效果按票逐个补齐。
 */
export function effectsOf(atomIds: readonly string[], targetId: string | undefined): readonly Effect[] {
  const effects: Effect[] = [];

  for (const id of atomIds) {
    const atom = atomOf(id);
    if (!atom || atom.pendingTicket || atom.forbidden) continue;

    switch (id) {
      case 'strike':
        if (targetId) effects.push({ kind: 'damage', targetId, amount: 6, hits: 1, ignoreBlock: false });
        break;
      case 'pierce':
        if (targetId) effects.push({ kind: 'damage', targetId, amount: 4, hits: 1, ignoreBlock: true });
        break;
      case 'multi':
        if (targetId) effects.push({ kind: 'damage', targetId, amount: 2, hits: 3, ignoreBlock: false });
        break;
      case 'burn':
        if (targetId) effects.push({ kind: 'apply_burn', targetId, amount: 3, turns: 2 });
        break;
      case 'guard':
        effects.push({ kind: 'gain_block', amount: 5 });
        break;
      case 'thorns':
        effects.push({ kind: 'gain_thorns', amount: 3 });
        break;
      case 'endure':
        effects.push({ kind: 'gain_endure', amount: 2 });
        break;
      case 'draw':
        effects.push({ kind: 'draw_cards', amount: 1 });
        break;
      case 'surge':
        effects.push({ kind: 'gain_energy', amount: 1 });
        break;
      case 'recall':
        effects.push({ kind: 'recall_card', amount: 1 });
        break;
      case 'expose':
        if (targetId) effects.push({ kind: 'apply_expose', targetId, amount: 1 });
        break;
      case 'weaken':
        if (targetId) effects.push({ kind: 'apply_weaken', targetId, amount: 1 });
        break;
    }
  }

  return effects;
}

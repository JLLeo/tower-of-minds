import type { CardType, Effect } from './types.js';

/**
 * Atom 是效果的最小单位，也是这个游戏全部内容的来源（ADR-0005）。
 *
 * Base Card 很少而且固定，一局之内的多样性全部来自 Fusion 与 Mutation 对 Atom 的
 * 重新组合。LLM 可以组合这张表里的 Atom，永远不能发明新的——所以玩家看到一张没见过
 * 的融合卡时，读的是已知 Atom 的组合，而不是一段新规则。
 */
export type AtomAxis = 'damage' | 'defense' | 'resource' | 'status' | 'execution' | 'faction';

/**
 * Atom 的效果模板：就是 Effect 去掉目标。目标由打出这张牌的时候决定。
 *
 * 数值只写在这里一处。牌面文字、给模型看的说明、以及引擎真正执行的效果，全部由它
 * 推出——否则三者会各自漂移，而给模型的 prompt 一旦与引擎不符，ADR-0005 用可学性
 * 换来的东西就白换了。
 */
export type EffectTemplate =
  | { readonly kind: 'damage'; readonly amount: number; readonly hits: number; readonly ignoreBlock: boolean }
  | { readonly kind: 'gain_block'; readonly amount: number }
  | { readonly kind: 'gain_thorns'; readonly amount: number }
  | { readonly kind: 'gain_endure'; readonly amount: number }
  | { readonly kind: 'apply_burn'; readonly amount: number; readonly turns: number }
  | { readonly kind: 'apply_expose' }
  | { readonly kind: 'apply_weaken' }
  | { readonly kind: 'draw_cards'; readonly amount: number }
  | { readonly kind: 'gain_energy'; readonly amount: number }
  | { readonly kind: 'recall_card'; readonly amount: number }
  | { readonly kind: 'parley' };

export interface AtomDefinition {
  readonly id: string;
  readonly name: string;
  readonly axis: AtomAxis;
  /** 费用由权重推出。Forbidden Atom 的权重为负，所以突变产物更强也更便宜。 */
  readonly weight: number;
  /** 效果模板。缺省表示这个 Atom 还没落地——它参与费用，但不产生效果。 */
  readonly template?: EffectTemplate;
  /** 无法从模板推出的说明，只用于尚未落地的 Atom。 */
  readonly flavor?: string;
  /** 只有 Mutation 能产出。Fusion 与 Base Card 都拿不到。 */
  readonly forbidden?: true;
  /** 这个 Atom 的效果由哪张票落地。 */
  readonly pendingTicket?: string;
}

export const ATOMS: readonly AtomDefinition[] = [
  // 伤害轴
  { id: 'strike', name: '劈', axis: 'damage', weight: 3, template: { kind: 'damage', amount: 6, hits: 1, ignoreBlock: false } },
  { id: 'pierce', name: '穿', axis: 'damage', weight: 3, template: { kind: 'damage', amount: 4, hits: 1, ignoreBlock: true } },
  { id: 'multi', name: '连', axis: 'damage', weight: 2, template: { kind: 'damage', amount: 2, hits: 3, ignoreBlock: false } },
  { id: 'burn', name: '灼', axis: 'damage', weight: 3, template: { kind: 'apply_burn', amount: 3, turns: 2 } },

  // 防御轴
  { id: 'guard', name: '挡', axis: 'defense', weight: 3, template: { kind: 'gain_block', amount: 5 } },
  { id: 'thorns', name: '棘', axis: 'defense', weight: 2, template: { kind: 'gain_thorns', amount: 3 } },
  { id: 'endure', name: '忍', axis: 'defense', weight: 2, template: { kind: 'gain_endure', amount: 2 } },

  // 资源轴
  { id: 'draw', name: '汲', axis: 'resource', weight: 2, template: { kind: 'draw_cards', amount: 1 } },
  { id: 'surge', name: '涌', axis: 'resource', weight: 3, template: { kind: 'gain_energy', amount: 1 } },
  { id: 'recall', name: '拾', axis: 'resource', weight: 3, template: { kind: 'recall_card', amount: 1 } },

  // 状态轴
  { id: 'expose', name: '破', axis: 'status', weight: 3, template: { kind: 'apply_expose' } },
  { id: 'weaken', name: '弱', axis: 'status', weight: 3, template: { kind: 'apply_weaken' } },

  // 判定轴 —— 它们没有 Effect，改的是**这张牌怎么判**。所以 effectsOf 跳过它们，
  // 由 executionFor 读进 ExecutionSpec：Execution Check 因此成了构筑的一部分。
  { id: 'steady', name: '稳', axis: 'execution', weight: 2, flavor: '本次判定窗口 ×1.5' },
  { id: 'focus', name: '专', axis: 'execution', weight: 3, flavor: '本次 Perfect 倍率提到 2.0' },
  { id: 'reflex', name: '应', axis: 'execution', weight: 3, flavor: '本次即使 Miss 也按 Good 结算' },

  // 派系轴 —— 效果随 Standing 在 #8 落地。
  { id: 'parley', name: '交', axis: 'faction', weight: 3, template: { kind: 'parley' } },

  // 禁忌 Atom —— 只有 Mutation 能拿到。权重为负，因此更强也更便宜。
  //
  // 它们和判定轴一样没有 template：改的是这张牌**怎么结算**（打谁、打几个、翻不翻倍、
  // 越打越贵），不是往效果表里加一条。所以 effectsOf 跳过它们，由 playCard 处理。
  { id: 'sacrifice', name: '献', axis: 'damage', weight: -2, flavor: '失去 5 点生命，本卡其余 Atom 效果翻倍', forbidden: true },
  { id: 'wild', name: '狂', axis: 'damage', weight: -2, flavor: '目标随机', forbidden: true },
  { id: 'contagion', name: '疫', axis: 'status', weight: -1, flavor: '效果同时作用于场上所有单位，包括你偏袒的一方', forbidden: true },
  { id: 'greed', name: '贪', axis: 'resource', weight: -2, flavor: '本局中每打出一次，费用 +1', forbidden: true },
];

/** 单张 Card 至多容纳这么多 Atom。超过时 Fusion 必须丢弃，或过载触发 Mutation。 */
export const MAX_ATOMS_PER_CARD = 4;

const BY_ID = new Map(ATOMS.map((atom) => [atom.id, atom]));

export function atomOf(id: string): AtomDefinition | undefined {
  return BY_ID.get(id);
}

/** 说明由模板推出，不手写——这样牌面、prompt 与引擎行为不可能各说各话。 */
export function describeAtom(atom: AtomDefinition): string {
  if (!atom.template) return atom.flavor ?? '';
  const t = atom.template;
  switch (t.kind) {
    case 'damage':
      return t.hits > 1
        ? `造成 ${t.hits} 段各 ${t.amount} 点伤害`
        : `造成 ${t.amount} 点伤害${t.ignoreBlock ? '，无视格挡' : ''}`;
    case 'gain_block':
      return `获得 ${t.amount} 点格挡`;
    case 'gain_thorns':
      return `获得 ${t.amount} 点反伤`;
    case 'gain_endure':
      return `本回合受到的伤害 -${t.amount}`;
    case 'apply_burn':
      return `灼烧 ${t.amount}，持续 ${t.turns} 回合`;
    case 'apply_expose':
      return '目标易伤：下次受到的伤害 +50%';
    case 'apply_weaken':
      return '目标虚弱：下次造成的伤害 -50%';
    case 'draw_cards':
      return `抽 ${t.amount} 张牌`;
    case 'gain_energy':
      return `获得 ${t.amount} 点能量`;
    case 'recall_card':
      return `从弃牌堆取回 ${t.amount} 张牌`;
    case 'parley':
      return '向目标所属的 Faction 示好，态度 +1';
  }
}

/** 一张牌的 Atom 印记，例如「劈穿」。玩家靠它一眼看出这张牌由什么组成。 */
export function atomGlyphs(atomIds: readonly string[]): string {
  return atomIds.map((id) => atomOf(id)?.name ?? '?').join('');
}

/** 一张牌的完整说明，由它的 Atom 拼出来——牌面文字不是手写的。 */
export function describeAtoms(atomIds: readonly string[]): string {
  return atomIds
    .map((id) => {
      const atom = atomOf(id);
      return atom ? describeAtom(atom) : '';
    })
    .filter((text) => text.length > 0)
    .join('；');
}

/** 给模型看的 Atom 表。它是可缓存前缀的一部分（ADR-0010）。 */
export function atomTableForPrompt(): string {
  return ATOMS.filter((atom) => !atom.forbidden)
    .map((atom) => `- ${atom.id}（${atom.name}，权重 ${atom.weight}）：${describeAtom(atom)}`)
    .join('\n');
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
  if (damage > 0) return 'attack';
  return 'spell';
}

/**
 * 把 Atom 展开成引擎认识的效果。
 *
 * 没有模板的 Atom（判定轴归 #5、派系轴归 #8、禁忌原子归 #13）在这里被跳过——
 * 它们已经参与费用计算，但还不产生效果。
 */
export function effectsOf(
  atomIds: readonly string[],
  targetId: string | undefined,
): readonly Effect[] {
  const effects: Effect[] = [];

  for (const id of atomIds) {
    const template = atomOf(id)?.template;
    if (!template) continue;
    const effect = materialize(template, targetId);
    if (effect) effects.push(effect);
  }

  return effects;
}

/** 给模板补上目标。需要目标却没有目标时，这个效果不发生。 */
function materialize(template: EffectTemplate, targetId: string | undefined): Effect | null {
  switch (template.kind) {
    case 'damage':
      return targetId
        ? { kind: 'damage', targetId, amount: template.amount, hits: template.hits, ignoreBlock: template.ignoreBlock }
        : null;
    case 'apply_burn':
      return targetId
        ? { kind: 'apply_burn', targetId, amount: template.amount, turns: template.turns }
        : null;
    case 'apply_expose':
      return targetId ? { kind: 'apply_expose', targetId } : null;
    case 'apply_weaken':
      return targetId ? { kind: 'apply_weaken', targetId } : null;
    case 'gain_block':
      return { kind: 'gain_block', amount: template.amount };
    case 'gain_thorns':
      return { kind: 'gain_thorns', amount: template.amount };
    case 'gain_endure':
      return { kind: 'gain_endure', amount: template.amount };
    case 'draw_cards':
      return { kind: 'draw_cards', amount: template.amount };
    case 'gain_energy':
      return { kind: 'gain_energy', amount: template.amount };
    case 'recall_card':
      return { kind: 'recall_card', amount: template.amount };
    case 'parley':
      return targetId ? { kind: 'parley', targetId } : null;
  }
}

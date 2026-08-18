import type { CardDefinition, CombatantState, Generation } from './types.js';

/**
 * 固定卡池。Generation 永远不产出 Card（ADR-0005），所以这里是静态资产。
 * 本票只有走通骨架所需的最小集合；扩到约 20 张是 #5 的事。
 */
export const CARD_POOL: readonly CardDefinition[] = [
  { id: 'strike', name: '劈砍', type: 'attack', cost: 1, damage: 6 },
  {
    id: 'guard',
    name: '格挡',
    type: 'shield',
    cost: 1,
    block: 5,
    execution: { windowMs: 900 },
  },
  { id: 'heavy', name: '重击', type: 'attack', cost: 2, damage: 10 },
];

/** 起始 Deck 10 张。 */
export const STARTING_DECK: readonly string[] = [
  'strike', 'strike', 'strike', 'strike', 'strike',
  'guard', 'guard', 'guard', 'guard',
  'heavy',
];

export const PLAYER_MAX_HP = 40;
export const MAX_ENERGY = 3;
export const HAND_SIZE = 5;

/**
 * 第 1 层的对手。它的下一步由 LLM 从 actions 里挑，因此它是 Agent。
 */
export function floorOneCombatants(): readonly CombatantState[] {
  return [
    {
      id: 'tower-guard',
      name: '塔卫',
      goal: '把外来者挡在第二层之下，但不想为此送命。',
      hp: 45,
      maxHp: 45,
      block: 0,
      actions: [
        { id: 'slash', kind: 'attack', amount: 7, description: '挥刀劈砍，造成 7 点伤害' },
        { id: 'crush', kind: 'attack', amount: 11, description: '沉重的下劈，造成 11 点伤害' },
        { id: 'brace', kind: 'defend', amount: 5, description: '举盾自守，获得 5 点格挡' },
      ],
      intent: null,
    },
  ];
}

/** 一次 IntentRequest 允许等待多久。实测中位延迟约 360ms，这里留足余量。 */
export const INTENT_TIMEOUT_MS = 2500;

/** Generation 失败时的内置局势，也是本票唯一的局势（#10 起才真正生成）。 */
export const BUILT_IN_GENERATION: Generation = {
  title: '围城中的塔',
};

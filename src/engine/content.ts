import type { CardDefinition, CombatantState, Generation } from './types.js';

/**
 * 固定卡池。Generation 永远不产出 Card（ADR-0005），所以这里是静态资产。
 * 本票只有走通骨架所需的最小集合；扩到约 20 张是 #5 的事。
 */
export const CARD_POOL: readonly CardDefinition[] = [
  { id: 'strike', name: '劈砍', type: 'attack', cost: 1, damage: 6 },
  { id: 'guard', name: '格挡', type: 'shield', cost: 1, block: 5 },
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
 * 第 1 层的对手。它按固定脚本行动，因此是 Combatant 而不是 Agent
 * ——把 script 换成 LLM 选出的 Intent 是 #4。
 */
export function floorOneCombatants(): readonly CombatantState[] {
  return [
    {
      id: 'tower-guard',
      name: '塔卫',
      hp: 45,
      maxHp: 45,
      block: 0,
      script: [
        { kind: 'attack', amount: 7 },
        { kind: 'attack', amount: 7 },
        { kind: 'defend', amount: 5 },
      ],
      scriptIndex: 0,
    },
  ];
}

/** Generation 失败时的内置局势，也是本票唯一的局势（#10 起才真正生成）。 */
export const BUILT_IN_GENERATION: Generation = {
  title: '围城中的塔',
};

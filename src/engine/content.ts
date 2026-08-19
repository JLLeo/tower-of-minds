import { MAX_ATOMS_PER_CARD, cardTypeOf, costOf } from './atoms.js';
import {
  NO_STATUSES,
  type AgentState,
  type CardDefinition,
  type CardType,
  type CombatantState,
  type ExecutionSpec,
  type Generation,
} from './types.js';

/**
 * Card Type 决定触发哪种 Execution Check 原型。本票只有盾牌的格挡时机；
 * 攻击的节奏连击与法术的蓄力在 #5 补上，届时把这张表填满即可。
 */
const EXECUTION_BY_TYPE: Partial<Record<CardType, ExecutionSpec>> = {
  shield: { windowMs: 900 },
};

/**
 * Base Card 由 Atom 组成，cost / type / execution 全部推出来，没有一处手写。
 * 想改一张牌的强度，改的是它的 Atom 而不是它的数字——否则费用会和内容脱节。
 */
function defineCard(
  id: string,
  name: string,
  faction: string,
  atoms: readonly string[],
): CardDefinition {
  if (atoms.length === 0 || atoms.length > MAX_ATOMS_PER_CARD) {
    throw new Error(`${id} 的 Atom 数量必须在 1 到 ${MAX_ATOMS_PER_CARD} 之间`);
  }
  const type = cardTypeOf(atoms);
  const execution = EXECUTION_BY_TYPE[type];
  return {
    id,
    name,
    faction,
    atoms,
    cost: costOf(atoms),
    type,
    ...(execution ? { execution } : {}),
  };
}

/** 赤环：进攻与代价。 */
const RED_RING: readonly CardDefinition[] = [
  defineCard('strike', '劈砍', 'red-ring', ['strike']),
  defineCard('heavy', '重击', 'red-ring', ['strike', 'pierce']),
  defineCard('rend', '破甲', 'red-ring', ['pierce']),
  defineCard('flurry', '连斩', 'red-ring', ['multi']),
  defineCard('ignite', '灼烧', 'red-ring', ['burn']),
  defineCard('crack', '破绽', 'red-ring', ['expose']),
  defineCard('sap', '弱化打击', 'red-ring', ['strike', 'weaken']),
  defineCard('onslaught', '狂攻', 'red-ring', ['strike', 'multi']),
  defineCard('searing', '灼心', 'red-ring', ['burn', 'expose']),
  defineCard('skewer', '穿刺连击', 'red-ring', ['pierce', 'multi']),
];

/** 青蔓：韧性与资源。 */
const GREEN_VINE: readonly CardDefinition[] = [
  defineCard('guard', '格挡', 'green-vine', ['guard']),
  defineCard('bramble', '荆棘', 'green-vine', ['thorns']),
  defineCard('brace', '坚忍', 'green-vine', ['endure']),
  defineCard('siphon', '汲取', 'green-vine', ['draw']),
  defineCard('surge', '涌动', 'green-vine', ['surge']),
  defineCard('glean', '回收', 'green-vine', ['recall']),
  defineCard('bulwark', '铁壁', 'green-vine', ['guard', 'endure']),
  defineCard('thornwall', '荆棘护盾', 'green-vine', ['guard', 'thorns']),
  defineCard('foresight', '深谋', 'green-vine', ['draw', 'surge']),
  defineCard('scavenge', '拾遗', 'green-vine', ['recall', 'draw']),
];

export const CARD_POOL: readonly CardDefinition[] = [...RED_RING, ...GREEN_VINE];

/**
 * 起始 Deck。#15 会让玩家进塔前自己组 Loadout；在那之前这是固定的一副，
 * 组成与引入 Atom 之前一致，好让既有的平衡与测试保持有效。
 */
export const STARTING_DECK: readonly string[] = [
  'strike', 'strike', 'strike', 'strike', 'strike',
  'guard', 'guard', 'guard', 'guard',
  'heavy',
];

export const PLAYER_MAX_HP = 40;
export const MAX_ENERGY = 3;
export const HAND_SIZE = 5;

/**
 * 本局的 Agent，一个 Faction 一个（ADR-0010）。#10 会让 Generation 生成它们的
 * 结仇原因与诉求；在那之前这是内置的一套。
 */
export function builtInAgents(): readonly AgentState[] {
  return [
    {
      factionId: 'red-ring',
      name: '赤环',
      persona: '守序而好战，认死理，看不起摇摆的人。',
      goal: '把外来者挡在塔的下层，但不想为此赔上自己人。',
    },
    {
      factionId: 'green-vine',
      name: '青蔓',
      persona: '谨慎，记仇，擅长等别人先出手。',
      goal: '保住塔里的补给线，谁挡路就记谁一笔。',
    },
  ];
}

/**
 * 第 1 层的对手。它的下一步由所属 Faction 的 Agent 决定。
 */
export function floorOneCombatants(): readonly CombatantState[] {
  return [
    {
      id: 'tower-guard',
      name: '塔卫',
      factionId: 'red-ring',
      hp: 45,
      maxHp: 45,
      block: 0,
      actions: [
        { id: 'slash', kind: 'attack', amount: 7, description: '挥刀劈砍，造成 7 点伤害' },
        { id: 'crush', kind: 'attack', amount: 11, description: '沉重的下劈，造成 11 点伤害' },
        { id: 'brace', kind: 'defend', amount: 5, description: '举盾自守，获得 5 点格挡' },
      ],
      intent: null,
      statuses: NO_STATUSES,
    },
  ];
}

/** 一次 IntentRequest 允许等待多久。实测中位延迟约 1 秒，这里留足余量。 */
export const INTENT_TIMEOUT_MS = 2500;

/** Generation 失败时的内置局势，也是本票唯一的局势（#10 起才真正生成）。 */
export const BUILT_IN_GENERATION: Generation = {
  title: '围城中的塔',
};

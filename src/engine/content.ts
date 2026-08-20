import { MAX_ATOMS_PER_CARD, cardTypeOf, costOf, type AtomAxis } from './atoms.js';
import {
  NO_STATUSES,
  type AgentState,
  type CardDefinition,
  type CombatantAction,
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

/** 某个 Card Type 触发哪种判定。锻造出来的牌也要照这张表来。 */
export function executionForType(type: CardType): ExecutionSpec | undefined {
  return EXECUTION_BY_TYPE[type];
}

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
  defineCard('accord', '递刀', 'red-ring', ['parley']),
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
  defineCard('truce', '止戈', 'green-vine', ['parley']),
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
      goal:
        '把外来者挡在塔的下层。但真正让你咽不下这口气的是青蔓——他们私通塔外、偷运补给，' +
        '你早想动手，只是不愿意两线开战。谁先露出破绽，你就先收拾谁。',
    },
    {
      factionId: 'green-vine',
      name: '青蔓',
      persona: '谨慎，记仇，擅长等别人先出手。',
      goal:
        '保住补给线。赤环封死了塔道、还想拿你当叛徒办，你恨他们更甚于恨外来者——' +
        '只是你人手不够，得等一个他们分神的时机。',
    },
  ];
}

/** 一个 Run 有几个普通 Floor。Boss 层是 #9。 */
export const NORMAL_FLOORS = 5;

interface CombatantTemplate {
  readonly id: string;
  readonly name: string;
  readonly factionId: string;
  readonly hp: number;
  readonly actions: readonly CombatantAction[];
}

const ROSTER: readonly CombatantTemplate[] = [
  {
    id: 'tower-guard',
    name: '塔卫',
    factionId: 'red-ring',
    hp: 34,
    actions: [
      { id: 'slash', kind: 'attack', amount: 7, description: '挥刀劈砍，造成 7 点伤害' },
      { id: 'crush', kind: 'attack', amount: 11, description: '沉重的下劈，造成 11 点伤害' },
      { id: 'brace', kind: 'defend', amount: 5, description: '举盾自守，获得 5 点格挡' },
    ],
  },
  {
    id: 'red-archer',
    name: '赤环弓手',
    factionId: 'red-ring',
    hp: 22,
    actions: [
      { id: 'loose', kind: 'attack', amount: 5, description: '放箭，造成 5 点伤害' },
      { id: 'volley', kind: 'attack', amount: 8, description: '压制射击，造成 8 点伤害' },
      { id: 'retreat', kind: 'defend', amount: 4, description: '后撤半步，获得 4 点格挡' },
    ],
  },
  {
    id: 'vine-scout',
    name: '青蔓斥候',
    factionId: 'green-vine',
    hp: 26,
    actions: [
      { id: 'lash', kind: 'attack', amount: 6, description: '藤鞭抽击，造成 6 点伤害' },
      { id: 'snare', kind: 'attack', amount: 9, description: '缠住对手狠抽，造成 9 点伤害' },
      { id: 'coil', kind: 'defend', amount: 6, description: '蜷起藤甲，获得 6 点格挡' },
    ],
  },
];

/**
 * 某一层的场面。两个 Faction 始终同场——它们之间也在打，玩家集火谁、放过谁本身
 * 就是表态。越往上血量越厚；真正的层间差异（不同的人、不同的过节）是 #10 的事。
 */
export function combatantsForFloor(
  floor: number,
  reinforced: readonly string[] = [],
): readonly CombatantState[] {
  const scale = 1 + 0.12 * (floor - 1);
  const build = (template: CombatantTemplate, suffix = ''): CombatantState => {
    // 增援是临时凑来的人手，比正规成员单薄。
    const hp = Math.round(template.hp * scale * (suffix ? 0.55 : 1));
    return {
      id: template.id + suffix,
      name: template.name + (suffix ? '（增援）' : ''),
      factionId: template.factionId,
      hp,
      maxHp: hp,
      block: 0,
      actions: template.actions,
      intent: null,
      statuses: NO_STATUSES,
    };
  };

  const field = ROSTER.map((template) => build(template));

  // 被得罪的 Faction 多带一个人。这是「你得罪了它」看得见的后果。
  for (const factionId of reinforced) {
    // 临时凑来的人手：挑这一派里最单薄的那个模板，再打个折。
    const template = ROSTER.filter((t) => t.factionId === factionId).sort(
      (a, b) => a.hp - b.hp,
    )[0];
    if (template) field.push(build(template, '-reinforcement'));
  }
  return field;
}

/** 每个 Faction 自己的 Base Card，Favor 从这里给。 */
export function baseCardsOf(factionId: string): readonly CardDefinition[] {
  return CARD_POOL.filter((card) => card.faction === factionId);
}

/** 跨过这个阈值的 Faction 提供高阶 Favor。同向站队两次。 */
export const HIGH_FAVOR_THRESHOLD = 2;

/**
 * 每个 Faction 融合时的性格：它舍不得哪一类 Atom，以及过载时会塞进哪个禁忌。
 *
 * 这不是给模型看的提示，而是**模型答不上来时引擎替它做的选择**。有了它，
 * 「同样两张牌找不同派系融会得到不同的牌」在模型失灵时依然成立。
 */
export interface FusionTaste {
  /** 优先丢掉的轴，按顺序。列在前面的先被舍弃。 */
  readonly sheds: readonly AtomAxis[];
  /** 过载时它会塞进来的那个 Forbidden Atom。 */
  readonly forbidden: string;
}

const TASTES: Readonly<Record<string, FusionTaste>> = {
  // 赤环要的是杀伤力，续航和资源先扔；过载时它选献祭。
  'red-ring': { sheds: ['resource', 'defense', 'status', 'execution', 'faction'], forbidden: 'sacrifice' },
  // 青蔓要的是活下去，纯输出先扔；过载时它选传染。
  'green-vine': { sheds: ['damage', 'faction', 'status', 'execution', 'resource'], forbidden: 'contagion' },
};

const DEFAULT_TASTE: FusionTaste = {
  sheds: ['faction', 'execution', 'status', 'resource', 'defense', 'damage'],
  forbidden: 'wild',
};

export function fusionTasteOf(factionId: string): FusionTaste {
  return TASTES[factionId] ?? DEFAULT_TASTE;
}

/** 一次 IntentRequest 允许等待多久。实测中位延迟约 1 秒，这里留足余量。 */
export const INTENT_TIMEOUT_MS = 2500;

/** Generation 失败时的内置局势，也是本票唯一的局势（#10 起才真正生成）。 */
export const BUILT_IN_GENERATION: Generation = {
  title: '围城中的塔',
};

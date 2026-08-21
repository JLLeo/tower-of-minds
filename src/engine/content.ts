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
 * Card Type 决定触发哪种 Execution Check 原型。三种手感必须明确不同——玩家不看
 * 牌面，也该从手上怎么动认出自己在打什么类别：
 *
 * - 盾牌 `block`：等一下，在窗口末段按一次。
 * - 攻击 `rhythm`：跟着拍子连按三次，窗口更长，因为要按三下。
 * - 法术 `charge`：按一下起手，撑住，快到头再按一下放出去。两次按键之间的那段
 *   空白就是「蓄力」——它是三者里唯一要求你**忍住不按**的。
 *
 * targets 是该按的那几个时刻，按窗口长度的比例给出。
 */
const EXECUTION_DEFAULTS = { perfectMultiplier: 1.5, softenMiss: false } as const;

/**
 * 容差跟着拍距走。节奏连击的三拍只隔 0.25，容差再宽一点相邻的 Good 带就会连成
 * 一片——那时「跟上拍子」和「窗口里随便按三下」就没有区别了。格挡只按一次，
 * 前后都是空的，所以它可以给得很宽。
 */
const EXECUTION_BY_TYPE: Record<CardType, ExecutionSpec> = {
  shield: {
    kind: 'block',
    windowMs: 900,
    targets: [0.775],
    perfectTolerance: 0.075,
    goodTolerance: 0.3,
    ...EXECUTION_DEFAULTS,
  },
  attack: {
    kind: 'rhythm',
    windowMs: 1500,
    targets: [0.3, 0.55, 0.8],
    perfectTolerance: 0.04,
    goodTolerance: 0.11,
    ...EXECUTION_DEFAULTS,
  },
  spell: {
    kind: 'charge',
    windowMs: 1300,
    targets: [0.15, 0.85],
    perfectTolerance: 0.06,
    goodTolerance: 0.2,
    ...EXECUTION_DEFAULTS,
  },
};

/** 判定轴的三个 Atom 各自把哪一项改成什么。没带这几个 Atom 就是这套默认值。 */
const STEADY_WINDOW_SCALE = 1.5;
const FOCUS_PERFECT_MULTIPLIER = 2;

/**
 * 这张牌触发哪种判定，以及判定轴的 Atom 把它改成了什么样。
 *
 * 从 **Atom** 推出来，不是从 Card Type 查表——`steady` / `focus` / `reflex` 正是靠
 * 这一步把 Execution Check 变成构筑的一部分：手不稳的堆 steady/reflex 把判定变宽
 * 变软，手稳的堆 focus 把 Perfect 的收益推到 2 倍。
 */
export function executionFor(atoms: readonly string[]): ExecutionSpec {
  const base = EXECUTION_BY_TYPE[cardTypeOf(atoms)];
  return {
    ...base,
    windowMs: atoms.includes('steady')
      ? Math.round(base.windowMs * STEADY_WINDOW_SCALE)
      : base.windowMs,
    perfectMultiplier: atoms.includes('focus')
      ? FOCUS_PERFECT_MULTIPLIER
      : base.perfectMultiplier,
    softenMiss: atoms.includes('reflex'),
  };
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
  return {
    id,
    name,
    faction,
    atoms,
    cost: costOf(atoms),
    type: cardTypeOf(atoms),
    execution: executionFor(atoms),
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
  // Loadout 只能取自一个 Faction，所以每一派都得拿得出另一条轴上的基本功——
  // 派系的性格在于**怎么**挡、**怎么**打，不在于能不能。
  defineCard('formup', '立阵', 'red-ring', ['guard']),
  // 判定轴的牌。两派各拿两张，但拿的不是同一套：赤环奖励**按得准**（focus），
  // 青蔓奖励**不会崩**（reflex），steady 两边都有——想把窗口放宽是谁都有的需求。
  defineCard('focusblow', '凝神', 'red-ring', ['strike', 'focus']),
  defineCard('steadyaim', '屏息', 'red-ring', ['pierce', 'steady']),
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
  defineCard('vinewhip', '藤鞭', 'green-vine', ['strike']),
  defineCard('steadyguard', '稳桩', 'green-vine', ['guard', 'steady']),
  defineCard('reflexcoil', '本能', 'green-vine', ['endure', 'reflex']),
];

export const CARD_POOL: readonly CardDefinition[] = [...RED_RING, ...GREEN_VINE];

/** 一副 Loadout 有多少张牌。允许重复，所以解锁得少不等于组不出一副。 */
export const LOADOUT_SIZE = 10;

/**
 * 没自己组 Loadout 时用的那一副。它跨了两个 Faction，因此**不是**合法 Loadout——
 * 它只是既有测试与离线场景的固定基准，保留是为了让引入 Loadout 之前的平衡结论仍然可比。
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
        '你不缺人手，缺的是一个他们分神的时机。',
    },
  ];
}

/** 一个 Run 有几个普通 Floor。Boss 层是 #9。 */
export const NORMAL_FLOORS = 5;

interface CombatantTemplate {
  readonly id: string;
  /**
   * 这个人在自己那一派里干什么。名字里的派系那半截不写死——它由这一局生成的
   * 名册来填，否则塔改了名，场上的人还叫着上一局的旧称。
   */
  readonly role: string;
  readonly factionId: string;
  readonly hp: number;
  readonly actions: readonly CombatantAction[];
}

/**
 * 每层站着的人。**两派必须对等**：同样的人数、大致相同的总血量与出手量。
 *
 * 不对等的话，「杀谁放谁」就不再是表态而是算术——人少血薄的那一方永远是更便宜的
 * 猎物，于是每一局都往同一个方向站队，而 Loadout 只能取自单个 Faction（#15），
 * 带另一派的牌进塔就等于白交一份难度税。
 *
 * 每个人都拿得出一个「替同伴挡一下」的动作。护的分量比自守小——照顾别人比照顾自己
 * 难。它让一派内部也有关系，于是玩家先打谁多了一层考虑：谁在护着谁。
 */
const ROSTER: readonly CombatantTemplate[] = [
  {
    id: 'tower-guard',
    role: '塔卫',
    factionId: 'red-ring',
    hp: 15,
    actions: [
      { id: 'slash', kind: 'attack', amount: 6, description: '挥刀劈砍，造成 6 点伤害' },
      { id: 'crush', kind: 'attack', amount: 10, description: '沉重的下劈，造成 10 点伤害' },
      { id: 'brace', kind: 'defend', amount: 5, description: '举盾自守，获得 5 点格挡' },
      { id: 'shieldwall', kind: 'protect', amount: 4, description: '横盾挡在同伴身前，替他获得 4 点格挡' },
    ],
  },
  {
    id: 'red-archer',
    role: '弓手',
    factionId: 'red-ring',
    hp: 12,
    actions: [
      { id: 'loose', kind: 'attack', amount: 4, description: '放箭，造成 4 点伤害' },
      { id: 'volley', kind: 'attack', amount: 6, description: '压制射击，造成 6 点伤害' },
      { id: 'retreat', kind: 'defend', amount: 4, description: '后撤半步，获得 4 点格挡' },
      { id: 'cover', kind: 'protect', amount: 3, description: '掩护射击，替同伴获得 3 点格挡' },
    ],
  },
  {
    id: 'vine-scout',
    role: '斥候',
    factionId: 'green-vine',
    hp: 12,
    actions: [
      { id: 'lash', kind: 'attack', amount: 4, description: '藤鞭抽击，造成 4 点伤害' },
      { id: 'snare', kind: 'attack', amount: 6, description: '缠住对手狠抽，造成 6 点伤害' },
      { id: 'coil', kind: 'defend', amount: 6, description: '蜷起藤甲，获得 6 点格挡' },
      { id: 'shelter', kind: 'protect', amount: 4, description: '把藤甲让给同伴，替他获得 4 点格挡' },
    ],
  },
  {
    id: 'vine-weaver',
    role: '织者',
    factionId: 'green-vine',
    hp: 15,
    actions: [
      { id: 'weave', kind: 'attack', amount: 6, description: '藤蔓收束，造成 6 点伤害' },
      { id: 'entangle', kind: 'attack', amount: 10, description: '连根绞紧，造成 10 点伤害' },
      { id: 'root', kind: 'defend', amount: 5, description: '扎下根须，获得 5 点格挡' },
      { id: 'graft', kind: 'protect', amount: 4, description: '藤蔓缠上同伴，替他获得 4 点格挡' },
    ],
  },
];

/**
 * 某一层的场面。两个 Faction 始终同场——它们之间也在打，玩家集火谁、放过谁本身
 * 就是表态。越往上血量越厚；真正的层间差异（不同的人、不同的过节）是 #10 的事。
 */
export function combatantsForFloor(
  floor: number,
  reinforced: readonly string[],
  factionName: (factionId: string) => string,
): readonly CombatantState[] {
  const scale = 1 + 0.12 * (floor - 1);
  const build = (template: CombatantTemplate, suffix = ''): CombatantState => {
    // 增援是临时凑来的人手，比正规成员单薄。
    const hp = Math.round(template.hp * scale * (suffix ? 0.55 : 1));
    return {
      id: template.id + suffix,
      name: factionName(template.factionId) + template.role + (suffix ? '（增援）' : ''),
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

interface LeaderTemplate {
  readonly id: string;
  /** 同 CombatantTemplate.role：派系那半截由名册来填。 */
  readonly role: string;
  readonly hp: number;
  readonly actions: readonly CombatantAction[];
}

/** 每个 Faction 的首领。塔顶等着你的就是其中之一（ADR-0008）。 */
const LEADERS: Readonly<Record<string, LeaderTemplate>> = {
  'red-ring': {
    id: 'red-warden',
    role: '执刑官',
    hp: 78,
    actions: [
      { id: 'cleave', kind: 'attack', amount: 12, description: '横扫，造成 12 点伤害' },
      { id: 'execute', kind: 'attack', amount: 18, description: '行刑一击，造成 18 点伤害' },
      { id: 'aegis', kind: 'defend', amount: 10, description: '立盾，获得 10 点格挡' },
      { id: 'bulwarkorder', kind: 'protect', amount: 7, description: '下令护住同伴，替他获得 7 点格挡' },
    ],
  },
  'green-vine': {
    id: 'vine-matron',
    role: '主事',
    hp: 72,
    actions: [
      { id: 'strangle', kind: 'attack', amount: 11, description: '绞缠，造成 11 点伤害' },
      { id: 'harvest', kind: 'attack', amount: 16, description: '收割，造成 16 点伤害' },
      { id: 'bulwark', kind: 'defend', amount: 12, description: '藤墙，获得 12 点格挡' },
      { id: 'entwine', kind: 'protect', amount: 8, description: '藤墙分给同伴一段，替他获得 8 点格挡' },
    ],
  },
};

/** 首领身边那位亲随比平时厚一些；援军与围攻者按同一个系数来。 */
const ESCORT_SCALE = 1.4;
const SUPPORT_SCALE = 1.2;

/**
 * 塔顶的场面。Boss 是你 Standing 最低的那一方的首领——难度是你自己填的期末试卷。
 *
 * allies 里的 Faction 派人来帮你打它；siege 为真时**每一个**别的 Faction 都派人来，
 * 但它们是冲你来的。得罪所有人不该比被人喜欢更轻松。
 */
export function bossFloorCombatants(
  bossFactionId: string,
  allies: readonly string[],
  siege: boolean,
  floor: number,
  otherFactionIds: readonly string[],
  factionName: (factionId: string) => string,
): readonly CombatantState[] {
  const scale = 1 + 0.12 * (floor - 1);
  const build = (
    template: { id: string; role: string; hp: number; actions: readonly CombatantAction[] },
    factionId: string,
    suffix: string,
    multiplier: number,
    isBoss?: true,
  ): CombatantState => {
    const hp = Math.round(template.hp * scale * multiplier);
    return {
      id: template.id + suffix,
      name:
        factionName(factionId) +
        template.role +
        (suffix ? `（${suffix === '-escort' ? '亲随' : siege ? '围攻' : '援军'}）` : ''),
      factionId,
      hp,
      maxHp: hp,
      block: 0,
      actions: template.actions,
      intent: null,
      statuses: NO_STATUSES,
      ...(isBoss ? { isBoss } : {}),
    };
  };

  const field: CombatantState[] = [];

  // 每个 Faction 都必须有一位首领。没有明写的就从它的名册里推一个出来——
  // #10 会生成 Faction，那时不该因为漏配一张表就让塔顶空着。
  const leader = LEADERS[bossFactionId] ?? improvisedLeader(bossFactionId);
  if (leader) field.push(build(leader, bossFactionId, '', 1, true));

  const escort = ROSTER.find((t) => t.factionId === bossFactionId);
  if (escort) field.push(build(escort, bossFactionId, '-escort', ESCORT_SCALE));

  // 援军站你这边；围攻者站它那边。谁来、来几个，由你一路的 Standing 决定。
  const supporters = siege ? otherFactionIds : allies;
  for (const factionId of supporters) {
    const template = ROSTER.find((t) => t.factionId === factionId);
    if (template) field.push(build(template, factionId, '-support', SUPPORT_SCALE));
  }

  return field;
}

/** 没有明写首领的 Faction：拿它名册里最硬的那个顶上，血量翻倍。 */
function improvisedLeader(factionId: string): LeaderTemplate | undefined {
  const template = [...ROSTER]
    .filter((t) => t.factionId === factionId)
    .sort((a, b) => b.hp - a.hp)[0];
  if (!template) return undefined;
  return {
    id: `${template.id}-leader`,
    role: `${template.role}·首领`,
    hp: template.hp * 2,
    actions: template.actions,
  };
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

/** 一次融合提问允许等待多久。玩家在层间干等着，所以留的余量比战斗里更大一点。 */
export const FUSION_TIMEOUT_MS = 3500;

/**
 * 层间构筑允许等待多久。它和玩家挑 Favor 是并行的，谁都不等谁，
 * 所以这里可以给得很宽松——真到开新层还没回来，就按预设走。
 */
export const DECKBUILD_TIMEOUT_MS = 6000;

/** Generation 失败时的内置局势，也是本票唯一的局势（#10 起才真正生成）。 */
export const BUILT_IN_GENERATION: Generation = {
  title: '围城中的塔',
  grievance: '赤环认定青蔓私通塔外、偷运补给；青蔓则说是赤环封死了塔道，先断了别人的活路。',
};

/** 生成一次局势允许等多久。玩家在开局界面上等着，不能太久。 */
export const GENERATION_TIMEOUT_MS = 8000;

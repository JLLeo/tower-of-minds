import type { Rng } from './rng.js';

// ---------------------------------------------------------------- Cards

export type CardType = 'attack' | 'shield' | 'spell';

/**
 * Card 结算过程中需要一次实时输入的声明（ADR-0002）。
 *
 * 判定用哪种原型由 Card Type 决定（盾牌是格挡时机、攻击是节奏连击、法术是蓄力），
 * 所以这里只放窗口长度——原型不能是一个能和 Card Type 互相矛盾的独立字段。
 */
export interface ExecutionSpec {
  readonly windowMs: number;
}

/** 一次 Execution Check 的结果档位。Miss 只是打折，不反噬。 */
export type ExecutionGrade = 'miss' | 'good' | 'perfect';

/**
 * Card 由 Atom 组成——Atom 是唯一的真相来源，cost / type / execution 全部由它推出，
 * 没有一处是手写的。这是 Fusion 的结果可预估、可平衡的前提（ADR-0005）。
 */
export interface CardDefinition {
  readonly id: string;
  readonly name: string;
  /** 内容分组：这张 Base Card 属于哪个 Faction 的牌组。Faction 系统本身见 #10。 */
  readonly faction: string;
  readonly atoms: readonly string[];
  readonly cost: number;
  readonly type: CardType;
  readonly execution?: ExecutionSpec;
}

/** Deck 里的一张具体的牌。同一个 definition 可以有多份。 */
export interface CardInstance {
  readonly instanceId: string;
  readonly definitionId: string;
}

// ---------------------------------------------------------------- Combatants

/** Combatant 的动作库中的一项。合法动作集就是从这里来的。 */
export interface CombatantAction {
  readonly id: string;
  readonly kind: 'attack' | 'defend';
  readonly amount: number;
  /** 给模型和玩家看的说明。引擎结算只认 kind 和 amount，不解析这段文字。 */
  readonly description: string;
}

/** 玩家在目标系统里的身份。他不是 Combatant，但可以被打。 */
export const PLAYER_TARGET = 'player';

/**
 * Agent 为下一回合选定的行动。它永远是引擎给出的合法动作集里的一个——
 * source 记下它究竟是模型选的，还是模型没能按时给出合法答案时引擎替它选的。
 */
export interface Intent {
  readonly actionId: string;
  /** 打谁。自我防御类动作为 null。 */
  readonly targetId: string | null;
  readonly line: string;
  readonly source: 'agent' | 'fallback';
}

/**
 * Encounter 中的一个战斗单位。它的下一步由 LLM 决定，因此它是 Agent。
 */
export interface CombatantState {
  readonly id: string;
  readonly name: string;
  /** 它属于哪个 Faction——它的心智就是那个 Faction 的 Agent。 */
  readonly factionId: string;
  readonly hp: number;
  readonly maxHp: number;
  readonly block: number;
  readonly actions: readonly CombatantAction[];
  readonly intent: Intent | null;
  readonly statuses: Statuses;
}

/**
 * Agent 记住的一条事实。结构化而不是自由文本——它要同时喂 prompt、推出 Standing、
 * 还要摊开给玩家看（ADR-0003：Run 结束即清空）。
 */
export type MemoryEntry =
  /** 你在它面前打出过这张牌。#14 的对手构筑只能用它见过的牌。 */
  | { readonly kind: 'card_played'; readonly floor: number; readonly cardId: string }
  /** 你伤了它多少。 */
  | { readonly kind: 'harmed'; readonly floor: number; readonly amount: number }
  /** 你把它留到了最后——这一层是它放你过去的。 */
  | { readonly kind: 'sided'; readonly floor: number }
  /** 你对它示好过。 */
  | { readonly kind: 'parley'; readonly floor: number };

/**
 * 一个 Faction 的持久心智（ADR-0010）。它在战斗中选 Intent、在 Fusion 时决定取舍、
 * 在层间为自己构筑——这些出自同一个 Agent，共享同一份性格与目标。
 * Memory 挂在这里，在 #8 落地。
 */
export interface AgentState {
  readonly factionId: string;
  readonly name: string;
  readonly persona: string;
  readonly goal: string;
}

/**
 * 引擎正在等待某个 Agent 的回答。
 *
 * kind 决定问的是什么、怎么校验、以及答不上来时怎么回退。目前只有 intent，
 * Fusion（#13）与层间构筑（#14）各自加一个 kind——suspend / validate / fallback
 * 这条路只写一份（ADR-0010）。
 */
export type AgentRequestKind = 'intent' | 'fusion';

export interface AgentRequestBase {
  /** 唯一标识这一次提问。响应靠它认领，迟到的响应因此认得出来。 */
  readonly id: string;
  readonly factionId: string;
  readonly requestedAtMs: number;
  readonly timeoutMs: number;
}

export interface IntentRequest extends AgentRequestBase {
  readonly kind: 'intent';
  readonly combatantId: string;
}

/**
 * 融合超出 Atom 上限时，由提供融合的那个 Faction 的 Agent 决定取舍：
 * 丢掉哪一个 Atom，或者过载时挑哪一个 Forbidden Atom，以及新 Card 叫什么。
 */
export interface FusionRequest extends AgentRequestBase {
  readonly kind: 'fusion';
  /** 合并后的全部 Atom。丢弃只能从这里面挑。 */
  readonly atoms: readonly string[];
  /** 玩家选了过载：不丢弃，改为塞进一个 Forbidden Atom。 */
  readonly overload: boolean;
  readonly sourceNames: readonly [string, string];
  /** 被融掉的那张牌，结算时从 Deck 里拿走。 */
  readonly deckInstanceId: string;
}

export type AgentRequest = IntentRequest | FusionRequest;

/**
 * Player 目前单独建模，因为只有他持有 Deck。#6 的多方混战会让 Player 也变成
 * 战场上的一个 Combatant——那次改动是有意留给 #6 的。
 */
export interface PlayerState {
  readonly hp: number;
  readonly maxHp: number;
  readonly block: number;
  readonly energy: number;
  readonly maxEnergy: number;
  readonly hand: readonly CardInstance[];
  readonly drawPile: readonly CardInstance[];
  readonly discardPile: readonly CardInstance[];
  readonly statuses: Statuses;
}

// ---------------------------------------------------------------- Resolution

/**
 * 一次 Card 结算被拆成的原子效果，逐个执行，可以在中途挂起。
 * 每种效果都有 amount，但只有伤害与护体类会被 Execution Grade 的倍率缩放——
 * 抽牌和能量不该因为手抖就变成半张牌。
 */
export type Effect =
  | {
      readonly kind: 'damage';
      readonly targetId: string;
      readonly amount: number;
      readonly hits: number;
      readonly ignoreBlock: boolean;
    }
  | { readonly kind: 'gain_block'; readonly amount: number }
  | { readonly kind: 'gain_thorns'; readonly amount: number }
  | { readonly kind: 'gain_endure'; readonly amount: number }
  | {
      readonly kind: 'apply_burn';
      readonly targetId: string;
      readonly amount: number;
      readonly turns: number;
    }
  | { readonly kind: 'apply_expose'; readonly targetId: string }
  | { readonly kind: 'apply_weaken'; readonly targetId: string }
  | { readonly kind: 'draw_cards'; readonly amount: number }
  | { readonly kind: 'gain_energy'; readonly amount: number }
  | { readonly kind: 'recall_card'; readonly amount: number }
  | { readonly kind: 'parley'; readonly targetId: string };

/** 附着在一个战斗单位身上的持续效果。 */
export interface Statuses {
  /** 每回合末结算的灼烧伤害。 */
  readonly burn: number;
  readonly burnTurns: number;
  /** 被近身攻击时反弹的伤害。 */
  readonly thorns: number;
  /** 本回合受到的伤害减免，回合开始时清零。 */
  readonly endure: number;
  /** 下一次受到的伤害 +50%，触发即消耗。 */
  readonly exposed: boolean;
  /** 下一次造成的伤害 -50%，触发即消耗。 */
  readonly weakened: boolean;
}

export const NO_STATUSES: Statuses = {
  burn: 0,
  burnTurns: 0,
  thorns: 0,
  endure: 0,
  exposed: false,
  weakened: false,
};

/**
 * 结算进行到一半、正在等待实时输入时的落点（ADR-0002）。
 *
 * openedAtMs 是判定窗口开启的时刻，由打出这张牌的输入带进来。有了它，
 * 引擎才能把后来的 execution_input 定位进窗口——判定窗口到 Execution Grade
 * 的计算归引擎，UI 只上报时刻。Grade 本身在 #3 落地。
 */
export interface PendingExecution {
  /** 正在结算的那张牌。它此刻既不在手上也不在弃牌堆——结算完才会落进弃牌堆。 */
  readonly card: CardInstance;
  readonly spec: ExecutionSpec;
  readonly openedAtMs: number;
  readonly remainingEffects: readonly Effect[];
}

// ---------------------------------------------------------------- Encounter & Run

export type EncounterPhase = 'player_turn' | 'awaiting_execution' | 'ended';

export interface EncounterState {
  readonly turn: number;
  readonly phase: EncounterPhase;
  readonly player: PlayerState;
  readonly combatants: readonly CombatantState[];
  readonly pending: PendingExecution | null;
  /**
   * 玩家这一场对每个 Faction 造成的伤害。站队就记在这里：你打谁打得最多，
   * 就是站在谁的对面。Standing 与跨层的累积在 #8 落地。
   */
  readonly damageDealtTo: Readonly<Record<string, number>>;
  /** ADR-0002：每回合最多触发一次 Execution Check。 */
  readonly executionUsedThisTurn: boolean;
  /** 本回合最近一次判定的结果，供界面当场反馈。新回合清空。 */
  readonly lastGrade: ExecutionGrade | null;
}

/**
 * Favor：一场 Encounter 之后，你偏袒过的那个 Faction 给你的报酬。
 *
 * 阶位由 Standing 决定（#8 会把 Standing 做成由 Memory 推出的东西；本票先用
 * 「你偏袒过它几次」这个最朴素的计数）。高阶 Favor 给的应该是一次 Fusion 机会
 * 而不是一张牌——那是 #13。
 */
export interface FavorOffer {
  readonly factionId: string;
  readonly tier: 'basic' | 'high';
  /** 可选的 Card。数量取决于这一方还有几个人活着——你保得越好，它给得越大方。 */
  readonly choices: readonly string[];
}

export type RunPhase = 'in_encounter' | 'choosing_favor' | 'fusing' | 'ended';
export type RunOutcome = 'victory' | 'defeat';

export interface RunState {
  readonly seed: number;
  readonly rng: Rng;
  /** 本局的 Agent，一个 Faction 一个，贯穿整座 Tower。 */
  readonly agents: readonly AgentState[];
  /**
   * 引擎正在等待回答的提问。放在 Run 级而不是 Encounter 级，因为 Fusion 的提问
   * 发生在层间——那时并没有 Encounter 在进行。
   */
  readonly agentRequests: readonly AgentRequest[];
  /** 提问编号，单调递增。它保证 requestId 不会因为同一毫秒发生两次提问而撞车。 */
  readonly nextRequestSeq: number;
  /** Card 实例的编号，单调递增。Fusion 会从 Deck 里拿走牌，所以不能按长度取号。 */
  readonly nextCardSeq: number;
  readonly floor: number;
  /**
   * 玩家这一 Run 的 Deck，跨 Floor 累积。每场 Encounter 把它洗进抽牌堆；
   * Encounter 里的增删只发生在这里，不发生在 Encounter 状态上。
   */
  readonly deck: readonly CardInstance[];
  /**
   * 每个 Faction 记得的事。Standing 由它推出，不单独存——否则两者会漂移，
   * 而玩家点开面板看到的正是这些条目。
   */
  readonly memories: Readonly<Record<string, readonly MemoryEntry[]>>;
  /** 正等着玩家挑的那份 Favor。 */
  readonly favor: FavorOffer | null;
  /**
   * 本局锻出来的 Card。它们只属于这一局：不进 Unlock Ledger，Run 结束即消失
   * （ADR-0009）。查一张牌的定义要同时看固定卡池和这里。
   */
  readonly forged: readonly CardDefinition[];
  readonly phase: RunPhase;
  readonly encounter: EncounterState;
  readonly outcome: RunOutcome | null;
  readonly journal: readonly string[];
}

// ---------------------------------------------------------------- Inputs

/**
 * 玩家输入。时间只能从这里进入引擎——引擎自己不读时钟，否则同一 seed
 * 加同一串输入就不再得到同一个 Run。
 */
export type PlayerInput =
  | {
      readonly type: 'play_card';
      readonly instanceId: string;
      readonly atMs: number;
      readonly targetId?: string;
    }
  | { readonly type: 'end_turn'; readonly atMs: number }
  /**
   * 模型对一次 AgentRequest 的原样响应。payload 是 unknown：解析与合法性校验都归
   * 引擎（ADR-0001），宿主只负责把网络上拿到的东西原封不动送进来。
   *
   * requestId 指认这是在回答哪一次提问。超时回退之后迟到的响应带着已经作废的 id，
   * 会被引擎丢掉——否则它会顶掉一次它没看过的局面下的决定。
   */
  | { readonly type: 'agent_response'; readonly requestId: string; readonly payload: unknown }
  /** 从 Favor 提供的选项里挑一张牌，然后上一层。 */
  | { readonly type: 'choose_favor'; readonly cardId: string | null; readonly atMs: number }
  /**
   * 用高阶 Favor 给的那张牌，和 Deck 里的一张融合。
   * overload 为 true 表示不丢弃、赌一次 Mutation。
   */
  | {
      readonly type: 'fuse';
      readonly offeredCardId: string;
      readonly deckInstanceId: string;
      readonly overload: boolean;
      readonly atMs: number;
    }
  | { readonly type: 'execution_input'; readonly atMs: number }
  /**
   * 时间的流逝。UI 每帧上报当前时刻，引擎据此判断判定窗口是否已经耗尽——
   * 「玩家完全不按」因此是引擎的规则，而不是渲染层的决定。
   * 没有任何变化时 applyInput 原样返回同一个对象，调用方可以据此跳过重绘。
   */
  | { readonly type: 'tick'; readonly atMs: number };

// ---------------------------------------------------------------- Generation

/**
 * Run 开局产出的局势（ADR-0005）。本票只有标题；Faction 名册与结仇原因是 #10。
 * Generation 永远不产出 Card、数值或规则。
 */
export interface Generation {
  readonly title: string;
}

/**
 * 测试用的替身：指定一副确定的起始 Deck，好让场景可复现。真实游戏不传。
 * 卡池本身不可替换——卡池、数值与判定窗口在所有 Run 中保持一致。
 */
export interface RunOptions {
  readonly startingDeck?: readonly string[];
  /** Run 开始的时刻，用于第一次 IntentRequest 的超时计算。 */
  readonly startedAtMs?: number;
}

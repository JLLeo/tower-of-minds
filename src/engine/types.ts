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

export interface CardDefinition {
  readonly id: string;
  readonly name: string;
  readonly type: CardType;
  readonly cost: number;
  readonly damage?: number;
  readonly block?: number;
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

/**
 * Agent 为下一回合选定的行动。它永远是引擎给出的合法动作集里的一个——
 * source 记下它究竟是模型选的，还是模型没能按时给出合法答案时引擎替它选的。
 */
export interface Intent {
  readonly actionId: string;
  readonly line: string;
  readonly source: 'agent' | 'fallback';
}

/**
 * Encounter 中的一个战斗单位。它的下一步由 LLM 决定，因此它是 Agent。
 */
export interface CombatantState {
  readonly id: string;
  readonly name: string;
  /** 喂给模型的动机。引擎不解释它，只负责传递。 */
  readonly goal: string;
  readonly hp: number;
  readonly maxHp: number;
  readonly block: number;
  readonly actions: readonly CombatantAction[];
  readonly intent: Intent | null;
}

/**
 * 引擎正在等待某个 Agent 的 Intent。宿主看到它就去调 provider，把原样的响应
 * 通过 intent_response 交回来；超时由引擎按 tick 判断。
 * 本票一场只有一个 Agent，所以一次只有一个请求；#6 的多方混战会让它变成一组。
 */
export interface IntentRequest {
  readonly combatantId: string;
  readonly requestedAtMs: number;
  readonly timeoutMs: number;
}

/**
 * Player 目前单独建模，因为只有他持有 Deck。#6 的多方混战会让 Player 也变成
 * 战场上的一个 Combatant——那次改动是有意留给 #6 的，不在本票范围内。
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
}

// ---------------------------------------------------------------- Resolution

/** 一次 Card 结算被拆成的原子效果，逐个执行，可以在中途挂起。 */
export type Effect =
  | { readonly kind: 'damage'; readonly targetId: string; readonly amount: number }
  | { readonly kind: 'gain_block'; readonly amount: number };

/**
 * 结算进行到一半、正在等待实时输入时的落点（ADR-0002）。
 *
 * openedAtMs 是判定窗口开启的时刻，由打出这张牌的输入带进来。有了它，
 * 引擎才能把后来的 execution_input 定位进窗口——判定窗口到 Execution Grade
 * 的计算归引擎，UI 只上报时刻。Grade 本身在 #3 落地。
 */
export interface PendingExecution {
  readonly cardInstanceId: string;
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
  readonly intentRequest: IntentRequest | null;
  /** ADR-0002：每回合最多触发一次 Execution Check。 */
  readonly executionUsedThisTurn: boolean;
  /** 本回合最近一次判定的结果，供界面当场反馈。新回合清空。 */
  readonly lastGrade: ExecutionGrade | null;
}

export type RunPhase = 'in_encounter' | 'ended';
export type RunOutcome = 'victory' | 'defeat';

export interface RunState {
  readonly seed: number;
  readonly rng: Rng;
  readonly floor: number;
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
   * 模型对一次 IntentRequest 的原样响应。payload 是 unknown：解析与合法性校验
   * 都归引擎（ADR-0001），宿主只负责把网络上拿到的东西原封不动送进来。
   *
   * requestedAtMs 用来指认这是在回答哪一次请求。超时回退之后迟到的响应带着
   * 过期的时刻，会被引擎丢掉——否则它会顶掉下一回合的 Intent，而那是它没看过的战况。
   */
  | {
      readonly type: 'intent_response';
      readonly combatantId: string;
      readonly requestedAtMs: number;
      readonly payload: unknown;
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

import type { Rng } from './rng.js';

// ---------------------------------------------------------------- Cards

export type CardType = 'attack' | 'shield' | 'spell';

/**
 * Card 结算过程中需要一次实时输入的声明（ADR-0002）。
 * 本票不产出带 execution 的 Card——判定本身在 #3 落地——但状态机
 * 从第一天起就必须能表达「结算挂起、等待输入」这件事。
 */
export interface ExecutionSpec {
  readonly kind: 'block_timing' | 'combo_rhythm' | 'charge_hold';
  readonly windowMs: number;
}

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

/**
 * 战场上的一个单位。Player 是其中之一；由固定脚本行动的对手也是。
 * 由 LLM 决定下一步的 Combatant 才是 Agent（见 CONTEXT.md），本票没有。
 */
export type ScriptedAction =
  | { readonly kind: 'attack'; readonly amount: number }
  | { readonly kind: 'defend'; readonly amount: number };

export interface FoeState {
  readonly id: string;
  readonly name: string;
  readonly hp: number;
  readonly maxHp: number;
  readonly block: number;
  readonly script: readonly ScriptedAction[];
  readonly scriptIndex: number;
}

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
 * remainingEffects 是 Execution Check 结束后还要继续执行的部分。
 */
export interface PendingExecution {
  readonly cardInstanceId: string;
  readonly spec: ExecutionSpec;
  readonly remainingEffects: readonly Effect[];
}

// ---------------------------------------------------------------- Encounter & Run

export type EncounterPhase = 'player_turn' | 'awaiting_execution' | 'ended';

export interface EncounterState {
  readonly turn: number;
  readonly phase: EncounterPhase;
  readonly player: PlayerState;
  readonly foes: readonly FoeState[];
  readonly pending: PendingExecution | null;
}

export type RunPhase = 'in_encounter' | 'ended';
export type RunOutcome = 'victory' | 'defeat';

export interface RunState {
  readonly seed: number;
  readonly rng: Rng;
  /** 本 Run 使用的卡池。放在状态里，applyInput 才能是纯粹的 (state, input) => state。 */
  readonly cards: readonly CardDefinition[];
  readonly floor: number;
  readonly phase: RunPhase;
  readonly encounter: EncounterState;
  readonly outcome: RunOutcome | null;
  readonly log: readonly string[];
}

// ---------------------------------------------------------------- Inputs

export type PlayerInput =
  | { readonly type: 'play_card'; readonly instanceId: string; readonly targetId?: string }
  | { readonly type: 'end_turn' }
  | { readonly type: 'execution_input'; readonly atMs: number };

// ---------------------------------------------------------------- Generation

/**
 * Run 开局产出的局势（ADR-0005）。本票只用到 title；Faction 在 #10 起填充。
 * Generation 永远不产出 Card、数值或规则。
 */
export interface Faction {
  readonly id: string;
  readonly name: string;
  readonly grievance: string;
  readonly want: string;
}

export interface Generation {
  readonly title: string;
  readonly factions: readonly Faction[];
}

/** 允许测试替换卡池与起始 Deck，真实游戏不传。 */
export interface RunOptions {
  readonly cards?: readonly CardDefinition[];
  readonly startingDeck?: readonly string[];
}

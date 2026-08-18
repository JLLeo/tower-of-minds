import type { CombatantState, RunState } from '../engine/types.js';

/** 一次 Intent 请求需要的全部上下文。合法动作集是其中的硬约束。 */
export interface IntentContext {
  readonly combatant: CombatantState;
  readonly turn: number;
  readonly playerHp: number;
  readonly playerMaxHp: number;
  readonly playerBlock: number;
  readonly handSize: number;
}

/**
 * 供应商适配器。它只负责把上下文送出去、把响应原样带回来——解析传输层格式是
 * 它的事，判断内容合不合法不是（ADR-0001）。返回 unknown 是刻意的：校验归引擎。
 *
 * 换供应商就是换一个这个接口的实现，引擎和界面都不需要改（ADR-0006）。
 */
export interface IntentProvider {
  requestIntent(context: IntentContext, signal: AbortSignal): Promise<unknown>;
}

export function contextFor(state: RunState, combatant: CombatantState): IntentContext {
  return {
    combatant,
    turn: state.encounter.turn,
    playerHp: state.encounter.player.hp,
    playerMaxHp: state.encounter.player.maxHp,
    playerBlock: state.encounter.player.block,
    handSize: state.encounter.player.hand.length,
  };
}

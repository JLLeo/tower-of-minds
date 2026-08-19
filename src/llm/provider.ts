import type { AgentRequest, AgentState, CombatantState, RunState } from '../engine/types.js';

/**
 * 一次提问需要的全部上下文，按 kind 分。Fusion（#13）与层间构筑（#14）各自加一个
 * 成员——宿主的分派点只有这里一处。
 */
export type AgentTask = {
  readonly kind: 'intent';
  readonly agent: AgentState;
  readonly combatant: CombatantState;
  readonly turn: number;
  readonly playerHp: number;
  readonly playerMaxHp: number;
  readonly playerBlock: number;
  readonly handSize: number;
};

/**
 * 供应商适配器。它只负责把上下文送出去、把响应原样带回来——解析传输层格式是它的事，
 * 判断内容合不合法不是（ADR-0001）。返回 unknown 是刻意的：校验归引擎。
 *
 * 换供应商就是换一个这个接口的实现，引擎和界面都不需要改（ADR-0006）。
 */
export interface AgentProvider {
  ask(task: AgentTask, signal: AbortSignal): Promise<unknown>;
}

/** 把一次 AgentRequest 翻译成模型看得懂的上下文。认不出来的请求返回 undefined。 */
export function taskFor(state: RunState, request: AgentRequest): AgentTask | undefined {
  const agent = state.agents.find((a) => a.factionId === request.factionId);
  if (!agent) return undefined;

  switch (request.kind) {
    case 'intent': {
      const combatant = state.encounter.combatants.find((c) => c.id === request.combatantId);
      if (!combatant) return undefined;
      return {
        kind: 'intent',
        agent,
        combatant,
        turn: state.encounter.turn,
        playerHp: state.encounter.player.hp,
        playerMaxHp: state.encounter.player.maxHp,
        playerBlock: state.encounter.player.block,
        handSize: state.encounter.player.hand.length,
      };
    }
  }
}

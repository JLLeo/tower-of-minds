import { legalTargetsFor } from '../engine/agents.js';
import { ATOMS, atomOf, describeAtom, describeAtoms } from '../engine/atoms.js';
import { CARD_POOL } from '../engine/content.js';
import { memoryForPrompt, standingOf } from '../engine/memory.js';
import { PLAYER_TARGET } from '../engine/types.js';
import type { AgentRequest, AgentState, CombatantState, RunState } from '../engine/types.js';

/** 一个合法动作，连同它这一刻能打的目标。合法集由引擎算，模型只能从中选。 */
export interface ActionOption {
  readonly actionId: string;
  readonly description: string;
  readonly targets: readonly { readonly id: string; readonly name: string }[];
}

/**
 * 一次提问需要的全部上下文，按 kind 分。Fusion（#13）与层间构筑（#14）各自加一个
 * 成员——宿主的分派点只有这里一处。
 */
export interface AtomOption {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly weight: number;
}

export type AgentTask = IntentTask | FusionTask | DeckbuildTask;

/** 层间构筑：从合法牌集里挑几张带上下一层，也可以顺手把其中两张融了。 */
export interface DeckbuildTask {
  readonly kind: 'deckbuild';
  readonly agent: AgentState;
  readonly memory: string;
  readonly standing: number;
  readonly forFloor: number;
  readonly capacity: number;
  /** 合法牌集。它没见过的牌不在这里——藏牌因此是玩家真实可用的反制。 */
  readonly cards: readonly { readonly id: string; readonly name: string; readonly text: string }[];
}

export interface IntentTask {
  readonly kind: 'intent';
  readonly agent: AgentState;
  readonly combatant: CombatantState;
  readonly options: readonly ActionOption[];
  readonly allies: readonly string[];
  readonly rivals: readonly string[];
  /** 这个 Faction 记得关于玩家的什么。它记得什么，就只知道什么。 */
  readonly memory: string;
  readonly standing: number;
  readonly turn: number;
  readonly playerHp: number;
  readonly playerMaxHp: number;
  readonly playerBlock: number;
  readonly handSize: number;
}

/** 融合的取舍：丢哪一个 Atom，或者过载时挑哪一个禁忌，以及新牌叫什么。 */
export interface FusionTask {
  readonly kind: 'fusion';
  readonly agent: AgentState;
  /** 它对你的态度会影响它替你留下什么——这正是「找不同派系融不一样」的一半原因。 */
  readonly memory: string;
  readonly standing: number;
  readonly sourceNames: readonly [string, string];
  readonly overload: boolean;
  /** 合并后的全部 Atom。不过载时只能从这里面丢一个。 */
  readonly atoms: readonly AtomOption[];
  /** 过载时可选的禁忌 Atom。 */
  readonly forbidden: readonly AtomOption[];
}

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
    case 'deckbuild': {
      const cards = request.legalCardIds
        .map((id) => CARD_POOL.find((card) => card.id === id) ?? state.forged.find((c) => c.id === id))
        .filter((card): card is NonNullable<typeof card> => card !== undefined)
        .map((card) => ({
          id: card.id,
          name: `${card.name}（${card.cost} 费）`,
          text: describeAtoms(card.atoms),
        }));

      return {
        kind: 'deckbuild',
        agent,
        memory: memoryForPrompt(state, request.factionId),
        standing: standingOf(state, request.factionId),
        forFloor: request.forFloor,
        capacity: request.capacity,
        cards,
      };
    }

    case 'fusion': {
      const describe = (id: string): AtomOption | null => {
        const atom = atomOf(id);
        return atom
          ? { id: atom.id, name: atom.name, description: describeAtom(atom), weight: atom.weight }
          : null;
      };
      const present = request.atoms
        .map(describe)
        .filter((option): option is AtomOption => option !== null);

      return {
        kind: 'fusion',
        agent,
        memory: memoryForPrompt(state, request.factionId),
        standing: standingOf(state, request.factionId),
        sourceNames: request.sourceNames,
        overload: request.overload,
        atoms: present,
        forbidden: ATOMS.filter((atom) => atom.forbidden)
          .map((atom) => describe(atom.id))
          .filter((option): option is AtomOption => option !== null),
      };
    }

    case 'intent': {
      const combatant = state.encounter.combatants.find((c) => c.id === request.combatantId);
      if (!combatant) return undefined;
      const nameOf = (id: string): string =>
        id === PLAYER_TARGET
          ? '外来者'
          : (state.encounter.combatants.find((c) => c.id === id)?.name ?? id);

      return {
        kind: 'intent',
        agent,
        combatant,
        options: combatant.actions.map((action) => ({
          actionId: action.id,
          description: action.description,
          targets: legalTargetsFor(state, combatant, action).map((id) => ({ id, name: nameOf(id) })),
        })),
        memory: memoryForPrompt(state, combatant.factionId),
        standing: standingOf(state, combatant.factionId),
        allies: state.encounter.combatants
          .filter((c) => c.hp > 0 && c.factionId === combatant.factionId && c.id !== combatant.id)
          .map((c) => `${c.name}（${c.hp}/${c.maxHp}）`),
        rivals: state.encounter.combatants
          .filter((c) => c.hp > 0 && c.factionId !== combatant.factionId)
          .map((c) => `${c.name}（${c.hp}/${c.maxHp}）`),
        turn: state.encounter.turn,
        playerHp: state.encounter.player.hp,
        playerMaxHp: state.encounter.player.maxHp,
        playerBlock: state.encounter.player.block,
        handSize: state.encounter.player.hand.length,
      };
    }
  }
}

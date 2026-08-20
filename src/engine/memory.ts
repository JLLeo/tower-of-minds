import type { MemoryEntry, RunState } from './types.js';

/**
 * Memory 与 Standing。
 *
 * Standing 不单独存，永远由 Memory 推出（ADR-0003 之外的一条自加约束）：两者一旦
 * 分开存，就会漂移，而玩家点开面板看到的正是这些条目——他必须能从条目算出那个数字，
 * 否则「看得见的记忆」就成了摆设。
 */

/** 伤害每累计这么多，态度掉一点。 */
const HARM_PER_STANDING = 20;

export function memoriesOf(state: RunState, factionId: string): readonly MemoryEntry[] {
  return state.memories[factionId] ?? [];
}

export function remember(
  state: RunState,
  factionId: string,
  entry: MemoryEntry,
): RunState {
  return {
    ...state,
    memories: {
      ...state.memories,
      [factionId]: [...memoriesOf(state, factionId), entry],
    },
  };
}

/**
 * 记下玩家在**所有在场且还活着的 Faction** 面前打出的牌。
 *
 * 它们看得见的只有这些——#14 的对手构筑就从这里取材，玩家因此可以藏牌：
 * 在某一方面前不打核心组合，它就永远不知道你有那张。
 */
export function rememberCardPlayed(state: RunState, cardId: string): RunState {
  const watchers = new Set(
    state.encounter.combatants.filter((c) => c.hp > 0).map((c) => c.factionId),
  );
  let next = state;
  for (const factionId of watchers) {
    next = remember(next, factionId, { kind: 'card_played', floor: state.floor, cardId });
  }
  return next;
}

/**
 * 由 Memory 推出的态度。
 *
 * 留它活着、对它示好各加一点；伤害每累计 HARM_PER_STANDING 掉一点。
 * 你在它面前打过什么牌是情报，不是恩怨，所以不参与计算。
 */
export function standingOf(state: RunState, factionId: string): number {
  let value = 0;
  let harm = 0;

  for (const entry of memoriesOf(state, factionId)) {
    switch (entry.kind) {
      case 'sided':
      case 'parley':
        value += 1;
        break;
      case 'harmed':
        harm += entry.amount;
        break;
      case 'card_played':
        break;
    }
  }

  return value - Math.floor(harm / HARM_PER_STANDING);
}

/** 所有它记得的 Faction 的态度，供界面与 prompt 使用。 */
export function allStandings(state: RunState): Readonly<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const factionId of Object.keys(state.memories)) {
    out[factionId] = standingOf(state, factionId);
  }
  return out;
}

/** 招来增援的门槛：你在这么多层里都挑了同一方下手。 */
const GRUDGE_FLOORS = 2;

/**
 * 会在下一层多带人的 Faction：**你反复挑它下手**的那一方。
 *
 * 判据不是「态度为负」——清一层就必须打光一方，所以得罪某方是必然发生的事，
 * 拿它当条件等于给所有人加一道固定的难度税。真正是玩家选择的，是他一次次挑了谁。
 */
export function offendedFactions(state: RunState): readonly string[] {
  return Object.entries(state.memories)
    .filter(([, entries]) => {
      const floors = new Set(
        entries.filter((e) => e.kind === 'harmed').map((e) => e.floor),
      );
      return floors.size >= GRUDGE_FLOORS;
    })
    .map(([factionId]) => factionId);
}

/** 把 Memory 摊成给模型看的几行。它记得什么，就只知道什么。 */
export function memoryForPrompt(state: RunState, factionId: string): string {
  const entries = memoriesOf(state, factionId);
  if (entries.length === 0) return '你对这个外来者还一无所知。';

  const cards = new Set<string>();
  let harm = 0;
  let sided = 0;
  let parley = 0;

  for (const entry of entries) {
    switch (entry.kind) {
      case 'card_played':
        cards.add(entry.cardId);
        break;
      case 'harmed':
        harm += entry.amount;
        break;
      case 'sided':
        sided += 1;
        break;
      case 'parley':
        parley += 1;
        break;
    }
  }

  const lines: string[] = [];
  if (sided > 0) lines.push(`他有 ${sided} 次把你们留到了最后。`);
  if (parley > 0) lines.push(`他对你们示好过 ${parley} 次。`);
  if (harm > 0) lines.push(`他一共伤了你们 ${harm} 点。`);
  if (cards.size > 0) lines.push(`你亲眼见过他打出：${[...cards].join('、')}。`);
  return lines.join('\n');
}

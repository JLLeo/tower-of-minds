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
  const summary = summarizeMemory(state, factionId);
  return summary.sided + summary.parley - Math.floor(summary.harm / HARM_PER_STANDING);
}

/** 只数「你把它留到最后」的次数。高阶 Favor 认这个，示好不能替代站队。 */
export function sidedWith(state: RunState, factionId: string): number {
  return summarizeMemory(state, factionId).sided;
}

/** 所有它记得的 Faction 的态度，供界面与 prompt 使用。 */
export function allStandings(state: RunState): Readonly<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const factionId of Object.keys(state.memories)) {
    out[factionId] = standingOf(state, factionId);
  }
  return out;
}

/** 招来增援的门槛：你对某一方下手的层数，比对别人多出这么多。 */
const GRUDGE_GAP = 2;

/**
 * 会在下一层多带人的 Faction：**你明显偏着挑它下手**的那一方。
 *
 * 判据既不是「态度为负」也不是「被打过两层」——清一层就必须打光一方，两者都会
 * 无差别地落到每个人头上，等于给所有人加一道固定的难度税。真正由玩家选择的，
 * 是他有没有一次次挑同一方；换着打就不该招来增援。
 */
export function offendedFactions(state: RunState): readonly string[] {
  const counts = new Map<string, number>();
  for (const [factionId, entries] of Object.entries(state.memories)) {
    counts.set(factionId, new Set(entries.filter((e) => e.kind === 'harmed').map((e) => e.floor)).size);
  }
  if (counts.size === 0) return [];

  return [...counts.entries()]
    .filter(([factionId, mine]) =>
      [...counts.entries()].every(([other, theirs]) => other === factionId || mine - theirs >= GRUDGE_GAP),
    )
    .map(([factionId]) => factionId);
}

/** Memory 的结构化摘要。prompt 与界面都从它出发，避免两处各写各的、各自漂移。 */
export interface MemorySummary {
  readonly sided: number;
  readonly parley: number;
  readonly harm: number;
  readonly cards: readonly string[];
}

export function summarizeMemory(state: RunState, factionId: string): MemorySummary {
  const cards = new Set<string>();
  let harm = 0;
  let sided = 0;
  let parley = 0;

  for (const entry of memoriesOf(state, factionId)) {
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

  // 正在打的这一场还没写进 Memory，但玩家看得见自己刚打出去的伤害——
  // 面板与 prompt 都该反映当下，而不是上一层结束时的快照。
  if (state.phase === 'in_encounter') {
    harm += state.encounter.damageDealtTo[factionId] ?? 0;
  }

  return { sided, parley, harm, cards: [...cards] };
}

/**
 * 把摘要摊成几行。nameOf 决定卡牌怎么显示——给模型看 id，给玩家看名字。
 */
export function describeMemory(
  summary: MemorySummary,
  nameOf: (cardId: string) => string,
): readonly string[] {
  const lines: string[] = [];
  if (summary.sided > 0) lines.push(`他有 ${summary.sided} 次把你们留到了最后。`);
  if (summary.parley > 0) lines.push(`他对你们示好过 ${summary.parley} 次。`);
  if (summary.harm > 0) lines.push(`他一共伤了你们 ${summary.harm} 点。`);
  if (summary.cards.length > 0) {
    lines.push(`你亲眼见过他打出：${summary.cards.map(nameOf).join('、')}。`);
  }
  return lines;
}

export function memoryForPrompt(state: RunState, factionId: string): string {
  const lines = describeMemory(summarizeMemory(state, factionId), (id) => id);
  return lines.length > 0 ? lines.join('\n') : '你对这个外来者还一无所知。';
}

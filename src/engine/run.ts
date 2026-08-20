import { createRng, nextInt, shuffle, type Rng } from './rng.js';
import { effectsOf } from './atoms.js';
import {
  allStandings,
  memoriesOf,
  offendedFactions,
  remember,
  rememberCardPlayed,
  sidedWith,
} from './memory.js';
import {
  dropRequests,
  expireRequests,
  fallbackIntent,
  openFusionRequest,
  openIntentRequests,
  receiveResponse,
} from './agents.js';
import { exceedsCapacity, fallbackName, forgeCard, mergeAtoms } from './fusion.js';
import { PLAYER_TARGET } from './types.js';
import {
  CARD_POOL,
  HAND_SIZE,
  HIGH_FAVOR_THRESHOLD,
  MAX_ENERGY,
  NORMAL_FLOORS,
  PLAYER_MAX_HP,
  STARTING_DECK,
  baseCardsOf,
  builtInAgents,
  combatantsForFloor,
  executionForType,
} from './content.js';
import { NO_STATUSES } from './types.js';
import type {
  CardDefinition,
  CardInstance,
  CombatantAction,
  CombatantState,
  Statuses,
  Effect,
  EncounterState,
  ExecutionGrade,
  ExecutionSpec,
  FavorOffer,
  Generation,
  MemoryEntry,
  PlayerInput,
  PlayerState,
  RunOptions,
  RunState,
} from './types.js';

/**
 * Engine 的 Run 级公开接口，也是本仓库唯一的测试 seam。
 *
 * startRun 拿到初始状态，之后反复 applyInput 取回新状态。两者都是纯函数：
 * 同一 seed 加同一串输入必然得到同一个 Run。所有随机走 state.rng，所有时间从
 * input 进来，模型的回答也是一种 input——引擎自己既不掷骰、不读时钟，也不联网。
 */
export function startRun(
  generation: Generation,
  seed: number,
  options: RunOptions = {},
): RunState {
  const deckIds = options.startingDeck ?? STARTING_DECK;
  const startedAtMs = options.startedAtMs ?? 0;
  const deck: readonly CardInstance[] = deckIds.map((id, index) => mintCard(id, index));

  const seeded: RunState = {
    seed,
    rng: createRng(seed),
    agents: builtInAgents(),
    agentRequests: [],
    nextRequestSeq: 0,
    nextCardSeq: deckIds.length,
    floor: 0,
    deck,
    forged: [],
    memories: {},
    favor: null,
    phase: 'in_encounter',
    encounter: EMPTY_ENCOUNTER,
    outcome: null,
    journal: [`进入${generation.title}。`],
  };

  return beginEncounter(seeded, 1, PLAYER_MAX_HP, startedAtMs);
}

/**
 * Deck 里每张牌的身份。序号单调递增，不依赖「Deck 只会变长」——#13 的 Fusion 会
 * 从 Deck 里拿走牌，那时按长度取号就会撞车。
 */
function mintCard(definitionId: string, seq: number): CardInstance {
  return { instanceId: `${definitionId}#${seq}`, definitionId };
}

/** 还没有 Encounter 时的占位。startRun 立刻会用真正的第一层覆盖它。 */
const EMPTY_ENCOUNTER: EncounterState = {
  turn: 0,
  phase: 'ended',
  player: {
    hp: PLAYER_MAX_HP,
    maxHp: PLAYER_MAX_HP,
    block: 0,
    energy: 0,
    maxEnergy: MAX_ENERGY,
    hand: [],
    drawPile: [],
    discardPile: [],
    statuses: NO_STATUSES,
  },
  combatants: [],
  pending: null,
  damageDealtTo: {},
  executionUsedThisTurn: false,
  lastGrade: null,
};

/**
 * 开一层。Deck 是 Run 级的资产，这里把它整副洗进抽牌堆——所以上一层拿到的牌
 * 从下一层第一回合起就在牌堆里。
 */
function beginEncounter(state: RunState, floor: number, hp: number, atMs: number): RunState {
  const [rngAfterShuffle, drawPile] = shuffle(state.rng, state.deck);
  const fresh: PlayerState = {
    hp,
    maxHp: PLAYER_MAX_HP,
    block: 0,
    energy: MAX_ENERGY,
    maxEnergy: MAX_ENERGY,
    hand: [],
    drawPile,
    discardPile: [],
    statuses: NO_STATUSES,
  };
  const [rng, player] = draw(rngAfterShuffle, fresh, HAND_SIZE);

  return openIntentRequests(
    {
      ...state,
      rng,
      floor,
      favor: null,
      phase: 'in_encounter',
      journal: [...state.journal, `第 ${floor} 层。`],
      encounter: {
        turn: 1,
        phase: 'player_turn',
        player,
        combatants: combatantsForFloor(floor, offendedFactions(state)),
        pending: null,
        damageDealtTo: {},
        executionUsedThisTurn: false,
        lastGrade: null,
      },
    },
    atMs,
  );
}

export function applyInput(state: RunState, input: PlayerInput): RunState {
  if (state.phase === 'ended') return state;
  // 层间：选 Favor 的时候只能选 Favor 或发起融合；等这一方取舍时什么都做不了，
  // 除了让时间流逝（超时由 tick 判）。
  if (state.phase === 'choosing_favor' && input.type !== 'choose_favor' && input.type !== 'fuse') {
    return state;
  }
  if (state.phase === 'fusing' && input.type !== 'agent_response' && input.type !== 'tick') {
    return state;
  }

  switch (input.type) {
    case 'play_card':
      return playCard(state, input.instanceId, input.atMs, input.targetId);
    case 'end_turn':
      return endTurn(state, input.atMs);
    case 'execution_input':
      return resolvePending(state, input.atMs);
    case 'agent_response':
      return receiveResponse(state, input.requestId, input.payload);
    case 'choose_favor':
      return takeFavor(state, input.cardId, input.atMs);
    case 'fuse':
      return startFusion(state, input.offeredCardId, input.deckInstanceId, input.overload, input.atMs);
    case 'tick':
      return expireRequests(expireIfWindowClosed(state, input.atMs), input.atMs);
  }
}

// ---------------------------------------------------------------- Execution Check

/**
 * 判定窗口内的分档，按窗口长度的比例给出，与具体 Card Type 无关——
 * #5 的节奏连击与蓄力沿用同一套分档，只换窗口长度与操作方式。
 */
export const PERFECT_BAND = { start: 0.7, end: 0.85 } as const;
export const GOOD_BAND = { start: 0.45, end: 1 } as const;

/** Miss 只是打折，不反噬。 */
export const GRADE_MULTIPLIER: Record<ExecutionGrade, number> = {
  miss: 0.5,
  good: 1,
  perfect: 1.5,
};

export const GRADE_LABEL: Record<ExecutionGrade, string> = {
  miss: '失手',
  good: '还行',
  perfect: '完美',
};

/**
 * 把输入时刻在窗口里的位置换成档位。窗口外——太早，或者拖到窗口耗尽——都算 Miss。
 * 计算归引擎，UI 只上报时刻。
 */
function gradeFor(spec: ExecutionSpec, elapsedMs: number): ExecutionGrade {
  const progress = Math.max(0, elapsedMs) / spec.windowMs;
  if (progress >= PERFECT_BAND.start && progress < PERFECT_BAND.end) return 'perfect';
  if (progress >= GOOD_BAND.start && progress < GOOD_BAND.end) return 'good';
  return 'miss';
}

/** 只缩放伤害与护体类效果——抽牌和能量不该因为手抖就变成半张牌。 */
const SCALABLE: ReadonlySet<Effect['kind']> = new Set([
  'damage',
  'gain_block',
  'gain_thorns',
  'apply_burn',
]);

function scaleEffects(effects: readonly Effect[], multiplier: number): readonly Effect[] {
  if (multiplier === 1) return effects;
  return effects.map((effect) => {
    if (!SCALABLE.has(effect.kind) || !('amount' in effect)) return effect;
    return { ...effect, amount: Math.max(1, Math.round(effect.amount * multiplier)) };
  });
}

// ---------------------------------------------------------------- 只读查询
// 渲染层通过这些函数读状态，自己不重新推导任何规则。

/**
 * 按定义 id 查一张 Card：固定卡池，加上本局锻出来的那些。
 * 融合产物是真正的 Card，界面和结算都必须能查到它。
 */
export function cardById(state: RunState, definitionId: string): CardDefinition | undefined {
  return (
    CARD_POOL.find((card) => card.id === definitionId) ??
    state.forged.find((card) => card.id === definitionId)
  );
}

export function definitionOf(state: RunState, instanceId: string): CardDefinition | undefined {
  const card =
    state.encounter.player.hand.find((c) => c.instanceId === instanceId) ??
    state.encounter.player.drawPile.find((c) => c.instanceId === instanceId) ??
    state.encounter.player.discardPile.find((c) => c.instanceId === instanceId);
  if (!card) return undefined;
  return cardById(state, card.definitionId);
}

/** 现在是否轮到玩家出牌。等 Intent 不会挡住玩家——Run 永远不因模型停下。 */
export function isPlayerActing(state: RunState): boolean {
  return state.phase === 'in_encounter' && state.encounter.phase === 'player_turn';
}

export function canPlay(state: RunState, instanceId: string): boolean {
  if (!isPlayerActing(state)) return false;
  if (!state.encounter.player.hand.some((c) => c.instanceId === instanceId)) return false;
  const definition = definitionOf(state, instanceId);
  return definition !== undefined && definition.cost <= state.encounter.player.energy;
}

export function livingCombatants(state: RunState): readonly CombatantState[] {
  return state.encounter.combatants.filter((c) => c.hp > 0);
}

/** 某个 Faction 记得的事。界面与测试都从这里读。 */
export function memoryOf(state: RunState, factionId: string): readonly MemoryEntry[] {
  return memoriesOf(state, factionId);
}

/** 每个 Faction 对玩家的态度，由 Memory 推出。界面与 prompt 都读它。 */
export function standings(state: RunState): Readonly<Record<string, number>> {
  return allStandings(state);
}

/** 玩家没有指定目标时打谁。渲染层读它来高亮，不自己再推一遍。 */
export function defaultTarget(state: RunState): string | undefined {
  return livingCombatants(state)[0]?.id;
}

/**
 * **战斗进行中**你正站在谁那边：还活着的 Faction 里，你打得最少的那个。
 * 打成平手就还没有表态。这是给玩家看的即时反馈——他应该随时知道自己站在哪。
 *
 * 它**不是**发 Favor 的规则。一层结束的条件就是「场上只剩一个 Faction」，那一刻
 * 候选只剩 0 或 1 个，这里的比较无从发生。层间的报酬按 rewardedFaction 走。
 */
export function currentSiding(state: RunState): string | null {
  const alive = [...new Set(livingCombatants(state).map((c) => c.factionId))];
  if (alive.length < 2) return alive[0] ?? null;

  const scored = alive
    .map((factionId) => ({ factionId, damage: state.encounter.damageDealtTo[factionId] ?? 0 }))
    .sort((a, b) => a.damage - b.damage);

  const best = scored[0];
  const runnerUp = scored[1];
  if (!best || !runnerUp || best.damage === runnerUp.damage) return null;
  return best.factionId;
}

/**
 * 一层结束时，欠你人情的是**你留下来的那一方**。
 *
 * 这不是「你打得最少的那一方」——听起来更细腻，但那条规则在这里根本触发不到：
 * 层是在只剩一个 Faction 时结束的。把话说清楚，好过留一段永远走不到的分支。
 * 全灭则没有人欠你人情。
 */
function rewardedFaction(state: RunState): string | null {
  const alive = [...new Set(livingCombatants(state).map((c) => c.factionId))];
  return alive.length === 1 ? (alive[0] ?? null) : null;
}

/** 某个 Agent 这一回合打算做的事，供界面显示。还没定下来时返回 undefined。 */
export function intendedAction(combatant: CombatantState): CombatantAction | undefined {
  const intent = combatant.intent;
  if (!intent) return undefined;
  return combatant.actions.find((action) => action.id === intent.actionId);
}

// ---------------------------------------------------------------- 打牌

function playCard(state: RunState, instanceId: string, atMs: number, targetId?: string): RunState {
  if (!canPlay(state, instanceId)) return state;

  const encounter = state.encounter;
  const card = encounter.player.hand.find((c) => c.instanceId === instanceId);
  const definition = definitionOf(state, instanceId);
  if (!card || !definition) return state;

  // 这张牌先离开手牌，但**不立刻进弃牌堆**——结算完才进去。否则「回收」这类
  // 效果会把正在结算的这张牌自己捡回来。
  const player: PlayerState = {
    ...encounter.player,
    energy: encounter.player.energy - definition.cost,
    hand: encounter.player.hand.filter((c) => c.instanceId !== instanceId),
  };

  const target = targetId ?? livingCombatants(state)[0]?.id;
  const effects = effectsOf(definition.atoms, target);
  const journal = [...state.journal, `你打出「${definition.name}」。`];

  // 在场的人当场就看见了这张牌。必须记在挂起判定**之前**——否则盾牌类
  // 永远走不到记录那一步，而那正是 #14 要用的情报。
  const seen = rememberCardPlayed(
    { ...state, journal, encounter: { ...encounter, player } },
    definition.id,
  );

  // ADR-0002：需要实时输入的 Card 在这里把结算挂起，剩下的效果等输入回来再执行。
  // 每回合只挂起一次——同回合的后续 Card 直接结算。
  if (definition.execution && !encounter.executionUsedThisTurn) {
    return {
      ...seen,
      encounter: {
        ...seen.encounter,
        phase: 'awaiting_execution',
        executionUsedThisTurn: true,
        lastGrade: null,
        pending: {
          card,
          spec: definition.execution,
          openedAtMs: atMs,
          remainingEffects: effects,
        },
      },
    };
  }

  return checkOutcome(discard(applyEffects(seen, effects), card));
}

/** 结算完毕，这张牌落进弃牌堆。 */
function discard(state: RunState, card: CardInstance): RunState {
  return withPlayer(state, {
    ...state.encounter.player,
    discardPile: [...state.encounter.player.discardPile, card],
  });
}

function applyEffects(state: RunState, effects: readonly Effect[]): RunState {
  let next = state;
  for (const effect of effects) next = applyEffect(next, effect);
  return next;
}

function applyEffect(state: RunState, effect: Effect): RunState {
  const encounter = state.encounter;
  const player = encounter.player;

  switch (effect.kind) {
    case 'damage':
      return dealDamage(state, effect.targetId, effect.amount, effect.hits, effect.ignoreBlock);

    case 'gain_block':
      return withPlayer(state, { ...player, block: player.block + effect.amount });

    case 'gain_thorns':
      return withPlayer(state, {
        ...player,
        statuses: { ...player.statuses, thorns: player.statuses.thorns + effect.amount },
      });

    case 'gain_endure':
      return withPlayer(state, {
        ...player,
        statuses: { ...player.statuses, endure: player.statuses.endure + effect.amount },
      });

    case 'apply_burn':
      return withCombatant(state, effect.targetId, (c) => ({
        ...c,
        statuses: {
          ...c.statuses,
          burn: c.statuses.burn + effect.amount,
          burnTurns: Math.max(c.statuses.burnTurns, effect.turns),
        },
      }));

    case 'apply_expose':
      return withCombatant(state, effect.targetId, (c) => ({
        ...c,
        statuses: { ...c.statuses, exposed: true },
      }));

    case 'apply_weaken':
      return withCombatant(state, effect.targetId, (c) => ({
        ...c,
        statuses: { ...c.statuses, weakened: true },
      }));

    case 'gain_energy':
      return withPlayer(state, { ...player, energy: player.energy + effect.amount });

    case 'draw_cards': {
      const [rng, drawn] = draw(state.rng, player, effect.amount);
      return { ...withPlayer(state, drawn), rng };
    }

    case 'recall_card':
      return recall(state, effect.amount);

    case 'parley': {
      const target = encounter.combatants.find((c) => c.id === effect.targetId && c.hp > 0);
      if (!target) return state;
      const who = state.agents.find((a) => a.factionId === target.factionId)?.name ?? '对方';
      return remember(
        { ...state, journal: [...state.journal, `你向${who}递出了善意。`] },
        target.factionId,
        { kind: 'parley', floor: state.floor },
      );
    }
  }
}

function withPlayer(state: RunState, player: PlayerState): RunState {
  return { ...state, encounter: { ...state.encounter, player } };
}

function withCombatant(
  state: RunState,
  id: string,
  update: (combatant: CombatantState) => CombatantState,
): RunState {
  return {
    ...state,
    encounter: {
      ...state.encounter,
      combatants: state.encounter.combatants.map((c) => (c.id === id ? update(c) : c)),
    },
  };
}

/** 从弃牌堆随机取回若干张。随机走 state.rng，所以同一 seed 的结果可复现。 */
function recall(state: RunState, count: number): RunState {
  let player = state.encounter.player;
  let rng = state.rng;

  for (let i = 0; i < count; i++) {
    if (player.discardPile.length === 0) break;
    const [nextRng, index] = nextInt(rng, player.discardPile.length);
    rng = nextRng;
    const card = player.discardPile[index];
    if (!card) break;
    player = {
      ...player,
      hand: [...player.hand, card],
      discardPile: player.discardPile.filter((_, i2) => i2 !== index),
    };
  }

  return { ...withPlayer(state, player), rng };
}

/**
 * 一次伤害效果可以拆成多段。分段对着格挡更吃亏、对着空门更划算——`multi` 的取舍
 * 就在这里，而 #5 的节奏连击会按段给判定。
 */
function dealDamage(
  state: RunState,
  targetId: string,
  amount: number,
  hits: number,
  ignoreBlock: boolean,
): RunState {
  const before = state.encounter.combatants.find((c) => c.id === targetId)?.hp;
  if (before === undefined) return state;

  const next = withCombatant(state, targetId, (combatant) => {
    let current = combatant;
    for (let i = 0; i < hits; i++) {
      if (current.hp <= 0) break;
      current = takeHit(current, amount, ignoreBlock);
    }
    return current;
  });

  const after = next.encounter.combatants.find((c) => c.id === targetId);
  return creditSiding(next, targetId, before - (after?.hp ?? before));
}

/**
 * 站队就记在这里：玩家打谁打得多，就是站在谁的对面。
 *
 * 灼烧这类延迟结算的伤害也要走这里——否则玩家可以把一个 Faction 烧死，账本上却
 * 显示他偏袒的正是这一方。
 */
function creditSiding(state: RunState, targetId: string, dealt: number): RunState {
  if (dealt <= 0) return state;
  const target = state.encounter.combatants.find((c) => c.id === targetId);
  if (!target) return state;

  return {
    ...state,
    encounter: {
      ...state.encounter,
      damageDealtTo: {
        ...state.encounter.damageDealtTo,
        [target.factionId]: (state.encounter.damageDealtTo[target.factionId] ?? 0) + dealt,
      },
    },
  };
}

/** 格挡先吃伤害，剩下的进 HP。易伤在第一段伤害上触发并消耗。 */
function absorb(block: number, amount: number): { block: number; dealt: number } {
  const absorbed = Math.min(block, amount);
  return { block: block - absorbed, dealt: amount - absorbed };
}

/**
 * respectsExposed 为 false 时跳过易伤：反伤这类被动伤害不该把玩家攒下的「破绽」
 * 花掉——那个加成是留给玩家自己下一击的。
 */
function takeHit(
  combatant: CombatantState,
  amount: number,
  ignoreBlock: boolean,
  respectsExposed = true,
): CombatantState {
  const exposed = respectsExposed && combatant.statuses.exposed;
  const incoming = exposed ? Math.round(amount * 1.5) : amount;
  const statuses: Statuses = exposed ? { ...combatant.statuses, exposed: false } : combatant.statuses;

  if (ignoreBlock) {
    return { ...combatant, statuses, hp: Math.max(0, combatant.hp - incoming) };
  }
  const { block, dealt } = absorb(combatant.block, incoming);
  return { ...combatant, statuses, block, hp: Math.max(0, combatant.hp - dealt) };
}

// ---------------------------------------------------------------- 结算挂起的恢复

function resolvePending(state: RunState, atMs: number): RunState {
  const encounter = state.encounter;
  const pending = encounter.pending;
  if (encounter.phase !== 'awaiting_execution' || !pending) return state;

  const grade = gradeFor(pending.spec, atMs - pending.openedAtMs);
  const multiplier = GRADE_MULTIPLIER[grade];

  const resumed: RunState = {
    ...state,
    journal: [...state.journal, `判定：${GRADE_LABEL[grade]}（×${multiplier}）。`],
    encounter: { ...encounter, phase: 'player_turn', pending: null, lastGrade: grade },
  };
  return checkOutcome(
    discard(applyEffects(resumed, scaleEffects(pending.remainingEffects, multiplier)), pending.card),
  );
}

/**
 * 窗口耗尽而玩家始终没有按下：结算照常推进，档位自然落在 Miss。
 * 窗口没走完就原样返回同一个对象——调用方据此跳过重绘，每帧上报才不昂贵。
 */
function expireIfWindowClosed(state: RunState, atMs: number): RunState {
  const pending = state.encounter.pending;
  if (state.encounter.phase !== 'awaiting_execution' || !pending) return state;
  if (atMs - pending.openedAtMs < pending.spec.windowMs) return state;
  return resolvePending(state, atMs);
}

// ---------------------------------------------------------------- 回合推进

function endTurn(state: RunState, atMs: number): RunState {
  const encounter = state.encounter;
  if (encounter.phase !== 'player_turn') return state;

  let player: PlayerState = {
    ...encounter.player,
    hand: [],
    discardPile: [...encounter.player.discardPile, ...encounter.player.hand],
  };
  const combatants = [...encounter.combatants];
  const journal = [...state.journal];

  for (let i = 0; i < combatants.length; i++) {
    const combatant = combatants[i];
    if (!combatant || combatant.hp <= 0) continue;

    // 还没等到模型回答就轮到它行动：引擎替它选，Run 不停。
    const intent = combatant.intent ?? fallbackIntent(combatant);
    const action = combatant.actions.find((a) => a.id === intent.actionId);

    // 上一轮攒下的 block 在它再次行动时清空，行动完 intent 也随之作废。
    const acted: CombatantState = { ...combatant, block: 0, intent: null };
    if (intent.line) journal.push(`${combatant.name}：「${intent.line}」`);

    if (!action) {
      combatants[i] = acted;
      continue;
    }

    if (action.kind === 'defend') {
      combatants[i] = { ...acted, block: action.amount };
      journal.push(`${combatant.name}架起 ${action.amount} 点格挡。`);
      continue;
    }

    // 虚弱先砍一半，这一刀无论打谁都一样。
    const raw = combatant.statuses.weakened ? Math.round(action.amount * 0.5) : action.amount;
    let after: CombatantState = acted;

    if (intent.targetId === PLAYER_TARGET) {
      after = { ...after, statuses: { ...after.statuses, weakened: false } };
      const reduced = Math.max(0, raw - player.statuses.endure);
      const { block, dealt } = absorb(player.block, reduced);
      player = { ...player, block, hp: Math.max(0, player.hp - dealt) };
      journal.push(`${combatant.name}攻向你，造成 ${dealt} 点伤害。`);

      if (player.statuses.thorns > 0) {
        after = takeHit(after, player.statuses.thorns, false, false);
        journal.push(`荆棘反弹 ${player.statuses.thorns} 点伤害。`);
      }
      combatants[i] = after;
      continue;
    }

    // 打的是别的 Faction 的人——这正是多方混战里玩家该看见的东西。
    const targetIndex = combatants.findIndex((c) => c?.id === intent.targetId);
    const target = targetIndex >= 0 ? combatants[targetIndex] : undefined;
    combatants[i] = after;
    if (!target || target.hp <= 0) {
      journal.push(`${combatant.name}扑了个空。`);
      continue;
    }
    const before = target.hp;
    combatants[i] = { ...after, statuses: { ...after.statuses, weakened: false } };
    combatants[targetIndex] = takeHit(target, raw, false, false);
    journal.push(
      `${combatant.name}攻向${target.name}，造成 ${before - (combatants[targetIndex]?.hp ?? before)} 点伤害。`,
    );
  }

  // 回合末结算灼烧。灼烧是玩家打上去的，所以它造成的伤害也要记进站队账本。
  const burned: { factionId: string; dealt: number }[] = [];
  for (let i = 0; i < combatants.length; i++) {
    const combatant = combatants[i];
    if (!combatant || combatant.hp <= 0) continue;
    const { burn, burnTurns } = combatant.statuses;
    if (burn <= 0 || burnTurns <= 0) continue;

    const remaining = burnTurns - 1;
    const before = combatant.hp;
    combatants[i] = {
      ...combatant,
      hp: Math.max(0, combatant.hp - burn),
      statuses: { ...combatant.statuses, burnTurns: remaining, burn: remaining > 0 ? burn : 0 },
    };
    burned.push({ factionId: combatant.factionId, dealt: before - (combatants[i]?.hp ?? before) });
    journal.push(`${combatant.name}被灼烧，受到 ${burn} 点伤害。`);
  }

  let damageDealtTo = encounter.damageDealtTo;
  for (const entry of burned) {
    if (entry.dealt <= 0) continue;
    damageDealtTo = {
      ...damageDealtTo,
      [entry.factionId]: (damageDealtTo[entry.factionId] ?? 0) + entry.dealt,
    };
  }

  const afterCombatants = checkOutcome(
    dropRequests({
      ...state,
      journal,
      encounter: { ...encounter, player, combatants, damageDealtTo },
    }),
  );
  // 这一层可能刚刚被清掉（phase 变成 choosing_favor）——那就不该再抽牌、也不该
  // 再挂提问，否则会在层间界面上开出永远无人回答的问题。
  if (afterCombatants.phase !== 'in_encounter') return afterCombatants;

  const [rng, refreshed] = draw(
    afterCombatants.rng,
    {
      ...player,
      block: 0,
      energy: player.maxEnergy,
      // 坚忍只管本回合；荆棘持续整场。
      statuses: { ...player.statuses, endure: 0 },
    },
    HAND_SIZE,
  );

  return openIntentRequests(
    {
      ...afterCombatants,
      rng,
      encounter: {
        ...afterCombatants.encounter,
        turn: encounter.turn + 1,
        player: refreshed,
        executionUsedThisTurn: false,
        lastGrade: null,
      },
    },
    atMs,
  );
}

// ---------------------------------------------------------------- 抽牌

function draw(rng: Rng, player: PlayerState, count: number): readonly [Rng, PlayerState] {
  const hand = [...player.hand];
  let drawPile = [...player.drawPile];
  let discardPile = [...player.discardPile];
  let current = rng;

  for (let i = 0; i < count; i++) {
    if (drawPile.length === 0) {
      if (discardPile.length === 0) break;
      const [next, reshuffled] = shuffle(current, discardPile);
      current = next;
      drawPile = [...reshuffled];
      discardPile = [];
    }
    const card = drawPile.shift();
    if (card) hand.push(card);
  }

  return [current, { ...player, hand, drawPile, discardPile }];
}

// ---------------------------------------------------------------- 胜负

function checkOutcome(state: RunState): RunState {
  const encounter = state.encounter;
  if (encounter.phase === 'ended') return state;

  if (encounter.player.hp <= 0) {
    return {
      ...state,
      phase: 'ended',
      outcome: 'defeat',
      memories: {},
      forged: [],
      agentRequests: [],
      encounter: { ...encounter, phase: 'ended', pending: null },
      journal: [...state.journal, '你倒在了塔里。'],
    };
  }

  // 玩家活着离开这一层：场上不再有两个敌对 Faction 同时存在，剩下的那一方放你过去。
  // 不需要清场——你可以刻意留某一方活着。
  const living = encounter.combatants.filter((combatant) => combatant.hp > 0);
  const factions = new Set(living.map((combatant) => combatant.factionId));
  if (factions.size <= 1) {
    const survivor = living[0];
    return clearFloor({
      ...state,
      agentRequests: [],
      encounter: { ...encounter, phase: 'ended', pending: null },
      journal: [
        ...state.journal,
        survivor ? `场上只剩下${survivor.name}这一方，它放你过去。` : '这一层清空了。',
      ],
    });
  }

  return state;
}

// ---------------------------------------------------------------- 层间

/**
 * 一层清完了。最后一层之后 Run 就结束（Boss 层是 #9）；否则停下来让玩家收 Favor。
 *
 * 这里不直接开下一层：开新层需要一个时刻，而时刻只能从 input 进引擎。玩家的
 * choose_favor 会带着它进来。
 */
function clearFloor(state: RunState): RunState {
  if (state.floor >= NORMAL_FLOORS) {
    return {
      ...state,
      phase: 'ended',
      outcome: 'victory',
      memories: {},
      forged: [],
      journal: [...state.journal, '你走到了塔的尽头。'],
    };
  }

  // 这一场发生的事写进 Memory，Standing 由 Memory 推出，不另存一份。
  let remembered = state;
  for (const [factionId, amount] of Object.entries(state.encounter.damageDealtTo)) {
    if (amount <= 0) continue;
    remembered = remember(remembered, factionId, {
      kind: 'harmed',
      floor: state.floor,
      amount,
    });
  }

  const factionId = rewardedFaction(state);
  if (factionId) {
    remembered = remember(remembered, factionId, { kind: 'sided', floor: state.floor });
  }

  const offer = buildFavor(remembered, factionId);
  const agentName = remembered.agents.find((a) => a.factionId === factionId)?.name;

  return {
    ...remembered,
    phase: 'choosing_favor',
    favor: offer,
    journal: [
      ...remembered.journal,
      agentName ? `${agentName}记下了你这一场的选择。` : '没有哪一方觉得欠你人情。',
    ],
  };
}

/**
 * 这一层的报酬。给的人是你偏袒过的那一方；给多少取决于它还剩几个人——
 * 你保得越好，它给得越大方。打成平手就没有人欠你人情。
 */
function buildFavor(state: RunState, factionId: string | null): FavorOffer {
  if (!factionId) return { factionId: '', tier: 'basic', choices: [] };

  // 给多少取决于这一方还剩几个人——你保得越好，它给得越大方。
  const survivors = state.encounter.combatants.filter(
    (c) => c.hp > 0 && c.factionId === factionId,
  ).length;
  const count = Math.max(1, survivors);

  const pool = baseCardsOf(factionId).map((card) => card.id);
  const [, shuffled] = shuffle(state.rng, pool);
  // 高阶只认「你把它留到最后」的次数：Parley 改变态度，但换不来融合的资格。
  const tier = sidedWith(state, factionId) >= HIGH_FAVOR_THRESHOLD ? 'high' : 'basic';

  // 高阶 Favor 本该给的是一次 Fusion 机会而不是一张牌——那是 #13。
  return { factionId, tier, choices: shuffled.slice(0, count) };
}

/**
 * 欠你人情的那一方会替你包扎。恢复量按 Favor 的阶位给。
 *
 * 这块是实现时被逼出来的：HP 跨 Floor 保留、对手血量逐层放大，而全程没有任何恢复，
 * 五层的 Run 在数学上赢不了。与其塞一个通用回血，不如把恢复接在站队上——谁欠你人情，
 * 谁替你处理伤口；打成平手就没人管你。数值需要靠试玩调。
 */
const FAVOR_HEAL: Readonly<Record<FavorOffer['tier'], number>> = { basic: 10, high: 16 };

/**
 * 发起一次融合：把高阶 Favor 给的那张牌与 Deck 里的一张合并。
 *
 * 合并后不超上限就当场锻好——引擎自己算得出来，没必要去打扰模型。超了才需要有人
 * 取舍，那时才挂出提问；玩家也可以选择过载，把取舍换成一次赌博。
 */
function startFusion(
  state: RunState,
  offeredCardId: string,
  deckInstanceId: string,
  overload: boolean,
  atMs: number,
): RunState {
  if (state.phase !== 'choosing_favor') return state;
  const offer = state.favor;
  if (!offer || offer.tier !== 'high' || !offer.choices.includes(offeredCardId)) return state;

  const offered = cardById(state, offeredCardId);
  const mine = state.deck.find((card) => card.instanceId === deckInstanceId);
  const mineDefinition = mine ? cardById(state, mine.definitionId) : undefined;
  if (!offered || !mine || !mineDefinition) return state;

  const atoms = mergeAtoms(mineDefinition.atoms, offered.atoms);

  // 没超上限就没有取舍可做，过载也无从谈起。
  if (!exceedsCapacity(atoms) && !overload) {
    return finishFusion(state, {
      atoms,
      factionId: offer.factionId,
      names: [mineDefinition.name, offered.name],
      deckInstanceId,
      mutated: false,
    });
  }

  return openFusionRequest(
    state,
    {
      factionId: offer.factionId,
      atoms,
      overload,
      sourceNames: [mineDefinition.name, offered.name],
      deckInstanceId,
    },
    atMs,
  );
}

/** 不需要取舍的那种融合：引擎直接锻出来。 */
function finishFusion(
  state: RunState,
  input: {
    atoms: readonly string[];
    factionId: string;
    names: readonly [string, string];
    deckInstanceId: string;
    mutated: boolean;
  },
): RunState {
  const forged = forgeCard({
    atoms: input.atoms,
    name: fallbackName(input.names[0], input.names[1], input.mutated),
    factionId: input.factionId,
    mutated: input.mutated,
    executionByType: {
      attack: executionForType('attack'),
      shield: executionForType('shield'),
      spell: executionForType('spell'),
    },
    seq: state.forged.length,
  });

  return {
    ...state,
    favor: { factionId: input.factionId, tier: 'high', choices: [] },
    forged: [...state.forged, forged],
    deck: [
      ...state.deck.filter((card) => card.instanceId !== input.deckInstanceId),
      { instanceId: `${forged.id}#${state.nextCardSeq}`, definitionId: forged.id },
    ],
    nextCardSeq: state.nextCardSeq + 1,
    journal: [...state.journal, `两张牌合成了「${forged.name}」。`],
  };
}

/** 收下（或放弃）这一层的报酬，然后上一层。 */
function takeFavor(state: RunState, cardId: string | null, atMs: number): RunState {
  if (state.phase !== 'choosing_favor') return state;
  const offer = state.favor;
  if (!offer) return state;
  if (cardId !== null && !offer.choices.includes(cardId)) return state;

  const deck = cardId ? [...state.deck, mintCard(cardId, state.nextCardSeq)] : state.deck;
  const journal = [...state.journal];
  if (cardId) {
    journal.push(`你收下了「${cardById(state, cardId)?.name ?? cardId}」。`);
  }

  const player = state.encounter.player;
  const heal = offer.factionId ? FAVOR_HEAL[offer.tier] : 0;
  const healed = Math.min(player.maxHp, player.hp + heal);
  if (healed > player.hp) {
    const who = state.agents.find((a) => a.factionId === offer.factionId)?.name ?? '有人';
    journal.push(`${who}替你处理了伤口，恢复 ${healed - player.hp} 点生命。`);
  }

  return beginEncounter(
    { ...state, deck, journal, nextCardSeq: state.nextCardSeq + (cardId ? 1 : 0) },
    state.floor + 1,
    healed,
    atMs,
  );
}

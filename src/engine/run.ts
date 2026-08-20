import { createRng, nextInt, shuffle, type Rng } from './rng.js';
import { effectsOf } from './atoms.js';
import {
  dropRequests,
  expireRequests,
  fallbackIntent,
  openIntentRequests,
  receiveResponse,
} from './agents.js';
import { PLAYER_TARGET } from './types.js';
import {
  CARD_POOL,
  HAND_SIZE,
  MAX_ENERGY,
  PLAYER_MAX_HP,
  STARTING_DECK,
  builtInAgents,
  floorOneCombatants,
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
  Generation,
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
  const deck: readonly CardInstance[] = deckIds.map((id, index) => ({
    instanceId: `${id}#${index}`,
    definitionId: id,
  }));

  const [rngAfterShuffle, drawPile] = shuffle(createRng(seed), deck);
  const fresh: PlayerState = {
    hp: PLAYER_MAX_HP,
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

  const encounter: EncounterState = {
    turn: 1,
    phase: 'player_turn',
    player,
    combatants: floorOneCombatants(),
    pending: null,
    damageDealtTo: {},
    executionUsedThisTurn: false,
    lastGrade: null,
  };

  return openIntentRequests(
    {
      seed,
      rng,
      agents: builtInAgents(),
      agentRequests: [],
      nextRequestSeq: 0,
      floor: 1,
      phase: 'in_encounter',
      encounter,
      outcome: null,
      journal: [`进入${generation.title}的第 1 层。`],
    },
    startedAtMs,
  );
}

export function applyInput(state: RunState, input: PlayerInput): RunState {
  if (state.phase === 'ended') return state;

  switch (input.type) {
    case 'play_card':
      return playCard(state, input.instanceId, input.atMs, input.targetId);
    case 'end_turn':
      return endTurn(state, input.atMs);
    case 'execution_input':
      return resolvePending(state, input.atMs);
    case 'agent_response':
      return receiveResponse(state, input.requestId, input.payload);
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

export function definitionOf(state: RunState, instanceId: string): CardDefinition | undefined {
  const card =
    state.encounter.player.hand.find((c) => c.instanceId === instanceId) ??
    state.encounter.player.drawPile.find((c) => c.instanceId === instanceId) ??
    state.encounter.player.discardPile.find((c) => c.instanceId === instanceId);
  if (!card) return undefined;
  return CARD_POOL.find((d) => d.id === card.definitionId);
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

/**
 * 你这一场偏袒了谁：在场的 Faction 里，你打得最少的那个。打得一样多就没有偏袒。
 * #7 的 Favor 与 #8 的 Standing 都从这里读。
 */
export function favoredFaction(state: RunState): string | null {
  const present = new Set(state.encounter.combatants.map((c) => c.factionId));
  if (present.size < 2) return null;

  const scored = [...present]
    .map((factionId) => ({ factionId, damage: state.encounter.damageDealtTo[factionId] ?? 0 }))
    .sort((a, b) => a.damage - b.damage);

  const best = scored[0];
  const runnerUp = scored[1];
  if (!best || !runnerUp || best.damage === runnerUp.damage) return null;
  return best.factionId;
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

  // ADR-0002：需要实时输入的 Card 在这里把结算挂起，剩下的效果等输入回来再执行。
  // 每回合只挂起一次——同回合的后续 Card 直接结算。
  if (definition.execution && !encounter.executionUsedThisTurn) {
    return {
      ...state,
      journal,
      encounter: {
        ...encounter,
        player,
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

  return checkOutcome(
    discard(
      applyEffects({ ...state, journal, encounter: { ...encounter, player } }, effects),
      card,
    ),
  );
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
  const target = state.encounter.combatants.find((c) => c.id === targetId);
  if (!target) return state;

  const before = target.hp;
  const next = withCombatant(state, targetId, (combatant) => {
    let current = combatant;
    for (let i = 0; i < hits; i++) {
      if (current.hp <= 0) break;
      current = takeHit(current, amount, ignoreBlock);
    }
    return current;
  });

  const after = next.encounter.combatants.find((c) => c.id === targetId);
  const dealt = before - (after?.hp ?? before);
  if (dealt <= 0) return next;

  // 站队就记在这里：玩家打谁打得多，就是站在谁的对面。
  return {
    ...next,
    encounter: {
      ...next.encounter,
      damageDealtTo: {
        ...next.encounter.damageDealtTo,
        [target.factionId]: (next.encounter.damageDealtTo[target.factionId] ?? 0) + dealt,
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
    let after: CombatantState = { ...acted, statuses: { ...acted.statuses, weakened: false } };

    if (intent.targetId === PLAYER_TARGET) {
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
    combatants[targetIndex] = takeHit(target, raw, false);
    journal.push(
      `${combatant.name}攻向${target.name}，造成 ${before - (combatants[targetIndex]?.hp ?? before)} 点伤害。`,
    );
  }

  // 回合末结算灼烧。
  for (let i = 0; i < combatants.length; i++) {
    const combatant = combatants[i];
    if (!combatant || combatant.hp <= 0) continue;
    const { burn, burnTurns } = combatant.statuses;
    if (burn <= 0 || burnTurns <= 0) continue;

    const remaining = burnTurns - 1;
    combatants[i] = {
      ...combatant,
      hp: Math.max(0, combatant.hp - burn),
      statuses: { ...combatant.statuses, burnTurns: remaining, burn: remaining > 0 ? burn : 0 },
    };
    journal.push(`${combatant.name}被灼烧，受到 ${burn} 点伤害。`);
  }

  const afterCombatants = checkOutcome(
    dropRequests({ ...state, journal, encounter: { ...encounter, player, combatants } }),
  );
  if (afterCombatants.phase === 'ended') return afterCombatants;

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
    return {
      ...state,
      phase: 'ended',
      outcome: 'victory',
      agentRequests: [],
      encounter: { ...encounter, phase: 'ended', pending: null },
      journal: [
        ...state.journal,
        survivor ? `场上只剩下${survivor.name}这一方，它放你过去。` : '这一层清空了。',
      ],
    };
  }

  return state;
}

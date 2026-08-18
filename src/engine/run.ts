import { createRng, shuffle, type Rng } from './rng.js';
import {
  CARD_POOL,
  HAND_SIZE,
  INTENT_TIMEOUT_MS,
  MAX_ENERGY,
  PLAYER_MAX_HP,
  STARTING_DECK,
  floorOneCombatants,
} from './content.js';
import type {
  CardDefinition,
  CardInstance,
  CombatantAction,
  CombatantState,
  Effect,
  EncounterState,
  ExecutionGrade,
  ExecutionSpec,
  Generation,
  Intent,
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
  };
  const [rng, player] = draw(rngAfterShuffle, fresh, HAND_SIZE);

  const encounter: EncounterState = {
    turn: 1,
    phase: 'player_turn',
    player,
    combatants: floorOneCombatants(),
    pending: null,
    intentRequest: null,
    executionUsedThisTurn: false,
    lastGrade: null,
  };

  return openIntentRequest(
    {
      seed,
      rng,
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
    case 'intent_response':
      return receiveIntent(state, input.combatantId, input.payload);
    case 'tick':
      return expireIntent(expireIfWindowClosed(state, input.atMs), input.atMs);
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

function scaleEffects(effects: readonly Effect[], multiplier: number): readonly Effect[] {
  if (multiplier === 1) return effects;
  return effects.map((effect) => ({
    ...effect,
    amount: Math.round(effect.amount * multiplier),
  }));
}

// ---------------------------------------------------------------- Intent

/** 台词只是叙事，不能变成规则的入口，所以截断到一个安全长度。 */
const MAX_LINE_LENGTH = 40;

/**
 * 校验模型的原样响应（ADR-0001）。凡是不在合法动作集里的东西一律拒绝——
 * 引擎不去猜模型的意思，猜错的代价是玩家学不到规则。
 */
function parseIntent(payload: unknown, actions: readonly CombatantAction[]): Intent | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const record = payload as Record<string, unknown>;

  const actionId = record['actionId'];
  if (typeof actionId !== 'string') return null;
  if (!actions.some((action) => action.id === actionId)) return null;

  const line = record['line'];
  return {
    actionId,
    line: typeof line === 'string' ? line.slice(0, MAX_LINE_LENGTH) : '',
    source: 'agent',
  };
}

/**
 * 模型没能按时给出合法答案时，引擎替它选。规则简单且确定：血量掉到三分之一
 * 以下就自保，否则进攻。可玩性因此不依赖模型可用性（ADR-0001）。
 */
function fallbackIntent(combatant: CombatantState): Intent {
  const wantsDefend = combatant.hp * 3 <= combatant.maxHp;
  const preferred = combatant.actions.find(
    (action) => action.kind === (wantsDefend ? 'defend' : 'attack'),
  );
  const action = preferred ?? combatant.actions[0];
  return { actionId: action?.id ?? '', line: '', source: 'fallback' };
}

/** 若有 Agent 还没定下这一回合的行动，就挂出一个请求，等宿主去问模型。 */
function openIntentRequest(state: RunState, atMs: number): RunState {
  const encounter = state.encounter;
  if (state.phase === 'ended' || encounter.intentRequest) return state;

  const waiting = encounter.combatants.find((c) => c.hp > 0 && c.intent === null);
  if (!waiting) return state;

  return {
    ...state,
    encounter: {
      ...encounter,
      intentRequest: {
        combatantId: waiting.id,
        requestedAtMs: atMs,
        timeoutMs: INTENT_TIMEOUT_MS,
      },
    },
  };
}

function settleIntent(
  state: RunState,
  combatantId: string,
  intent: Intent,
  note: string,
): RunState {
  return {
    ...state,
    journal: [...state.journal, note],
    encounter: {
      ...state.encounter,
      intentRequest: null,
      combatants: state.encounter.combatants.map((c) =>
        c.id === combatantId ? { ...c, intent } : c,
      ),
    },
  };
}

function receiveIntent(state: RunState, combatantId: string, payload: unknown): RunState {
  const request = state.encounter.intentRequest;
  if (!request || request.combatantId !== combatantId) return state;

  const combatant = state.encounter.combatants.find((c) => c.id === combatantId);
  if (!combatant) return state;

  const parsed = parseIntent(payload, combatant.actions);
  if (parsed) return settleIntent(state, combatantId, parsed, `${combatant.name}打定了主意。`);

  return settleIntent(
    state,
    combatantId,
    fallbackIntent(combatant),
    `${combatant.name}没有给出合法的选择，凭本能行动。`,
  );
}

/** 请求超时：引擎替它选，Run 继续。没到点就原样返回同一个对象。 */
function expireIntent(state: RunState, atMs: number): RunState {
  const request = state.encounter.intentRequest;
  if (!request) return state;
  if (atMs - request.requestedAtMs < request.timeoutMs) return state;

  const combatant = state.encounter.combatants.find((c) => c.id === request.combatantId);
  if (!combatant) return state;

  return settleIntent(
    state,
    request.combatantId,
    fallbackIntent(combatant),
    `${combatant.name}等不及了，凭本能行动。`,
  );
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

  const player: PlayerState = {
    ...encounter.player,
    energy: encounter.player.energy - definition.cost,
    hand: encounter.player.hand.filter((c) => c.instanceId !== instanceId),
    discardPile: [...encounter.player.discardPile, card],
  };

  const target = targetId ?? livingCombatants(state)[0]?.id;
  const effects = effectsOf(definition, target);
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
          cardInstanceId: card.instanceId,
          spec: definition.execution,
          openedAtMs: atMs,
          remainingEffects: effects,
        },
      },
    };
  }

  return checkOutcome(
    applyEffects({ ...state, journal, encounter: { ...encounter, player } }, effects),
  );
}

function effectsOf(definition: CardDefinition, targetId: string | undefined): readonly Effect[] {
  const effects: Effect[] = [];
  if (definition.damage !== undefined && targetId !== undefined) {
    effects.push({ kind: 'damage', targetId, amount: definition.damage });
  }
  if (definition.block !== undefined) {
    effects.push({ kind: 'gain_block', amount: definition.block });
  }
  return effects;
}

function applyEffects(state: RunState, effects: readonly Effect[]): RunState {
  let encounter = state.encounter;

  for (const effect of effects) {
    if (effect.kind === 'gain_block') {
      encounter = {
        ...encounter,
        player: { ...encounter.player, block: encounter.player.block + effect.amount },
      };
      continue;
    }
    encounter = {
      ...encounter,
      combatants: encounter.combatants.map((combatant) =>
        combatant.id === effect.targetId ? takeHit(combatant, effect.amount) : combatant,
      ),
    };
  }

  return { ...state, encounter };
}

/** 格挡先吃伤害，剩下的进 HP。玩家和 Combatant 用的是同一套算法。 */
function absorb(block: number, amount: number): { block: number; dealt: number } {
  const absorbed = Math.min(block, amount);
  return { block: block - absorbed, dealt: amount - absorbed };
}

function takeHit(combatant: CombatantState, amount: number): CombatantState {
  const { block, dealt } = absorb(combatant.block, amount);
  return { ...combatant, block, hp: Math.max(0, combatant.hp - dealt) };
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
  return checkOutcome(applyEffects(resumed, scaleEffects(pending.remainingEffects, multiplier)));
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
    if (action.kind === 'attack') {
      const { block, dealt } = absorb(player.block, action.amount);
      player = { ...player, block, hp: Math.max(0, player.hp - dealt) };
      combatants[i] = acted;
      journal.push(`${combatant.name}${action.description}，造成 ${dealt} 点伤害。`);
    } else {
      combatants[i] = { ...acted, block: action.amount };
      journal.push(`${combatant.name}${action.description}。`);
    }
  }

  const afterCombatants = checkOutcome({
    ...state,
    journal,
    encounter: { ...encounter, player, combatants, intentRequest: null },
  });
  if (afterCombatants.phase === 'ended') return afterCombatants;

  const [rng, refreshed] = draw(
    afterCombatants.rng,
    { ...player, block: 0, energy: player.maxEnergy },
    HAND_SIZE,
  );

  return openIntentRequest(
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
      encounter: { ...encounter, phase: 'ended', pending: null, intentRequest: null },
      journal: [...state.journal, '你倒在了塔里。'],
    };
  }

  if (encounter.combatants.every((combatant) => combatant.hp <= 0)) {
    return {
      ...state,
      phase: 'ended',
      outcome: 'victory',
      encounter: { ...encounter, phase: 'ended', pending: null, intentRequest: null },
      journal: [...state.journal, '这一层清空了。'],
    };
  }

  return state;
}

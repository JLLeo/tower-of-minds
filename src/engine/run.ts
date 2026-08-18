import { createRng, shuffle, type Rng } from './rng.js';
import {
  CARD_POOL,
  HAND_SIZE,
  MAX_ENERGY,
  PLAYER_MAX_HP,
  STARTING_DECK,
  floorOneCombatants,
} from './content.js';
import type {
  CardDefinition,
  CardInstance,
  CombatantState,
  Effect,
  EncounterState,
  ExecutionGrade,
  ExecutionSpec,
  Generation,
  PlayerInput,
  PlayerState,
  RunOptions,
  RunState,
  ScriptedAction,
} from './types.js';

/**
 * Engine 的 Run 级公开接口，也是本仓库唯一的测试 seam。
 *
 * startRun 拿到初始状态，之后反复 applyInput 取回新状态。两者都是纯函数：
 * 同一 seed 加同一串输入必然得到同一个 Run。所有随机走 state.rng，所有时间
 * 从 input 进来——引擎自己既不掷骰也不读时钟。
 */
export function startRun(
  generation: Generation,
  seed: number,
  options: RunOptions = {},
): RunState {
  const deckIds = options.startingDeck ?? STARTING_DECK;
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
    executionUsedThisTurn: false,
    lastGrade: null,
  };

  return {
    seed,
    rng,
    cards: CARD_POOL,
    floor: 1,
    phase: 'in_encounter',
    encounter,
    outcome: null,
    journal: [`进入${generation.title}的第 1 层。`],
  };
}

export function applyInput(state: RunState, input: PlayerInput): RunState {
  if (state.phase === 'ended') return state;

  switch (input.type) {
    case 'play_card':
      return playCard(state, input.instanceId, input.atMs, input.targetId);
    case 'end_turn':
      return endTurn(state);
    case 'execution_input':
      return resumeExecution(state, input.atMs);
  }
}

// ---------------------------------------------------------------- Execution Check

/**
 * 判定窗口内的分档，按窗口长度的比例给出，与具体 Card Type 无关——
 * #5 的节奏连击与蓄力沿用同一套分档，只换窗口长度与操作方式。
 */
export const PERFECT_BAND = { start: 0.7, end: 0.85 } as const;
export const GOOD_BAND_START = 0.45;

/** Miss 只是打折，不反噬。 */
export const GRADE_MULTIPLIER: Record<ExecutionGrade, number> = {
  miss: 0.5,
  good: 1,
  perfect: 1.5,
};

const GRADE_LABEL: Record<ExecutionGrade, string> = {
  miss: '失手',
  good: '还行',
  perfect: '完美',
};

/**
 * 把输入时刻在窗口里的位置换成档位。窗口外（太早、或者根本没按）都算 Miss。
 * 计算归引擎，UI 只上报玩家按下的时刻。
 */
export function gradeFor(spec: ExecutionSpec, elapsedMs: number): ExecutionGrade {
  const progress = elapsedMs / spec.windowMs;
  if (progress >= PERFECT_BAND.start && progress < PERFECT_BAND.end) return 'perfect';
  if (progress >= GOOD_BAND_START && progress < 1) return 'good';
  return 'miss';
}

function scaleEffects(effects: readonly Effect[], multiplier: number): readonly Effect[] {
  if (multiplier === 1) return effects;
  return effects.map((effect) => {
    switch (effect.kind) {
      case 'gain_block':
        return { ...effect, amount: Math.round(effect.amount * multiplier) };
      case 'damage':
        return { ...effect, amount: Math.round(effect.amount * multiplier) };
    }
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
  return state.cards.find((d) => d.id === card.definitionId);
}

/** 现在是否轮到玩家出牌。 */
export function isPlayerActing(state: RunState): boolean {
  return state.phase === 'in_encounter' && state.encounter.phase === 'player_turn';
}

/** 这张手牌现在打不打得出去——能量、时机、牌是否还在手上，全部在这里判。 */
export function canPlay(state: RunState, instanceId: string): boolean {
  if (!isPlayerActing(state)) return false;
  if (!state.encounter.player.hand.some((c) => c.instanceId === instanceId)) return false;
  const definition = definitionOf(state, instanceId);
  return definition !== undefined && definition.cost <= state.encounter.player.energy;
}

export function livingCombatants(state: RunState): readonly CombatantState[] {
  return state.encounter.combatants.filter((c) => c.hp > 0);
}

// ---------------------------------------------------------------- 打牌

function playCard(
  state: RunState,
  instanceId: string,
  atMs: number,
  targetId?: string,
): RunState {
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
  // 每回合只挂起一次——同回合的后续 Card 直接结算，不再要求玩家做判定。
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

function resumeExecution(state: RunState, atMs: number): RunState {
  const encounter = state.encounter;
  const pending = encounter.pending;
  if (encounter.phase !== 'awaiting_execution' || !pending) return state;

  const grade = gradeFor(pending.spec, atMs - pending.openedAtMs);
  const multiplier = GRADE_MULTIPLIER[grade];

  const resumed: RunState = {
    ...state,
    journal: [...state.journal, `格挡时机：${GRADE_LABEL[grade]}（×${multiplier}）。`],
    encounter: { ...encounter, phase: 'player_turn', pending: null, lastGrade: grade },
  };
  return checkOutcome(applyEffects(resumed, scaleEffects(pending.remainingEffects, multiplier)));
}

// ---------------------------------------------------------------- 回合推进

function endTurn(state: RunState): RunState {
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

    const action = nextActionOf(combatant);
    // 上一轮攒下的 block 在它再次行动时清空。
    const advanced: CombatantState = {
      ...combatant,
      block: 0,
      scriptIndex: combatant.scriptIndex + 1,
    };

    if (!action) {
      combatants[i] = advanced;
      continue;
    }
    if (action.kind === 'attack') {
      const { block, dealt } = absorb(player.block, action.amount);
      player = { ...player, block, hp: Math.max(0, player.hp - dealt) };
      combatants[i] = advanced;
      journal.push(`${combatant.name}攻击，造成 ${dealt} 点伤害。`);
    } else {
      combatants[i] = { ...advanced, block: action.amount };
      journal.push(`${combatant.name}架起 ${action.amount} 点格挡。`);
    }
  }

  const afterFoes = checkOutcome({
    ...state,
    journal,
    encounter: { ...encounter, player, combatants },
  });
  if (afterFoes.phase === 'ended') return afterFoes;

  const [rng, refreshed] = draw(
    afterFoes.rng,
    { ...player, block: 0, energy: player.maxEnergy },
    HAND_SIZE,
  );

  return {
    ...afterFoes,
    rng,
    encounter: {
      ...afterFoes.encounter,
      turn: encounter.turn + 1,
      player: refreshed,
      executionUsedThisTurn: false,
      lastGrade: null,
    },
  };
}

function nextActionOf(combatant: CombatantState): ScriptedAction | undefined {
  return combatant.script[combatant.scriptIndex % combatant.script.length];
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
      encounter: { ...encounter, phase: 'ended', pending: null },
      journal: [...state.journal, '你倒在了塔里。'],
    };
  }

  if (encounter.combatants.every((combatant) => combatant.hp <= 0)) {
    return {
      ...state,
      phase: 'ended',
      outcome: 'victory',
      encounter: { ...encounter, phase: 'ended', pending: null },
      journal: [...state.journal, '这一层清空了。'],
    };
  }

  return state;
}

import { createRng, shuffle, type Rng } from './rng.js';
import {
  CARD_POOL,
  HAND_SIZE,
  MAX_ENERGY,
  PLAYER_MAX_HP,
  STARTING_DECK,
  floorOneFoes,
} from './content.js';
import type {
  CardDefinition,
  CardInstance,
  Effect,
  EncounterState,
  FoeState,
  Generation,
  PlayerInput,
  PlayerState,
  RunOptions,
  RunState,
} from './types.js';

/**
 * Engine 的 Run 级公开接口，也是本仓库唯一的测试 seam。
 *
 * 用法是 startRun 拿到初始状态，之后反复 applyInput 取回新状态。两者都是纯函数：
 * 同一 seed 加同一串输入必然得到同一个 Run。所有随机都走 state.rng。
 */
export function startRun(
  generation: Generation,
  seed: number,
  options: RunOptions = {},
): RunState {
  const cards = options.cards ?? CARD_POOL;
  const deckIds = options.startingDeck ?? STARTING_DECK;
  const deck: readonly CardInstance[] = deckIds.map((id, index) => ({
    instanceId: `${id}#${index}`,
    definitionId: id,
  }));

  const [rngAfterShuffle, drawPile] = shuffle(createRng(seed), deck);
  const empty: PlayerState = {
    hp: PLAYER_MAX_HP,
    maxHp: PLAYER_MAX_HP,
    block: 0,
    energy: MAX_ENERGY,
    maxEnergy: MAX_ENERGY,
    hand: [],
    drawPile,
    discardPile: [],
  };
  const [rng, player] = draw(rngAfterShuffle, empty, HAND_SIZE);

  const encounter: EncounterState = {
    turn: 1,
    phase: 'player_turn',
    player,
    foes: floorOneFoes(),
    pending: null,
  };

  return {
    seed,
    rng,
    cards,
    floor: 1,
    phase: 'in_encounter',
    encounter,
    outcome: null,
    log: [`进入${generation.title}的第 1 层。`],
  };
}

export function applyInput(state: RunState, input: PlayerInput): RunState {
  if (state.phase === 'ended') return state;

  switch (input.type) {
    case 'play_card':
      return playCard(state, input.instanceId, input.targetId);
    case 'end_turn':
      return endTurn(state);
    case 'execution_input':
      return resumeExecution(state);
  }
}

// ---------------------------------------------------------------- 打牌

function playCard(state: RunState, instanceId: string, targetId?: string): RunState {
  const encounter = state.encounter;
  if (encounter.phase !== 'player_turn') return state;

  const card = encounter.player.hand.find((c) => c.instanceId === instanceId);
  if (!card) return state;

  const definition = state.cards.find((d) => d.id === card.definitionId);
  if (!definition) return state;
  if (definition.cost > encounter.player.energy) return state;

  const player: PlayerState = {
    ...encounter.player,
    energy: encounter.player.energy - definition.cost,
    hand: encounter.player.hand.filter((c) => c.instanceId !== instanceId),
    discardPile: [...encounter.player.discardPile, card],
  };

  const target = targetId ?? encounter.foes.find((f) => f.hp > 0)?.id;
  const effects = effectsOf(definition, target);
  const log = [...state.log, `你打出「${definition.name}」。`];

  // ADR-0002：需要实时输入的 Card 在这里把结算挂起，剩下的效果等输入回来再执行。
  if (definition.execution) {
    return {
      ...state,
      log,
      encounter: {
        ...encounter,
        player,
        phase: 'awaiting_execution',
        pending: {
          cardInstanceId: card.instanceId,
          spec: definition.execution,
          remainingEffects: effects,
        },
      },
    };
  }

  return settle(applyEffects({ ...state, log, encounter: { ...encounter, player } }, effects));
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
      foes: encounter.foes.map((foe) =>
        foe.id === effect.targetId ? damageFoe(foe, effect.amount) : foe,
      ),
    };
  }

  return { ...state, encounter };
}

function damageFoe(foe: FoeState, amount: number): FoeState {
  const absorbed = Math.min(foe.block, amount);
  return {
    ...foe,
    block: foe.block - absorbed,
    hp: Math.max(0, foe.hp - (amount - absorbed)),
  };
}

// ---------------------------------------------------------------- 结算挂起的恢复

function resumeExecution(state: RunState): RunState {
  const encounter = state.encounter;
  const pending = encounter.pending;
  if (encounter.phase !== 'awaiting_execution' || !pending) return state;

  // Execution Grade 与倍率在 #3 落地；这里先按原值结算，只验证挂起与恢复的通路。
  const resumed: RunState = {
    ...state,
    encounter: { ...encounter, phase: 'player_turn', pending: null },
  };
  return settle(applyEffects(resumed, pending.remainingEffects));
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
  const foes = [...encounter.foes];
  const log = [...state.log];

  for (let i = 0; i < foes.length; i++) {
    const foe = foes[i];
    if (!foe || foe.hp <= 0) continue;

    const action = foe.script[foe.scriptIndex % foe.script.length];
    // 上一轮攒下的 block 在它再次行动时清空。
    const advanced: FoeState = { ...foe, block: 0, scriptIndex: foe.scriptIndex + 1 };

    if (!action) {
      foes[i] = advanced;
      continue;
    }
    if (action.kind === 'attack') {
      const absorbed = Math.min(player.block, action.amount);
      const dealt = action.amount - absorbed;
      player = { ...player, block: player.block - absorbed, hp: Math.max(0, player.hp - dealt) };
      foes[i] = advanced;
      log.push(`${foe.name}攻击，造成 ${dealt} 点伤害。`);
    } else {
      foes[i] = { ...advanced, block: action.amount };
      log.push(`${foe.name}架起 ${action.amount} 点格挡。`);
    }
  }

  const afterFoes = settle({ ...state, log, encounter: { ...encounter, player, foes } });
  if (afterFoes.phase === 'ended') return afterFoes;

  const [rng, refreshed] = draw(
    afterFoes.rng,
    { ...player, block: 0, energy: player.maxEnergy },
    HAND_SIZE,
  );

  return {
    ...afterFoes,
    rng,
    encounter: { ...afterFoes.encounter, turn: encounter.turn + 1, player: refreshed },
  };
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

function settle(state: RunState): RunState {
  const encounter = state.encounter;
  if (encounter.phase === 'ended') return state;

  if (encounter.player.hp <= 0) {
    return {
      ...state,
      phase: 'ended',
      outcome: 'defeat',
      encounter: { ...encounter, phase: 'ended', pending: null },
      log: [...state.log, '你倒在了塔里。'],
    };
  }

  if (encounter.foes.every((foe) => foe.hp <= 0)) {
    return {
      ...state,
      phase: 'ended',
      outcome: 'victory',
      encounter: { ...encounter, phase: 'ended', pending: null },
      log: [...state.log, '这一层清空了。'],
    };
  }

  return state;
}

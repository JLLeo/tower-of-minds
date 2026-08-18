import { describe, expect, it } from 'vitest';
import { applyInput, canPlay, definitionOf, startRun } from './run.js';
import { BUILT_IN_GENERATION, CARD_POOL, STARTING_DECK } from './content.js';
import type { CardDefinition, PlayerInput, RunState } from './types.js';

const SEED = 20260818;

/** 脚本化的输入时刻：真人按键的替身，每次输入推进一点。 */
function clock(): () => number {
  let now = 0;
  return () => (now += 100);
}

/** 贪心策略：能打就打第一张打得出的牌，打不动就结束回合。用于生成一串输入。 */
function scriptInputs(start: RunState, maxSteps = 500): PlayerInput[] {
  const at = clock();
  let state = start;
  const inputs: PlayerInput[] = [];

  for (let i = 0; i < maxSteps && state.phase === 'in_encounter'; i++) {
    if (state.encounter.phase !== 'player_turn') break;
    const playable = state.encounter.player.hand.find((c) => canPlay(state, c.instanceId));
    const input: PlayerInput = playable
      ? { type: 'play_card', instanceId: playable.instanceId, atMs: at() }
      : { type: 'end_turn' };
    inputs.push(input);
    state = applyInput(state, input);
  }
  return inputs;
}

function run(inputs: readonly PlayerInput[], options?: Parameters<typeof startRun>[2]): RunState {
  let state = startRun(BUILT_IN_GENERATION, SEED, options);
  for (const input of inputs) state = applyInput(state, input);
  return state;
}

describe('startRun', () => {
  it('把玩家放进第 1 层的 Encounter，手牌抽满', () => {
    const state = startRun(BUILT_IN_GENERATION, SEED);

    expect(state.floor).toBe(1);
    expect(state.phase).toBe('in_encounter');
    expect(state.outcome).toBeNull();
    expect(state.encounter.phase).toBe('player_turn');
    expect(state.encounter.turn).toBe(1);
    expect(state.encounter.player.hand).toHaveLength(5);
    expect(state.encounter.player.drawPile).toHaveLength(STARTING_DECK.length - 5);
    expect(state.encounter.combatants).toHaveLength(1);
    expect(state.encounter.combatants[0]?.hp).toBeGreaterThan(0);
  });

  it('同一 seed 得到同一个起手局面', () => {
    expect(startRun(BUILT_IN_GENERATION, SEED)).toEqual(startRun(BUILT_IN_GENERATION, SEED));
  });
});

describe('Card 循环', () => {
  it('打出一张牌会扣能量、离开手牌、进入弃牌堆', () => {
    const state = startRun(BUILT_IN_GENERATION, SEED);
    const card = state.encounter.player.hand[0];
    expect(card).toBeDefined();
    const definition = definitionOf(state, card!.instanceId);
    expect(definition).toBeDefined();

    const next = applyInput(state, {
      type: 'play_card',
      instanceId: card!.instanceId,
      atMs: 100,
    });

    expect(next.encounter.player.hand).toHaveLength(4);
    expect(next.encounter.player.discardPile.map((c) => c.instanceId)).toContain(card!.instanceId);
    expect(next.encounter.player.energy).toBe(state.encounter.player.energy - definition!.cost);
  });

  it('能量不够时打牌不改变状态', () => {
    let state = startRun(BUILT_IN_GENERATION, SEED);
    const at = clock();
    while (state.encounter.phase === 'player_turn') {
      const playable = state.encounter.player.hand.find((c) => canPlay(state, c.instanceId));
      if (!playable) break;
      state = applyInput(state, {
        type: 'play_card',
        instanceId: playable.instanceId,
        atMs: at(),
      });
    }

    const leftover = state.encounter.player.hand[0];
    expect(leftover).toBeDefined();
    expect(canPlay(state, leftover!.instanceId)).toBe(false);
    expect(
      applyInput(state, { type: 'play_card', instanceId: leftover!.instanceId, atMs: at() }),
    ).toEqual(state);
  });

  it('结束回合会弃掉手牌并重新抽满', () => {
    const state = startRun(BUILT_IN_GENERATION, SEED);
    const next = applyInput(state, { type: 'end_turn' });

    expect(next.encounter.turn).toBe(2);
    expect(next.encounter.player.hand).toHaveLength(5);
    expect(next.encounter.player.energy).toBe(next.encounter.player.maxEnergy);
    expect(next.encounter.player.block).toBe(0);
  });

  it('抽牌堆抽空后会把弃牌堆洗回来，牌的总数不变', () => {
    let state = startRun(BUILT_IN_GENERATION, SEED);
    for (let i = 0; i < 3 && state.phase === 'in_encounter'; i++) {
      state = applyInput(state, { type: 'end_turn' });
    }

    expect(state.encounter.player.hand).toHaveLength(5);
    expect(
      state.encounter.player.hand.length +
        state.encounter.player.drawPile.length +
        state.encounter.player.discardPile.length,
    ).toBe(STARTING_DECK.length);
  });
});

describe('脚本化对手', () => {
  it('回合结束后按脚本第一项攻击玩家', () => {
    const state = startRun(BUILT_IN_GENERATION, SEED);
    const firstAction = state.encounter.combatants[0]?.script[0];
    expect(firstAction?.kind).toBe('attack');

    const next = applyInput(state, { type: 'end_turn' });

    const expected = firstAction?.kind === 'attack' ? firstAction.amount : 0;
    expect(next.encounter.player.hp).toBe(state.encounter.player.hp - expected);
    expect(next.encounter.combatants[0]?.scriptIndex).toBe(1);
  });
});

describe('完整一场', () => {
  it('用固定 seed 与一串脚本化输入跑到 Run 结束并取胜', () => {
    const inputs = scriptInputs(startRun(BUILT_IN_GENERATION, SEED));
    const state = run(inputs);

    expect(state.phase).toBe('ended');
    expect(state.outcome).toBe('victory');
    expect(state.encounter.phase).toBe('ended');
    expect(state.encounter.combatants.every((c) => c.hp <= 0)).toBe(true);
    expect(state.encounter.player.hp).toBeGreaterThan(0);
  });

  it('同一 seed 加同一串输入必然得到同一个 Run', () => {
    const inputs = scriptInputs(startRun(BUILT_IN_GENERATION, SEED));
    expect(run(inputs)).toEqual(run(inputs));
  });

  it('Run 结束后再喂输入不再改变状态', () => {
    const state = run(scriptInputs(startRun(BUILT_IN_GENERATION, SEED)));
    expect(applyInput(state, { type: 'end_turn' })).toEqual(state);
  });
});

describe('结算挂起（ADR-0002）', () => {
  const timingShield: CardDefinition = {
    id: 'timing-guard',
    name: '时机格挡',
    type: 'shield',
    cost: 1,
    block: 8,
    execution: { windowMs: 900 },
  };
  const options = {
    cards: [...CARD_POOL, timingShield],
    startingDeck: Array.from({ length: 10 }, () => timingShield.id),
  };

  function suspended(): RunState {
    const state = startRun(BUILT_IN_GENERATION, SEED, options);
    const card = state.encounter.player.hand[0];
    return applyInput(state, { type: 'play_card', instanceId: card!.instanceId, atMs: 100 });
  }

  it('打出需要实时输入的 Card 会把结算挂起，并记下窗口开启的时刻', () => {
    const state = suspended();

    expect(state.encounter.phase).toBe('awaiting_execution');
    expect(state.encounter.pending?.spec.windowMs).toBe(900);
    expect(state.encounter.pending?.openedAtMs).toBe(100);
    expect(state.encounter.player.block).toBe(0); // 效果尚未落地
  });

  it('输入时刻能被引擎定位进窗口', () => {
    const resumed = applyInput(suspended(), { type: 'execution_input', atMs: 420 });

    // 判定窗口到 Execution Grade 的计算归引擎（#3 落地倍率），这里先验证
    // 时刻确实到得了引擎手里：420 - 100 = 320。
    expect(resumed.journal.at(-1)).toBe('窗口开启后 320ms 完成输入。');
    expect(resumed.encounter.phase).toBe('player_turn');
    expect(resumed.encounter.pending).toBeNull();
    expect(resumed.encounter.player.block).toBe(8);
  });

  it('挂起状态可以序列化、还原并继续推进', () => {
    const state = suspended();
    const restored = JSON.parse(JSON.stringify(state)) as RunState;

    expect(restored).toEqual(state);
    expect(applyInput(restored, { type: 'execution_input', atMs: 420 })).toEqual(
      applyInput(state, { type: 'execution_input', atMs: 420 }),
    );
  });

  it('挂起期间不接受打牌输入', () => {
    const state = suspended();
    const other = state.encounter.player.hand[0];

    expect(
      applyInput(state, { type: 'play_card', instanceId: other!.instanceId, atMs: 200 }),
    ).toEqual(state);
  });

  it('每回合只挂起一次，同回合的后续 Card 直接结算', () => {
    const resumed = applyInput(suspended(), { type: 'execution_input', atMs: 420 });
    expect(resumed.encounter.executionUsedThisTurn).toBe(true);

    const second = resumed.encounter.player.hand[0];
    const next = applyInput(resumed, {
      type: 'play_card',
      instanceId: second!.instanceId,
      atMs: 500,
    });

    expect(next.encounter.phase).toBe('player_turn');
    expect(next.encounter.pending).toBeNull();
    expect(next.encounter.player.block).toBe(16); // 8 + 8，第二张直接落地
  });

  it('新回合重新允许一次挂起', () => {
    const resumed = applyInput(suspended(), { type: 'execution_input', atMs: 420 });
    const nextTurn = applyInput(resumed, { type: 'end_turn' });
    expect(nextTurn.encounter.executionUsedThisTurn).toBe(false);

    const card = nextTurn.encounter.player.hand[0];
    const next = applyInput(nextTurn, {
      type: 'play_card',
      instanceId: card!.instanceId,
      atMs: 900,
    });

    expect(next.encounter.phase).toBe('awaiting_execution');
    expect(next.encounter.pending?.openedAtMs).toBe(900);
  });
});

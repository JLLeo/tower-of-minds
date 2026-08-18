import { describe, expect, it } from 'vitest';
import { GRADE_MULTIPLIER, applyInput, canPlay, definitionOf, gradeFor, startRun } from './run.js';
import { BUILT_IN_GENERATION, STARTING_DECK } from './content.js';
import type { PlayerInput, RunOptions, RunState } from './types.js';

const SEED = 20260818;

const ALL_GUARDS: RunOptions = { startingDeck: Array.from({ length: 10 }, () => 'guard') };
const ALL_STRIKES: RunOptions = { startingDeck: Array.from({ length: 10 }, () => 'strike') };

/** 脚本化的输入时刻：真人按键的替身。 */
function clock(): () => number {
  let now = 0;
  return () => (now += 100);
}

/** 在窗口里的某个相对位置按下。0.75 落在 Perfect 区，0.2 落在窗口太早的一侧。 */
function pressAt(state: RunState, progress: number): PlayerInput {
  const pending = state.encounter.pending;
  if (!pending) throw new Error('没有挂起的结算');
  return { type: 'execution_input', atMs: pending.openedAtMs + pending.spec.windowMs * progress };
}

/** 贪心策略：能打就打，挂起就用完美时机接上，打不动就结束回合。 */
function scriptInputs(start: RunState, maxSteps = 500): PlayerInput[] {
  const at = clock();
  let state = start;
  const inputs: PlayerInput[] = [];

  for (let i = 0; i < maxSteps && state.phase === 'in_encounter'; i++) {
    let input: PlayerInput;
    if (state.encounter.phase === 'awaiting_execution') {
      input = pressAt(state, 0.75);
    } else {
      const playable = state.encounter.player.hand.find((c) => canPlay(state, c.instanceId));
      input = playable
        ? { type: 'play_card', instanceId: playable.instanceId, atMs: at() }
        : { type: 'end_turn' };
    }
    inputs.push(input);
    state = applyInput(state, input);
  }
  return inputs;
}

function run(inputs: readonly PlayerInput[], options?: RunOptions): RunState {
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
    const state = startRun(BUILT_IN_GENERATION, SEED, ALL_STRIKES);
    const card = state.encounter.player.hand[0];
    const definition = definitionOf(state, card!.instanceId);
    expect(definition).toBeDefined();

    const next = applyInput(state, { type: 'play_card', instanceId: card!.instanceId, atMs: 100 });

    expect(next.encounter.player.hand).toHaveLength(4);
    expect(next.encounter.player.discardPile.map((c) => c.instanceId)).toContain(card!.instanceId);
    expect(next.encounter.player.energy).toBe(state.encounter.player.energy - definition!.cost);
  });

  it('能量不够时打牌不改变状态', () => {
    let state = startRun(BUILT_IN_GENERATION, SEED, ALL_STRIKES);
    const at = clock();
    for (let i = 0; i < 3; i++) {
      const playable = state.encounter.player.hand.find((c) => canPlay(state, c.instanceId));
      state = applyInput(state, {
        type: 'play_card',
        instanceId: playable!.instanceId,
        atMs: at(),
      });
    }

    expect(state.encounter.player.energy).toBe(0);
    const leftover = state.encounter.player.hand[0];
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
    const state = run(scriptInputs(startRun(BUILT_IN_GENERATION, SEED)));

    expect(state.phase).toBe('ended');
    expect(state.outcome).toBe('victory');
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

describe('Execution Check：挂起与恢复（ADR-0002）', () => {
  function suspended(): RunState {
    const state = startRun(BUILT_IN_GENERATION, SEED, ALL_GUARDS);
    const card = state.encounter.player.hand[0];
    return applyInput(state, { type: 'play_card', instanceId: card!.instanceId, atMs: 100 });
  }

  it('打出盾牌类 Card 会挂起结算，并记下窗口开启的时刻', () => {
    const state = suspended();

    expect(state.encounter.phase).toBe('awaiting_execution');
    expect(state.encounter.pending?.openedAtMs).toBe(100);
    expect(state.encounter.pending?.spec.windowMs).toBe(900);
    expect(state.encounter.player.block).toBe(0); // 效果尚未落地
  });

  it('挂起状态可以序列化、还原并继续推进', () => {
    const state = suspended();
    const restored = JSON.parse(JSON.stringify(state)) as RunState;

    expect(restored).toEqual(state);
    expect(applyInput(restored, pressAt(state, 0.75))).toEqual(
      applyInput(state, pressAt(state, 0.75)),
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
    const resumed = applyInput(suspended(), pressAt(suspended(), 0.75));
    expect(resumed.encounter.executionUsedThisTurn).toBe(true);

    const second = resumed.encounter.player.hand[0];
    const next = applyInput(resumed, {
      type: 'play_card',
      instanceId: second!.instanceId,
      atMs: 500,
    });

    expect(next.encounter.phase).toBe('player_turn');
    expect(next.encounter.pending).toBeNull();
    // 第一张完美 8 点，第二张不再判定、按原值 5 点
    expect(next.encounter.player.block).toBe(13);
  });

  it('新回合重新允许一次挂起', () => {
    const resumed = applyInput(suspended(), pressAt(suspended(), 0.75));
    const nextTurn = applyInput(resumed, { type: 'end_turn' });
    expect(nextTurn.encounter.executionUsedThisTurn).toBe(false);
    expect(nextTurn.encounter.lastGrade).toBeNull();

    const card = nextTurn.encounter.player.hand[0];
    const next = applyInput(nextTurn, {
      type: 'play_card',
      instanceId: card!.instanceId,
      atMs: 5000,
    });

    expect(next.encounter.phase).toBe('awaiting_execution');
    expect(next.encounter.pending?.openedAtMs).toBe(5000);
  });
});

describe('Execution Check：档位与倍率', () => {
  const spec = { windowMs: 1000 };

  it('按窗口内的位置分出三档', () => {
    expect(gradeFor(spec, 100)).toBe('miss'); // 太早
    expect(gradeFor(spec, 500)).toBe('good');
    expect(gradeFor(spec, 750)).toBe('perfect');
    expect(gradeFor(spec, 900)).toBe('good'); // 过了完美区但还在窗口内
    expect(gradeFor(spec, 1200)).toBe('miss'); // 窗口外
  });

  it('完全不按等同于窗口耗尽，算 Miss', () => {
    expect(gradeFor(spec, spec.windowMs)).toBe('miss');
  });

  it('Miss 只是打折，仍然给出格挡', () => {
    expect(GRADE_MULTIPLIER.miss).toBeGreaterThan(0);
    expect(GRADE_MULTIPLIER.miss).toBeLessThan(GRADE_MULTIPLIER.good);
  });

  function blockAfter(progress: number): RunState {
    const state = startRun(BUILT_IN_GENERATION, SEED, ALL_GUARDS);
    const card = state.encounter.player.hand[0];
    const suspended = applyInput(state, {
      type: 'play_card',
      instanceId: card!.instanceId,
      atMs: 0,
    });
    return applyInput(suspended, pressAt(suspended, progress));
  }

  it('三档对格挡强度的影响各不相同', () => {
    const miss = blockAfter(0.1);
    const good = blockAfter(0.5);
    const perfect = blockAfter(0.75);

    expect(miss.encounter.lastGrade).toBe('miss');
    expect(good.encounter.lastGrade).toBe('good');
    expect(perfect.encounter.lastGrade).toBe('perfect');

    // 基础格挡 5：失手 3、还行 5、完美 8
    expect(miss.encounter.player.block).toBe(3);
    expect(good.encounter.player.block).toBe(5);
    expect(perfect.encounter.player.block).toBe(8);
    expect(miss.encounter.player.block).toBeGreaterThan(0);
  });

  it('窗口耗尽（完全不按）仍然结算，只是按 Miss 打折', () => {
    const expired = blockAfter(1.5);

    expect(expired.encounter.phase).toBe('player_turn');
    expect(expired.encounter.lastGrade).toBe('miss');
    expect(expired.encounter.player.block).toBe(3);
  });
});

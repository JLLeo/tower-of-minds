import { describe, expect, it } from 'vitest';
import { applyInput, startRun } from './run.js';
import { BUILT_IN_GENERATION, CARD_POOL, STARTING_DECK } from './content.js';
import type { CardDefinition, PlayerInput, RunState } from './types.js';

const SEED = 20260818;

function cardDef(state: RunState, instanceId: string): CardDefinition | undefined {
  const inst = state.encounter.player.hand.find((c) => c.instanceId === instanceId);
  if (!inst) return undefined;
  return state.cards.find((d) => d.id === inst.definitionId);
}

/** 贪心策略：能打就打第一张打得起的牌，打不动就结束回合。用于驱动完整一场。 */
function playToTheEnd(start: RunState, maxSteps = 500): { state: RunState; inputs: PlayerInput[] } {
  let state = start;
  const inputs: PlayerInput[] = [];
  for (let i = 0; i < maxSteps && state.phase === 'in_encounter'; i++) {
    if (state.encounter.phase !== 'player_turn') break;
    const playable = state.encounter.player.hand.find((c) => {
      const def = cardDef(state, c.instanceId);
      return def !== undefined && def.cost <= state.encounter.player.energy;
    });
    const input: PlayerInput = playable
      ? { type: 'play_card', instanceId: playable.instanceId }
      : { type: 'end_turn' };
    inputs.push(input);
    state = applyInput(state, input);
  }
  return { state, inputs };
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
    expect(state.encounter.foes).toHaveLength(1);
    expect(state.encounter.foes[0]?.hp).toBeGreaterThan(0);
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
    const def = cardDef(state, card!.instanceId);
    expect(def).toBeDefined();

    const next = applyInput(state, { type: 'play_card', instanceId: card!.instanceId });

    expect(next.encounter.player.hand).toHaveLength(4);
    expect(next.encounter.player.discardPile.map((c) => c.instanceId)).toContain(card!.instanceId);
    expect(next.encounter.player.energy).toBe(state.encounter.player.energy - def!.cost);
  });

  it('能量不够时打牌不改变状态', () => {
    const state = startRun(BUILT_IN_GENERATION, SEED);
    const expensive = state.cards.find((d) => d.cost > state.encounter.player.maxEnergy);
    expect(expensive).toBeUndefined(); // 本票卡池没有超过满能量的牌

    // 打光能量后，任何还打得起 cost 的牌都不该再生效
    let drained = state;
    while (drained.encounter.player.energy > 0 && drained.encounter.phase === 'player_turn') {
      const next = drained.encounter.player.hand.find((c) => {
        const def = cardDef(drained, c.instanceId);
        return def !== undefined && def.cost <= drained.encounter.player.energy;
      });
      if (!next) break;
      drained = applyInput(drained, { type: 'play_card', instanceId: next.instanceId });
    }
    const leftover = drained.encounter.player.hand[0];
    if (!leftover) return;

    expect(applyInput(drained, { type: 'play_card', instanceId: leftover.instanceId })).toEqual(
      drained,
    );
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
    const firstAction = state.encounter.foes[0]?.script[0];
    expect(firstAction?.kind).toBe('attack');

    const next = applyInput(state, { type: 'end_turn' });

    const expectedDamage = firstAction?.kind === 'attack' ? firstAction.amount : 0;
    expect(next.encounter.player.hp).toBe(state.encounter.player.hp - expectedDamage);
    expect(next.encounter.foes[0]?.scriptIndex).toBe(1);
  });
});

describe('完整一场', () => {
  it('用固定 seed 与脚本化输入跑到 Run 结束并取胜', () => {
    const { state } = playToTheEnd(startRun(BUILT_IN_GENERATION, SEED));

    expect(state.phase).toBe('ended');
    expect(state.outcome).toBe('victory');
    expect(state.encounter.phase).toBe('ended');
    expect(state.encounter.foes.every((f) => f.hp <= 0)).toBe(true);
    expect(state.encounter.player.hp).toBeGreaterThan(0);
  });

  it('同一 seed 加同一串输入必然得到同一个 Run', () => {
    const first = playToTheEnd(startRun(BUILT_IN_GENERATION, SEED));

    let replay = startRun(BUILT_IN_GENERATION, SEED);
    for (const input of first.inputs) replay = applyInput(replay, input);

    expect(replay).toEqual(first.state);
  });

  it('Run 结束后再喂输入不再改变状态', () => {
    const { state } = playToTheEnd(startRun(BUILT_IN_GENERATION, SEED));
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
    execution: { kind: 'block_timing', windowMs: 900 },
  };
  const options = {
    cards: [...CARD_POOL, timingShield],
    startingDeck: Array.from({ length: 10 }, () => timingShield.id),
  };

  it('打出需要实时输入的 Card 会把结算挂起', () => {
    const state = startRun(BUILT_IN_GENERATION, SEED, options);
    const card = state.encounter.player.hand[0];
    const next = applyInput(state, { type: 'play_card', instanceId: card!.instanceId });

    expect(next.encounter.phase).toBe('awaiting_execution');
    expect(next.encounter.pending?.cardInstanceId).toBe(card!.instanceId);
    expect(next.encounter.pending?.spec.windowMs).toBe(900);
    expect(next.encounter.player.block).toBe(0); // 效果尚未落地
  });

  it('挂起状态可以序列化、还原并继续推进', () => {
    const state = startRun(BUILT_IN_GENERATION, SEED, options);
    const card = state.encounter.player.hand[0];
    const suspended = applyInput(state, { type: 'play_card', instanceId: card!.instanceId });

    const restored = JSON.parse(JSON.stringify(suspended)) as RunState;
    expect(restored).toEqual(suspended);

    const resumed = applyInput(restored, { type: 'execution_input', atMs: 420 });

    expect(resumed.encounter.phase).toBe('player_turn');
    expect(resumed.encounter.pending).toBeNull();
    expect(resumed.encounter.player.block).toBe(8);
  });

  it('挂起期间不接受打牌输入', () => {
    const state = startRun(BUILT_IN_GENERATION, SEED, options);
    const card = state.encounter.player.hand[0];
    const suspended = applyInput(state, { type: 'play_card', instanceId: card!.instanceId });
    const other = suspended.encounter.player.hand[0];

    expect(applyInput(suspended, { type: 'play_card', instanceId: other!.instanceId })).toEqual(
      suspended,
    );
  });
});

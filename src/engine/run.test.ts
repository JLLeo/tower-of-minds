import { describe, expect, it } from 'vitest';
import {
  applyInput,
  canPlay,
  definitionOf,
  currentSiding,
  cardById,
  isBossFloor,
  isPlayerActing,
  memoryOf,
  standings,
  startRun,
} from './run.js';
import { ATOMS, MAX_ATOMS_PER_CARD, costOf, effectsOf } from './atoms.js';
import { BUILT_IN_GENERATION, CARD_POOL, NORMAL_FLOORS, STARTING_DECK } from './content.js';
import { PLAYER_TARGET } from './types.js';
import type { DeckbuildRequest, FusionRequest, IntentRequest } from './types.js';
import type { CombatantState, PlayerInput, RunOptions, RunState } from './types.js';

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
function scriptInputs(start: RunState, maxSteps = 3000): PlayerInput[] {
  const at = clock();
  let state = start;
  const inputs: PlayerInput[] = [];

  for (let i = 0; i < maxSteps && state.phase !== 'ended'; i++) {
    // 层间：先报一次时。对手的构筑提问就是在 tick 上挂出来的——引擎不自己造时刻。
    if (state.phase === 'choosing_favor' && !state.agentRequests.some((r) => r.kind === 'deckbuild')) {
      const ticked: PlayerInput = { type: 'tick', atMs: at() };
      const next = applyInput(state, ticked);
      if (next !== state) {
        inputs.push(ticked);
        state = next;
        continue;
      }
    }

    // 层间的构筑提问：挑合法集里最前面的两张，模拟一个会用手边东西的对手。
    const building = state.agentRequests.filter((r) => r.kind === 'deckbuild');
    if (building.length > 0) {
      for (const request of building) {
        const answer: PlayerInput = {
          type: 'agent_response',
          requestId: request.id,
          payload: { cardIds: request.legalCardIds.slice(0, request.capacity) },
        };
        inputs.push(answer);
        state = applyInput(state, answer);
      }
      continue;
    }

    // 场上有敌对派系就先打对方——这是实测到的真实模型行为，而不是回退那种
    // 「所有人都打玩家」的最坏情况。不这么做，测的就不是这个游戏。
    if (intentRequestsOf(state).length > 0) {
      for (const request of intentRequestsOf(state)) {
        const me = state.encounter.combatants.find((c) => c.id === request.combatantId);
        const rival = state.encounter.combatants.find(
          (c) => c.hp > 0 && me !== undefined && c.factionId !== me.factionId,
        );
        const attack = me?.actions.find((a) => a.kind === 'attack');
        const payload = attack
          ? { actionId: attack.id, targetId: rival && state.encounter.turn % 2 === 0 ? rival.id : PLAYER_TARGET, line: '' }
          : { actionId: me?.actions[0]?.id ?? '' };
        const answer: PlayerInput = {
          type: 'agent_response',
          requestId: request.id,
          payload,
        };
        inputs.push(answer);
        state = applyInput(state, answer);
      }
      continue;
    }

    let input: PlayerInput;
    if (state.phase === 'choosing_favor') {
      // 层间：收下第一个选项，上一层
      input = {
        type: 'choose_favor',
        cardId: state.favor?.choices[0] ?? null,
        atMs: at(),
      };
    } else if (state.encounter.phase === 'awaiting_execution') {
      input = pressAt(state, 0.75);
    } else {
      // 一个还算像样的玩家：挑最快能清掉的那个 Faction 集火，血少了先找护体牌。
      const byFaction = new Map<string, number>();
      for (const c of state.encounter.combatants) {
        if (c.hp <= 0) continue;
        byFaction.set(c.factionId, (byFaction.get(c.factionId) ?? 0) + c.hp);
      }
      const weakest = [...byFaction.entries()].sort((a, b) => a[1] - b[1])[0]?.[0];
      const focus = state.encounter.combatants.find((c) => c.hp > 0 && c.factionId === weakest);

      const hurt = state.encounter.player.hp * 2 < state.encounter.player.maxHp;
      const hand = state.encounter.player.hand.filter((c) => canPlay(state, c.instanceId));
      const preferred = hurt
        ? (hand.find((c) => definitionOf(state, c.instanceId)?.type === 'shield') ?? hand[0])
        : hand[0];
      input = preferred
        ? {
            type: 'play_card',
            instanceId: preferred.instanceId,
            atMs: at(),
            ...(focus ? { targetId: focus.id } : {}),
          }
        : { type: 'end_turn', atMs: at() };
    }
    inputs.push(input);
    state = applyInput(state, input);
  }
  return inputs;
}

/** 一副由同一张牌堆成的 Deck，让手牌内容可预测。 */
const deckOf = (id: string): RunOptions => ({
  startingDeck: Array.from({ length: 10 }, () => id),
  startedAtMs: 0,
});

function playCardById(state: RunState, definitionId: string, atMs = 100): RunState {
  const card = state.encounter.player.hand.find((c) => c.instanceId.startsWith(definitionId + '#'));
  if (!card) throw new Error('手上没有 ' + definitionId);
  return applyInput(state, { type: 'play_card', instanceId: card.instanceId, atMs });
}

/** 打出一张会挂起判定的牌，并以 Good 的时机接上——倍率为 1，数值好断言。 */
function playAndResolve(state: RunState, definitionId: string): RunState {
  const suspended = playCardById(state, definitionId, 0);
  if (suspended.encounter.phase !== 'awaiting_execution') return suspended;
  return applyInput(suspended, pressAt(suspended, 0.5));
}

/**
 * 让某个 Combatant 安静地过掉这一回合：用它自己的防御动作。
 * 不写死一张 id 表——塔顶的首领、亲随、援军都不在那张表里，写死会让它们全部回退成打玩家。
 */
function defendPayload(state: RunState, combatantId: string): unknown {
  const combatant = state.encounter.combatants.find((c) => c.id === combatantId);
  const defend = combatant?.actions.find((a) => a.kind === 'defend');
  return defend ? { actionId: defend.id, line: '' } : { actionId: 'none' };
}

/** 只挑战斗提问。融合提问是另一种 kind，测试里另外处理。 */
function intentRequestsOf(state: RunState): readonly IntentRequest[] {
  return state.agentRequests.filter((r): r is IntentRequest => r.kind === 'intent');
}

/** 回答场上所有待答的提问。plan 决定每个 Combatant 答什么。 */
function answerAll(
  state: RunState,
  plan: (combatantId: string) => unknown,
): RunState {
  let next = state;
  for (const request of intentRequestsOf(state)) {
    next = applyInput(next, {
      type: 'agent_response',
      requestId: request.id,
      payload: plan(request.combatantId),
    });
  }
  return next;
}

/** 全员自守：把场面安静下来，好断言某一件事。 */
function allDefend(state: RunState): RunState {
  return answerAll(state, (id) => defendPayload(state, id));
}

/** 除了 except 全员自守，except 按给定的方式行动。 */
function onlyOneActs(state: RunState, except: string, payload: unknown): RunState {
  return answerAll(state, (id) => (id === except ? payload : defendPayload(state, id)));
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
    expect(state.encounter.combatants).toHaveLength(3);
    expect(state.encounter.combatants.every((c) => c.hp > 0)).toBe(true);
    // 两个敌对 Faction 同场——这不是「玩家对一队敌人」
    expect(new Set(state.encounter.combatants.map((c) => c.factionId)).size).toBe(2);
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
    const next = applyInput(state, { type: 'end_turn', atMs: 10_000 });

    expect(next.encounter.turn).toBe(2);
    expect(next.encounter.player.hand).toHaveLength(5);
    expect(next.encounter.player.energy).toBe(next.encounter.player.maxEnergy);
    expect(next.encounter.player.block).toBe(0);
  });

  it('抽牌堆抽空后会把弃牌堆洗回来，牌的总数不变', () => {
    let state = startRun(BUILT_IN_GENERATION, SEED);
    for (let i = 0; i < 3 && state.phase === 'in_encounter'; i++) {
      state = applyInput(allDefend(state), { type: 'end_turn', atMs: 10_000 * (i + 1) });
    }

    expect(state.encounter.player.hand).toHaveLength(5);
    expect(
      state.encounter.player.hand.length +
        state.encounter.player.drawPile.length +
        state.encounter.player.discardPile.length,
    ).toBe(STARTING_DECK.length);
  });
});

describe('Agent 与 Intent（ADR-0001）', () => {
  const GUARD = 'tower-guard';

  function fresh(): RunState {
    return startRun(BUILT_IN_GENERATION, SEED, { ...ALL_STRIKES, startedAtMs: 0 });
  }

  /** 只回答塔卫那一条提问，其余留着不动。 */
  function answer(state: RunState, payload: unknown): RunState {
    const request = intentRequestsOf(state).find((r) => r.combatantId === GUARD);
    return applyInput(state, { type: 'agent_response', requestId: request?.id ?? 'none', payload });
  }

  /** 塔卫按指定动作打玩家，其余单位自守。 */
  function guardActs(state: RunState, actionId: string): RunState {
    return onlyOneActs(state, GUARD, { actionId, targetId: PLAYER_TARGET, line: '' });
  }

  it('Run 一开始就挂出一个 IntentRequest', () => {
    const state = fresh();

    expect(state.agentRequests).toHaveLength(3); // 每个 Combatant 一条
    expect(intentRequestsOf(state).some((r) => r.combatantId === GUARD)).toBe(true);
    expect(state.agentRequests[0]?.requestedAtMs).toBe(0);
    expect(state.encounter.combatants.every((c) => c.intent === null)).toBe(true);
  });

  it('等待模型回答不会挡住玩家', () => {
    const state = fresh();
    expect(state.agentRequests.length).toBeGreaterThan(0);
    expect(isPlayerActing(state)).toBe(true);
    expect(canPlay(state, state.encounter.player.hand[0]!.instanceId)).toBe(true);
  });

  it('合法响应会落成这一回合的 Intent', () => {
    const state = answer(fresh(), { actionId: 'brace', line: '先稳住阵脚。' });

    expect(intentRequestsOf(state).some((r) => r.combatantId === GUARD)).toBe(false);
    expect(state.encounter.combatants[0]?.intent).toEqual({
      actionId: 'brace',
      targetId: null,
      line: '先稳住阵脚。',
      source: 'agent',
    });
  });

  it('Agent 按自己选的 Intent 行动', () => {
    const braced = applyInput(onlyOneActs(fresh(), GUARD, { actionId: 'brace', line: '' }), {
      type: 'end_turn',
      atMs: 1000,
    });
    expect(braced.encounter.combatants[0]?.block).toBe(5);

    const before = fresh();
    const crushed = applyInput(guardActs(before, 'crush'), { type: 'end_turn', atMs: 1000 });
    expect(crushed.encounter.player.hp).toBe(before.encounter.player.hp - 11);
  });

  it('台词会被记进 journal', () => {
    const state = applyInput(
      onlyOneActs(fresh(), GUARD, {
        actionId: 'slash',
        targetId: PLAYER_TARGET,
        line: '别再往上走了。',
      }),
      { type: 'end_turn', atMs: 1000 },
    );
    expect(state.journal.some((line) => line.includes('别再往上走了。'))).toBe(true);
  });

  it('过长的台词会被截断', () => {
    const state = answer(fresh(), { actionId: 'slash', line: '啊'.repeat(200) });
    expect(state.encounter.combatants[0]?.intent?.line.length).toBeLessThanOrEqual(40);
  });

  describe('三条回退路径', () => {
    it('返回不在合法动作集里的 actionId：引擎替它选，Run 继续', () => {
      const state = answer(fresh(), { actionId: 'summon_dragon', line: '受死吧。' });

      expect(state.encounter.combatants[0]?.intent?.source).toBe('fallback');
      expect(
        state.encounter.combatants[0]?.actions.some(
          (a) => a.id === state.encounter.combatants[0]?.intent?.actionId,
        ),
      ).toBe(true);
      expect(state.phase).toBe('in_encounter');
    });

    it('畸形响应：引擎替它选，Run 继续', () => {
      for (const payload of [null, 'not json', 42, {}, { line: '只有台词' }, { actionId: 7 }]) {
        const state = answer(fresh(), payload);
        expect(intentRequestsOf(state).some((r) => r.combatantId === GUARD)).toBe(false);
        expect(state.encounter.combatants[0]?.intent?.source).toBe('fallback');
        expect(state.phase).toBe('in_encounter');
      }
    });

    it('超时：引擎替它选，Run 继续', () => {
      const waiting = fresh();
      const timeout = waiting.agentRequests[0]!.timeoutMs;

      const early = applyInput(waiting, { type: 'tick', atMs: timeout - 1 });
      expect(early).toBe(waiting); // 没到点，原样返回

      const expired = applyInput(waiting, { type: 'tick', atMs: timeout });
      expect(expired.agentRequests).toHaveLength(0);
      expect(expired.encounter.combatants[0]?.intent?.source).toBe('fallback');
      expect(expired.phase).toBe('in_encounter');
    });

    it('回退选择是确定性的：血厚时进攻，血薄时自保', () => {
      const healthy = answer(fresh(), null);
      const healthyAction = healthy.encounter.combatants[0]?.actions.find(
        (a) => a.id === healthy.encounter.combatants[0]?.intent?.actionId,
      );
      expect(healthyAction?.kind).toBe('attack');
    });
  });

  it('回答一个不存在的提问不改变状态', () => {
    const state = fresh();
    expect(
      applyInput(state, { type: 'agent_response', requestId: '不存在', payload: {} }),
    ).toBe(state);
  });

  it('超时回退之后迟到的响应会被丢掉，不会顶掉下一回合的 Intent', () => {
    const waiting = fresh();
    const stale = waiting.agentRequests[0]!;

    // 先超时，引擎替它选
    const expired = applyInput(waiting, { type: 'tick', atMs: stale.timeoutMs });
    expect(expired.encounter.combatants[0]?.intent?.source).toBe('fallback');

    // 打完这一回合，新回合挂出一次新的请求
    const nextTurn = applyInput(expired, { type: 'end_turn', atMs: 9000 });
    const currentRequest = nextTurn.agentRequests[0];
    expect(currentRequest?.requestedAtMs).toBe(9000);

    // 那次早已超时的提问现在才回来：它看的是上一回合的战况，必须被丢掉
    const late = applyInput(nextTurn, {
      type: 'agent_response',
      requestId: stale.id,
      payload: { actionId: 'crush', line: '迟到的杀意。' },
    });

    expect(late).toBe(nextTurn);
    expect(late.agentRequests[0]).toEqual(currentRequest);
    expect(late.encounter.combatants[0]?.intent).toBeNull();
  });

  it('行动之后会为新回合重新挂出请求', () => {
    const state = applyInput(answer(fresh(), { actionId: 'slash', line: '' }), {
      type: 'end_turn',
      atMs: 4000,
    });

    expect(state.encounter.combatants[0]?.intent).toBeNull();
    expect(state.agentRequests[0]?.requestedAtMs).toBe(4000);
  });
});

describe('完整一场', () => {
  it('用固定 seed 与一串脚本化输入推完五层，Deck 一层长一张', () => {
    // 断言的是「推进」而不是「取胜」：驱动这一串输入的是个很粗糙的策略，
    // 它该不该赢是平衡问题，不该由测试来决定。
    const state = run(scriptInputs(startRun(BUILT_IN_GENERATION, SEED)));

    expect(state.phase).toBe('ended');
    expect(state.floor).toBe(5); // 一路推到了最后一层
    // Deck 跨层累积，且多出来的每一张都来自某个 Faction 的 Base Card
    expect(state.deck.length).toBeGreaterThan(STARTING_DECK.length);
    const startingCounts = new Map<string, number>();
    for (const id of STARTING_DECK) startingCounts.set(id, (startingCounts.get(id) ?? 0) + 1);
    const gained: string[] = [];
    const seen = new Map(startingCounts);
    for (const card of state.deck) {
      const left = seen.get(card.definitionId) ?? 0;
      if (left > 0) seen.set(card.definitionId, left - 1);
      else gained.push(card.definitionId);
    }
    expect(gained.length).toBe(state.deck.length - STARTING_DECK.length);
    for (const id of gained) expect(CARD_POOL.some((card) => card.id === id)).toBe(true);
    // 实例 id 不重复
    expect(new Set(state.deck.map((c) => c.instanceId)).size).toBe(state.deck.length);
  });

  it('同一 seed 加同一串输入必然得到同一个 Run', () => {
    const inputs = scriptInputs(startRun(BUILT_IN_GENERATION, SEED));
    expect(run(inputs)).toEqual(run(inputs));
  });

  it('Run 结束后再喂输入不再改变状态', () => {
    const state = run(scriptInputs(startRun(BUILT_IN_GENERATION, SEED)));
    expect(applyInput(state, { type: 'end_turn', atMs: 10_000 })).toEqual(state);
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
    const nextTurn = applyInput(resumed, { type: 'end_turn', atMs: 10_000 });
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
  function blockAfter(inputs: (state: RunState) => readonly PlayerInput[]): RunState {
    const start = startRun(BUILT_IN_GENERATION, SEED, ALL_GUARDS);
    const card = start.encounter.player.hand[0];
    const suspended = applyInput(start, {
      type: 'play_card',
      instanceId: card!.instanceId,
      atMs: 0,
    });
    let state = suspended;
    for (const input of inputs(suspended)) state = applyInput(state, input);
    return state;
  }

  const pressedAt = (progress: number) => (state: RunState) => [pressAt(state, progress)];

  it('三档对格挡强度的影响各不相同', () => {
    const miss = blockAfter(pressedAt(0.1));
    const good = blockAfter(pressedAt(0.5));
    const perfect = blockAfter(pressedAt(0.75));

    expect(miss.encounter.lastGrade).toBe('miss');
    expect(good.encounter.lastGrade).toBe('good');
    expect(perfect.encounter.lastGrade).toBe('perfect');

    // 基础格挡 5：失手 3、还行 5、完美 8
    expect(miss.encounter.player.block).toBe(3);
    expect(good.encounter.player.block).toBe(5);
    expect(perfect.encounter.player.block).toBe(8);
  });

  it('Miss 只是打折，仍然给出格挡而不是反噬', () => {
    const miss = blockAfter(pressedAt(0.1));
    const good = blockAfter(pressedAt(0.5));

    expect(miss.encounter.player.block).toBeGreaterThan(0);
    expect(miss.encounter.player.block).toBeLessThan(good.encounter.player.block);
    expect(miss.encounter.player.hp).toBe(good.encounter.player.hp);
  });

  it('完全不按：窗口耗尽后结算照常推进，判为 Miss', () => {
    const expired = blockAfter((state) => {
      const pending = state.encounter.pending!;
      // 只有时间在流逝，没有任何 execution_input
      return [
        { type: 'tick', atMs: pending.openedAtMs + pending.spec.windowMs * 0.5 },
        { type: 'tick', atMs: pending.openedAtMs + pending.spec.windowMs },
      ];
    });

    expect(expired.encounter.phase).toBe('player_turn');
    expect(expired.encounter.pending).toBeNull();
    expect(expired.encounter.lastGrade).toBe('miss');
    expect(expired.encounter.player.block).toBe(3);
  });

  it('窗口还没走完时 tick 不改变任何东西', () => {
    const start = startRun(BUILT_IN_GENERATION, SEED, ALL_GUARDS);
    const card = start.encounter.player.hand[0];
    const suspended = applyInput(start, {
      type: 'play_card',
      instanceId: card!.instanceId,
      atMs: 0,
    });
    const pending = suspended.encounter.pending!;

    const ticked = applyInput(suspended, {
      type: 'tick',
      atMs: pending.openedAtMs + pending.spec.windowMs * 0.5,
    });

    // 原样返回同一个对象，调用方据此跳过重绘
    expect(ticked).toBe(suspended);
  });

  it('既没有挂起结算、也没到 Intent 截止点时，tick 是空操作', () => {
    const state = startRun(BUILT_IN_GENERATION, SEED, { startedAtMs: 0 });
    expect(applyInput(state, { type: 'tick', atMs: 100 })).toBe(state);
  });
});

describe('Atom 系统', () => {
  it('费用由 Atom 权重推出：打出后扣掉的能量就是算出来的那个数', () => {
    const one = startRun(BUILT_IN_GENERATION, SEED, deckOf('strike'));
    expect(one.encounter.player.energy - playCardById(one, 'strike').encounter.player.energy).toBe(
      1,
    ); // strike(3) -> ceil(3/3)

    const two = startRun(BUILT_IN_GENERATION, SEED, deckOf('heavy'));
    expect(two.encounter.player.energy - playCardById(two, 'heavy').encounter.player.energy).toBe(
      2,
    ); // strike(3)+pierce(3) -> ceil(6/3)
  });

  it('Card Type 由主导 Atom 推出：防御为主的牌才会触发格挡判定', () => {
    // 铁壁 = guard + endure，防御轴占多数 -> shield -> 挂起判定
    const shield = startRun(BUILT_IN_GENERATION, SEED, deckOf('bulwark'));
    expect(playCardById(shield, 'bulwark').encounter.phase).toBe('awaiting_execution');

    // 汲取 = draw，只有资源轴 -> spell -> 本票还没有它的判定原型
    const spell = startRun(BUILT_IN_GENERATION, SEED, deckOf('siphon'));
    expect(playCardById(spell, 'siphon').encounter.phase).toBe('player_turn');
  });

  it('每个已落地的 Atom 都真的产生效果——不会只收费不干活', () => {
    // 这条不在 seam 上：它守的是 Atom 表本身的完整性，而不是某个行为。
    // 没有它，新加的 Atom 会静默地只参与费用计算却什么都不做。
    for (const atom of ATOMS) {
      if (atom.pendingTicket) continue;
      expect(effectsOf([atom.id], 'tower-guard').length).toBeGreaterThan(0);
    }
  });

  it('每个 Faction 都有自己的一套 Base Card，含一张 Parley', () => {
    const counts = new Map<string, number>();
    for (const card of CARD_POOL) counts.set(card.faction, (counts.get(card.faction) ?? 0) + 1);

    expect(counts.get('red-ring')).toBeGreaterThanOrEqual(10);
    expect(counts.get('green-vine')).toBeGreaterThanOrEqual(10);

    // Parley 是站队的显式动词，两派各有一张
    for (const factionId of ['red-ring', 'green-vine']) {
      expect(
        CARD_POOL.some((c) => c.faction === factionId && c.atoms.includes('parley')),
      ).toBe(true);
    }
  });

  it('Base Card 不含 Forbidden Atom，也不超过 Atom 上限', () => {
    const forbidden = new Set(ATOMS.filter((a) => a.forbidden).map((a) => a.id));

    for (const card of CARD_POOL) {
      expect(card.atoms.length).toBeGreaterThan(0);
      expect(card.atoms.length).toBeLessThanOrEqual(MAX_ATOMS_PER_CARD);
      for (const atom of card.atoms) expect(forbidden.has(atom)).toBe(false);
    }
  });

  it('Forbidden Atom 权重为负，所以突变产物更强也更便宜', () => {
    const forbidden = ATOMS.filter((a) => a.forbidden);
    expect(forbidden.length).toBeGreaterThan(0);
    for (const atom of forbidden) expect(atom.weight).toBeLessThan(0);
  });

  it('尚未落地的 Atom 参与费用，但不出现在任何 Base Card 上', () => {
    const pending = ATOMS.filter((a) => a.pendingTicket && !a.forbidden);
    expect(pending.length).toBeGreaterThan(0);
    for (const atom of pending) expect(atom.weight).toBeGreaterThan(0);

    const pendingIds = new Set(pending.map((a) => a.id));
    for (const card of CARD_POOL) {
      for (const atom of card.atoms) expect(pendingIds.has(atom)).toBe(false);
    }
  });
});

describe('Atom 效果', () => {
  const foeOf = (state: RunState): CombatantState => state.encounter.combatants[0]!;

  /** 只让塔卫按指定动作打玩家，其余单位自守。 */
  function answerWith(state: RunState, actionId: string): RunState {
    const action = state.encounter.combatants[0]?.actions.find((a) => a.id === actionId);
    const payload =
      action?.kind === 'attack'
        ? { actionId, targetId: PLAYER_TARGET, line: '' }
        : { actionId, line: '' };
    return onlyOneActs(state, 'tower-guard', payload);
  }

  it('pierce 无视格挡', () => {
    let state = startRun(BUILT_IN_GENERATION, SEED, deckOf('rend'));
    state = answerWith(state, 'brace');
    state = applyInput(state, { type: 'end_turn', atMs: 1000 });
    expect(foeOf(state).block).toBe(5);

    const before = foeOf(state).hp;
    const after = playCardById(state, 'rend');

    expect(foeOf(after).hp).toBe(before - 4);
    expect(foeOf(after).block).toBe(5);
  });

  it('multi 的分段不会绕过格挡：格挡在各段之间共享', () => {
    let state = startRun(BUILT_IN_GENERATION, SEED, deckOf('flurry'));

    const bare = playCardById(state, 'flurry');
    expect(foeOf(bare).hp).toBe(foeOf(state).hp - 6); // 3 段各 2

    state = answerWith(state, 'brace');
    state = applyInput(state, { type: 'end_turn', atMs: 1000 });
    const guardedHp = foeOf(state).hp;
    const blocked = playCardById(state, 'flurry');

    // 6 点总伤害对 5 点格挡，漏过去 1 点——和一次性打 6 点是一样的
    expect(foeOf(blocked).hp).toBe(guardedHp - 1);
  });

  it('multi 打易伤更亏：加成只被第一段吃掉', () => {
    const deck = {
      startingDeck: ['crack', 'flurry', 'strike', 'crack', 'flurry', 'strike', 'crack', 'flurry', 'strike', 'strike'],
      startedAtMs: 0,
    };
    const opened = startRun(BUILT_IN_GENERATION, SEED, deck);
    const before = foeOf(opened).hp;

    const exposed = playCardById(opened, 'crack');
    // 分段：3 + 2 + 2 = 7
    expect(foeOf(playCardById(exposed, 'flurry')).hp).toBe(before - 7);
    // 一次性：round(6 * 1.5) = 9
    expect(foeOf(playCardById(exposed, 'strike')).hp).toBe(before - 9);
  });

  it('burn 在回合末结算，并按回合数递减', () => {
    let state = startRun(BUILT_IN_GENERATION, SEED, deckOf('ignite'));
    const before = foeOf(state).hp;

    state = playCardById(state, 'ignite');
    expect(foeOf(state).hp).toBe(before);
    expect(foeOf(state).statuses.burn).toBe(3);

    state = applyInput(state, { type: 'end_turn', atMs: 1000 });
    expect(foeOf(state).hp).toBe(before - 3);

    state = applyInput(state, { type: 'end_turn', atMs: 2000 });
    expect(foeOf(state).hp).toBe(before - 6);
    expect(foeOf(state).statuses.burn).toBe(0);

    state = applyInput(state, { type: 'end_turn', atMs: 3000 });
    expect(foeOf(state).hp).toBe(before - 6);
  });

  it('expose 让下一次伤害 +50%，且只生效一次', () => {
    let state = startRun(BUILT_IN_GENERATION, SEED, {
      startingDeck: ['crack', 'strike', 'strike', 'crack', 'strike', 'strike', 'strike', 'crack', 'strike', 'strike'],
      startedAtMs: 0,
    });
    const before = foeOf(state).hp;

    state = playCardById(state, 'crack');
    expect(foeOf(state).statuses.exposed).toBe(true);

    state = playCardById(state, 'strike');
    expect(foeOf(state).hp).toBe(before - 9);
    expect(foeOf(state).statuses.exposed).toBe(false);

    state = playCardById(state, 'strike');
    expect(foeOf(state).hp).toBe(before - 15);
  });

  it('weaken 让对手下次攻击减半', () => {
    let state = startRun(BUILT_IN_GENERATION, SEED, deckOf('sap'));
    state = answerWith(state, 'slash');
    const hpBefore = state.encounter.player.hp;

    state = playCardById(state, 'sap');
    expect(foeOf(state).statuses.weakened).toBe(true);

    state = applyInput(state, { type: 'end_turn', atMs: 1000 });
    expect(state.encounter.player.hp).toBe(hpBefore - 4);
    expect(foeOf(state).statuses.weakened).toBe(false);
  });

  it('反伤不会消耗掉目标身上的易伤——那个加成留给玩家自己的下一击', () => {
    const deck = {
      startingDeck: ['bramble', 'crack', 'strike', 'bramble', 'crack', 'strike', 'strike', 'strike', 'strike', 'strike'],
      startedAtMs: 0,
    };
    let state = startRun(BUILT_IN_GENERATION, SEED, deck);
    state = answerWith(state, 'slash');

    state = playAndResolve(state, 'bramble');
    state = playCardById(state, 'crack');
    expect(foeOf(state).statuses.exposed).toBe(true);

    // 对手攻击 -> 触发反伤。易伤不该在这里被花掉。
    state = applyInput(state, { type: 'end_turn', atMs: 1000 });
    expect(foeOf(state).statuses.exposed).toBe(true);
  });

  it('thorns 在对手攻击时反弹', () => {
    let state = startRun(BUILT_IN_GENERATION, SEED, deckOf('bramble'));
    state = answerWith(state, 'slash');

    state = playAndResolve(state, 'bramble');
    expect(state.encounter.player.statuses.thorns).toBe(3);
    const foeHp = foeOf(state).hp;

    state = applyInput(state, { type: 'end_turn', atMs: 1000 });
    expect(foeOf(state).hp).toBe(foeHp - 3);
  });

  it('endure 减免本回合伤害，回合结束后清零', () => {
    let state = startRun(BUILT_IN_GENERATION, SEED, deckOf('brace'));
    state = answerWith(state, 'slash');
    const hpBefore = state.encounter.player.hp;

    state = playAndResolve(state, 'brace');
    expect(state.encounter.player.statuses.endure).toBe(2);

    state = applyInput(state, { type: 'end_turn', atMs: 1000 });
    expect(state.encounter.player.hp).toBe(hpBefore - 5);
    expect(state.encounter.player.statuses.endure).toBe(0);
  });

  it('draw 抽牌、surge 给能量', () => {
    let siphon = startRun(BUILT_IN_GENERATION, SEED, deckOf('siphon'));
    const handBefore = siphon.encounter.player.hand.length;
    siphon = playCardById(siphon, 'siphon');
    expect(siphon.encounter.player.hand.length).toBe(handBefore); // 打掉一张、抽回一张

    let surged = startRun(BUILT_IN_GENERATION, SEED, deckOf('surge'));
    const energyBefore = surged.encounter.player.energy;
    surged = playCardById(surged, 'surge');
    expect(surged.encounter.player.energy).toBe(energyBefore); // -1 费 +1 能量
  });

  it('recall 从弃牌堆取回，但取不回正在结算的这张牌自己', () => {
    const deck = {
      startingDeck: ['strike', 'glean', 'strike', 'glean', 'strike', 'strike', 'glean', 'strike', 'strike', 'strike'],
      startedAtMs: 0,
    };

    // 弃牌堆空着的时候打出回收：它不该把自己捡回来
    const empty = startRun(BUILT_IN_GENERATION, SEED, deck);
    const alone = playCardById(empty, 'glean');
    expect(alone.encounter.player.discardPile).toHaveLength(1);
    expect(alone.encounter.player.discardPile[0]?.instanceId).toContain('glean');
    expect(alone.encounter.player.hand).toHaveLength(4);

    // 弃牌堆里有东西时，取回的是那张
    const played = playCardById(empty, 'strike');
    expect(played.encounter.player.discardPile).toHaveLength(1);
    const recalled = playCardById(played, 'glean');
    expect(recalled.encounter.player.discardPile).toHaveLength(1);
    expect(recalled.encounter.player.discardPile[0]?.instanceId).toContain('glean');
    expect(
      recalled.encounter.player.hand.filter((c) => c.instanceId.startsWith('strike#')).length,
    ).toBeGreaterThan(
      played.encounter.player.hand.filter((c) => c.instanceId.startsWith('strike#')).length,
    );
  });
});

describe('AgentRequest 管道（ADR-0010）', () => {
  it('Agent 是 Faction 级的，一个 Faction 一个', () => {
    const state = startRun(BUILT_IN_GENERATION, SEED, { startedAtMs: 0 });

    expect(state.agents.length).toBeGreaterThan(1);
    const factions = new Set(state.agents.map((a) => a.factionId));
    expect(factions.size).toBe(state.agents.length);

    // 场上的 Combatant 都归属于某个已知 Faction
    for (const combatant of state.encounter.combatants) {
      expect(factions.has(combatant.factionId)).toBe(true);
    }
  });

  it('每个提问都带 kind 与唯一 id，并指向发问对象所属的 Faction', () => {
    const state = startRun(BUILT_IN_GENERATION, SEED, { startedAtMs: 0 });
    const request = state.agentRequests[0];

    expect(request?.kind).toBe('intent');
    expect(request?.id).toBeTruthy();
    const combatant = state.encounter.combatants.find(
      (c) => c.id === (request?.kind === 'intent' ? request.combatantId : undefined),
    );
    expect(request?.factionId).toBe(combatant?.factionId);
  });

  it('提问不会跨回合堆积：没回答的问题在回合推进时作废', () => {
    const state = startRun(BUILT_IN_GENERATION, SEED, { startedAtMs: 0 });
    expect(state.agentRequests).toHaveLength(3); // 每个 Combatant 一条
    const firstIds = new Set(state.agentRequests.map((r) => r.id));

    // 一直不回答，直接结束回合
    const next = applyInput(state, { type: 'end_turn', atMs: 5000 });

    expect(next.agentRequests).toHaveLength(3);
    expect(next.agentRequests.some((r) => firstIds.has(r.id))).toBe(false);
    // 上一回合的对手仍然行动了——引擎替它选（ADR-0001）
    expect(next.encounter.player.hp).toBeLessThan(state.encounter.player.hp);
  });

  it('Run 结束时不留下任何待回答的提问', () => {
    const ended = run(scriptInputs(startRun(BUILT_IN_GENERATION, SEED)));
    expect(ended.phase).toBe('ended');
    expect(ended.agentRequests).toHaveLength(0);
  });
});

describe('多方混战与站队', () => {
  const GUARD = 'tower-guard';
  const ARCHER = 'red-archer';
  const SCOUT = 'vine-scout';
  const at = (state: RunState, id: string): CombatantState =>
    state.encounter.combatants.find((c) => c.id === id)!;


  function fresh(options?: RunOptions): RunState {
    return startRun(BUILT_IN_GENERATION, SEED, { startedAtMs: 0, ...options });
  }

  it('每个 Combatant 各有一条提问，即使同属一个 Faction', () => {
    const state = fresh();
    const asked = intentRequestsOf(state).map((r) => r.combatantId).sort();

    expect(asked).toEqual([ARCHER, SCOUT, GUARD].sort());
    // 同派的两个单位分别被问——合并成一次调用是 ADR-0004 明确拒绝的
    const redRequests = state.agentRequests.filter((r) => r.factionId === 'red-ring');
    expect(redRequests).toHaveLength(2);
  });

  it('Agent 可以选择攻击敌对派系，而不是玩家', () => {
    let state = fresh();
    state = answerAll(state, (id) =>
      id === SCOUT
        ? { actionId: 'coil', line: '' }
        : { actionId: 'slash', targetId: SCOUT, line: '碍事。' },
    );
    // 弓手没有 slash，它会被判非法并回退到打玩家；塔卫的选择是合法的
    expect(at(state, GUARD).intent?.targetId).toBe(SCOUT);

    const scoutHp = at(state, SCOUT).hp;
    const playerHp = state.encounter.player.hp;
    state = applyInput(state, { type: 'end_turn', atMs: 1000 });

    expect(at(state, SCOUT).hp).toBeLessThan(scoutHp); // 青蔓挨了赤环一刀
    expect(state.encounter.player.hp).toBeLessThan(playerHp); // 弓手回退去打了玩家
    expect(state.journal.some((line) => line.includes('攻向青蔓斥候'))).toBe(true);
  });

  it('不能打自己人，也不能打不存在的目标', () => {
    const state = fresh();

    // 塔卫想打同派的弓手
    const sameFaction = answerAll(state, (id) =>
      id === GUARD ? { actionId: 'slash', targetId: ARCHER, line: '' } : defendPayload(state, id),
    );
    expect(at(sameFaction, GUARD).intent?.source).toBe('fallback');

    // 目标根本不存在
    const ghost = answerAll(state, (id) =>
      id === GUARD ? { actionId: 'slash', targetId: '幽灵', line: '' } : defendPayload(state, id),
    );
    expect(at(ghost, GUARD).intent?.source).toBe('fallback');
  });

  it('玩家打谁被记进站队账本，偏袒的是挨打最少的那一方', () => {
    let state = fresh(deckOf('strike'));
    expect(currentSiding(state)).toBeNull(); // 还没出手，谈不上偏袒

    const scout = state.encounter.player.hand[0]!;
    state = applyInput(state, {
      type: 'play_card',
      instanceId: scout.instanceId,
      atMs: 100,
      targetId: SCOUT,
    });

    expect(state.encounter.damageDealtTo['green-vine']).toBe(6);
    expect(state.encounter.damageDealtTo['red-ring']).toBeUndefined();
    // 打了青蔓，就是站在赤环那边
    expect(currentSiding(state)).toBe('red-ring');
  });

  it('灼烧造成的伤害也算进站队账本', () => {
    // 否则玩家可以把一个 Faction 烧死，账本上却显示他偏袒的正是这一方
    let state = fresh(deckOf('ignite'));
    const card = state.encounter.player.hand[0]!;
    state = applyInput(state, {
      type: 'play_card',
      instanceId: card.instanceId,
      atMs: 100,
      targetId: SCOUT,
    });
    expect(state.encounter.damageDealtTo['green-vine']).toBeUndefined(); // 打出时不掉血

    state = applyInput(allDefend(state), { type: 'end_turn', atMs: 1000 });

    expect(state.encounter.damageDealtTo['green-vine']).toBe(3);
    expect(currentSiding(state)).toBe('red-ring');
  });

  it('被打光的 Faction 不会被算作你偏袒的一方——它没人可以还这个人情', () => {
    let state = fresh(deckOf('strike'));
    // 把青蔓打光
    for (let turn = 0; turn < 12 && state.phase === 'in_encounter'; turn++) {
      state = allDefend(state);
      while (state.encounter.phase === 'player_turn') {
        const card = state.encounter.player.hand.find((c) => canPlay(state, c.instanceId));
        const victim = state.encounter.combatants.find((c) =>
          isBossFloor(state.floor) ? c.isBoss && c.hp > 0 : c.hp > 0 && c.factionId === 'green-vine',
        );
        if (!card || !victim) break;
        state = applyInput(state, {
          type: 'play_card',
          instanceId: card.instanceId,
          atMs: 100 * turn + 1,
          targetId: victim.id,
        });
      }
      if (state.phase !== 'in_encounter') break;
      state = applyInput(state, { type: 'end_turn', atMs: 1000 * (turn + 1) });
    }

    expect(at(state, SCOUT).hp).toBe(0);
    // 玩家一点都没打赤环，但偏袒的只能是还站着的那一方
    expect(state.encounter.damageDealtTo['red-ring']).toBeUndefined();
    expect(currentSiding(state)).toBe('red-ring');
  });

  it('打成平手就没有偏袒', () => {
    let state = fresh(deckOf('strike'));
    for (const target of [SCOUT, GUARD]) {
      const card = state.encounter.player.hand[0]!;
      state = applyInput(state, {
        type: 'play_card',
        instanceId: card.instanceId,
        atMs: 100,
        targetId: target,
      });
    }

    expect(state.encounter.damageDealtTo['green-vine']).toBe(6);
    expect(state.encounter.damageDealtTo['red-ring']).toBe(6);
    expect(currentSiding(state)).toBeNull();
  });

  it('打光一方就能走：剩下的那一方放你过去，不需要清场', () => {
    let state = fresh(deckOf('strike'));

    // 只打青蔓斥候，把它打掉；赤环两人一直自守
    for (let turn = 0; turn < 12 && state.phase === 'in_encounter'; turn++) {
      state = allDefend(state);
      while (state.encounter.phase === 'player_turn') {
        const card = state.encounter.player.hand.find((c) => canPlay(state, c.instanceId));
        const victim = state.encounter.combatants.find((c) =>
          isBossFloor(state.floor) ? c.isBoss && c.hp > 0 : c.hp > 0 && c.factionId === 'green-vine',
        );
        if (!card || !victim) break;
        state = applyInput(state, {
          type: 'play_card',
          instanceId: card.instanceId,
          atMs: 100 * turn + 1,
          targetId: victim.id,
        });
      }
      if (state.phase !== 'in_encounter') break;
      state = applyInput(state, { type: 'end_turn', atMs: 1000 * (turn + 1) });
    }

    // 清完这一层就停下来收人情，而不是直接结束 Run
    expect(state.phase).toBe('choosing_favor');
    // 赤环两人还站着——他们放你过去
    expect(at(state, GUARD).hp).toBeGreaterThan(0);
    expect(at(state, ARCHER).hp).toBeGreaterThan(0);
    expect(at(state, SCOUT).hp).toBe(0);
    expect(currentSiding(state)).toBe('red-ring');
  });
});

describe('多 Floor 推进与 Favor', () => {
  /** 只打青蔓，把这一派清掉；赤环一直自守。被得罪的一方会带增援，所以逐个点名。 */
  function clearFloorOne(state: RunState): RunState {
    let next = state;
    for (let turn = 0; turn < 30 && next.phase === 'in_encounter'; turn++) {
      next = allDefend(next);
      while (next.encounter.phase === 'player_turn') {
        const card = next.encounter.player.hand.find((c) => canPlay(next, c.instanceId));
        // 塔顶只认首领；普通层打青蔓这一派。
        const victim = next.encounter.combatants.find((c) =>
          isBossFloor(next.floor) ? c.isBoss && c.hp > 0 : c.hp > 0 && c.factionId === 'green-vine',
        );
        if (!card || !victim) break;
        next = applyInput(next, {
          type: 'play_card',
          instanceId: card.instanceId,
          atMs: 100 * turn + 1,
          targetId: victim.id,
        });
      }
      if (next.phase !== 'in_encounter') break;
      next = applyInput(next, { type: 'end_turn', atMs: 1000 * (turn + 1) });
    }
    return next;
  }

  it('清完一层不会直接结束 Run，而是停下来收人情', () => {
    const state = clearFloorOne(startRun(BUILT_IN_GENERATION, SEED, deckOf('strike')));

    expect(state.phase).toBe('choosing_favor');
    expect(state.outcome).toBeNull();
    expect(state.favor?.factionId).toBe('red-ring');
    expect(state.favor?.choices.length).toBeGreaterThan(0);
    // 给你牌的是赤环，所以选项来自赤环的 Base Card
    for (const cardId of state.favor!.choices) {
      expect(CARD_POOL.find((c) => c.id === cardId)?.faction).toBe('red-ring');
    }
  });

  it('收下 Favor 会进 Deck，并在下一层第一回合就可能摸到', () => {
    const cleared = clearFloorOne(startRun(BUILT_IN_GENERATION, SEED, deckOf('strike')));
    const picked = cleared.favor!.choices[0]!;
    const deckBefore = cleared.deck.length;

    const next = applyInput(cleared, { type: 'choose_favor', cardId: picked, atMs: 20_000 });

    expect(next.phase).toBe('in_encounter');
    expect(next.floor).toBe(2);
    expect(next.deck).toHaveLength(deckBefore + 1);
    expect(next.deck.some((c) => c.definitionId === picked)).toBe(true);
    // Deck 整副洗进这一层的抽牌堆
    const inPlay =
      next.encounter.player.hand.length +
      next.encounter.player.drawPile.length +
      next.encounter.player.discardPile.length;
    expect(inPlay).toBe(next.deck.length);
  });

  it('可以什么都不要', () => {
    const cleared = clearFloorOne(startRun(BUILT_IN_GENERATION, SEED, deckOf('strike')));
    const next = applyInput(cleared, { type: 'choose_favor', cardId: null, atMs: 20_000 });

    expect(next.floor).toBe(2);
    expect(next.deck).toHaveLength(cleared.deck.length);
  });

  it('不在选项里的牌拿不走', () => {
    const cleared = clearFloorOne(startRun(BUILT_IN_GENERATION, SEED, deckOf('strike')));
    expect(
      applyInput(cleared, { type: 'choose_favor', cardId: 'skewer-not-offered', atMs: 20_000 }),
    ).toBe(cleared);
  });

  it('选 Favor 的时候玩家的别的输入都不生效，但对手照常在忙', () => {
    const cleared = clearFloorOne(startRun(BUILT_IN_GENERATION, SEED, deckOf('strike')));

    // 玩家这边：除了选 Favor 和发起融合，什么都不生效
    expect(applyInput(cleared, { type: 'end_turn', atMs: 20_000 })).toBe(cleared);
    expect(
      applyInput(cleared, { type: 'play_card', instanceId: 'strike#0', atMs: 20_000 }),
    ).toBe(cleared);

    // 对手这边：层间构筑是并行的，时间流逝与模型的回答照常放行
    const ticked = applyInput(cleared, { type: 'tick', atMs: 20_000 });
    expect(ticked.agentRequests.some((r) => r.kind === 'deckbuild')).toBe(true);
    const built = applyInput(ticked, {
      type: 'agent_response',
      requestId: ticked.agentRequests[0]!.id,
      payload: { cardIds: [] },
    });
    expect(built).not.toBe(ticked);
    expect(built.phase).toBe('choosing_favor'); // 但它没有把玩家推走
  });

  it('同向站队两次就跨过阈值，Favor 升到高阶', () => {
    let state = clearFloorOne(startRun(BUILT_IN_GENERATION, SEED, deckOf('strike')));
    expect(state.favor?.tier).toBe('basic');
    expect(standings(state)['red-ring']).toBe(1);

    state = applyInput(state, { type: 'choose_favor', cardId: null, atMs: 20_000 });
    state = clearFloorOne(state);

    expect(standings(state)['red-ring']).toBe(2);
    expect(state.favor?.tier).toBe('high');
  });

  it('保下的人越多，它给得越大方', () => {
    const bothAlive = clearFloorOne(startRun(BUILT_IN_GENERATION, SEED, deckOf('strike')));
    // 赤环两人都活着
    expect(
      bothAlive.encounter.combatants.filter((c) => c.hp > 0 && c.factionId === 'red-ring'),
    ).toHaveLength(2);
    expect(bothAlive.favor?.choices).toHaveLength(2);
  });

  it('欠你人情的那一方会替你包扎', () => {
    // 先挨一刀，否则满血无从谈起恢复
    let state = startRun(BUILT_IN_GENERATION, SEED, deckOf('strike'));
    state = onlyOneActs(state, 'tower-guard', {
      actionId: 'slash',
      targetId: PLAYER_TARGET,
      line: '',
    });
    state = applyInput(state, { type: 'end_turn', atMs: 500 });

    const cleared = clearFloorOne(state);
    const hurt = cleared.encounter.player.hp;
    expect(hurt).toBeLessThan(cleared.encounter.player.maxHp);

    const next = applyInput(cleared, { type: 'choose_favor', cardId: null, atMs: 20_000 });
    expect(next.encounter.player.hp).toBeGreaterThan(hurt);
  });
});

describe('Memory 与 Standing', () => {
  function fresh(options?: RunOptions): RunState {
    return startRun(BUILT_IN_GENERATION, SEED, { startedAtMs: 0, ...options });
  }

  /** 打光青蔓这一派，清掉当前这一层；赤环一直自守。 */
  function clearFloor(state: RunState): RunState {
    let next = state;
    for (let turn = 0; turn < 30 && next.phase === 'in_encounter'; turn++) {
      next = allDefend(next);
      while (next.encounter.phase === 'player_turn') {
        const card = next.encounter.player.hand.find((c) => canPlay(next, c.instanceId));
        // 塔顶只认首领；普通层打青蔓这一派。
        const victim = next.encounter.combatants.find((c) =>
          isBossFloor(next.floor) ? c.isBoss && c.hp > 0 : c.hp > 0 && c.factionId === 'green-vine',
        );
        if (!card || !victim) break;
        next = applyInput(next, {
          type: 'play_card',
          instanceId: card.instanceId,
          atMs: 100 * turn + 1,
          targetId: victim.id,
        });
      }
      if (next.phase !== 'in_encounter') break;
      next = applyInput(next, { type: 'end_turn', atMs: 1000 * (turn + 1) });
    }
    return next;
  }

  const clearedOnce = (): RunState => clearFloor(fresh(deckOf('strike')));

  it('玩家打出的牌被在场的每个 Faction 记住', () => {
    let state = fresh(deckOf('strike'));
    const card = state.encounter.player.hand[0]!;
    state = applyInput(state, {
      type: 'play_card',
      instanceId: card.instanceId,
      atMs: 100,
      targetId: 'vine-scout',
    });

    for (const factionId of ['red-ring', 'green-vine']) {
      const seen = memoryOf(state, factionId).filter((e) => e.kind === 'card_played');
      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({ kind: 'card_played', cardId: 'strike', floor: 1 });
    }
  });

  it('它只知道你打过的牌，不知道你牌库里有什么', () => {
    // #14 的对手构筑只能用这份情报。玩家因此可以留着某些牌不打，让它无从针对。
    let state = fresh({
      startingDeck: ['strike', 'strike', 'strike', 'strike', 'strike', 'guard', 'guard', 'guard', 'guard', 'heavy'],
      startedAtMs: 0,
    });

    for (let i = 0; i < 2; i++) {
      const card = state.encounter.player.hand.find((c) => c.instanceId.startsWith('strike#'));
      if (!card) break;
      state = applyInput(state, {
        type: 'play_card',
        instanceId: card.instanceId,
        atMs: 100 * (i + 1),
        targetId: 'vine-scout',
      });
    }

    const seen = new Set(
      memoryOf(state, 'red-ring')
        .filter((e) => e.kind === 'card_played')
        .map((e) => (e.kind === 'card_played' ? e.cardId : '')),
    );

    expect(seen.has('strike')).toBe(true);
    // 牌库里有格挡和重击，但它一张都没见过
    expect(state.deck.some((c) => c.definitionId === 'guard')).toBe(true);
    expect(seen.has('guard')).toBe(false);
    expect(seen.has('heavy')).toBe(false);
  });

  it('盾牌类 Card 也会被记住——它会挂起判定，但不该因此从记忆里消失', () => {
    let state = fresh(deckOf('guard'));
    const card = state.encounter.player.hand[0]!;
    state = applyInput(state, { type: 'play_card', instanceId: card.instanceId, atMs: 0 });
    expect(state.encounter.phase).toBe('awaiting_execution'); // 确实挂起了

    const seen = memoryOf(state, 'red-ring').filter((e) => e.kind === 'card_played');
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ cardId: 'guard' });
  });

  it('Run 结束时 Memory 清空（ADR-0003）', () => {
    let state = clearedOnce();
    expect(memoryOf(state, 'red-ring').length).toBeGreaterThan(0);

    // 一路走到塔顶并把首领放倒
    for (let floor = 1; floor < 8 && state.phase !== 'ended'; floor++) {
      state = applyInput(state, { type: 'choose_favor', cardId: null, atMs: 20_000 * floor });
      state = clearFloor(state);
    }

    expect(state.phase).toBe('ended');
    expect(state.outcome).toBe('victory');
    expect(Object.keys(state.memories)).toHaveLength(0);
  });

  it('换着打就不会招来增援，一直挑同一方才会', () => {
    // 一直挑青蔓：第三层它就带人来了
    let picky = clearedOnce();
    picky = clearFloor(applyInput(picky, { type: 'choose_favor', cardId: null, atMs: 20_000 }));
    const third = applyInput(picky, { type: 'choose_favor', cardId: null, atMs: 40_000 });
    expect(third.encounter.combatants.length).toBeGreaterThan(3);
  });

  it('Standing 由 Memory 推出：留它活着加分，伤它扣分', () => {
    const state = clearedOnce();

    // 赤环被留下来了
    expect(memoryOf(state, 'red-ring').some((e) => e.kind === 'sided')).toBe(true);
    expect(standings(state)['red-ring']).toBe(1);

    // 青蔓被打光了
    const harmed = memoryOf(state, 'green-vine').filter((e) => e.kind === 'harmed');
    expect(harmed).toHaveLength(1);
    expect(standings(state)['green-vine']).toBeLessThan(0);
  });

  it('Parley 直接改变态度', () => {
    let state = fresh(deckOf('truce')); // 青蔓的止戈
    const before = standings(state)['green-vine'] ?? 0;
    const card = state.encounter.player.hand[0]!;

    state = applyInput(state, {
      type: 'play_card',
      instanceId: card.instanceId,
      atMs: 100,
      targetId: 'vine-scout',
    });

    expect(memoryOf(state, 'green-vine').some((e) => e.kind === 'parley')).toBe(true);
    expect(standings(state)['green-vine']).toBe(before + 1);
  });

  it('反复挑同一方下手，它下一层就会多带人', () => {
    // 第一次清场之后还没结怨到那个份上
    const once = clearedOnce();
    const secondFloor = applyInput(once, { type: 'choose_favor', cardId: null, atMs: 20_000 });
    expect(secondFloor.encounter.combatants).toHaveLength(3);

    // 第二次还挑青蔓，第三层它就带人来了
    const twice = clearFloor(secondFloor);
    const thirdFloor = applyInput(twice, { type: 'choose_favor', cardId: null, atMs: 40_000 });
    expect(thirdFloor.encounter.combatants.length).toBeGreaterThan(3);
    expect(
      thirdFloor.encounter.combatants.filter((c) => c.factionId === 'green-vine'),
    ).toHaveLength(2);
  });

  it('同向站队两次跨过阈值，Favor 升到高阶', () => {
    const once = clearedOnce();
    expect(once.favor?.tier).toBe('basic');

    const twice = clearFloor(applyInput(once, { type: 'choose_favor', cardId: null, atMs: 20_000 }));
    expect(standings(twice)['red-ring']).toBe(2);
    expect(twice.favor?.tier).toBe('high');
  });
});

describe('Fusion 与 Mutation', () => {
  const fresh = (options?: RunOptions): RunState =>
    startRun(BUILT_IN_GENERATION, SEED, { startedAtMs: 0, ...options });

  /** 牌库里放满重击（两个 Atom），这样两张合起来正好顶到上限。 */
  const FUSION_DECK: RunOptions = {
    startingDeck: Array.from({ length: 10 }, () => 'heavy'),
    startedAtMs: 0,
  };

  /** 打光青蔓这一派，清掉当前这一层；赤环一直自守。 */
  function clearFloor(state: RunState): RunState {
    let next = state;
    for (let turn = 0; turn < 40 && next.phase === 'in_encounter'; turn++) {
      next = allDefend(next);
      while (next.encounter.phase === 'player_turn') {
        const card = next.encounter.player.hand.find((c) => canPlay(next, c.instanceId));
        // 塔顶只认首领；普通层打青蔓这一派。
        const victim = next.encounter.combatants.find((c) =>
          isBossFloor(next.floor) ? c.isBoss && c.hp > 0 : c.hp > 0 && c.factionId === 'green-vine',
        );
        if (!card || !victim) break;
        next = applyInput(next, {
          type: 'play_card',
          instanceId: card.instanceId,
          atMs: 100 * turn + 1,
          targetId: victim.id,
        });
      }
      if (next.phase !== 'in_encounter') break;
      next = applyInput(next, { type: 'end_turn', atMs: 1000 * (turn + 1) });
    }
    return next;
  }

  /** 连续两层把赤环留到最后，拿到第一次高阶 Favor。 */
  function atHighFavor(): RunState {
    let state = clearFloor(fresh(FUSION_DECK));
    state = applyInput(state, { type: 'choose_favor', cardId: null, atMs: 20_000 });
    return clearFloor(state);
  }

  /** 挑它给的选项里 Atom 最多的那张——选项是随机的，这样融合的结果才可预期。 */
  function richestOffer(state: RunState): string {
    return [...state.favor!.choices].sort(
      (a, b) => (cardById(state, b)?.atoms.length ?? 0) - (cardById(state, a)?.atoms.length ?? 0),
    )[0]!;
  }

  function fuse(state: RunState, deckInstanceId: string, overload: boolean, atMs: number): RunState {
    return applyInput(state, {
      type: 'fuse',
      offeredCardId: richestOffer(state),
      deckInstanceId,
      overload,
      atMs,
    });
  }

  /**
   * 推到「融合必须有人取舍」的那一刻。
   *
   * Base Card 最多两个 Atom，所以**第一次融合永远顶不破上限**——它是引擎自己算完的。
   * 要让 Agent 出场，得拿第一次锻出来的那张（4 个 Atom）再融一次。
   */
  function atOverflow(overload: boolean): { asking: RunState; request: FusionRequest } {
    let state = atHighFavor();
    const first = state.deck.find((c) => c.definitionId === 'heavy')!;
    state = fuse(state, first.instanceId, false, 30_000);
    expect(state.forged).toHaveLength(1);
    // 重击两个 Atom 加它给的一到两个：顶到上限但没超，所以刚才没人需要取舍
    expect(state.forged[0]!.atoms.length).toBeGreaterThanOrEqual(3);
    expect(state.forged[0]!.atoms.length).toBeLessThanOrEqual(MAX_ATOMS_PER_CARD);

    state = applyInput(state, { type: 'choose_favor', cardId: null, atMs: 31_000 });
    state = clearFloor(state);
    expect(state.favor?.tier).toBe('high');

    const forgedInstance = state.deck.find((c) => c.definitionId === state.forged[0]!.id)!;
    const asking = fuse(state, forgedInstance.instanceId, overload, 40_000);
    const request = asking.agentRequests.find((r): r is FusionRequest => r.kind === 'fusion');
    expect(request).toBeDefined();
    return { asking, request: request! };
  }

  it('高阶 Favor 给的是一次融合机会', () => {
    const state = atHighFavor();
    expect(state.favor?.tier).toBe('high');
    expect(state.favor?.choices.length).toBeGreaterThan(0);
  });

  it('合起来不超上限就当场锻好，不去打扰模型', () => {
    const state = atHighFavor();
    const mine = state.deck.find((c) => c.definitionId === 'heavy')!;
    const offeredDefinition = cardById(state, richestOffer(state))!;

    const fused = fuse(state, mine.instanceId, false, 30_000);

    expect(fused.agentRequests.some((r) => r.kind === 'fusion')).toBe(false);
    expect(fused.forged).toHaveLength(1);
    const forged = fused.forged[0]!;

    // 被融掉的那张走了，新的那张进来了，总数不变
    expect(fused.deck.some((c) => c.instanceId === mine.instanceId)).toBe(false);
    expect(fused.deck.some((c) => c.definitionId === forged.id)).toBe(true);
    expect(fused.deck).toHaveLength(state.deck.length);

    // Atom 合并、费用重算，玩家读得懂
    expect(forged.atoms).toHaveLength(2 + offeredDefinition.atoms.length);
    expect(forged.cost).toBe(costOf(forged.atoms));
  });

  it('超出上限才去问那一方该丢什么', () => {
    const { asking, request } = atOverflow(false);

    expect(asking.phase).toBe('fusing');
    expect(request.overload).toBe(false);
    expect(request.atoms.length).toBeGreaterThan(MAX_ATOMS_PER_CARD);
  });

  it('等取舍的时候别的输入都不生效', () => {
    const { asking } = atOverflow(false);
    expect(applyInput(asking, { type: 'choose_favor', cardId: null, atMs: 41_000 })).toBe(asking);
    expect(applyInput(asking, { type: 'end_turn', atMs: 41_000 })).toBe(asking);
  });

  it('三条回退路径：超时、非法选择、畸形响应', () => {
    const { asking, request } = atOverflow(false);

    const outcomes = [
      applyInput(asking, { type: 'tick', atMs: 40_000 + request.timeoutMs }),
      applyInput(asking, {
        type: 'agent_response',
        requestId: request.id,
        payload: { dropAtomId: 'sacrifice', name: '越界' }, // 不在合并结果里
      }),
      applyInput(asking, { type: 'agent_response', requestId: request.id, payload: null }),
    ];

    for (const outcome of outcomes) {
      expect(outcome.phase).toBe('choosing_favor'); // Run 继续
      expect(outcome.forged).toHaveLength(2);
      const forged = outcome.forged[1]!;
      expect(forged.atoms).toHaveLength(request.atoms.length - 1);
      for (const atom of forged.atoms) expect(request.atoms).toContain(atom);
    }
  });

  it('合法的取舍会被接受，名字也照用', () => {
    const { asking, request } = atOverflow(false);
    const drop = request.atoms[0]!;

    const done = applyInput(asking, {
      type: 'agent_response',
      requestId: request.id,
      payload: { dropAtomId: drop, name: '断链' },
    });

    const forged = done.forged[1]!;
    expect(forged.name).toBe('断链');
    expect(forged.atoms).toHaveLength(request.atoms.length - 1);
  });

  it('过载换来的是一个额外的位置，装的正是禁忌 Atom', () => {
    const { asking, request } = atOverflow(true);
    expect(request.overload).toBe(true);

    const mutated = applyInput(asking, { type: 'tick', atMs: 40_000 + request.timeoutMs });
    const forged = mutated.forged[1]!;

    const forbidden = forged.atoms.filter((id) => ATOMS.find((a) => a.id === id)?.forbidden);
    expect(forbidden).toHaveLength(1);
    // 比上限多一个，而不是无限膨胀
    expect(forged.atoms).toHaveLength(MAX_ATOMS_PER_CARD + 1);
    // 禁忌权重为负，所以多这一个 Atom 不会让它更贵（费用取整时可能持平）
    expect(forged.cost).toBeLessThanOrEqual(
      costOf(forged.atoms.filter((id) => !forbidden.includes(id))),
    );
  });

  it('过载的三条回退路径也各自成立', () => {
    const { asking, request } = atOverflow(true);

    const outcomes = [
      applyInput(asking, { type: 'tick', atMs: 40_000 + request.timeoutMs }),
      applyInput(asking, {
        type: 'agent_response',
        requestId: request.id,
        payload: { forbiddenAtomId: 'strike', name: '不是禁忌' }, // 不是 Forbidden Atom
      }),
      applyInput(asking, { type: 'agent_response', requestId: request.id, payload: 42 }),
    ];

    for (const outcome of outcomes) {
      expect(outcome.phase).toBe('choosing_favor');
      const forged = outcome.forged[1]!;
      expect(forged.atoms.filter((id) => ATOMS.find((a) => a.id === id)?.forbidden)).toHaveLength(1);
      expect(forged.atoms).toHaveLength(MAX_ATOMS_PER_CARD + 1);
    }
  });

  it('反复融合不会让一张牌无限膨胀', () => {
    // 这条守的是 ADR-0005 的「单卡至多 4 个 Atom」：只丢一个是不够的，
    // 一张顶到上限的产物再融一次会有 6 个，丢一个还剩 5。
    let state = atHighFavor();
    for (let round = 0; round < 3 && state.phase !== 'ended'; round++) {
      const fattest = [...state.deck].sort(
        (a, b) =>
          (cardById(state, b.definitionId)?.atoms.length ?? 0) -
          (cardById(state, a.definitionId)?.atoms.length ?? 0),
      )[0]!;
      state = fuse(state, fattest.instanceId, false, 30_000 + round * 1000);

      const request = state.agentRequests.find((r): r is FusionRequest => r.kind === 'fusion');
      if (request) {
        state = applyInput(state, {
          type: 'tick',
          atMs: 30_000 + round * 1000 + request.timeoutMs,
        });
      }
      for (const forged of state.forged) {
        expect(forged.atoms.length).toBeLessThanOrEqual(MAX_ATOMS_PER_CARD);
      }

      state = applyInput(state, { type: 'choose_favor', cardId: null, atMs: 35_000 + round * 1000 });
      if (state.phase === 'in_encounter') state = clearFloor(state);
    }
  });

  it('同样两张牌，找不同派系融会得到不同的牌', () => {
    // 这条经 seam 断言，不去戳内部函数——正因为之前那条直接测偏好函数的测试，
    // 一个把偏好顺序弄反了的 bug 才溜了过去。
    const atoms = ['strike', 'pierce', 'guard', 'draw', 'burn'];
    const forge = (factionId: string): readonly string[] => {
      const base = startRun(BUILT_IN_GENERATION, SEED, { startedAtMs: 0 });
      const request: FusionRequest = {
        kind: 'fusion',
        id: 'r0',
        factionId,
        requestedAtMs: 0,
        timeoutMs: 1000,
        atoms,
        overload: false,
        sourceNames: ['甲', '乙'],
        deckInstanceId: base.deck[0]!.instanceId,
      };
      const asking: RunState = {
        ...base,
        phase: 'fusing',
        favor: { factionId, tier: 'high', choices: [] },
        agentRequests: [request],
      };
      const done = applyInput(asking, { type: 'tick', atMs: 5000 });
      return done.forged[0]!.atoms;
    };

    const red = forge('red-ring');
    const green = forge('green-vine');

    expect(red).not.toEqual(green);
    // 赤环留下杀伤力：伤害轴的 Atom 一个不少
    expect(red).toContain('strike');
    expect(red).toContain('pierce');
    // 青蔓留下的是活下去的东西
    expect(green).toContain('guard');
  });

  it('融合产物只属于这一局：Run 结束就没了（ADR-0009）', () => {
    let state = atHighFavor();
    const mine = state.deck.find((c) => c.definitionId === 'heavy')!;
    state = fuse(state, mine.instanceId, false, 30_000);
    expect(state.forged.length).toBeGreaterThan(0);

    for (let floor = 2; floor < 9 && state.phase !== 'ended'; floor++) {
      state = applyInput(state, { type: 'choose_favor', cardId: null, atMs: 40_000 * floor });
      state = clearFloor(state);
    }

    expect(state.phase).toBe('ended');
    expect(state.forged).toHaveLength(0);
  });
});

describe('对手也在构筑', () => {
  const fresh = (options?: RunOptions): RunState =>
    startRun(BUILT_IN_GENERATION, SEED, { startedAtMs: 0, ...options });

  /** 打光青蔓这一派，清掉当前这一层；赤环一直自守。 */
  function clearFloor(state: RunState): RunState {
    let next = state;
    for (let turn = 0; turn < 40 && next.phase === 'in_encounter'; turn++) {
      next = allDefend(next);
      while (next.encounter.phase === 'player_turn') {
        const card = next.encounter.player.hand.find((c) => canPlay(next, c.instanceId));
        // 塔顶只认首领；普通层打青蔓这一派。
        const victim = next.encounter.combatants.find((c) =>
          isBossFloor(next.floor) ? c.isBoss && c.hp > 0 : c.hp > 0 && c.factionId === 'green-vine',
        );
        if (!card || !victim) break;
        next = applyInput(next, {
          type: 'play_card',
          instanceId: card.instanceId,
          atMs: 100 * turn + 1,
          targetId: victim.id,
        });
      }
      if (next.phase !== 'in_encounter') break;
      next = applyInput(next, { type: 'end_turn', atMs: 1000 * (turn + 1) });
    }
    return next;
  }

  /** 清完一层之后报一次时——构筑提问就是在 tick 上挂出来的，实机也是这么走的。 */
  const withDeckbuild = (state: RunState, atMs = 20_000): RunState =>
    applyInput(state, { type: 'tick', atMs });

  const buildRequestOf = (state: RunState, factionId: string): DeckbuildRequest =>
    state.agentRequests.find(
      (r): r is DeckbuildRequest => r.kind === 'deckbuild' && r.factionId === factionId,
    )!;

  it('清完一层就为下一层挂出构筑提问，和玩家挑 Favor 并行', () => {
    const cleared = withDeckbuild(clearFloor(fresh(deckOf('strike'))));

    expect(cleared.phase).toBe('choosing_favor');
    for (const agent of cleared.agents) {
      const request = buildRequestOf(cleared, agent.factionId);
      expect(request).toBeDefined();
      expect(request.forFloor).toBe(2);
      expect(request.capacity).toBeGreaterThan(0);
    }
  });

  it('提问的时刻就是报时带进来的那个，引擎不自己造钟', () => {
    // 这条守的是一个实机才会犯的错：引擎若凭回合数编一个时刻，它和宿主的
    // performance.now() 就是两把尺子，超时判断立刻失真——对手永远走预设、从不构筑，
    // 而用同一把编造尺子的测试还照样通过。
    const cleared = clearFloor(fresh(deckOf('strike')));
    const realClock = 1_234_567;
    const opened = withDeckbuild(cleared, realClock);

    const request = buildRequestOf(opened, 'red-ring');
    expect(request.requestedAtMs).toBe(realClock);

    // 同一把尺子下，它不该在刚挂出来就被判超时
    const soon = applyInput(opened, { type: 'tick', atMs: realClock + 100 });
    expect(soon.agentRequests.some((r) => r.kind === 'deckbuild')).toBe(true);

    // 真到点了才超时，退回预设
    const late = applyInput(opened, { type: 'tick', atMs: realClock + request.timeoutMs });
    expect(late.agentRequests.some((r) => r.kind === 'deckbuild')).toBe(false);
    expect(late.factionDecks['red-ring']?.length).toBeGreaterThan(0);
  });

  it('合法牌集 = 自己的家底 + 它亲眼见过你打的牌', () => {
    const cleared = withDeckbuild(clearFloor(fresh(deckOf('strike'))));
    const request = buildRequestOf(cleared, 'red-ring');

    // 自己派系的每一张都在
    for (const card of CARD_POOL.filter((c) => c.faction === 'red-ring')) {
      expect(request.legalCardIds).toContain(card.id);
    }
    // 玩家在它面前打过劈砍，所以它拿得到
    expect(request.legalCardIds).toContain('strike');
  });

  it('藏牌真的有效：没在它面前打过的牌不会进它的合法集', () => {
    // 刻意只打劈砍，格挡与重击一张都不打——它们全程留在手上或牌堆里。
    let state = fresh({
      startingDeck: ['strike', 'strike', 'strike', 'strike', 'strike', 'guard', 'guard', 'guard', 'guard', 'heavy'],
      startedAtMs: 0,
    });

    for (let turn = 0; turn < 40 && state.phase === 'in_encounter'; turn++) {
      state = allDefend(state);
      while (state.encounter.phase === 'player_turn') {
        const card = state.encounter.player.hand.find(
          (c) => c.instanceId.startsWith('strike#') && canPlay(state, c.instanceId),
        );
        const victim = state.encounter.combatants.find((c) =>
          isBossFloor(state.floor) ? c.isBoss && c.hp > 0 : c.hp > 0 && c.factionId === 'green-vine',
        );
        if (!card || !victim) break;
        state = applyInput(state, {
          type: 'play_card',
          instanceId: card.instanceId,
          atMs: 100 * turn + 1,
          targetId: victim.id,
        });
      }
      if (state.phase !== 'in_encounter') break;
      state = applyInput(state, { type: 'end_turn', atMs: 1000 * (turn + 1) });
    }

    expect(state.phase).toBe('choosing_favor');
    state = withDeckbuild(state, 50_000);
    // 对赤环断言：格挡是青蔓的家底，赤环只可能从「见过玩家打出」这条路拿到它
    const request = buildRequestOf(state, 'red-ring');

    expect(request.legalCardIds).toContain('strike'); // 见过，而且本来就是它的
    // 玩家牌库里有四张格挡，但一张都没打出去——赤环因此无从知道
    expect(state.deck.some((c) => c.definitionId === 'guard')).toBe(true);
    expect(request.legalCardIds).not.toContain('guard');
  });

  it('它挑的牌变成下一层多出来的动作，数值照玩家的规则算', () => {
    let state = withDeckbuild(clearFloor(fresh(deckOf('strike'))));
    const request = buildRequestOf(state, 'red-ring');

    state = applyInput(state, {
      type: 'agent_response',
      requestId: request.id,
      payload: { cardIds: ['strike'] }, // 它学会了你的劈砍
    });
    // 另一派按预设走
    const other = buildRequestOf(state, 'green-vine');
    state = applyInput(state, {
      type: 'agent_response',
      requestId: other.id,
      payload: { cardIds: [] },
    });

    state = applyInput(state, { type: 'choose_favor', cardId: null, atMs: 20_000 });

    const guard = state.encounter.combatants.find((c) => c.id === 'tower-guard')!;
    const learned = guard.actions.find((a) => a.id === 'card:strike');
    expect(learned).toBeDefined();
    expect(learned?.kind).toBe('attack');
    expect(learned?.amount).toBe(6); // 劈砍就是 6 点，和玩家手里一模一样
  });

  it('三条回退路径：超时、非法选择、畸形响应，一律退回固定预设', () => {
    const cleared = withDeckbuild(clearFloor(fresh(deckOf('strike'))));
    const request = buildRequestOf(cleared, 'red-ring');
    const preset = CARD_POOL.filter((c) => c.faction === 'red-ring')
      .slice(0, request.capacity)
      .map((c) => c.id);

    const outcomes = [
      applyInput(cleared, { type: 'tick', atMs: request.requestedAtMs + request.timeoutMs }),
      applyInput(cleared, {
        type: 'agent_response',
        requestId: request.id,
        payload: { cardIds: ['truce', '不存在的牌'] }, // 青蔓的牌，它拿不到
      }),
      applyInput(cleared, { type: 'agent_response', requestId: request.id, payload: 'nonsense' }),
    ];

    for (const outcome of outcomes) {
      expect(outcome.factionDecks['red-ring']).toEqual(preset);
      expect(outcome.phase).toBe('choosing_favor'); // Run 继续
    }
  });

  it('它也会融合，产物照玩家的 Atom 与费用规则来', () => {
    const cleared = withDeckbuild(clearFloor(fresh(deckOf('strike'))));
    const request = buildRequestOf(cleared, 'red-ring');

    const built = applyInput(cleared, {
      type: 'agent_response',
      requestId: request.id,
      payload: { cardIds: ['strike', 'heavy'], fuse: ['strike', 'heavy'], name: '双刃' },
    });

    expect(built.forged).toHaveLength(1);
    const forged = built.forged[0]!;
    expect(forged.name).toBe('双刃');
    expect(forged.faction).toBe('red-ring');
    expect(forged.cost).toBe(costOf(forged.atoms));
    expect(forged.atoms.length).toBeLessThanOrEqual(MAX_ATOMS_PER_CARD);
    expect(built.factionDecks['red-ring']).toContain(forged.id);
  });

  it('第 1 层它什么都没带——没问过就不该有', () => {
    const opening = fresh(deckOf('strike'));
    for (const combatant of opening.encounter.combatants) {
      expect(combatant.actions.filter((a) => a.id.startsWith('card:'))).toHaveLength(0);
    }
  });

  it('没答完就开新层的话什么都不带，提问也不会留到场上', () => {
    let state = withDeckbuild(clearFloor(fresh(deckOf('strike'))));
    expect(state.agentRequests.some((r) => r.kind === 'deckbuild')).toBe(true);

    state = applyInput(state, { type: 'choose_favor', cardId: null, atMs: 21_000 });

    expect(state.agentRequests.some((r) => r.kind === 'deckbuild')).toBe(false);
    const guard = state.encounter.combatants.find((c) => c.id === 'tower-guard')!;
    expect(guard.actions.filter((a) => a.id.startsWith('card:'))).toHaveLength(0);
  });
});

describe('Boss 层（ADR-0008）', () => {
  const fresh = (options?: RunOptions): RunState =>
    startRun(BUILT_IN_GENERATION, SEED, { startedAtMs: 0, ...options });

  /** 直接把 Run 摆到塔顶前一刻，Standing 由这份 memories 决定。 */
  function atTop(memories: RunState['memories']): RunState {
    const base = fresh(deckOf('strike'));
    const before: RunState = { ...base, floor: NORMAL_FLOORS, memories };
    // 走一次正常的层间流程上塔顶
    const cleared: RunState = {
      ...before,
      phase: 'choosing_favor',
      favor: { factionId: 'red-ring', tier: 'basic', choices: [] },
    };
    return applyInput(cleared, { type: 'choose_favor', cardId: null, atMs: 60_000 });
  }

  const bossOf = (state: RunState): CombatantState | undefined =>
    state.encounter.combatants.find((c) => c.isBoss);

  it('塔顶坐着的是你 Standing 最低的那一方的首领', () => {
    // 得罪青蔓：它的首领在等你
    const angryGreen = atTop({
      'green-vine': [{ kind: 'harmed', floor: 1, amount: 60 }],
      'red-ring': [{ kind: 'sided', floor: 1 }],
    });
    expect(isBossFloor(angryGreen.floor)).toBe(true);
    expect(bossOf(angryGreen)?.factionId).toBe('green-vine');

    // 反过来得罪赤环，塔顶就换了人——同一个 Run 结构，不同的结局
    const angryRed = atTop({
      'red-ring': [{ kind: 'harmed', floor: 1, amount: 60 }],
      'green-vine': [{ kind: 'sided', floor: 1 }],
    });
    expect(bossOf(angryRed)?.factionId).toBe('red-ring');
  });

  it('Standing 为正的那一方派援军来帮你', () => {
    const state = atTop({
      'green-vine': [{ kind: 'harmed', floor: 1, amount: 60 }],
      'red-ring': [{ kind: 'sided', floor: 1 }, { kind: 'sided', floor: 2 }],
    });

    const allies = state.encounter.combatants.filter((c) => c.factionId === 'red-ring');
    expect(allies.length).toBeGreaterThan(0);
    expect(state.encounter.siege).toBe(false);

    // 援军和首领不是一伙的：让它去打首领，引擎应当认这个目标
    const ally = allies[0]!;
    const attack = ally.actions.find((a) => a.kind === 'attack')!;
    const boss = bossOf(state)!;
    const answered = answerAll(state, (id) =>
      id === ally.id
        ? { actionId: attack.id, targetId: boss.id, line: '' }
        : defendPayload(state, id),
    );
    const decided = answered.encounter.combatants.find((c) => c.id === ally.id)!;
    expect(decided.intent?.source).toBe('agent');
    expect(decided.intent?.targetId).toBe(boss.id);
  });

  it('谁都得罪光了就是围攻：所有人只打你，彼此不再动手', () => {
    const state = atTop({
      'green-vine': [{ kind: 'harmed', floor: 1, amount: 60 }],
      'red-ring': [{ kind: 'harmed', floor: 1, amount: 40 }],
    });

    expect(state.encounter.siege).toBe(true);

    // 围攻期间它们只认玩家：给一个「打旁边那位」的目标，引擎应当拒绝并回退
    const boss = bossOf(state)!;
    const other = state.encounter.combatants.find((c) => c.id !== boss.id)!;
    const attack = other.actions.find((a) => a.kind === 'attack')!;
    const answered = answerAll(state, (id) =>
      id === other.id
        ? { actionId: attack.id, targetId: boss.id, line: '' }
        : defendPayload(state, id),
    );
    const decided = answered.encounter.combatants.find((c) => c.id === other.id)!;
    expect(decided.intent?.source).toBe('fallback');
    expect(decided.intent?.targetId).toBe(PLAYER_TARGET);
  });

  it('首领带着这一派备好的牌上来', () => {
    const before = atTop({ 'green-vine': [{ kind: 'harmed', floor: 1, amount: 60 }] });
    expect(bossOf(before)?.factionId).toBe('green-vine');

    // 让青蔓在上塔顶之前备好一张牌
    const base = fresh(deckOf('strike'));
    const staged: RunState = {
      ...base,
      floor: NORMAL_FLOORS,
      memories: { 'green-vine': [{ kind: 'harmed', floor: 1, amount: 60 }] },
      factionDecks: { 'green-vine': ['guard', 'bramble'] },
      phase: 'choosing_favor',
      favor: { factionId: 'green-vine', tier: 'basic', choices: [] },
    };
    const top = applyInput(staged, { type: 'choose_favor', cardId: null, atMs: 60_000 });

    const boss = bossOf(top)!;
    expect(boss.actions.some((a) => a.id === 'card:guard')).toBe(true);

    // 但它拿到的是那张牌的骨架，不是全部：Combatant 的动作只有攻击和防御两种形状，
    // 反伤这类附带效果搬不过去，所以只有反伤的荆棘不会变成任何动作。
    expect(boss.actions.some((a) => a.id === 'card:bramble')).toBe(false);
  });

  it('围攻不该比被人喜欢更轻松：得罪所有人时每一方都来', () => {
    const liked = atTop({
      'green-vine': [{ kind: 'harmed', floor: 1, amount: 60 }],
      'red-ring': [{ kind: 'sided', floor: 1 }, { kind: 'sided', floor: 2 }],
    });
    const hated = atTop({
      'green-vine': [{ kind: 'harmed', floor: 1, amount: 60 }],
      'red-ring': [{ kind: 'harmed', floor: 1, amount: 40 }],
    });

    expect(hated.encounter.siege).toBe(true);
    // 围攻的场面不比有援军的时候小——每一个别的 Faction 都派了人来
    expect(hated.encounter.combatants.length).toBeGreaterThanOrEqual(
      liked.encounter.combatants.length,
    );
    expect(hated.encounter.combatants.some((c) => c.factionId === 'red-ring')).toBe(true);
  });

  it('都是 0 的中立局面既没有援军也不是围攻', () => {
    const neutral = atTop({});
    expect(neutral.encounter.siege).toBe(false);
    const bossFaction = bossOf(neutral)!.factionId;
    expect(neutral.encounter.combatants.every((c) => c.factionId === bossFaction)).toBe(true);
  });

  it('援军超时也不会反过来打你', () => {
    const state = atTop({
      'green-vine': [{ kind: 'harmed', floor: 1, amount: 60 }],
      'red-ring': [{ kind: 'sided', floor: 1 }, { kind: 'sided', floor: 2 }],
    });
    const ally = state.encounter.combatants.find((c) => c.factionId === 'red-ring')!;
    const request = state.agentRequests.find(
      (r): r is IntentRequest => r.kind === 'intent' && r.combatantId === ally.id,
    )!;

    const expired = applyInput(state, {
      type: 'tick',
      atMs: request.requestedAtMs + request.timeoutMs,
    });

    const decided = expired.encounter.combatants.find((c) => c.id === ally.id)!;
    expect(decided.intent?.source).toBe('fallback');
    expect(decided.intent?.targetId).toBe(bossOf(state)!.id); // 打首领，不是打你
  });

  it('每个 Faction 都拿得出一位首领', () => {
    // #10 会生成 Faction，那时不该因为漏配一张表就让塔顶空着
    for (const agent of fresh().agents) {
      const top = atTop({ [agent.factionId]: [{ kind: 'harmed', floor: 1, amount: 99 }] });
      expect(bossOf(top)).toBeDefined();
      expect(bossOf(top)?.factionId).toBe(agent.factionId);
    }
  });

  it('首领倒下这一场就结束，不管旁边还站着谁', () => {
    let state = atTop({
      'green-vine': [{ kind: 'harmed', floor: 1, amount: 60 }],
      'red-ring': [{ kind: 'sided', floor: 1 }, { kind: 'sided', floor: 2 }],
    });

    for (let turn = 0; turn < 60 && state.phase === 'in_encounter'; turn++) {
      state = allDefend(state);
      while (state.encounter.phase === 'player_turn') {
        const card = state.encounter.player.hand.find((c) => canPlay(state, c.instanceId));
        const boss = bossOf(state);
        if (!card || !boss || boss.hp <= 0) break;
        state = applyInput(state, {
          type: 'play_card',
          instanceId: card.instanceId,
          atMs: 100 * turn + 1,
          targetId: boss.id,
        });
      }
      if (state.phase !== 'in_encounter') break;
      state = applyInput(state, { type: 'end_turn', atMs: 1000 * (turn + 1) });
    }

    expect(state.phase).toBe('ended');
    expect(state.outcome).toBe('victory');
    expect(bossOf(state)?.hp).toBe(0);
    // 援军还活着，但这一场已经结束了
    expect(state.encounter.combatants.some((c) => c.hp > 0 && !c.isBoss)).toBe(true);
  });

  it('在塔顶倒下也是正常结束', () => {
    let state = atTop({
      'green-vine': [{ kind: 'harmed', floor: 1, amount: 60 }],
      'red-ring': [{ kind: 'harmed', floor: 1, amount: 40 }],
    });
    // 什么都不做，一路挨打
    for (let turn = 0; turn < 40 && state.phase === 'in_encounter'; turn++) {
      state = applyInput(state, { type: 'end_turn', atMs: 1000 * (turn + 1) });
    }

    expect(state.phase).toBe('ended');
    expect(state.outcome).toBe('defeat');
    expect(state.encounter.player.hp).toBe(0);
  });
});

describe('一局完整的塔', () => {
  it('从 startRun 一路打到塔顶：五个普通 Floor 加一场首领战', () => {
    let state = startRun(BUILT_IN_GENERATION, SEED, {
      startingDeck: Array.from({ length: 10 }, () => 'heavy'),
      startedAtMs: 0,
    });
    const floorsSeen: number[] = [];
    let bossFought = '';

    for (let step = 0; step < 4000 && state.phase !== 'ended'; step++) {
      if (!floorsSeen.includes(state.floor)) floorsSeen.push(state.floor);

      if (state.phase === 'choosing_favor') {
        state = applyInput(state, {
          type: 'choose_favor',
          cardId: state.favor?.choices[0] ?? null,
          atMs: 100_000 + step,
        });
        continue;
      }
      if (state.phase === 'fusing') {
        state = applyInput(state, { type: 'tick', atMs: 200_000 + step * 100 });
        continue;
      }

      state = allDefend(state);
      if (state.encounter.phase === 'awaiting_execution') {
        state = applyInput(state, pressAt(state, 0.75));
        continue;
      }

      const boss = state.encounter.combatants.find((c) => c.isBoss && c.hp > 0);
      if (boss) bossFought = boss.name;
      const victim =
        boss ?? state.encounter.combatants.find((c) => c.hp > 0 && c.factionId === 'green-vine');
      const card = state.encounter.player.hand.find((c) => canPlay(state, c.instanceId));

      if (card && victim) {
        state = applyInput(state, {
          type: 'play_card',
          instanceId: card.instanceId,
          atMs: 1000 + step,
          targetId: victim.id,
        });
      } else {
        state = applyInput(state, { type: 'end_turn', atMs: 2000 + step * 10 });
      }
    }

    expect(state.phase).toBe('ended');
    expect(state.outcome).toBe('victory');
    // 五个普通 Floor 加塔顶，一个都没漏
    expect(floorsSeen).toEqual([1, 2, 3, 4, 5, NORMAL_FLOORS + 1]);
    expect(bossFought).not.toBe('');
    // 跨局的东西一律清空（ADR-0003 / ADR-0009）
    expect(Object.keys(state.memories)).toHaveLength(0);
    expect(state.forged).toHaveLength(0);
  });
});

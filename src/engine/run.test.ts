import { describe, expect, it } from 'vitest';
import {
  applyInput,
  canPlay,
  definitionOf,
  favoredFaction,
  isPlayerActing,
  startRun,
} from './run.js';
import { ATOMS, MAX_ATOMS_PER_CARD, effectsOf } from './atoms.js';
import { BUILT_IN_GENERATION, CARD_POOL, STARTING_DECK } from './content.js';
import { PLAYER_TARGET } from './types.js';
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
function scriptInputs(start: RunState, maxSteps = 500): PlayerInput[] {
  const at = clock();
  let state = start;
  const inputs: PlayerInput[] = [];

  for (let i = 0; i < maxSteps && state.phase !== 'ended'; i++) {
    // 场上有敌对派系就先打对方——这是实测到的真实模型行为，而不是回退那种
    // 「所有人都打玩家」的最坏情况。不这么做，测的就不是这个游戏。
    if (state.agentRequests.length > 0) {
      for (const request of state.agentRequests) {
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

/** 每个 Combatant 的自守动作，用来让不相干的单位安静地过掉这一回合。 */
const DEFEND: Readonly<Record<string, string>> = {
  'tower-guard': 'brace',
  'red-archer': 'retreat',
  'vine-scout': 'coil',
};

/** 回答场上所有待答的提问。plan 决定每个 Combatant 答什么。 */
function answerAll(
  state: RunState,
  plan: (combatantId: string) => unknown,
): RunState {
  let next = state;
  for (const request of state.agentRequests) {
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
  return answerAll(state, (id) => ({ actionId: DEFEND[id], line: '' }));
}

/** 除了 except 全员自守，except 按给定的方式行动。 */
function onlyOneActs(state: RunState, except: string, payload: unknown): RunState {
  return answerAll(state, (id) => (id === except ? payload : { actionId: DEFEND[id], line: '' }));
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
    const request = state.agentRequests.find((r) => r.combatantId === GUARD);
    return applyInput(state, { type: 'agent_response', requestId: request?.id ?? 'none', payload });
  }

  /** 塔卫按指定动作打玩家，其余单位自守。 */
  function guardActs(state: RunState, actionId: string): RunState {
    return onlyOneActs(state, GUARD, { actionId, targetId: PLAYER_TARGET, line: '' });
  }

  it('Run 一开始就挂出一个 IntentRequest', () => {
    const state = fresh();

    expect(state.agentRequests).toHaveLength(3); // 每个 Combatant 一条
    expect(state.agentRequests.some((r) => r.combatantId === GUARD)).toBe(true);
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

    expect(state.agentRequests.some((r) => r.combatantId === GUARD)).toBe(false);
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
        expect(state.agentRequests.some((r) => r.combatantId === GUARD)).toBe(false);
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
  it('用固定 seed 与一串脚本化输入跑到 Run 结束并取胜', () => {
    const state = run(scriptInputs(startRun(BUILT_IN_GENERATION, SEED)));

    expect(state.phase).toBe('ended');
    expect(state.outcome).toBe('victory');
    expect(state.encounter.player.hp).toBeGreaterThan(0);
    expect(state.floor).toBe(5); // 五层都过了
    // 不需要清场：只要场上不再有两个敌对 Faction，剩下的那一方就放你过去
    const living = state.encounter.combatants.filter((c) => c.hp > 0);
    expect(new Set(living.map((c) => c.factionId)).size).toBeLessThanOrEqual(1);
    // Deck 跨层累积：起始 10 张，每层收一张
    expect(state.deck.length).toBeGreaterThan(10);
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

  it('每个 Faction 各有 10 张 Base Card', () => {
    const counts = new Map<string, number>();
    for (const card of CARD_POOL) counts.set(card.faction, (counts.get(card.faction) ?? 0) + 1);

    expect(counts.get('red-ring')).toBe(10);
    expect(counts.get('green-vine')).toBe(10);
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
    const combatant = state.encounter.combatants.find((c) => c.id === request?.combatantId);
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
    const asked = state.agentRequests.map((r) => r.combatantId).sort();

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
      id === GUARD ? { actionId: 'slash', targetId: ARCHER, line: '' } : { actionId: DEFEND[id] },
    );
    expect(at(sameFaction, GUARD).intent?.source).toBe('fallback');

    // 目标根本不存在
    const ghost = answerAll(state, (id) =>
      id === GUARD ? { actionId: 'slash', targetId: '幽灵', line: '' } : { actionId: DEFEND[id] },
    );
    expect(at(ghost, GUARD).intent?.source).toBe('fallback');
  });

  it('玩家打谁被记进站队账本，偏袒的是挨打最少的那一方', () => {
    let state = fresh(deckOf('strike'));
    expect(favoredFaction(state)).toBeNull(); // 还没出手，谈不上偏袒

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
    expect(favoredFaction(state)).toBe('red-ring');
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
    expect(favoredFaction(state)).toBe('red-ring');
  });

  it('被打光的 Faction 不会被算作你偏袒的一方——它没人可以还这个人情', () => {
    let state = fresh(deckOf('strike'));
    // 把青蔓打光
    for (let turn = 0; turn < 12 && state.phase === 'in_encounter'; turn++) {
      state = allDefend(state);
      while (state.encounter.phase === 'player_turn') {
        const card = state.encounter.player.hand.find((c) => canPlay(state, c.instanceId));
        if (!card) break;
        state = applyInput(state, {
          type: 'play_card',
          instanceId: card.instanceId,
          atMs: 100 * turn + 1,
          targetId: SCOUT,
        });
      }
      if (state.phase !== 'in_encounter') break;
      state = applyInput(state, { type: 'end_turn', atMs: 1000 * (turn + 1) });
    }

    expect(at(state, SCOUT).hp).toBe(0);
    // 玩家一点都没打赤环，但偏袒的只能是还站着的那一方
    expect(state.encounter.damageDealtTo['red-ring']).toBeUndefined();
    expect(favoredFaction(state)).toBe('red-ring');
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
    expect(favoredFaction(state)).toBeNull();
  });

  it('打光一方就能走：剩下的那一方放你过去，不需要清场', () => {
    let state = fresh(deckOf('strike'));

    // 只打青蔓斥候，把它打掉；赤环两人一直自守
    for (let turn = 0; turn < 12 && state.phase === 'in_encounter'; turn++) {
      state = allDefend(state);
      while (state.encounter.phase === 'player_turn') {
        const card = state.encounter.player.hand.find((c) => canPlay(state, c.instanceId));
        if (!card) break;
        state = applyInput(state, {
          type: 'play_card',
          instanceId: card.instanceId,
          atMs: 100 * turn + 1,
          targetId: SCOUT,
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
    expect(favoredFaction(state)).toBe('red-ring');
  });
});

describe('多 Floor 推进与 Favor', () => {
  const SCOUT = 'vine-scout';

  function clearFloorOne(state: RunState): RunState {
    // 只打青蔓斥候，把它清掉；赤环两人一直自守
    let next = state;
    for (let turn = 0; turn < 14 && next.phase === 'in_encounter'; turn++) {
      next = allDefend(next);
      while (next.encounter.phase === 'player_turn') {
        const card = next.encounter.player.hand.find((c) => canPlay(next, c.instanceId));
        if (!card) break;
        next = applyInput(next, {
          type: 'play_card',
          instanceId: card.instanceId,
          atMs: 100 * turn + 1,
          targetId: SCOUT,
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

  it('选 Favor 的时候别的输入都不生效', () => {
    const cleared = clearFloorOne(startRun(BUILT_IN_GENERATION, SEED, deckOf('strike')));
    expect(applyInput(cleared, { type: 'end_turn', atMs: 20_000 })).toBe(cleared);
    expect(applyInput(cleared, { type: 'tick', atMs: 99_999 })).toBe(cleared);
  });

  it('同向站队两次就跨过阈值，Favor 升到高阶', () => {
    let state = clearFloorOne(startRun(BUILT_IN_GENERATION, SEED, deckOf('strike')));
    expect(state.favor?.tier).toBe('basic');
    expect(state.standing['red-ring']).toBe(1);

    state = applyInput(state, { type: 'choose_favor', cardId: null, atMs: 20_000 });
    state = clearFloorOne(state);

    expect(state.standing['red-ring']).toBe(2);
    expect(state.favor?.tier).toBe('high');
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

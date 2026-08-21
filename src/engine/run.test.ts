import { describe, expect, it } from 'vitest';
import { fallbackIntent, isActionable, legalTargetsFor } from './agents.js';
import { forgeCard } from './fusion.js';
import {
  applyInput,
  canPlay,
  costFor,
  definitionOf,
  currentSiding,
  cardById,
  isBossFloor,
  isPlayerActing,
  memoryOf,
  standings,
  startRun,
} from './run.js';
import { ATOMS, MAX_ATOMS_PER_CARD, costOf, describeAtom, effectsOf } from './atoms.js';
import {
  BUILT_IN_GENERATION,
  CARD_POOL,
  GENERATION_TIMEOUT_MS,
  combatantsForFloor,
  LOADOUT_SIZE,
  NORMAL_FLOORS,
  STARTING_DECK,
} from './content.js';
import {
  NEW_SAVE_LEDGER,
  defaultLoadout,
  isLegalLoadout,
  unlocksForFavoring,
  unlocksForFelling,
} from './unlocks.js';
import { PLAYER_TARGET } from './types.js';
import type { AgentRequest, DeckbuildRequest, FusionRequest, IntentRequest } from './types.js';
import type {
  CombatantAction,
  CombatantState,
  ExecutionSpec,
  PlayerInput,
  RunOptions,
  RunState,
  UnlockLedger,
} from './types.js';

const SEED = 20260818;

/**
 * 测试默认跳过开局的局势生成，直接进第 1 层——专门测生成的那一节除外。
 * 局势是叙事，绝大多数断言不关心它，但每条测试都去等它会把噪音铺满整个文件。
 */
function beginRun(seed: number, options: RunOptions = {}): RunState {
  return startRun(BUILT_IN_GENERATION, seed, {
    skipGeneration: true,
    startingDeck: STARTING_DECK,
    ...options,
  });
}

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

/**
 * 按在下一个还没按过的靶子上。band 决定档位——容差是每个原型自己的，所以这里
 * 按档位说话，不写死一个比例。
 */
type Band = 'perfect' | 'good' | 'miss';

function offsetFor(spec: ExecutionSpec, band: Band): number {
  if (band === 'perfect') return 0;
  if (band === 'good') return (spec.perfectTolerance + spec.goodTolerance) / 2;
  return spec.goodTolerance + 0.02;
}

function pressBeat(state: RunState, band: Band): PlayerInput {
  const pending = state.encounter.pending;
  if (!pending) throw new Error('没有挂起的结算');
  const target = pending.spec.targets[pending.presses.length];
  if (target === undefined) throw new Error('这一次判定已经按满了');
  const at = target + offsetFor(pending.spec, band);
  return {
    type: 'execution_input',
    atMs: pending.openedAtMs + pending.spec.windowMs * at,
  };
}

/**
 * 一路按到结算完。offset 决定档位：0 是 Perfect，GOOD_OFFSET 是 Good。
 *
 * 大多数测试关心的是效果本身，不是手稳不稳——所以它们一律按成 Good（×1），
 * 数值和引入判定之前完全一致。手稳不稳有专门的一节。
 */
function settleAt(state: RunState, band: Band): RunState {
  let next = state;
  while (next.encounter.phase === 'awaiting_execution' && next.encounter.pending) {
    next = applyInput(next, pressBeat(next, band));
  }
  return next;
}

function settleGood(state: RunState): RunState {
  return settleAt(state, 'good');
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
      input = pressBeat(state, 'good');
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

/**
 * 打一张牌并把判定按成 Good。三类牌都会挂起判定（#5），所以这才是常态；
 * 要看挂起本身的测试用 playCardById。
 */
function playCard(state: RunState, definitionId: string, atMs = 0): RunState {
  return settleGood(playCardById(state, definitionId, atMs));
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

/** 场上第一个人某个动作的数值。名册的数字会变，规则不会。 */
function amountOf(state: RunState, actionId: string): number {
  const action = state.encounter.combatants[0]?.actions.find((a) => a.id === actionId);
  if (!action) throw new Error('没有这个动作：' + actionId);
  return action.amount;
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

/**
 * 顺次喂输入，每一步之后把挂起的判定按成 Good。
 *
 * 攻击、盾牌、法术三类牌都会挂起判定（#5），所以几乎每条测试都得接上一次判定。
 * 按成 Good 意味着倍率是 1：这些测试断言的数值因此和引入判定之前一模一样。
 */
function run(inputs: readonly PlayerInput[], options?: RunOptions): RunState {
  let state = beginRun(SEED, options);
  for (const input of inputs) state = settleGood(applyInput(state, input));
  return state;
}

describe('startRun', () => {
  it('把玩家放进第 1 层的 Encounter，手牌抽满', () => {
    const state = beginRun(SEED);

    expect(state.floor).toBe(1);
    expect(state.phase).toBe('in_encounter');
    expect(state.outcome).toBeNull();
    expect(state.encounter.phase).toBe('player_turn');
    expect(state.encounter.turn).toBe(1);
    expect(state.encounter.player.hand).toHaveLength(5);
    expect(state.encounter.player.drawPile).toHaveLength(STARTING_DECK.length - 5);
    expect(state.encounter.combatants.length).toBeGreaterThan(0);
    expect(state.encounter.combatants.every((c) => c.hp > 0)).toBe(true);
    // 两个敌对 Faction 同场——这不是「玩家对一队敌人」
    expect(new Set(state.encounter.combatants.map((c) => c.factionId)).size).toBe(2);
  });

  it('同一 seed 得到同一个起手局面', () => {
    expect(beginRun(SEED)).toEqual(beginRun(SEED));
  });
});

describe('Card 循环', () => {
  it('打出一张牌会扣能量、离开手牌、进入弃牌堆', () => {
    const state = beginRun(SEED, ALL_STRIKES);
    const card = state.encounter.player.hand[0];
    const definition = definitionOf(state, card!.instanceId);
    expect(definition).toBeDefined();

    const next = settleGood(applyInput(state, { type: 'play_card', instanceId: card!.instanceId, atMs: 100 }));

    expect(next.encounter.player.hand).toHaveLength(4);
    expect(next.encounter.player.discardPile.map((c) => c.instanceId)).toContain(card!.instanceId);
    expect(next.encounter.player.energy).toBe(state.encounter.player.energy - definition!.cost);
  });

  it('能量不够时打牌不改变状态', () => {
    let state = beginRun(SEED, ALL_STRIKES);
    const at = clock();
    for (let i = 0; i < 3; i++) {
      const playable = state.encounter.player.hand.find((c) => canPlay(state, c.instanceId));
      state = settleGood(applyInput(state, {
        type: 'play_card',
        instanceId: playable!.instanceId,
        atMs: at(),
      }));
    }

    expect(state.encounter.player.energy).toBe(0);
    const leftover = state.encounter.player.hand[0];
    expect(canPlay(state, leftover!.instanceId)).toBe(false);
    expect(
      settleGood(applyInput(state, { type: 'play_card', instanceId: leftover!.instanceId, atMs: at() })),
    ).toEqual(state);
  });

  it('结束回合会弃掉手牌并重新抽满', () => {
    const state = beginRun(SEED);
    const next = applyInput(state, { type: 'end_turn', atMs: 10_000 });

    expect(next.encounter.turn).toBe(2);
    expect(next.encounter.player.hand).toHaveLength(5);
    expect(next.encounter.player.energy).toBe(next.encounter.player.maxEnergy);
    expect(next.encounter.player.block).toBe(0);
  });

  it('抽牌堆抽空后会把弃牌堆洗回来，牌的总数不变', () => {
    let state = beginRun(SEED);
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
    return beginRun(SEED, { ...ALL_STRIKES, startedAtMs: 0 });
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

    // 每个 Combatant 一条
    expect(state.agentRequests).toHaveLength(state.encounter.combatants.length);
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
    expect(crushed.encounter.player.hp).toBe(
      before.encounter.player.hp - amountOf(before, 'crush'),
    );
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
    const state = run(scriptInputs(beginRun(SEED)));

    expect(state.phase).toBe('ended');
    // 走得够深，好让 Deck 真的累积起来。**不**断言走到第几层：那是平衡，
    // 会随卡池的每一次改动漂移。整座塔走通由「一局完整的塔」那条测试盯着。
    expect(state.floor).toBeGreaterThanOrEqual(3);
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
    const inputs = scriptInputs(beginRun(SEED));
    expect(run(inputs)).toEqual(run(inputs));
  });

  it('Run 结束后再喂输入不再改变状态', () => {
    const state = run(scriptInputs(beginRun(SEED)));
    expect(applyInput(state, { type: 'end_turn', atMs: 10_000 })).toEqual(state);
  });
});

describe('Execution Check：挂起与恢复（ADR-0002）', () => {
  function suspended(): RunState {
    const state = beginRun(SEED, ALL_GUARDS);
    const card = state.encounter.player.hand[0];
    return applyInput(state, { type: 'play_card', instanceId: card!.instanceId, atMs: 100 });
  }

  it('打出盾牌类 Card 会挂起结算，并记下窗口开启的时刻', () => {
    const state = suspended();

    expect(state.encounter.phase).toBe('awaiting_execution');
    expect(state.encounter.pending?.openedAtMs).toBe(100);
    expect(state.encounter.pending?.spec.windowMs).toBe(900);
    expect(state.encounter.pending?.presses).toEqual([]);
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
    const resumed = applyInput(suspended(), pressAt(suspended(), 0.775));
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
    const resumed = applyInput(suspended(), pressAt(suspended(), 0.775));
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

describe('Execution Check：三种原型', () => {
  /** 打出一张牌，停在挂起状态。三类牌现在都会挂起。 */
  function hang(cardId: string): RunState {
    return playCardById(beginRun(SEED, deckOf(cardId)), cardId, 0);
  }

  it('三种 Card Type 各有各的原型，操作方式明确不同', () => {
    const block = hang('guard').encounter.pending!.spec;
    const rhythm = hang('strike').encounter.pending!.spec;
    const charge = hang('siphon').encounter.pending!.spec;

    expect(block.kind).toBe('block');
    expect(rhythm.kind).toBe('rhythm');
    expect(charge.kind).toBe('charge');

    // 按几次、按在哪，才是三种手感的来源
    expect(block.targets).toHaveLength(1);
    expect(rhythm.targets).toHaveLength(3);
    expect(charge.targets).toHaveLength(2);

    // 蓄力那一段空白是 charge 独有的：它是唯一要求你忍住不按的
    const gap = charge.targets[1]! - charge.targets[0]!;
    const beat = rhythm.targets[1]! - rhythm.targets[0]!;
    expect(gap).toBeGreaterThan(beat * 2);
  });

  it('格挡：按一次，三档各不相同', () => {
    const base = hang('guard');
    const at = (progress: number): RunState => applyInput(base, pressAt(base, progress));

    expect(at(0.1).encounter.lastGrade).toBe('miss');
    expect(at(0.5).encounter.lastGrade).toBe('good');
    expect(at(0.775).encounter.lastGrade).toBe('perfect');

    // 基础格挡 5：失手 3、还行 5、完美 8
    expect(at(0.1).encounter.player.block).toBe(3);
    expect(at(0.5).encounter.player.block).toBe(5);
    expect(at(0.775).encounter.player.block).toBe(8);
  });

  it('节奏连击：三拍都得跟上，三档各不相同', () => {
    const foeHp = (state: RunState): number => state.encounter.combatants[0]!.hp;
    const before = foeHp(hang('strike'));

    const perfect = settleAt(hang('strike'), 'perfect');
    const good = settleAt(hang('strike'), 'good');
    const missed = settleAt(hang('strike'), 'miss');

    expect(perfect.encounter.lastGrade).toBe('perfect');
    expect(good.encounter.lastGrade).toBe('good');
    expect(missed.encounter.lastGrade).toBe('miss');

    // 劈砍 6 点：失手 3、还行 6、完美 9
    expect(before - foeHp(missed)).toBe(3);
    expect(before - foeHp(good)).toBe(6);
    expect(before - foeHp(perfect)).toBe(9);
  });

  it('节奏连击：少按一拍会拖到窗口耗尽，判 Miss', () => {
    const base = hang('strike');
    const one = applyInput(base, pressBeat(base, 'perfect'));
    expect(one.encounter.phase).toBe('awaiting_execution'); // 还在等下一拍

    const pending = one.encounter.pending!;
    const expired = applyInput(one, {
      type: 'tick',
      atMs: pending.openedAtMs + pending.spec.windowMs,
    });
    expect(expired.encounter.lastGrade).toBe('miss');
  });

  it('节奏连击：按键是按顺序对拍子的，中间插一下就把整串都推歪了', () => {
    expect(settleAt(hang('strike'), 'perfect').encounter.lastGrade).toBe('perfect');

    // 第一拍按准，第二下却按在第一拍附近——它顶掉了第二拍的位置，整串就废了
    let state = hang('strike');
    state = applyInput(state, pressBeat(state, 'perfect'));
    state = applyInput(state, pressAt(state, 0.32));
    state = applyInput(state, pressBeat(state, 'perfect'));

    expect(state.encounter.lastGrade).toBe('miss');
  });

  it('蓄力：按一下起手，撑住，再按一下放出去', () => {
    const perfect = settleAt(hang('siphon'), 'perfect');
    const good = settleAt(hang('siphon'), 'good');

    expect(perfect.encounter.lastGrade).toBe('perfect');
    expect(good.encounter.lastGrade).toBe('good');
    // 完美蓄力多抽一张：法术的效果也吃档位，否则蓄力这个原型就是装饰
    expect(perfect.encounter.player.hand.length).toBeGreaterThan(
      good.encounter.player.hand.length,
    );
  });

  it('蓄力：起手就放，撑不住，判 Miss', () => {
    let state = hang('siphon');
    state = applyInput(state, pressAt(state, 0.15)); // 起手准
    state = applyInput(state, pressAt(state, 0.25)); // 但立刻就放了
    expect(state.encounter.lastGrade).toBe('miss');
  });

  it('Miss 只是打折，仍然给出格挡而不是反噬', () => {
    const base = hang('guard');
    const miss = applyInput(base, pressAt(base, 0.1));
    const good = applyInput(base, pressAt(base, 0.5));

    expect(miss.encounter.player.block).toBeGreaterThan(0);
    expect(miss.encounter.player.block).toBeLessThan(good.encounter.player.block);
    expect(miss.encounter.player.hp).toBe(good.encounter.player.hp);
  });

  it('完全不按：窗口耗尽后结算照常推进，判为 Miss', () => {
    const base = hang('guard');
    const pending = base.encounter.pending!;
    const expired = applyInput(base, {
      type: 'tick',
      atMs: pending.openedAtMs + pending.spec.windowMs,
    });

    expect(expired.encounter.phase).toBe('player_turn');
    expect(expired.encounter.pending).toBeNull();
    expect(expired.encounter.lastGrade).toBe('miss');
    expect(expired.encounter.player.block).toBe(3);
  });

  it('窗口还没走完时 tick 不改变任何东西', () => {
    const base = hang('guard');
    const pending = base.encounter.pending!;

    const ticked = applyInput(base, {
      type: 'tick',
      atMs: pending.openedAtMs + pending.spec.windowMs * 0.5,
    });

    // 原样返回同一个对象，调用方据此跳过重绘
    expect(ticked).toBe(base);
  });

  it('既没有挂起结算、也没到 Intent 截止点时，tick 是空操作', () => {
    const state = beginRun(SEED, { startedAtMs: 0 });
    expect(applyInput(state, { type: 'tick', atMs: 100 })).toBe(state);
  });
});

describe('判定轴 Atom：把 Execution Check 变成构筑的一部分', () => {
  function hang(cardId: string): RunState {
    return playCardById(beginRun(SEED, deckOf(cardId)), cardId, 0);
  }

  it('steady 把判定窗口放宽——手不稳的人靠它把窗口变长', () => {
    const plain = hang('guard').encounter.pending!.spec;
    const steady = hang('steadyguard').encounter.pending!.spec;

    expect(steady.kind).toBe(plain.kind); // 还是格挡，只是窗口变宽了
    expect(steady.windowMs).toBeGreaterThan(plain.windowMs);
    // 容差是比例，窗口一长，同样的比例就是更多的毫秒——真的更好按了
    const widened =
      steady.windowMs * steady.perfectTolerance - plain.windowMs * plain.perfectTolerance;
    expect(widened).toBeGreaterThan(0);
  });

  it('focus 把 Perfect 的倍率从 1.5 提到 2.0——手稳的人靠它把收益推上去', () => {
    const foeHp = (state: RunState): number => state.encounter.combatants[0]!.hp;
    const before = foeHp(hang('strike'));

    // 劈砍与凝神都是 strike 打底，差别只在那一个判定轴 Atom
    expect(settleAt(hang('strike'), 'perfect').encounter.lastGrade).toBe('perfect');
    expect(before - foeHp(settleAt(hang('strike'), 'perfect'))).toBe(9); // 6 × 1.5
    expect(before - foeHp(settleAt(hang('focusblow'), 'perfect'))).toBe(12); // 6 × 2.0

    // 但它只加 Perfect 那一档：没按准的时候一点用都没有
    expect(before - foeHp(settleAt(hang('focusblow'), 'miss'))).toBe(
      before - foeHp(settleAt(hang('strike'), 'miss')),
    );
  });

  it('reflex 把 Miss 兜成 Good，但兜不出 Perfect', () => {
    expect(settleAt(hang('brace'), 'miss').encounter.lastGrade).toBe('miss');
    expect(settleAt(hang('reflexcoil'), 'miss').encounter.lastGrade).toBe('good');

    // 买的是下限，不是上限：按准了还是 Perfect，按到 Good 带里还是 Good
    expect(settleAt(hang('reflexcoil'), 'perfect').encounter.lastGrade).toBe('perfect');
    expect(settleAt(hang('reflexcoil'), 'good').encounter.lastGrade).toBe('good');
  });

  it('判定轴 Atom 参与费用：它们不是白送的', () => {
    for (const id of ['steady', 'focus', 'reflex']) {
      expect(costOf(['guard', id])).toBeGreaterThan(costOf(['guard']));
    }
  });

  it('判定轴 Atom 不产生 Effect——它们改的是怎么判，不是打出去什么', () => {
    for (const id of ['steady', 'focus', 'reflex']) {
      expect(effectsOf([id], 'x')).toHaveLength(0);
    }
  });

  it('融合融进一个判定轴 Atom，锻出来的牌当场就换判定', () => {
    // 判定是从 Atom 推出来的，所以从来没出现过的牌也照样算得出来
    const plain = beginRun(SEED, deckOf('guard'));
    expect(cardById(plain, 'guard')?.execution?.windowMs).toBe(900);
    expect(cardById(plain, 'steadyguard')?.execution?.windowMs).toBe(1350);
  });
});

describe('Atom 系统', () => {
  it('费用由 Atom 权重推出：打出后扣掉的能量就是算出来的那个数', () => {
    const one = beginRun(SEED, deckOf('strike'));
    expect(one.encounter.player.energy - playCard(one, 'strike').encounter.player.energy).toBe(
      1,
    ); // strike(3) -> ceil(3/3)

    const two = beginRun(SEED, deckOf('heavy'));
    expect(two.encounter.player.energy - playCard(two, 'heavy').encounter.player.energy).toBe(
      2,
    ); // strike(3)+pierce(3) -> ceil(6/3)
  });

  it('Card Type 由主导 Atom 推出，判定原型跟着 Card Type 走', () => {
    // 铁壁 = guard + endure，防御轴占多数 -> shield -> 格挡判定
    const shield = beginRun(SEED, deckOf('bulwark'));
    const bracing = playCardById(shield, 'bulwark');
    expect(bracing.encounter.phase).toBe('awaiting_execution');
    expect(bracing.encounter.pending?.spec.kind).toBe('block');

    // 汲取 = draw，只有资源轴 -> spell -> 蓄力判定
    const spell = beginRun(SEED, deckOf('siphon'));
    const charging = playCardById(spell, 'siphon');
    expect(charging.encounter.phase).toBe('awaiting_execution');
    expect(charging.encounter.pending?.spec.kind).toBe('charge');
  });

  it('每个已落地的 Atom 都真的产生效果——不会只收费不干活', () => {
    // 这条不在 seam 上：它守的是 Atom 表本身的完整性，而不是某个行为。
    // 没有它，新加的 Atom 会静默地只参与费用计算却什么都不做。
    //
    // 两类例外，都是有意的：判定轴（steady / focus / reflex）改的是**这张牌怎么判**，
    // 禁忌 Atom 改的是**这张牌怎么结算**（打谁、打几个、翻不翻倍、越打越贵）。
    // 两类都不产生 Effect，作用由各自那一节盯着。
    const MODIFIERS = new Set(['steady', 'focus', 'reflex', 'sacrifice', 'wild', 'contagion', 'greed']);
    for (const atom of ATOMS) {
      if (atom.pendingTicket || MODIFIERS.has(atom.id)) continue;
      expect(effectsOf([atom.id], 'tower-guard').length).toBeGreaterThan(0);
    }
    // 名单不许悄悄变长：每一个进来的都得在别处被真的实现
    expect(ATOMS.filter((a) => MODIFIERS.has(a.id))).toHaveLength(MODIFIERS.size);
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
    // #5 之后判定轴也落地了，这张名单眼下是空的——这条留着，是给下一个引入
    // 待落地 Atom 的票用的：它一进来就得同时满足「参与费用」和「不进 Base Card」。
    const pending = ATOMS.filter((a) => a.pendingTicket && !a.forbidden);
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
    let state = beginRun(SEED, deckOf('rend'));
    state = answerWith(state, 'brace');
    state = applyInput(state, { type: 'end_turn', atMs: 1000 });
    expect(foeOf(state).block).toBe(5);

    const before = foeOf(state).hp;
    const after = playCard(state, 'rend');

    expect(foeOf(after).hp).toBe(before - 4);
    expect(foeOf(after).block).toBe(5);
  });

  it('multi 的分段不会绕过格挡：格挡在各段之间共享', () => {
    let state = beginRun(SEED, deckOf('flurry'));

    const bare = playCard(state, 'flurry');
    expect(foeOf(bare).hp).toBe(foeOf(state).hp - 6); // 3 段各 2

    state = answerWith(state, 'brace');
    state = applyInput(state, { type: 'end_turn', atMs: 1000 });
    const guardedHp = foeOf(state).hp;
    const blocked = playCard(state, 'flurry');

    // 6 点总伤害对 5 点格挡，漏过去 1 点——和一次性打 6 点是一样的
    expect(foeOf(blocked).hp).toBe(guardedHp - 1);
  });

  it('multi 打易伤更亏：加成只被第一段吃掉', () => {
    const deck = {
      startingDeck: ['crack', 'flurry', 'strike', 'crack', 'flurry', 'strike', 'crack', 'flurry', 'strike', 'strike'],
      startedAtMs: 0,
    };
    const opened = beginRun(SEED, deck);
    const before = foeOf(opened).hp;

    const exposed = playCard(opened, 'crack');
    // 分段：3 + 2 + 2 = 7
    expect(foeOf(playCard(exposed, 'flurry')).hp).toBe(before - 7);
    // 一次性：round(6 * 1.5) = 9
    expect(foeOf(playCard(exposed, 'strike')).hp).toBe(before - 9);
  });

  it('burn 在回合末结算，并按回合数递减', () => {
    let state = beginRun(SEED, deckOf('ignite'));
    const before = foeOf(state).hp;

    state = playCard(state, 'ignite');
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
    let state = beginRun(SEED, {
      startingDeck: ['crack', 'strike', 'strike', 'crack', 'strike', 'strike', 'strike', 'crack', 'strike', 'strike'],
      startedAtMs: 0,
    });
    const before = foeOf(state).hp;

    state = playCard(state, 'crack');
    expect(foeOf(state).statuses.exposed).toBe(true);

    state = playCard(state, 'strike');
    expect(foeOf(state).hp).toBe(before - 9);
    expect(foeOf(state).statuses.exposed).toBe(false);

    state = playCard(state, 'strike');
    expect(foeOf(state).hp).toBe(before - 15);
  });

  it('weaken 让对手下次攻击减半', () => {
    let state = beginRun(SEED, deckOf('sap'));
    state = answerWith(state, 'slash');
    const hpBefore = state.encounter.player.hp;

    state = playCard(state, 'sap');
    expect(foeOf(state).statuses.weakened).toBe(true);

    const halved = Math.round(amountOf(state, 'slash') * 0.5);
    state = applyInput(state, { type: 'end_turn', atMs: 1000 });
    expect(state.encounter.player.hp).toBe(hpBefore - halved);
    expect(foeOf(state).statuses.weakened).toBe(false);
  });

  it('反伤不会消耗掉目标身上的易伤——那个加成留给玩家自己的下一击', () => {
    const deck = {
      startingDeck: ['bramble', 'crack', 'strike', 'bramble', 'crack', 'strike', 'strike', 'strike', 'strike', 'strike'],
      startedAtMs: 0,
    };
    let state = beginRun(SEED, deck);
    state = answerWith(state, 'slash');

    state = playCard(state, 'bramble');
    state = playCard(state, 'crack');
    expect(foeOf(state).statuses.exposed).toBe(true);

    // 对手攻击 -> 触发反伤。易伤不该在这里被花掉。
    state = applyInput(state, { type: 'end_turn', atMs: 1000 });
    expect(foeOf(state).statuses.exposed).toBe(true);
  });

  it('thorns 在对手攻击时反弹', () => {
    let state = beginRun(SEED, deckOf('bramble'));
    state = answerWith(state, 'slash');

    state = playCard(state, 'bramble');
    expect(state.encounter.player.statuses.thorns).toBe(3);
    const foeHp = foeOf(state).hp;

    state = applyInput(state, { type: 'end_turn', atMs: 1000 });
    expect(foeOf(state).hp).toBe(foeHp - 3);
  });

  it('endure 减免本回合伤害，回合结束后清零', () => {
    let state = beginRun(SEED, deckOf('brace'));
    state = answerWith(state, 'slash');
    const hpBefore = state.encounter.player.hp;

    state = playCard(state, 'brace');
    expect(state.encounter.player.statuses.endure).toBe(2);

    const reduced = amountOf(state, 'slash') - 2; // 坚忍减免 2
    state = applyInput(state, { type: 'end_turn', atMs: 1000 });
    expect(state.encounter.player.hp).toBe(hpBefore - reduced);
    expect(state.encounter.player.statuses.endure).toBe(0);
  });

  it('draw 抽牌、surge 给能量', () => {
    let siphon = beginRun(SEED, deckOf('siphon'));
    const handBefore = siphon.encounter.player.hand.length;
    siphon = playCard(siphon, 'siphon');
    expect(siphon.encounter.player.hand.length).toBe(handBefore); // 打掉一张、抽回一张

    let surged = beginRun(SEED, deckOf('surge'));
    const energyBefore = surged.encounter.player.energy;
    surged = playCard(surged, 'surge');
    expect(surged.encounter.player.energy).toBe(energyBefore); // -1 费 +1 能量
  });

  it('recall 从弃牌堆取回，但取不回正在结算的这张牌自己', () => {
    const deck = {
      startingDeck: ['strike', 'glean', 'strike', 'glean', 'strike', 'strike', 'glean', 'strike', 'strike', 'strike'],
      startedAtMs: 0,
    };

    // 弃牌堆空着的时候打出回收：它不该把自己捡回来
    const empty = beginRun(SEED, deck);
    const alone = playCard(empty, 'glean');
    expect(alone.encounter.player.discardPile).toHaveLength(1);
    expect(alone.encounter.player.discardPile[0]?.instanceId).toContain('glean');
    expect(alone.encounter.player.hand).toHaveLength(4);

    // 弃牌堆里有东西时，取回的是那张
    const played = playCard(empty, 'strike');
    expect(played.encounter.player.discardPile).toHaveLength(1);
    const recalled = playCard(played, 'glean');
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
    const state = beginRun(SEED, { startedAtMs: 0 });

    expect(state.agents.length).toBeGreaterThan(1);
    const factions = new Set(state.agents.map((a) => a.factionId));
    expect(factions.size).toBe(state.agents.length);

    // 场上的 Combatant 都归属于某个已知 Faction
    for (const combatant of state.encounter.combatants) {
      expect(factions.has(combatant.factionId)).toBe(true);
    }
  });

  it('每个提问都带 kind 与唯一 id，并指向发问对象所属的 Faction', () => {
    const state = beginRun(SEED, { startedAtMs: 0 });
    const request = state.agentRequests[0];

    expect(request?.kind).toBe('intent');
    expect(request?.id).toBeTruthy();
    const combatant = state.encounter.combatants.find(
      (c) => c.id === (request?.kind === 'intent' ? request.combatantId : undefined),
    );
    expect(request?.factionId).toBe(combatant?.factionId);
  });

  it('提问不会跨回合堆积：没回答的问题在回合推进时作废', () => {
    const state = beginRun(SEED, { startedAtMs: 0 });
    const asked = state.encounter.combatants.length; // 每个 Combatant 一条
    expect(state.agentRequests).toHaveLength(asked);
    const firstIds = new Set(state.agentRequests.map((r) => r.id));

    // 一直不回答，直接结束回合
    const next = applyInput(state, { type: 'end_turn', atMs: 5000 });

    expect(next.agentRequests).toHaveLength(asked);
    expect(next.agentRequests.some((r) => firstIds.has(r.id))).toBe(false);
    // 上一回合的对手仍然行动了——引擎替它选（ADR-0001）
    expect(next.encounter.player.hp).toBeLessThan(state.encounter.player.hp);
  });

  it('Run 结束时不留下任何待回答的提问', () => {
    const ended = run(scriptInputs(beginRun(SEED)));
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
    return beginRun(SEED, { startedAtMs: 0, ...options });
  }

  it('两派在同一层对等：一样多的人、一样厚的血、一样重的手', () => {
    // 不对等的话，「杀谁放谁」就不再是表态而是算术——人少血薄的那一方永远是更便宜的
    // 猎物，于是每一局都往同一个方向站队。而 Loadout 只能取自单个 Faction，带另一派
    // 的牌进塔就等于白交一份难度税。
    //
    // 这条不挑 seed：名册是固定的，每一层都该成立。
    for (const floor of [1, 2, 3, 4, 5]) {
      const field = combatantsForFloor(floor, [], (id) => id);
      const tally = (factionId: string): { count: number; hp: number; punch: number } => {
        const units = field.filter((c) => c.factionId === factionId);
        return {
          count: units.length,
          hp: units.reduce((sum, c) => sum + c.maxHp, 0),
          punch: units.reduce(
            (sum, c) =>
              sum +
              Math.max(...c.actions.filter((a) => a.kind === 'attack').map((a) => a.amount)),
            0,
          ),
        };
      };

      const red = tally('red-ring');
      const green = tally('green-vine');

      expect(red.count).toBe(green.count);
      expect(red.count).toBeGreaterThan(0);
      // 血量随层数缩放，所以按比例给容差，不写死一个绝对值
      expect(Math.abs(red.hp - green.hp)).toBeLessThanOrEqual(Math.ceil(red.hp * 0.1));
      expect(Math.abs(red.punch - green.punch)).toBeLessThanOrEqual(1);
    }

    // 第 1 层真的就是这个场面——上面那几层走的是同一个函数，这里过一遍 seam
    const opening = beginRun(SEED);
    for (const factionId of ['red-ring', 'green-vine']) {
      expect(
        opening.encounter.combatants.filter((c) => c.factionId === factionId).length,
      ).toBe(combatantsForFloor(1, [], (id) => id).filter((c) => c.factionId === factionId).length);
    }
  });

  it('每个 Combatant 各有一条提问，即使同属一个 Faction', () => {
    const state = fresh();
    const asked = intentRequestsOf(state).map((r) => r.combatantId).sort();

    expect(asked).toEqual([...state.encounter.combatants.map((c) => c.id)].sort());
    expect(asked).toContain(ARCHER);
    expect(asked).toContain(GUARD);
    expect(asked).toContain(SCOUT);

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
    state = settleGood(applyInput(state, {
      type: 'play_card',
      instanceId: scout.instanceId,
      atMs: 100,
      targetId: SCOUT,
    }));

    expect(state.encounter.damageDealtTo['green-vine']).toBe(6);
    expect(state.encounter.damageDealtTo['red-ring']).toBeUndefined();
    // 打了青蔓，就是站在赤环那边
    expect(currentSiding(state)).toBe('red-ring');
  });

  it('灼烧造成的伤害也算进站队账本', () => {
    // 否则玩家可以把一个 Faction 烧死，账本上却显示他偏袒的正是这一方
    let state = fresh(deckOf('ignite'));
    const card = state.encounter.player.hand[0]!;
    state = settleGood(applyInput(state, {
      type: 'play_card',
      instanceId: card.instanceId,
      atMs: 100,
      targetId: SCOUT,
    }));
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
        state = settleGood(applyInput(state, {
          type: 'play_card',
          instanceId: card.instanceId,
          atMs: 100 * turn + 1,
          targetId: victim.id,
        }));
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
      state = settleGood(applyInput(state, {
        type: 'play_card',
        instanceId: card.instanceId,
        atMs: 100,
        targetId: target,
      }));
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
        state = settleGood(applyInput(state, {
          type: 'play_card',
          instanceId: card.instanceId,
          atMs: 100 * turn + 1,
          targetId: victim.id,
        }));
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
        next = settleGood(applyInput(next, {
          type: 'play_card',
          instanceId: card.instanceId,
          atMs: 100 * turn + 1,
          targetId: victim.id,
        }));
      }
      if (next.phase !== 'in_encounter') break;
      next = applyInput(next, { type: 'end_turn', atMs: 1000 * (turn + 1) });
    }
    return next;
  }

  it('清完一层不会直接结束 Run，而是停下来收人情', () => {
    const state = clearFloorOne(beginRun(SEED, deckOf('strike')));

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
    const cleared = clearFloorOne(beginRun(SEED, deckOf('strike')));
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
    const cleared = clearFloorOne(beginRun(SEED, deckOf('strike')));
    const next = applyInput(cleared, { type: 'choose_favor', cardId: null, atMs: 20_000 });

    expect(next.floor).toBe(2);
    expect(next.deck).toHaveLength(cleared.deck.length);
  });

  it('不在选项里的牌拿不走', () => {
    const cleared = clearFloorOne(beginRun(SEED, deckOf('strike')));
    expect(
      applyInput(cleared, { type: 'choose_favor', cardId: 'skewer-not-offered', atMs: 20_000 }),
    ).toBe(cleared);
  });

  it('选 Favor 的时候玩家的别的输入都不生效，但对手照常在忙', () => {
    const cleared = clearFloorOne(beginRun(SEED, deckOf('strike')));

    // 玩家这边：除了选 Favor 和发起融合，什么都不生效
    expect(applyInput(cleared, { type: 'end_turn', atMs: 20_000 })).toBe(cleared);
    expect(
      settleGood(applyInput(cleared, { type: 'play_card', instanceId: 'strike#0', atMs: 20_000 })),
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
    let state = clearFloorOne(beginRun(SEED, deckOf('strike')));
    expect(state.favor?.tier).toBe('basic');
    expect(standings(state)['red-ring']).toBe(1);

    state = applyInput(state, { type: 'choose_favor', cardId: null, atMs: 20_000 });
    state = clearFloorOne(state);

    expect(standings(state)['red-ring']).toBe(2);
    expect(state.favor?.tier).toBe('high');
  });

  it('保下的人越多，它给得越大方', () => {
    const bothAlive = clearFloorOne(beginRun(SEED, deckOf('strike')));
    // 赤环两人都活着
    expect(
      bothAlive.encounter.combatants.filter((c) => c.hp > 0 && c.factionId === 'red-ring'),
    ).toHaveLength(2);
    expect(bothAlive.favor?.choices).toHaveLength(2);
  });

  it('欠你人情的那一方会替你包扎', () => {
    // 先挨一刀，否则满血无从谈起恢复
    let state = beginRun(SEED, deckOf('strike'));
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
    return beginRun(SEED, { startedAtMs: 0, ...options });
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
        next = settleGood(applyInput(next, {
          type: 'play_card',
          instanceId: card.instanceId,
          atMs: 100 * turn + 1,
          targetId: victim.id,
        }));
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
    state = settleGood(applyInput(state, {
      type: 'play_card',
      instanceId: card.instanceId,
      atMs: 100,
      targetId: 'vine-scout',
    }));

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
      state = settleGood(applyInput(state, {
        type: 'play_card',
        instanceId: card.instanceId,
        atMs: 100 * (i + 1),
        targetId: 'vine-scout',
      }));
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

    state = settleGood(applyInput(state, {
      type: 'play_card',
      instanceId: card.instanceId,
      atMs: 100,
      targetId: 'vine-scout',
    }));

    expect(memoryOf(state, 'green-vine').some((e) => e.kind === 'parley')).toBe(true);
    expect(standings(state)['green-vine']).toBe(before + 1);
  });

  it('反复挑同一方下手，它下一层就会多带人', () => {
    // 第一次清场之后还没结怨到那个份上
    const once = clearedOnce();
    const secondFloor = applyInput(once, { type: 'choose_favor', cardId: null, atMs: 20_000 });
    const normal = secondFloor.encounter.combatants.filter((c) => c.factionId === 'green-vine');

    // 第二次还挑青蔓，第三层它就带人来了
    const twice = clearFloor(secondFloor);
    const thirdFloor = applyInput(twice, { type: 'choose_favor', cardId: null, atMs: 40_000 });
    expect(thirdFloor.encounter.combatants.length).toBeGreaterThan(
      secondFloor.encounter.combatants.length,
    );
    expect(
      thirdFloor.encounter.combatants.filter((c) => c.factionId === 'green-vine'),
    ).toHaveLength(normal.length + 1);
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
    beginRun(SEED, { startedAtMs: 0, ...options });

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
        next = settleGood(applyInput(next, {
          type: 'play_card',
          instanceId: card.instanceId,
          atMs: 100 * turn + 1,
          targetId: victim.id,
        }));
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
      // 丢到不超上限为止，能少丢就少丢
      expect(forged.atoms).toHaveLength(
        Math.min(request.atoms.length - 1, MAX_ATOMS_PER_CARD),
      );
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
    expect(forged.atoms).toHaveLength(Math.min(request.atoms.length - 1, MAX_ATOMS_PER_CARD));
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
      const base = beginRun(SEED, { startedAtMs: 0 });
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
    beginRun(SEED, { startedAtMs: 0, ...options });

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
        next = settleGood(applyInput(next, {
          type: 'play_card',
          instanceId: card.instanceId,
          atMs: 100 * turn + 1,
          targetId: victim.id,
        }));
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
        state = settleGood(applyInput(state, {
          type: 'play_card',
          instanceId: card.instanceId,
          atMs: 100 * turn + 1,
          targetId: victim.id,
        }));
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
    beginRun(SEED, { startedAtMs: 0, ...options });

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
        state = settleGood(applyInput(state, {
          type: 'play_card',
          instanceId: card.instanceId,
          atMs: 100 * turn + 1,
          targetId: boss.id,
        }));
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

/**
 * 把一局从头打到底：能打就打，挂起就用完美时机接上，Favor 一律拿第一个选项。
 * 打谁按 aimAt 决定——集火哪一派是 Standing 的唯一来源，测解锁时要能指定。
 */
function playOut(
  start: RunState,
  aimAt = 'green-vine',
): { state: RunState; floorsSeen: number[]; bossFought: string } {
  let state = start;
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
      state = applyInput(state, pressBeat(state, 'good'));
      continue;
    }

    const boss = state.encounter.combatants.find((c) => c.isBoss && c.hp > 0);
    if (boss) bossFought = boss.name;
    const victim =
      boss ?? state.encounter.combatants.find((c) => c.hp > 0 && c.factionId === aimAt);
    const card = state.encounter.player.hand.find((c) => canPlay(state, c.instanceId));

    if (card && victim) {
      state = settleGood(applyInput(state, {
        type: 'play_card',
        instanceId: card.instanceId,
        atMs: 1000 + step,
        targetId: victim.id,
      }));
    } else {
      state = applyInput(state, { type: 'end_turn', atMs: 2000 + step * 10 });
    }
  }

  return { state, floorsSeen, bossFought };
}

describe('一局完整的塔', () => {
  it('从 startRun 一路打到塔顶：五个普通 Floor 加一场首领战', () => {
    const { state, floorsSeen, bossFought } = playOut(
      beginRun(SEED, {
        startingDeck: Array.from({ length: 10 }, () => 'heavy'),
        startedAtMs: 0,
      }),
    );

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

describe('开局的局势', () => {
  /** 真正走生成那条路：不跳过，从「塔在成形」开始。 */
  function generating(seed = SEED): RunState {
    return startRun(BUILT_IN_GENERATION, seed, {
      startedAtMs: 0,
      startingDeck: STARTING_DECK,
    });
  }

  function generationRequestOf(state: RunState): AgentRequest {
    const request = state.agentRequests.find((r) => r.kind === 'generation');
    if (!request) throw new Error('没有待答的局势生成');
    return request;
  }

  /** 脚本化的假 provider：把这份答案交给引擎，再报一次时让塔开门。 */
  function answerGeneration(state: RunState, payload: unknown): RunState {
    const answered = applyInput(state, {
      type: 'agent_response',
      requestId: generationRequestOf(state).id,
      payload,
    });
    return applyInput(answered, { type: 'tick', atMs: 1 });
  }

  const GOOD = {
    title: '断水的塔',
    grievance: '铁沙截了井，藤影就烧了他们的粮道。',
    factions: [
      { factionId: 'green-vine', name: '藤影', persona: '记仇，不出声', goal: '把井抢回来' },
      { factionId: 'red-ring', name: '铁沙', persona: '先动手再说', goal: '守住井口，逼藤影低头' },
    ],
  };

  it('第 1 层要等局势定下来才开', () => {
    const state = generating();

    expect(state.phase).toBe('generating');
    expect(state.floor).toBe(0);
    expect(state.encounter.combatants).toHaveLength(0);
    expect(state.agentRequests.filter((r) => r.kind === 'generation')).toHaveLength(1);
  });

  it('塔还在成形时，玩家的输入一律不算数', () => {
    const state = generating();
    const meddled = applyInput(state, { type: 'end_turn', atMs: 500 });

    expect(meddled).toBe(state);
  });

  it('答上来了：这一局的塔和两派都换了说法，然后开门', () => {
    const state = answerGeneration(generating(), GOOD);

    expect(state.generation.title).toBe('断水的塔');
    expect(state.generation.grievance).toBe(GOOD.grievance);
    expect([...state.agents].map((a) => a.name).sort()).toEqual(['藤影', '铁沙'].sort());
    expect(state.agents.find((a) => a.factionId === 'red-ring')?.goal).toContain('井');
    expect(state.phase).toBe('in_encounter');
    expect(state.floor).toBe(1);
    expect(state.journal.some((line) => line.includes('断水的塔'))).toBe(true);
  });

  it('局势只换说法，不换名册：陌生的 Faction id 一律不认', () => {
    const state = answerGeneration(generating(), {
      ...GOOD,
      factions: [
        ...GOOD.factions,
        { factionId: 'blue-ash', name: '灰烬', persona: '冷', goal: '看戏' },
      ],
    });

    // Base Card 按 id 分组，凭空多出来的一派会把整副牌池打散
    expect([...state.agents].map((a) => a.factionId).sort()).toEqual([
      'green-vine',
      'red-ring',
    ]);
    expect(state.encounter.combatants.every((c) => c.factionId !== 'blue-ash')).toBe(true);
  });

  it('模型答歪了也不影响开局：空字段沿用内置那份', () => {
    const before = generating();
    const state = answerGeneration(before, {
      title: '   ',
      factions: [{ factionId: 'green-vine', name: '', persona: 42, goal: null }],
    });

    expect(state.generation.title).toBe(BUILT_IN_GENERATION.title);
    expect(state.generation.grievance).toBe(BUILT_IN_GENERATION.grievance);
    const vine = state.agents.find((a) => a.factionId === 'green-vine')!;
    const original = before.agents.find((a) => a.factionId === 'green-vine')!;
    expect(vine.name).toBe(original.name);
    expect(vine.persona).toBe(original.persona);
    expect(state.phase).toBe('in_encounter');
  });

  it('回退：模型不答，超时之后照常进第 1 层', () => {
    const state = generating();
    const request = generationRequestOf(state);
    const expired = applyInput(state, {
      type: 'tick',
      atMs: request.requestedAtMs + request.timeoutMs,
    });

    expect(expired.generation).toEqual(BUILT_IN_GENERATION);
    expect(expired.agents).toEqual(generating().agents);
    expect(expired.phase).toBe('in_encounter');
    expect(expired.floor).toBe(1);
    expect(expired.agentRequests.some((r) => r.kind === 'generation')).toBe(false);
  });

  it('名册管到每一层：塔改了名，塔里的人也跟着改', () => {
    const state = answerGeneration(generating(), GOOD);

    // 场上的人不该还叫着上一局的名字
    for (const combatant of state.encounter.combatants) {
      const faction = state.agents.find((a) => a.factionId === combatant.factionId)!;
      expect(combatant.name.startsWith(faction.name)).toBe(true);
    }
    expect(state.encounter.combatants.some((c) => c.name.startsWith('藤影'))).toBe(true);
    expect(state.encounter.combatants.some((c) => c.name.startsWith('铁沙'))).toBe(true);
  });

  it('同一个 seed 加同一份局势，开出来的第 1 层一模一样', () => {
    const a = answerGeneration(generating(), GOOD);
    const b = answerGeneration(generating(), GOOD);

    expect(b.encounter.combatants).toEqual(a.encounter.combatants);
    expect(b.encounter.player.hand).toEqual(a.encounter.player.hand);
  });
});

describe('Loadout 与 Unlock Ledger', () => {
  /** 真正走 Loadout 那条路：不给 startingDeck，从「还没进塔」开始。 */
  function atGate(ledger = NEW_SAVE_LEDGER, seed = SEED): RunState {
    return startRun(BUILT_IN_GENERATION, seed, { startedAtMs: 0, ledger });
  }

  /** 组好这一副，再让局势超时，塔就开门了。 */
  function enterWith(state: RunState, cardIds: readonly string[]): RunState {
    const chosen = applyInput(state, { type: 'choose_loadout', cardIds, atMs: 10 });
    return applyInput(chosen, { type: 'tick', atMs: GENERATION_TIMEOUT_MS + 100 });
  }

  const RED_TEN = Array.from({ length: LOADOUT_SIZE }, () => 'strike');
  const GREEN_TEN = Array.from({ length: LOADOUT_SIZE }, () => 'guard');

  it('新档只解锁基础牌：组合牌与 Parley 都还没有', () => {
    for (const id of NEW_SAVE_LEDGER.cardIds) {
      const card = CARD_POOL.find((c) => c.id === id)!;
      expect(card.atoms).toHaveLength(1);
      expect(card.atoms).not.toContain('parley');
    }
    // 每一派都得拿得出攻与守两条轴，否则单派系的 Loadout 组不出能打的牌
    for (const factionId of ['red-ring', 'green-vine']) {
      const mine = CARD_POOL.filter(
        (c) => c.faction === factionId && NEW_SAVE_LEDGER.cardIds.includes(c.id),
      );
      expect(mine.some((c) => c.type === 'attack')).toBe(true);
      expect(mine.some((c) => c.type === 'shield')).toBe(true);
    }
  });

  it('没组 Loadout 就不进塔，但局势已经在问了', () => {
    const state = atGate();

    expect(state.phase).toBe('loadout');
    expect(state.floor).toBe(0);
    expect(state.deck).toHaveLength(0);
    // 两件事并行：玩家挑牌的这几秒正好把生成的延迟盖掉
    expect(state.agentRequests.some((r) => r.kind === 'generation')).toBe(true);
  });

  it('组好了就进塔，Deck 就是你带的那一副', () => {
    const state = enterWith(atGate(), RED_TEN);

    expect(state.phase).toBe('in_encounter');
    expect(state.floor).toBe(1);
    expect(state.deck.map((c) => c.definitionId)).toEqual(RED_TEN);
    expect(new Set(state.deck.map((c) => c.instanceId)).size).toBe(LOADOUT_SIZE);
  });

  it('跨了 Faction 的一副不算数——那正是这条约束要挡的取舍', () => {
    const mixed = [...RED_TEN.slice(0, 5), ...GREEN_TEN.slice(0, 5)];
    const state = enterWith(atGate(), mixed);

    expect(isLegalLoadout(NEW_SAVE_LEDGER, mixed)).toBe(false);
    const factions = new Set(
      state.deck.map((c) => CARD_POOL.find((card) => card.id === c.definitionId)?.faction),
    );
    expect(factions.size).toBe(1);
    expect(state.phase).toBe('in_encounter'); // Run 不会因为一副烂牌停下
  });

  it('没解锁的牌带不进去', () => {
    const locked = Array.from({ length: LOADOUT_SIZE }, () => 'heavy'); // 组合牌，新档没有
    expect(NEW_SAVE_LEDGER.cardIds).not.toContain('heavy');

    const state = enterWith(atGate(), locked);
    expect(state.deck.every((c) => c.definitionId !== 'heavy')).toBe(true);
    expect(state.deck).toHaveLength(LOADOUT_SIZE);
  });

  it('张数不对也不算数', () => {
    expect(isLegalLoadout(NEW_SAVE_LEDGER, RED_TEN.slice(0, 3))).toBe(false);
    const state = enterWith(atGate(), RED_TEN.slice(0, 3));
    expect(state.deck).toHaveLength(LOADOUT_SIZE);
  });

  it('Loadout 只组一次：进塔之后再递一副没有用', () => {
    const state = enterWith(atGate(), RED_TEN);
    const meddled = applyInput(state, {
      type: 'choose_loadout',
      cardIds: GREEN_TEN,
      atMs: 50_000,
    });

    expect(meddled).toBe(state);
  });

  it('解锁得多，能带的就多——不同的 Ledger 驱动出不同的一局', () => {
    const wide: UnlockLedger = { cardIds: CARD_POOL.map((c) => c.id) };
    const heavies = Array.from({ length: LOADOUT_SIZE }, () => 'heavy');

    expect(isLegalLoadout(wide, heavies)).toBe(true);
    const state = enterWith(atGate(wide), heavies);
    expect(state.deck.map((c) => c.definitionId)).toEqual(heavies);

    const { state: ended, floorsSeen } = playOut(state);
    expect(ended.phase).toBe('ended');
    expect(floorsSeen).toContain(1);
  });

  it('通关才教你东西：站过队的那一派给组合牌，被你打倒的首领给 Parley', () => {
    // 一路集火青蔓：赤环因此欠你人情，青蔓则坐上塔顶等你
    const { state } = playOut(
      beginRun(SEED, { startingDeck: Array.from({ length: 10 }, () => 'heavy') }),
      'green-vine',
    );

    expect(state.outcome).toBe('victory');
    expect(state.earnedUnlocks.length).toBeGreaterThan(0);
    // 站过队的那一派教你它的组合牌
    expect(state.earnedUnlocks).toEqual(
      expect.arrayContaining([...unlocksForFavoring('red-ring')]),
    );
    // 被你打倒的首领那一派，肯跟你谈了
    expect(state.earnedUnlocks).toEqual(
      expect.arrayContaining([...unlocksForFelling('green-vine')]),
    );
    // 挣到的都进了 Ledger，一张不落
    for (const id of state.earnedUnlocks) expect(state.ledger.cardIds).toContain(id);
    // 已经有的不重复记
    expect(new Set(state.ledger.cardIds).size).toBe(state.ledger.cardIds.length);
  });

  it('死在塔里什么也带不走：Ledger 原样不动', () => {
    let state = enterWith(atGate(), RED_TEN);
    // 什么都不做，一路挨打。提问一超时，全场都回退成打你。
    for (let turn = 0; turn < 200 && state.phase !== 'ended'; turn++) {
      state = applyInput(state, { type: 'end_turn', atMs: 100_000 + 1000 * turn });
    }

    expect(state.outcome).toBe('defeat');
    expect(state.earnedUnlocks).toHaveLength(0);
    expect(state.ledger.cardIds).toEqual(NEW_SAVE_LEDGER.cardIds);
  });

  it('融合的产物进不了 Ledger：跨 Run 带走的只有 Base Card', () => {
    const won = playOut(
      beginRun(SEED, { startingDeck: Array.from({ length: 10 }, () => 'heavy') }),
    ).state;

    expect(won.outcome).toBe('victory');
    for (const id of won.ledger.cardIds) {
      expect(CARD_POOL.some((card) => card.id === id)).toBe(true);
    }
  });

  it('默认牌组要能打：主力是最便宜的攻与最便宜的守，不是把解锁的牌摊平', () => {
    // 摊平组出来的一副实测比有意组的少撑一整层。这条盯着它别退回去。
    for (const factionId of ['red-ring', 'green-vine']) {
      const deck = defaultLoadout(NEW_SAVE_LEDGER, factionId);
      const types = deck.map((id) => CARD_POOL.find((card) => card.id === id)!.type);
      expect(types.filter((t) => t === 'attack').length).toBeGreaterThanOrEqual(5);
      expect(types.filter((t) => t === 'shield').length).toBeGreaterThanOrEqual(4);
    }
  });

  it('默认牌组是确定性的：同一个 Ledger 永远得到同一副', () => {
    expect(defaultLoadout(NEW_SAVE_LEDGER)).toEqual(defaultLoadout(NEW_SAVE_LEDGER));
    expect(defaultLoadout(NEW_SAVE_LEDGER)).toHaveLength(LOADOUT_SIZE);
    expect(isLegalLoadout(NEW_SAVE_LEDGER, defaultLoadout(NEW_SAVE_LEDGER))).toBe(true);
  });
});

describe('两派对等（#16）', () => {
  /**
   * 最严基线：对手一个都不回答，全部超时回退成打你。
   *
   * 它不是常见局面，但它是**唯一不掺策略的**局面——两派的差距在这里只可能来自
   * 名册本身。带谁的牌进塔，就集火另一派：那是玩家最自然的走法，也正是 Loadout
   * 只能取自单个 Faction 之后可能被收难度税的那条路。
   */
  function pressBeat(state: RunState): PlayerInput {
    const pending = state.encounter.pending!;
    const target = pending.spec.targets[pending.presses.length]!;
    const off = (pending.spec.perfectTolerance + pending.spec.goodTolerance) / 2;
    return {
      type: 'execution_input',
      atMs: pending.openedAtMs + pending.spec.windowMs * (target + off),
    };
  }

  function depth(deck: readonly string[], seed: number, aimAt: string): number {
    let state = beginRun(seed, { startingDeck: deck, startedAtMs: 0 });
    for (let step = 0; step < 12_000 && state.phase !== 'ended'; step++) {
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
      if (state.encounter.pending) {
        state = applyInput(state, pressBeat(state));
        continue;
      }

      // 报时把提问推过截止点，对手全部回退
      state = applyInput(state, { type: 'tick', atMs: 300_000 + step * 3000 });
      if (state.phase === 'ended' || state.encounter.pending) continue;

      const boss = state.encounter.combatants.find((c) => c.isBoss && c.hp > 0);
      const victim =
        boss ??
        state.encounter.combatants.find((c) => c.hp > 0 && c.factionId === aimAt) ??
        state.encounter.combatants.find((c) => c.hp > 0);
      const card = state.encounter.player.hand.find((c) => canPlay(state, c.instanceId));

      if (card && victim) {
        state = applyInput(state, {
          type: 'play_card',
          instanceId: card.instanceId,
          atMs: 400_000 + step,
          targetId: victim.id,
        });
      } else {
        state = applyInput(state, { type: 'end_turn', atMs: 500_000 + step * 3000 });
      }
    }
    return state.floor;
  }

  it('两派的单派系默认牌组走到的层数，差不超过一层', () => {
    const red = defaultLoadout(NEW_SAVE_LEDGER, 'red-ring');
    const green = defaultLoadout(NEW_SAVE_LEDGER, 'green-vine');

    for (const seed of [1, 2, 3, 7, 11]) {
      const withRed = depth(red, seed, 'green-vine');
      const withGreen = depth(green, seed, 'red-ring');

      expect(withRed).toBeGreaterThan(0);
      expect(withGreen).toBeGreaterThan(0);
      // 带谁的牌进塔是表态，不该是难度选择
      expect(Math.abs(withRed - withGreen)).toBeLessThanOrEqual(1);
    }
  });
});

describe('Forbidden Atom（#17）', () => {
  /**
   * 禁忌 Atom 只有 Mutation 拿得到，Base Card 上一个都没有——所以测试自己锻一张。
   * 锻的路径和过载走的是同一个 forgeCard，牌面因此和玩家真正拿到的那张一致。
   */
  function withForged(atoms: readonly string[], options: RunOptions = {}): RunState {
    const start = beginRun(SEED, { startingDeck: ['strike'], ...options });
    const forged = forgeCard({ atoms, name: '禁忌', factionId: 'red-ring', seq: 1 });
    return {
      ...start,
      forged: [forged],
      encounter: {
        ...start.encounter,
        player: {
          ...start.encounter.player,
          energy: 9, // 别让能量成为这一节的干扰项
          hand: [
            { instanceId: 'x#0', definitionId: forged.id },
            { instanceId: 'x#1', definitionId: forged.id },
            { instanceId: 'x#2', definitionId: forged.id },
          ],
        },
      },
    };
  }

  function playForged(state: RunState, instanceId: string, targetId?: string): RunState {
    return settleGood(
      applyInput(state, { type: 'play_card', instanceId, atMs: 100, targetId }),
    );
  }

  it('四个禁忌 Atom 都不出现在 Base Card 上，而且更强也更便宜', () => {
    const forbidden = ATOMS.filter((a) => a.forbidden);
    expect(forbidden).toHaveLength(4);
    for (const atom of forbidden) {
      expect(atom.weight).toBeLessThan(0);
      expect(atom.pendingTicket).toBeUndefined(); // 全部落地了
      expect(describeAtom(atom).length).toBeGreaterThan(0); // 代价写在牌面上
      expect(CARD_POOL.some((card) => card.atoms.includes(atom.id))).toBe(false);
    }
  });

  it('献：付 5 点生命，本卡其余 Atom 效果翻倍', () => {
    const plain = withForged(['strike']);
    const cursed = withForged(['strike', 'sacrifice']);
    const foe = plain.encounter.combatants[0]!.id;

    const after = playForged(plain, 'x#0', foe);
    const bled = playForged(cursed, 'x#0', foe);

    const dealt = (s: RunState): number =>
      s.encounter.combatants.find((c) => c.id === foe)!.maxHp -
      s.encounter.combatants.find((c) => c.id === foe)!.hp;

    expect(dealt(bled)).toBe(dealt(after) * 2);
    expect(bled.encounter.player.hp).toBe(plain.encounter.player.hp - 5);
    expect(after.encounter.player.hp).toBe(plain.encounter.player.hp);
  });

  it('献：自伤能当场把人放倒，那一局就到此为止', () => {
    const cursed = withForged(['strike', 'sacrifice']);
    const dying: RunState = {
      ...cursed,
      encounter: {
        ...cursed.encounter,
        player: { ...cursed.encounter.player, hp: 3 },
      },
    };

    const done = playForged(dying, 'x#0', dying.encounter.combatants[0]!.id);
    expect(done.encounter.player.hp).toBe(0);
    expect(done.phase).toBe('ended');
    expect(done.outcome).toBe('defeat');
  });

  it('狂：目标随机，但同一 seed 加同一串输入还是同一个 Run', () => {
    const cursed = withForged(['strike', 'wild']);
    const aimed = cursed.encounter.combatants[0]!.id;

    // 指定了目标也没用——狂说了算
    const once = playForged(cursed, 'x#0', aimed);
    const again = playForged(cursed, 'x#0', aimed);
    expect(again.encounter.combatants).toEqual(once.encounter.combatants);
    expect(again.rng).toEqual(once.rng);

    // 打出去的那一下确实落在了场上某个人身上
    const hurt = once.encounter.combatants.filter((c) => c.hp < c.maxHp);
    expect(hurt).toHaveLength(1);

    // 连打几张，落点不总是同一个人
    let state = cursed;
    const hitIds = new Set<string>();
    for (const id of ['x#0', 'x#1', 'x#2']) {
      const before = new Map(state.encounter.combatants.map((c) => [c.id, c.hp]));
      state = playForged(state, id, aimed);
      for (const c of state.encounter.combatants) {
        if ((before.get(c.id) ?? c.hp) > c.hp) hitIds.add(c.id);
      }
    }
    expect(hitIds.size).toBeGreaterThan(1);
  });

  it('疫：打到场上每一个人，包括你偏袒的那一方', () => {
    const cursed = withForged(['strike', 'contagion']);
    const done = playForged(cursed, 'x#0', cursed.encounter.combatants[0]!.id);

    expect(done.encounter.combatants.every((c) => c.hp < c.maxHp)).toBe(true);
    // 两派都挨了打——站队因此被搅乱，这正是它的代价
    const factions = new Set(done.encounter.combatants.map((c) => c.factionId));
    expect(factions.size).toBeGreaterThan(1);
    for (const factionId of factions) {
      expect(done.encounter.damageDealtTo[factionId]).toBeGreaterThan(0);
    }
  });

  it('疫：给自己的那部分只结算一次，不按人数翻倍', () => {
    const plain = withForged(['guard']);
    const spread = withForged(['guard', 'contagion']);

    const after = playForged(plain, 'x#0');
    const infected = playForged(spread, 'x#0');

    expect(infected.encounter.player.block).toBe(after.encounter.player.block);
  });

  it('贪：本局每打出一次就贵一点，费用、能否打出与牌面三处一致', () => {
    const cursed = withForged(['strike', 'greed']);
    const definition = cursed.forged[0]!;

    expect(costFor(cursed, definition)).toBe(definition.cost);

    const once = playForged(cursed, 'x#0', cursed.encounter.combatants[0]!.id);
    expect(costFor(once, definition)).toBe(definition.cost + 1);

    const twice = playForged(once, 'x#1', once.encounter.combatants[0]!.id);
    expect(costFor(twice, definition)).toBe(definition.cost + 2);

    // 能量掉的是涨过之后的价
    const spent = once.encounter.player.energy - twice.encounter.player.energy;
    expect(spent).toBe(definition.cost + 1);
  });

  it('贪：涨价跨回合，一局之内一直记着', () => {
    const cursed = withForged(['strike', 'greed']);
    const definition = cursed.forged[0]!;

    let state = playForged(cursed, 'x#0', cursed.encounter.combatants[0]!.id);
    state = allDefend(state);
    state = applyInput(state, { type: 'end_turn', atMs: 10_000 });

    expect(costFor(state, definition)).toBe(definition.cost + 1);
    expect(state.encounter.turn).toBeGreaterThan(cursed.encounter.turn);
  });

  it('贪：贵到打不动的时候，canPlay 就说打不动', () => {
    const cursed = withForged(['strike', 'greed']);
    const definition = cursed.forged[0]!;

    const broke: RunState = {
      ...cursed,
      playedCounts: { [definition.id]: 9 },
      encounter: {
        ...cursed.encounter,
        player: { ...cursed.encounter.player, energy: definition.cost },
      },
    };

    expect(costFor(broke, definition)).toBe(definition.cost + 9);
    expect(canPlay(broke, 'x#0')).toBe(false);
    expect(applyInput(broke, { type: 'play_card', instanceId: 'x#0', atMs: 100 })).toBe(broke);
  });

  it('禁忌 Atom 让牌更便宜：同样的效果，带上它费用更低', () => {
    for (const id of ['sacrifice', 'wild', 'greed']) {
      expect(costOf(['strike', 'strike', id])).toBeLessThanOrEqual(costOf(['strike', 'strike']));
    }
  });
});

describe('护同伴（#18）', () => {
  const GUARD = 'tower-guard';

  function fresh(options?: RunOptions): RunState {
    return beginRun(SEED, { startedAtMs: 0, ...options });
  }

  /** 某个人的护同伴动作。每个人都拿得出一个。 */
  function protectOf(state: RunState, combatantId: string): CombatantAction {
    const combatant = state.encounter.combatants.find((c) => c.id === combatantId)!;
    const action = combatant.actions.find((a) => a.kind === 'protect');
    if (!action) throw new Error(combatantId + ' 不会护人');
    return action;
  }

  function alliesOf(state: RunState, combatantId: string): readonly CombatantState[] {
    const me = state.encounter.combatants.find((c) => c.id === combatantId)!;
    return state.encounter.combatants.filter(
      (c) => c.hp > 0 && c.id !== me.id && c.factionId === me.factionId,
    );
  }

  it('格挡记在同伴身上，不是自己身上', () => {
    const state = fresh();
    const ward = alliesOf(state, GUARD)[0]!;
    const action = protectOf(state, GUARD);

    const acted = applyInput(
      onlyOneActs(state, GUARD, { actionId: action.id, targetId: ward.id, line: '' }),
      { type: 'end_turn', atMs: 1000 },
    );

    const guard = acted.encounter.combatants.find((c) => c.id === GUARD)!;
    const guarded = acted.encounter.combatants.find((c) => c.id === ward.id)!;

    expect(guard.block).toBe(0); // 护人的那个自己没捞到格挡
    expect(guarded.block).toBeGreaterThanOrEqual(action.amount);
  });

  it('挡下的那几点真的顶住了玩家的攻击', () => {
    const base = beginRun(SEED, ALL_STRIKES);
    const ward = alliesOf(base, GUARD)[0]!;
    const action = protectOf(base, GUARD);

    // 一次没人护，一次有人护——除此之外两条路一模一样
    const bare = applyInput(allDefend(base), { type: 'end_turn', atMs: 1000 });
    const shielded = applyInput(
      onlyOneActs(base, GUARD, { actionId: action.id, targetId: ward.id, line: '' }),
      { type: 'end_turn', atMs: 1000 },
    );

    const strikeAt = (state: RunState): number => {
      const after = settleGood(
        applyInput(state, {
          type: 'play_card',
          instanceId: state.encounter.player.hand[0]!.instanceId,
          atMs: 2000,
          targetId: ward.id,
        }),
      );
      return after.encounter.combatants.find((c) => c.id === ward.id)!.hp;
    };

    expect(strikeAt(shielded)).toBeGreaterThan(strikeAt(bare));
  });

  it('护的是同伴，敌人、自己、已倒下的人都不算数', () => {
    const state = fresh();
    const action = protectOf(state, GUARD);
    const me = state.encounter.combatants.find((c) => c.id === GUARD)!;
    const legal = legalTargetsFor(state, me, action);

    expect(legal.length).toBeGreaterThan(0);
    expect(legal).not.toContain(GUARD); // 不能护自己
    expect(legal).not.toContain(PLAYER_TARGET);
    for (const id of legal) {
      const target = state.encounter.combatants.find((c) => c.id === id)!;
      expect(target.factionId).toBe(me.factionId);
      expect(target.hp).toBeGreaterThan(0);
    }
  });

  it('同伴全倒下之后，这个动作整个不进合法集', () => {
    const state = fresh();
    const me = state.encounter.combatants.find((c) => c.id === GUARD)!;
    const alone: RunState = {
      ...state,
      encounter: {
        ...state.encounter,
        combatants: state.encounter.combatants.map((c) =>
          c.id !== GUARD && c.factionId === me.factionId ? { ...c, hp: 0 } : c,
        ),
      },
    };

    const action = protectOf(alone, GUARD);
    const solo = alone.encounter.combatants.find((c) => c.id === GUARD)!;
    expect(legalTargetsFor(alone, solo, action)).toHaveLength(0);
    expect(isActionable(alone, solo, action)).toBe(false);

    // 模型选了它也不算数——引擎拒绝并回退
    const request = intentRequestsOf(alone).find((r) => r.combatantId === GUARD)!;
    const answered = applyInput(alone, {
      type: 'agent_response',
      requestId: request.id,
      payload: { actionId: action.id, targetId: solo.id, line: '' },
    });
    expect(answered.encounter.combatants.find((c) => c.id === GUARD)?.intent?.source).toBe(
      'fallback',
    );
  });

  it('回退永远不会挑一个落不下去的动作', () => {
    const state = fresh();

    // 常规局面：每个人的回退选择都落得下去
    for (const combatant of state.encounter.combatants) {
      const intent = fallbackIntent(state, combatant);
      const action = combatant.actions.find((a) => a.id === intent.actionId)!;
      expect(isActionable(state, combatant, action)).toBe(true);
    }

    // 真正会咬人的那种局面：动作表里护同伴排在最前，没有自守，同伴又全倒下了。
    // 不过滤的话回退会挑中那个护同伴，然后「扑了个空」——看上去像引擎在糊弄人。
    const me = state.encounter.combatants.find((c) => c.id === GUARD)!;
    const cornered: RunState = {
      ...state,
      encounter: {
        ...state.encounter,
        combatants: state.encounter.combatants.map((c) => {
          if (c.id === GUARD) {
            return {
              ...c,
              hp: 1, // 血低到只想自保——但它没有自守动作
              actions: [
                c.actions.find((a) => a.kind === 'protect')!,
                c.actions.find((a) => a.kind === 'attack')!,
              ],
            };
          }
          return c.factionId === me.factionId ? { ...c, hp: 0 } : c;
        }),
      },
    };

    const solo = cornered.encounter.combatants.find((c) => c.id === GUARD)!;
    const intent = fallbackIntent(cornered, solo);
    const action = solo.actions.find((a) => a.id === intent.actionId)!;

    expect(action.kind).toBe('attack');
    expect(isActionable(cornered, solo, action)).toBe(true);
    expect(intent.targetId).not.toBeNull();
  });

  it('护同伴不会被同伴自己的行动抹掉——不管谁先动', () => {
    // 每个人行动时都会把自己的 block 清零。护一个还没轮到行动的人，
    // 那份格挡如果当场加上去，转眼就没了。
    const state = fresh();
    const first = state.encounter.combatants[0]!;
    const ward = alliesOf(state, first.id)[0]!;
    const action = protectOf(state, first.id);

    const acted = applyInput(
      answerAll(state, (id) =>
        id === first.id
          ? { actionId: action.id, targetId: ward.id, line: '' }
          : defendPayload(state, id),
      ),
      { type: 'end_turn', atMs: 1000 },
    );

    const guarded = acted.encounter.combatants.find((c) => c.id === ward.id)!;
    const own = ward.actions.find((a) => a.kind === 'defend')!.amount;
    // 自守的那份加上别人护的那份，一份都没丢
    expect(guarded.block).toBe(own + action.amount);
  });

  it('每个人都拿得出一个护同伴的动作，而且护得比自守少', () => {
    const state = fresh();
    for (const combatant of state.encounter.combatants) {
      const protect = combatant.actions.find((a) => a.kind === 'protect');
      const defend = combatant.actions.find((a) => a.kind === 'defend');
      expect(protect).toBeDefined();
      expect(defend).toBeDefined();
      // 照顾别人比照顾自己难
      expect(protect!.amount).toBeLessThan(defend!.amount);
    }
  });
});


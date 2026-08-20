import { INTENT_TIMEOUT_MS } from './content.js';
import { PLAYER_TARGET } from './types.js';
import type {
  AgentRequest,
  AgentRequestKind,
  CombatantAction,
  CombatantState,
  Intent,
  RunState,
} from './types.js';

/**
 * 所有 Agent 决策共用的一条管道（ADR-0010）。
 *
 * 引擎挂出带 kind 的提问，宿主去问模型，把响应原样交回来；引擎按 kind 校验，
 * 非法即按 kind 回退到确定性选择。增加一个 Agent 角色 = 增加一个 kind、一个校验器、
 * 一个回退策略，suspend / validate / fallback 这条路不用再写一遍。
 *
 * ADR-0001 的边界对每一种 kind 都成立：模型永远只在引擎给出的合法集里选。
 */

/** 台词只是叙事，不能变成规则的入口，所以截断到一个安全长度。 */
const MAX_LINE_LENGTH = 40;

// ---------------------------------------------------------------- 挂出提问

/**
 * 为每个还没定下这一回合行动的 Combatant 挂出一个 intent 提问。
 *
 * 每个 Combatant 一个提问，即使同属一个 Faction——它们共享心智与记忆，但各自站在
 * 场上的不同位置，行动要分别决定。合并成一次调用是 ADR-0004 明确拒绝的事。
 */
export function openIntentRequests(state: RunState, atMs: number): RunState {
  if (state.phase === 'ended') return state;

  const pending = new Set(
    state.agentRequests.filter((r) => r.kind === 'intent').map((r) => r.combatantId),
  );
  const added: AgentRequest[] = [];
  let seq = state.nextRequestSeq;

  for (const combatant of state.encounter.combatants) {
    if (combatant.hp <= 0 || combatant.intent !== null) continue;
    if (pending.has(combatant.id)) continue;
    added.push({
      kind: 'intent',
      id: `r${seq++}`,
      factionId: combatant.factionId,
      combatantId: combatant.id,
      requestedAtMs: atMs,
      timeoutMs: INTENT_TIMEOUT_MS,
    });
  }

  if (added.length === 0) return state;
  return {
    ...state,
    nextRequestSeq: seq,
    agentRequests: [...state.agentRequests, ...added],
  };
}

/** 清空所有待回答的提问。回合推进或 Encounter 结束时用——旧问题不该跨局面存活。 */
export function dropRequests(state: RunState): RunState {
  if (state.agentRequests.length === 0) return state;
  return { ...state, agentRequests: [] };
}

// ---------------------------------------------------------------- 回答与超时

export function receiveResponse(state: RunState, requestId: string, payload: unknown): RunState {
  const request = state.agentRequests.find((r) => r.id === requestId);
  // 认不出来的 id：要么是迟到的回答，要么是别的局面留下的，一律丢掉。
  if (!request) return state;
  return settle(state, request, payload);
}

/** 超时的提问由引擎替它作答，Run 继续。没到点就原样返回同一个对象。 */
export function expireRequests(state: RunState, atMs: number): RunState {
  const expired = state.agentRequests.filter((r) => atMs - r.requestedAtMs >= r.timeoutMs);
  if (expired.length === 0) return state;

  let next = state;
  for (const request of expired) next = settle(next, request, undefined, true);
  return next;
}

/** 按 kind 分派校验与落地。新增 kind 时只需要在这里加一个分支。 */
function settle(
  state: RunState,
  request: AgentRequest,
  payload: unknown,
  timedOut = false,
): RunState {
  const withoutRequest: RunState = {
    ...state,
    agentRequests: state.agentRequests.filter((r) => r.id !== request.id),
  };

  switch (request.kind) {
    case 'intent':
      return settleIntent(withoutRequest, request.combatantId, payload, timedOut);
  }
}

function settleIntent(
  state: RunState,
  combatantId: string,
  payload: unknown,
  timedOut: boolean,
): RunState {
  const combatant = state.encounter.combatants.find((c) => c.id === combatantId);
  if (!combatant) return state;

  const parsed = timedOut ? null : parseIntent(state, combatant, payload);
  const intent = parsed ?? fallbackIntent(combatant);
  const note = parsed
    ? `${combatant.name}打定了主意。`
    : timedOut
      ? `${combatant.name}等不及了，凭本能行动。`
      : `${combatant.name}没有给出合法的选择，凭本能行动。`;

  return {
    ...state,
    journal: [...state.journal, note],
    encounter: {
      ...state.encounter,
      combatants: state.encounter.combatants.map((c) =>
        c.id === combatantId ? { ...c, intent } : c,
      ),
    },
  };
}

// ---------------------------------------------------------------- 合法目标

/**
 * 一个动作能打谁。自我防御类没有目标；攻击类可以打玩家，也可以打**别的 Faction 的**
 * Combatant——同派不会互相攻击，但敌对派系之间会。合法集由引擎算出，模型只能从中选。
 */
export function legalTargetsFor(
  state: RunState,
  combatant: CombatantState,
  action: CombatantAction,
): readonly string[] {
  if (action.targeting === 'self') return [];
  return [
    PLAYER_TARGET,
    ...state.encounter.combatants
      .filter((c) => c.hp > 0 && c.factionId !== combatant.factionId)
      .map((c) => c.id),
  ];
}

// ---------------------------------------------------------------- intent 的校验与回退

/**
 * 校验模型的原样响应（ADR-0001）。凡是不在合法动作集里的东西一律拒绝——
 * 引擎不去猜模型的意思，猜错的代价是玩家学不到规则。
 */
function parseIntent(
  state: RunState,
  combatant: CombatantState,
  payload: unknown,
): Intent | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const record = payload as Record<string, unknown>;

  const actionId = record['actionId'];
  if (typeof actionId !== 'string') return null;
  const action = combatant.actions.find((a) => a.id === actionId);
  if (!action) return null;

  // 目标同样要落在合法集里。模型想打一个不存在的、或者自己同派的目标，一律拒绝。
  const legal = legalTargetsFor(state, combatant, action);
  let targetId: string | null = null;
  if (legal.length > 0) {
    const proposed = record['targetId'];
    if (typeof proposed !== 'string' || !legal.includes(proposed)) return null;
    targetId = proposed;
  }

  const line = record['line'];
  return {
    actionId,
    targetId,
    line: typeof line === 'string' ? line.slice(0, MAX_LINE_LENGTH) : '',
    source: 'agent',
  };
}

/**
 * 模型没能按时给出合法答案时，引擎替它选。规则简单且确定：血量掉到三分之一
 * 以下就自保，否则进攻。可玩性因此不依赖模型可用性（ADR-0001）。
 */
export function fallbackIntent(combatant: CombatantState): Intent {
  const wantsDefend = combatant.hp * 3 <= combatant.maxHp;
  const preferred = combatant.actions.find(
    (action) => action.kind === (wantsDefend ? 'defend' : 'attack'),
  );
  const action = preferred ?? combatant.actions[0];
  // 回退永远打玩家：它刻意是无脑的那条路。Agent 选择去打别的派系，因此是一个
  // 玩家看得出来的、比回退更聪明的决定。
  return {
    actionId: action?.id ?? '',
    targetId: action?.targeting === 'enemy' ? PLAYER_TARGET : null,
    line: '',
    source: 'fallback',
  };
}

/** 某个 kind 现在有没有待回答的提问。渲染层用它显示「正在盘算」。 */
export function pendingRequestFor(
  state: RunState,
  kind: AgentRequestKind,
  factionId: string,
): AgentRequest | undefined {
  return state.agentRequests.find((r) => r.kind === kind && r.factionId === factionId);
}

import { atomOf } from './atoms.js';
import {
  BUILT_IN_GENERATION,
  CARD_POOL,
  DECKBUILD_TIMEOUT_MS,
  FUSION_TIMEOUT_MS,
  GENERATION_TIMEOUT_MS,
  INTENT_TIMEOUT_MS,
} from './content.js';
import { DECK_CAPACITY, legalCardsFor, presetDeckFor } from './deckbuild.js';
import {
  applyForge,
  fallbackName,
  forgeCard,
  mergeAtoms,
  preferredForbidden,
  sanitizeName,
  trimToCapacity,
} from './fusion.js';
import { PLAYER_TARGET } from './types.js';
import type {
  AgentRequest,
  AgentRequestKind,
  CombatantAction,
  CombatantState,
  DeckbuildRequest,
  FusionRequest,
  Generation,
  GenerationRequest,
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
 * 场上的不同位置，行动要分别决定。
 *
 * 注意这与 ADR-0004 的字面表述有张力：那条写的是「每个 Agent 每回合各自发起一次调用」，
 * 而 ADR-0010 之后 Agent 是 Faction 级的，同派两个单位于是问了两次。ADR-0004 真正
 * 禁止的是把**不同心智**合并成一个指挥官 prompt，这里没有那么做；但字面要不要跟着改，
 * 是一个需要决定的问题，不该由这段注释悄悄定下来。
 */
export function openIntentRequests(state: RunState, atMs: number): RunState {
  // 只有正在打的时候才问。层间选 Favor 时挂出的提问永远等不到人回答。
  if (state.phase !== 'in_encounter') return state;

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
    case 'fusion':
      return settleFusion(withoutRequest, request, payload, timedOut);
    case 'deckbuild':
      return settleDeckbuild(withoutRequest, request, payload, timedOut);
    case 'generation':
      return settleGeneration(withoutRequest, request, payload, timedOut);
  }
}

// ---------------------------------------------------------------- generation

/** 开局问一次：这一局的塔是什么样。 */
export function openGenerationRequest(state: RunState, atMs: number): RunState {
  return {
    ...state,
    nextRequestSeq: state.nextRequestSeq + 1,
    agentRequests: [
      ...state.agentRequests,
      {
        kind: 'generation',
        id: `r${state.nextRequestSeq}`,
        factionId: '',
        requestedAtMs: atMs,
        timeoutMs: GENERATION_TIMEOUT_MS,
        factionIds: state.agents.map((agent) => agent.factionId),
      },
    ],
  };
}

/** 局势里的一句话：洗掉空白、截断，空的就沿用内置那份。 */
function sanitizeLine(raw: unknown, fallback: string, limit: number): string {
  if (typeof raw !== 'string') return fallback;
  const trimmed = raw.trim();
  return trimmed.length === 0 ? fallback : trimmed.slice(0, limit);
}

/**
 * 校验生成的局势（ADR-0005）。它只能改**说法**：塔叫什么、两派为什么结仇、
 * 各自是什么脾气、想要什么。
 *
 * Faction 的 id 一个都不能新增或替换——Base Card 按 id 分组，名册的机械身份是内容，
 * 不是虚构。模型提到的陌生 id 一律忽略，缺的那份沿用内置。
 */
function settleGeneration(
  state: RunState,
  request: GenerationRequest,
  payload: unknown,
  timedOut: boolean,
): RunState {
  const record =
    !timedOut && typeof payload === 'object' && payload !== null
      ? (payload as Record<string, unknown>)
      : {};

  const generation: Generation = {
    title: sanitizeLine(record['title'], BUILT_IN_GENERATION.title, 16),
    grievance: sanitizeLine(record['grievance'], BUILT_IN_GENERATION.grievance, 160),
  };

  const proposed = Array.isArray(record['factions']) ? (record['factions'] as unknown[]) : [];
  const byId = new Map<string, Record<string, unknown>>();
  for (const entry of proposed) {
    if (typeof entry !== 'object' || entry === null) continue;
    const row = entry as Record<string, unknown>;
    const id = row['factionId'];
    if (typeof id === 'string' && request.factionIds.includes(id)) byId.set(id, row);
  }

  const agents = state.agents.map((agent) => {
    const row = byId.get(agent.factionId);
    if (!row) return agent;
    return {
      factionId: agent.factionId,
      name: sanitizeLine(row['name'], agent.name, 8),
      persona: sanitizeLine(row['persona'], agent.persona, 80),
      goal: sanitizeLine(row['goal'], agent.goal, 160),
    };
  });

  const accepted = byId.size > 0;
  return {
    ...state,
    agents,
    generation,
    journal: [
      ...state.journal,
      accepted ? `这一局的塔：${generation.title}。` : '塔还是老样子。',
      generation.grievance,
    ],
  };
}

// ---------------------------------------------------------------- deckbuild

/**
 * 挂出一次层间构筑：这一派为下一层挑几张牌。
 *
 * 它和玩家挑 Favor 是并行的——玩家在层间做自己的选择时，对手也在做它的。
 * 等玩家上楼时它已经准备好了，谁都不用等谁。
 */
export function openDeckbuildRequests(state: RunState, forFloor: number, atMs: number): RunState {
  const added: AgentRequest[] = [];
  let seq = state.nextRequestSeq;

  for (const agent of state.agents) {
    added.push({
      kind: 'deckbuild',
      id: `r${seq++}`,
      factionId: agent.factionId,
      requestedAtMs: atMs,
      timeoutMs: DECKBUILD_TIMEOUT_MS,
      legalCardIds: legalCardsFor(state, agent.factionId),
      capacity: DECK_CAPACITY,
      forFloor,
    });
  }

  if (added.length === 0) return state;
  return {
    ...state,
    nextRequestSeq: seq,
    agentRequests: [...state.agentRequests, ...added],
  };
}

/**
 * 校验它挑的牌（ADR-0001）。合法集就是 legalCardIds——它没见过的牌一张都拿不到，
 * 越界的一律丢掉。全都不合法就退回这一派的固定预设。
 *
 * 它也可以顺手把挑到的两张融了：走的是和玩家完全相同的合并与上限规则。
 */
function settleDeckbuild(
  state: RunState,
  request: DeckbuildRequest,
  payload: unknown,
  timedOut: boolean,
): RunState {
  const record =
    !timedOut && typeof payload === 'object' && payload !== null
      ? (payload as Record<string, unknown>)
      : {};

  const proposed = Array.isArray(record['cardIds']) ? (record['cardIds'] as unknown[]) : [];
  const picked = [
    ...new Set(
      proposed.filter(
        (id): id is string => typeof id === 'string' && request.legalCardIds.includes(id),
      ),
    ),
  ].slice(0, request.capacity);

  const chosen = picked.length > 0 ? picked : presetDeckFor(request.factionId);
  const who = state.agents.find((a) => a.factionId === request.factionId)?.name ?? '对方';

  // 它也想把这两张融了。合并与上限规则和玩家的完全一致。
  const fuse = record['fuse'];
  const pair =
    Array.isArray(fuse) && fuse.length === 2 && fuse.every((id) => typeof id === 'string')
      ? (fuse as string[]).filter((id) => chosen.includes(id))
      : [];

  if (pair.length === 2) {
    const a = cardDefinitionOf(state, pair[0]!);
    const b = cardDefinitionOf(state, pair[1]!);
    if (a && b) {
      const atoms = trimToCapacity(request.factionId, mergeAtoms(a.atoms, b.atoms));
      const forged = forgeCard({
        atoms,
        name: sanitizeName(record['name'], fallbackName(a.name, b.name, false)),
        factionId: request.factionId,
        seq: state.forged.length,
      });
      const rest = chosen.filter((id) => id !== pair[0] && id !== pair[1]);
      return {
        ...state,
        forged: [...state.forged, forged],
        factionDecks: { ...state.factionDecks, [request.factionId]: [...rest, forged.id] },
        journal: [...state.journal, `${who}把两张牌融成了「${forged.name}」。`],
      };
    }
  }

  const note =
    picked.length > 0
      ? `${who}为下一层备好了牌。`
      : `${who}没有给出说得通的构筑，按老一套准备。`;

  return {
    ...state,
    factionDecks: { ...state.factionDecks, [request.factionId]: chosen },
    journal: [...state.journal, note],
  };
}

function cardDefinitionOf(state: RunState, id: string) {
  return CARD_POOL.find((c) => c.id === id) ?? state.forged.find((c) => c.id === id);
}

// ---------------------------------------------------------------- fusion

/** 挂出一次融合提问：由这一方决定取舍与命名。 */
export function openFusionRequest(
  state: RunState,
  request: Omit<FusionRequest, 'kind' | 'id' | 'requestedAtMs' | 'timeoutMs'>,
  atMs: number,
): RunState {
  return {
    ...state,
    phase: 'fusing',
    nextRequestSeq: state.nextRequestSeq + 1,
    agentRequests: [
      ...state.agentRequests,
      {
        ...request,
        kind: 'fusion',
        id: `r${state.nextRequestSeq}`,
        requestedAtMs: atMs,
        timeoutMs: FUSION_TIMEOUT_MS,
      },
    ],
  };
}

/**
 * 校验这一方的取舍（ADR-0001）。合法集是明确的：
 * 不过载时只能丢合并后确实存在的那些 Atom；过载时只能挑 Forbidden Atom。
 * 越界一律拒绝，回退到这一方的性格偏好。
 */
function settleFusion(
  state: RunState,
  request: FusionRequest,
  payload: unknown,
  timedOut: boolean,
): RunState {
  const record =
    !timedOut && typeof payload === 'object' && payload !== null
      ? (payload as Record<string, unknown>)
      : {};

  const [nameA, nameB] = request.sourceNames;
  const name = sanitizeName(record['name'], fallbackName(nameA, nameB, request.overload));

  let atoms: readonly string[];
  let chosenByAgent: boolean;

  if (request.overload) {
    const proposed = record['forbiddenAtomId'];
    const legal = typeof proposed === 'string' && atomOf(proposed)?.forbidden === true;
    const forbidden = legal ? proposed : preferredForbidden(request.factionId);
    // 过载换来的是一个额外的位置，不是「一个都不丢」——否则反复融合会无限膨胀。
    atoms = [...trimToCapacity(request.factionId, request.atoms), forbidden];
    chosenByAgent = legal;
  } else {
    const proposed = record['dropAtomId'];
    const legal = typeof proposed === 'string' && request.atoms.includes(proposed);
    if (legal) {
      const index = request.atoms.indexOf(proposed);
      atoms = trimToCapacity(
        request.factionId,
        request.atoms.filter((_, i) => i !== index),
      );
    } else {
      atoms = trimToCapacity(request.factionId, request.atoms);
    }
    chosenByAgent = legal;
  }

  const who = state.agents.find((a) => a.factionId === request.factionId)?.name ?? '对方';
  const note = chosenByAgent
    ? `${who}替你做了取舍，锻出「{name}」。`
    : `${who}没有给出说得通的取舍，按它一贯的偏好锻出「{name}」。`;

  return applyForge(state, {
    atoms,
    name,
    factionId: request.factionId,
    deckInstanceId: request.deckInstanceId,
    note,
  });
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
  const intent = parsed ?? fallbackIntent(state, combatant);
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
  // 打谁由 kind 推出，不另存一个可能与它矛盾的字段。

  // 保护：只能给同派**活着的别人**。一个都没有时这个动作没有合法目标，
  // 于是它整个不进合法集——引擎不会让模型选一个落不下去的动作。
  if (action.kind === 'protect') {
    return state.encounter.combatants
      .filter((c) => c.hp > 0 && c.id !== combatant.id && c.factionId === combatant.factionId)
      .map((c) => c.id);
  }

  // 自守只作用于自己。
  if (action.kind !== 'attack') return [];

  // 围攻：各方暂时联手，这一场里它们只打你。护同伴照旧——联手不等于互不相干。
  if (state.encounter.siege) return [PLAYER_TARGET];
  return [
    PLAYER_TARGET,
    ...state.encounter.combatants
      .filter((c) => c.hp > 0 && c.factionId !== combatant.factionId)
      .map((c) => c.id),
  ];
}

/**
 * 这个动作此刻落得下去吗。
 *
 * `protect` 在同伴全倒下之后就没有目标了，`attack` 在场上只剩自己人时也一样。
 * 合法集与回退都得走这里，否则模型能选一个引擎结算不了的动作。
 */
export function isActionable(
  state: RunState,
  combatant: CombatantState,
  action: CombatantAction,
): boolean {
  if (action.kind === 'defend') return true;
  return legalTargetsFor(state, combatant, action).length > 0;
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
  // 落不下去的动作一律拒绝。「护同伴」在同伴全倒下之后就是这样一个动作——
  // 放它过去会变成一次「扑了个空」，看上去像引擎在糊弄人。
  if (!isActionable(state, combatant, action)) return null;

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
export function fallbackIntent(state: RunState, combatant: CombatantState): Intent {
  const wantsDefend = combatant.hp * 3 <= combatant.maxHp;
  // 落不下去的动作一个都不挑——同伴全倒了的时候「护同伴」就是这样一个动作。
  const usable = combatant.actions.filter((action) => isActionable(state, combatant, action));
  const preferred = usable.find(
    (action) => action.kind === (wantsDefend ? 'defend' : 'attack'),
  );
  const action = preferred ?? usable[0];
  if (!action || action.kind !== 'attack') {
    return { actionId: action?.id ?? '', targetId: null, line: '', source: 'fallback' };
  }

  // 回退默认打玩家——它刻意是无脑的那条路，所以「主动去打别的派系」才成为一个
  // 玩家看得出来的、比回退更聪明的决定。
  //
  // 唯一的例外是援军：塔顶那些站你这边的人，回退时不该反过来打你。它们打首领。
  const legal = legalTargetsFor(state, combatant, action);
  const boss = state.encounter.combatants.find((c) => c.isBoss && c.hp > 0);
  const isAlly = boss !== undefined && !state.encounter.siege && combatant.factionId !== boss.factionId;
  const target = isAlly && legal.includes(boss.id) ? boss.id : PLAYER_TARGET;

  return { actionId: action.id, targetId: target, line: '', source: 'fallback' };
}

/** 某个 kind 现在有没有待回答的提问。渲染层用它显示「正在盘算」。 */
export function pendingRequestFor(
  state: RunState,
  kind: AgentRequestKind,
  factionId: string,
): AgentRequest | undefined {
  return state.agentRequests.find((r) => r.kind === kind && r.factionId === factionId);
}

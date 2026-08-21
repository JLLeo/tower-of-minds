import './style.css';
import { applyInput, startRun } from './engine/run.js';
import { BUILT_IN_GENERATION } from './engine/content.js';
import { createDeepSeekProvider } from './llm/deepseek.js';
import { taskFor } from './llm/provider.js';
import { render } from './ui/render.js';
import { NEW_SAVE_LEDGER } from './engine/unlocks.js';
import type { PlayerInput, RunState, UnlockLedger } from './engine/types.js';

const root = document.querySelector<HTMLDivElement>('#app');
if (!root) throw new Error('缺少 #app 挂载点');

// 浏览器打到本地代理；API key 由 Node 侧的 vite 配置注入，前端包里没有它。
const provider = createDeepSeekProvider({ baseUrl: '/api/llm', model: __INTENT_MODEL__ });

/**
 * Unlock Ledger 是跨 Run 唯一持久的东西（ADR-0009），所以它是唯一存盘的东西。
 * 存盘归宿主：引擎收下一份 Ledger、还回一份 Ledger，自己不碰 localStorage。
 *
 * 读不出来就当新档——存档坏了不该让人打不开游戏。
 */
const SAVE_KEY = 'tower-of-minds/unlocks';

function loadLedger(): UnlockLedger {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return NEW_SAVE_LEDGER;
    const parsed: unknown = JSON.parse(raw);
    const ids = (parsed as { cardIds?: unknown })?.cardIds;
    if (!Array.isArray(ids)) return NEW_SAVE_LEDGER;
    // 基础牌由引擎兜底补上，这里只负责把存档读成合法形状。
    return { cardIds: ids.filter((id): id is string => typeof id === 'string') };
  } catch {
    return NEW_SAVE_LEDGER;
  }
}

function saveLedger(ledger: UnlockLedger): void {
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify(ledger));
  } catch {
    // 存不了就存不了（无痕模式、配额满）。这一局照常打完。
  }
}

let state: RunState = startRun(BUILT_IN_GENERATION, Date.now(), {
  startedAtMs: performance.now(),
  ledger: loadLedger(),
});

/** 正在飞的提问，按 requestId 索引——同时可能有好几个 Agent 在被问。 */
const inFlight = new Map<string, AbortController>();

/** 界面状态：选中的攻击目标。它不影响规则，所以不进 RunState。 */
let selectedTargetId: string | null = null;
let fuseOfferedId: string | null = null;
let fuseDeckInstanceId: string | null = null;
let loadoutFaction: string | null = null;
let loadoutPicks: readonly string[] = [];

function paint(): void {
  render(
    root!,
    state,
    {
      selectedTargetId,
      onSelectTarget: (id) => {
        selectedTargetId = id;
        paint();
      },
      fuseOfferedId,
      fuseDeckInstanceId,
      onPickFuse: (offered, deckInstance) => {
        fuseOfferedId = offered;
        fuseDeckInstanceId = deckInstance;
        paint();
      },
      loadoutFaction,
      loadoutPicks,
      onPickLoadout: (factionId, picks) => {
        loadoutFaction = factionId;
        loadoutPicks = picks;
        paint();
      },
    },
    dispatch,
    restart,
  );
}

function dispatch(input: PlayerInput): void {
  const next = applyInput(state, input);
  // 引擎在无事发生时原样返回同一个对象——时机条与超时都靠每帧上报时刻，
  // 靠这一步才不至于每帧重绘。
  if (next === state) return;
  const before = state;
  state = next;
  // 通关时引擎把这一局挣到的解锁并进了 Ledger。存盘只在它真的变了的时候做。
  if (state.ledger !== before.ledger) saveLedger(state.ledger);
  paint();
  askAgents();
}

/**
 * 引擎挂出提问就去问模型，把响应原样交回引擎。网络失败也照样交回去（payload 为
 * null），引擎会判非法并回退——Run 不会停。
 *
 * 响应带着 requestId。引擎超时回退之后那次提问就不存在了，迟到的回答认不出来会被
 * 丢掉；这里也顺手 abort 掉，不让它白白占着连接。
 */
function askAgents(): void {
  const live = new Set(state.agentRequests.map((request) => request.id));

  for (const [id, controller] of inFlight) {
    if (live.has(id)) continue;
    controller.abort();
    inFlight.delete(id);
  }

  for (const request of state.agentRequests) {
    if (inFlight.has(request.id)) continue;
    const task = taskFor(state, request);
    if (!task) continue;

    const controller = new AbortController();
    inFlight.set(request.id, controller);

    provider
      .ask(task, controller.signal)
      .then((payload) => {
        dispatch({ type: 'agent_response', requestId: request.id, payload });
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        dispatch({ type: 'agent_response', requestId: request.id, payload: null });
      });
  }
}

// 时间的流逝：判定窗口是否耗尽、IntentRequest 是否超时，都由引擎按这个时刻判断。
// 时机条自己另有一套逐帧动画；这里只需要够粗的粒度把超时推下去。
setInterval(() => {
  // 层间也要报时：对手的构筑提问就是在这些 tick 上挂出来并计时的。
  if (
    state.agentRequests.length > 0 ||
    state.encounter.pending ||
    state.phase === 'choosing_favor' ||
    state.phase === 'generating' ||
    state.phase === 'loadout'
  ) {
    dispatch({ type: 'tick', atMs: performance.now() });
  }
}, 200);

function restart(): void {
  for (const controller of inFlight.values()) controller.abort();
  inFlight.clear();
  loadoutFaction = null;
  loadoutPicks = [];
  state = startRun(BUILT_IN_GENERATION, Date.now(), {
    startedAtMs: performance.now(),
    // 上一局挣到的解锁在这里生效——这是重玩的动机所在。
    ledger: state.ledger,
  });
  paint();
  askAgents();
}

paint();
askAgents();

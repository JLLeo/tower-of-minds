import './style.css';
import { applyInput, startRun } from './engine/run.js';
import { BUILT_IN_GENERATION } from './engine/content.js';
import { createDeepSeekProvider } from './llm/deepseek.js';
import { taskFor } from './llm/provider.js';
import { render } from './ui/render.js';
import type { PlayerInput, RunState } from './engine/types.js';

const root = document.querySelector<HTMLDivElement>('#app');
if (!root) throw new Error('缺少 #app 挂载点');

// 浏览器打到本地代理；API key 由 Node 侧的 vite 配置注入，前端包里没有它。
const provider = createDeepSeekProvider({ baseUrl: '/api/llm', model: __INTENT_MODEL__ });

let state: RunState = startRun(BUILT_IN_GENERATION, Date.now(), {
  startedAtMs: performance.now(),
});

/** 正在飞的提问，按 requestId 索引——同时可能有好几个 Agent 在被问。 */
const inFlight = new Map<string, AbortController>();

/** 界面状态：选中的攻击目标。它不影响规则，所以不进 RunState。 */
let selectedTargetId: string | null = null;

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
  state = next;
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
  if (state.agentRequests.length > 0 || state.encounter.pending) {
    dispatch({ type: 'tick', atMs: performance.now() });
  }
}, 200);

function restart(): void {
  for (const controller of inFlight.values()) controller.abort();
  inFlight.clear();
  state = startRun(BUILT_IN_GENERATION, Date.now(), { startedAtMs: performance.now() });
  paint();
  askAgents();
}

paint();
askAgents();

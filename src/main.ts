import './style.css';
import { applyInput, startRun } from './engine/run.js';
import { BUILT_IN_GENERATION } from './engine/content.js';
import { createDeepSeekProvider } from './llm/deepseek.js';
import { contextFor } from './llm/provider.js';
import { render } from './ui/render.js';
import type { PlayerInput, RunState } from './engine/types.js';

const root = document.querySelector<HTMLDivElement>('#app');
if (!root) throw new Error('缺少 #app 挂载点');

// 浏览器打到本地代理；API key 由 Node 侧的 vite 配置注入，前端包里没有它。
const provider = createDeepSeekProvider({ baseUrl: '/api/llm', model: __INTENT_MODEL__ });

let state: RunState = startRun(BUILT_IN_GENERATION, Date.now(), {
  startedAtMs: performance.now(),
});

/** 已经发出去、还没回来的那个请求。用请求的时刻做键，避免重复提问。 */
let inFlight: string | null = null;

function paint(): void {
  render(root!, state, dispatch, restart);
}

function dispatch(input: PlayerInput): void {
  const next = applyInput(state, input);
  // 引擎在无事发生时原样返回同一个对象——时机条与超时都靠每帧上报时刻，
  // 靠这一步才不至于每帧重绘。
  if (next === state) return;
  state = next;
  paint();
  askForIntent();
}

/**
 * 引擎挂出 IntentRequest 时去问模型，把响应原样交回引擎。
 * 网络失败也照样交回去（payload 为 null），引擎会判非法并回退——Run 不会停。
 */
function askForIntent(): void {
  const request = state.encounter.intentRequest;
  if (!request) {
    inFlight = null;
    return;
  }

  const key = `${request.combatantId}@${request.requestedAtMs}`;
  if (inFlight === key) return;
  inFlight = key;

  const combatant = state.encounter.combatants.find((c) => c.id === request.combatantId);
  if (!combatant) return;

  const controller = new AbortController();
  provider
    .requestIntent(contextFor(state, combatant), controller.signal)
    .then((payload) => {
      dispatch({ type: 'intent_response', combatantId: request.combatantId, payload });
    })
    .catch(() => {
      dispatch({ type: 'intent_response', combatantId: request.combatantId, payload: null });
    });
}

// 时间的流逝：判定窗口是否耗尽、IntentRequest 是否超时，都由引擎按这个时刻判断。
// 时机条自己另有一套逐帧动画；这里只需要够粗的粒度把超时推下去。
setInterval(() => {
  if (state.encounter.intentRequest || state.encounter.pending) {
    dispatch({ type: 'tick', atMs: performance.now() });
  }
}, 200);

function restart(): void {
  state = startRun(BUILT_IN_GENERATION, Date.now(), { startedAtMs: performance.now() });
  inFlight = null;
  paint();
  askForIntent();
}

paint();
askForIntent();

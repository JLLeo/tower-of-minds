import './style.css';
import { applyInput, startRun } from './engine/run.js';
import { BUILT_IN_GENERATION } from './engine/content.js';
import { render } from './ui/render.js';
import type { PlayerInput, RunState } from './engine/types.js';

const root = document.querySelector<HTMLDivElement>('#app');
if (!root) throw new Error('缺少 #app 挂载点');

let state: RunState = startRun(BUILT_IN_GENERATION, Date.now());

function paint(): void {
  render(root!, state, dispatch, restart);
}

function dispatch(input: PlayerInput): void {
  state = applyInput(state, input);
  paint();
}

function restart(): void {
  state = startRun(BUILT_IN_GENERATION, Date.now());
  paint();
}

paint();

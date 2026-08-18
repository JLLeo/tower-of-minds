import {
  GOOD_BAND,
  GRADE_LABEL,
  PERFECT_BAND,
  canPlay,
  definitionOf,
  intendedAction,
  isPlayerActing,
} from '../engine/run.js';
import type { CardDefinition, PendingExecution, PlayerInput, RunState } from '../engine/types.js';

export type Dispatch = (input: PlayerInput) => void;

/** 上一次渲染留下的时机条动画与按键监听，下一次渲染前必须先拆掉。 */
let stopTimingBar: (() => void) | null = null;

/**
 * 把 RunState 画出来。渲染层不持有游戏状态，也不推导规则——需要判断的地方
 * 一律问 engine 导出的查询函数。判定档位、窗口是否耗尽同样由引擎判断：这里只负责
 * 把窗口画出来，并把时刻报回去。UI 里没有未被测试的规则，这是单一 seam 能覆盖
 * 全部行为的前提。
 */
export function render(
  root: HTMLElement,
  state: RunState,
  dispatch: Dispatch,
  restart: () => void,
): void {
  stopTimingBar?.();
  stopTimingBar = null;

  root.replaceChildren(
    header(state),
    combatantsView(state),
    playerView(state),
    handView(state, dispatch),
    controls(state, dispatch),
    journalView(state),
    ...(state.phase === 'ended' ? [outcomeView(state, restart)] : []),
  );

  const pending = state.encounter.pending;
  if (state.encounter.phase === 'awaiting_execution' && pending) {
    const track = root.querySelector<HTMLElement>('.timing-track');
    const indicator = root.querySelector<HTMLElement>('.timing-indicator');
    if (track && indicator) {
      stopTimingBar = runTimingBar({ root, track, indicator }, pending, dispatch);
    }
  }
}

function el(tag: string, className?: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function header(state: RunState): HTMLElement {
  return el(
    'header',
    'header',
    `Tower of Minds — 第 ${state.floor} 层 · 回合 ${state.encounter.turn}`,
  );
}

function meter(label: string, value: number, max: number, className: string): HTMLElement {
  const wrap = el('div', 'meter');
  wrap.appendChild(el('span', 'meter-label', `${label} ${value}/${max}`));
  const bar = el('div', 'meter-bar');
  const fill = el('div', `meter-fill ${className}`);
  fill.style.width = `${max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0}%`;
  bar.appendChild(fill);
  wrap.appendChild(bar);
  return wrap;
}

function combatantsView(state: RunState): HTMLElement {
  const section = el('section', 'combatants');
  const waitingFor = state.encounter.intentRequest?.combatantId;

  for (const combatant of state.encounter.combatants) {
    const down = combatant.hp <= 0;
    const card = el('div', down ? 'combatant combatant-down' : 'combatant');
    card.appendChild(el('h2', undefined, combatant.name));
    card.appendChild(meter('HP', combatant.hp, combatant.maxHp, 'fill-hp'));
    if (combatant.block > 0) card.appendChild(el('div', 'block-badge', `格挡 ${combatant.block}`));

    if (down) {
      card.appendChild(el('div', 'combatant-next', '已倒下'));
    } else {
      // Intent：它下一回合打算做什么。动作由引擎从合法集里确认过，台词只是叙事。
      const action = intendedAction(combatant);
      if (action) {
        card.appendChild(el('div', 'combatant-next', `意图：${action.description}`));
        const line = combatant.intent?.line;
        if (line) card.appendChild(el('div', 'combatant-line', `「${line}」`));
      } else if (waitingFor === combatant.id && state.encounter.phase !== 'awaiting_execution') {
        // 玩家正在做 Execution Check 时不显示这行：等待要被玩法盖住，不是摆在脸上。
        card.appendChild(el('div', 'combatant-next combatant-thinking', '正在盘算…'));
      }
    }
    section.appendChild(card);
  }
  return section;
}

function playerView(state: RunState): HTMLElement {
  const player = state.encounter.player;
  const section = el('section', 'player');
  section.appendChild(meter('HP', player.hp, player.maxHp, 'fill-hp'));
  section.appendChild(
    el('div', 'stats', `能量 ${player.energy}/${player.maxEnergy} · 格挡 ${player.block}`),
  );
  section.appendChild(
    el('div', 'piles', `抽牌堆 ${player.drawPile.length} · 弃牌堆 ${player.discardPile.length}`),
  );
  return section;
}

function describe(definition: CardDefinition): string {
  const parts: string[] = [];
  if (definition.damage !== undefined) parts.push(`造成 ${definition.damage} 伤害`);
  if (definition.block !== undefined) parts.push(`获得 ${definition.block} 格挡`);
  if (definition.execution) parts.push('需要时机判定');
  return parts.join('，');
}

function handView(state: RunState, dispatch: Dispatch): HTMLElement {
  const section = el('section', 'hand');

  for (const card of state.encounter.player.hand) {
    const definition = definitionOf(state, card.instanceId);
    if (!definition) continue;

    const button = document.createElement('button');
    button.className = `card card-${definition.type}`;
    button.disabled = !canPlay(state, card.instanceId);
    button.appendChild(el('span', 'card-cost', String(definition.cost)));
    button.appendChild(el('span', 'card-name', definition.name));
    button.appendChild(el('span', 'card-text', describe(definition)));
    button.addEventListener('click', () =>
      dispatch({ type: 'play_card', instanceId: card.instanceId, atMs: performance.now() }),
    );
    section.appendChild(button);
  }
  return section;
}

interface TimingBar {
  readonly root: HTMLElement;
  readonly track: HTMLElement;
  readonly indicator: HTMLElement;
}

function zone(band: { readonly start: number; readonly end: number }, className: string): HTMLElement {
  const node = el('div', `timing-zone ${className}`);
  node.style.left = `${band.start * 100}%`;
  node.style.width = `${(band.end - band.start) * 100}%`;
  return node;
}

/**
 * 时机条：轨道代表整个判定窗口，高亮区是 Perfect 带。分档位置直接读引擎导出的
 * 常量，UI 和规则不各写一份。
 */
function timingBar(): TimingBar {
  const root = el('section', 'timing');
  root.appendChild(el('div', 'timing-hint', '按 空格 定格'));

  const track = el('div', 'timing-track');
  track.appendChild(zone(GOOD_BAND, 'timing-good'));
  track.appendChild(zone(PERFECT_BAND, 'timing-perfect'));

  const indicator = el('div', 'timing-indicator');
  track.appendChild(indicator);
  root.appendChild(track);
  return { root, track, indicator };
}

/**
 * 驱动时机条。这里只做两件事：把指示器画到当前位置，以及每帧把当前时刻上报给
 * 引擎。窗口有没有走完、走完了算什么档位，全部由引擎判断——UI 不做规则决定。
 * 标签页被切走时 rAF 暂停、tick 停发，窗口也就不会在玩家看不见的时候悄悄耗尽。
 */
function runTimingBar(
  bar: TimingBar,
  pending: PendingExecution,
  dispatch: Dispatch,
): () => void {
  let stopped = false;
  let frame = 0;

  const press = (): void => {
    if (stopped) return;
    dispatch({ type: 'execution_input', atMs: performance.now() });
  };

  const onKey = (event: KeyboardEvent): void => {
    if (event.code !== 'Space' && event.code !== 'Enter') return;
    event.preventDefault();
    press();
  };

  const frameStep = (): void => {
    if (stopped) return;
    const now = performance.now();
    const progress = (now - pending.openedAtMs) / pending.spec.windowMs;
    bar.indicator.style.left = `${Math.max(0, Math.min(100, progress * 100))}%`;
    dispatch({ type: 'tick', atMs: now });
    if (stopped) return;
    frame = requestAnimationFrame(frameStep);
  };

  window.addEventListener('keydown', onKey);
  bar.track.addEventListener('click', press);
  frame = requestAnimationFrame(frameStep);

  return () => {
    stopped = true;
    cancelAnimationFrame(frame);
    window.removeEventListener('keydown', onKey);
    bar.track.removeEventListener('click', press);
  };
}

function controls(state: RunState, dispatch: Dispatch): HTMLElement {
  const section = el('section', 'controls');

  if (state.encounter.phase === 'awaiting_execution') {
    section.appendChild(timingBar().root);
    return section;
  }

  const grade = state.encounter.lastGrade;
  if (grade) section.appendChild(el('div', `grade grade-${grade}`, GRADE_LABEL[grade]));

  const endTurn = document.createElement('button');
  endTurn.className = 'primary';
  endTurn.textContent = '结束回合';
  endTurn.disabled = !isPlayerActing(state);
  endTurn.addEventListener('click', () =>
    dispatch({ type: 'end_turn', atMs: performance.now() }),
  );
  section.appendChild(endTurn);
  return section;
}

function journalView(state: RunState): HTMLElement {
  const section = el('section', 'log');
  for (const line of state.journal.slice(-8)) section.appendChild(el('p', undefined, line));
  return section;
}

function outcomeView(state: RunState, restart: () => void): HTMLElement {
  const section = el('section', 'outcome');
  section.appendChild(
    el('h2', undefined, state.outcome === 'victory' ? '你活着离开了这一层' : '你倒在了塔里'),
  );
  const again = document.createElement('button');
  again.className = 'primary';
  again.textContent = '再来一局';
  again.addEventListener('click', restart);
  section.appendChild(again);
  return section;
}

import {
  GOOD_BAND_START,
  PERFECT_BAND,
  canPlay,
  definitionOf,
  isPlayerActing,
} from '../engine/run.js';
import type {
  CardDefinition,
  ExecutionGrade,
  PendingExecution,
  PlayerInput,
  RunState,
} from '../engine/types.js';

export type Dispatch = (input: PlayerInput) => void;

/** 上一次渲染留下的时机条动画与按键监听，下一次渲染前必须先拆掉。 */
let stopTimingBar: (() => void) | null = null;

/**
 * 把 RunState 画出来。渲染层不持有游戏状态，也不推导规则——需要判断的地方
 * 一律问 engine 导出的查询函数。判定档位同样由引擎算：这里只负责把窗口画出来，
 * 并把玩家按下的时刻报回去。
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
    stopTimingBar = runTimingBar(root, pending, dispatch);
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
  const section = el('section', 'foes');
  for (const combatant of state.encounter.combatants) {
    const down = combatant.hp <= 0;
    const card = el('div', down ? 'foe foe-down' : 'foe');
    card.appendChild(el('h2', undefined, combatant.name));
    card.appendChild(meter('HP', combatant.hp, combatant.maxHp, 'fill-hp'));
    if (combatant.block > 0) card.appendChild(el('div', 'block-badge', `格挡 ${combatant.block}`));
    if (down) card.appendChild(el('div', 'foe-next', '已倒下'));
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

const GRADE_TEXT: Record<ExecutionGrade, string> = {
  miss: '失手',
  good: '还行',
  perfect: '完美',
};

/**
 * 时机条：轨道代表整个判定窗口，高亮区是 Perfect 带。指示器扫过轨道，
 * 玩家按空格或点击轨道来定格。窗口走完仍未按下就自动交卷（引擎判为 Miss）。
 * 分档位置直接读引擎导出的常量，避免 UI 和规则各写一份。
 */
function timingBar(): HTMLElement {
  const wrap = el('section', 'timing');
  wrap.appendChild(el('div', 'timing-hint', '按 空格 定格'));

  const track = el('div', 'timing-track');

  const good = el('div', 'timing-zone timing-good');
  good.style.left = `${GOOD_BAND_START * 100}%`;
  good.style.width = `${(1 - GOOD_BAND_START) * 100}%`;
  track.appendChild(good);

  const perfect = el('div', 'timing-zone timing-perfect');
  perfect.style.left = `${PERFECT_BAND.start * 100}%`;
  perfect.style.width = `${(PERFECT_BAND.end - PERFECT_BAND.start) * 100}%`;
  track.appendChild(perfect);

  track.appendChild(el('div', 'timing-indicator'));
  wrap.appendChild(track);
  return wrap;
}

function runTimingBar(
  root: HTMLElement,
  pending: PendingExecution,
  dispatch: Dispatch,
): () => void {
  const indicator = root.querySelector<HTMLElement>('.timing-indicator');
  const track = root.querySelector<HTMLElement>('.timing-track');
  if (!indicator || !track) return () => {};

  let settled = false;
  let frame = 0;

  const submit = (): void => {
    if (settled) return;
    settled = true;
    dispatch({ type: 'execution_input', atMs: performance.now() });
  };

  const onKey = (event: KeyboardEvent): void => {
    if (event.code !== 'Space' && event.code !== 'Enter') return;
    event.preventDefault();
    submit();
  };

  const tick = (): void => {
    const progress = (performance.now() - pending.openedAtMs) / pending.spec.windowMs;
    indicator.style.left = `${Math.max(0, Math.min(100, progress * 100))}%`;
    if (progress >= 1) {
      submit();
      return;
    }
    frame = requestAnimationFrame(tick);
  };

  window.addEventListener('keydown', onKey);
  track.addEventListener('click', submit);
  frame = requestAnimationFrame(tick);

  return () => {
    settled = true;
    cancelAnimationFrame(frame);
    window.removeEventListener('keydown', onKey);
  };
}

function controls(state: RunState, dispatch: Dispatch): HTMLElement {
  const section = el('section', 'controls');

  if (state.encounter.phase === 'awaiting_execution') {
    section.appendChild(timingBar());
    return section;
  }

  const grade = state.encounter.lastGrade;
  if (grade) section.appendChild(el('div', `grade grade-${grade}`, GRADE_TEXT[grade]));

  const endTurn = document.createElement('button');
  endTurn.className = 'primary';
  endTurn.textContent = '结束回合';
  endTurn.disabled = !isPlayerActing(state);
  endTurn.addEventListener('click', () => dispatch({ type: 'end_turn' }));
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

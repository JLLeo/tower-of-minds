import { canPlay, definitionOf, isPlayerActing } from '../engine/run.js';
import type { CardDefinition, PlayerInput, RunState } from '../engine/types.js';

export type Dispatch = (input: PlayerInput) => void;

/**
 * 把 RunState 画出来。渲染层不持有游戏状态，也不推导规则——需要判断的地方
 * 一律问 engine 导出的查询函数（canPlay / isPlayerActing / definitionOf）。
 * 这是单一测试 seam 能覆盖全部行为的前提：UI 里没有未被测试的规则。
 */
export function render(
  root: HTMLElement,
  state: RunState,
  dispatch: Dispatch,
  restart: () => void,
): void {
  root.replaceChildren(
    header(state),
    combatantsView(state),
    playerView(state),
    handView(state, dispatch),
    controls(state, dispatch),
    journalView(state),
    ...(state.phase === 'ended' ? [outcomeView(state, restart)] : []),
  );
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

function controls(state: RunState, dispatch: Dispatch): HTMLElement {
  const section = el('section', 'controls');

  if (state.encounter.phase === 'awaiting_execution') {
    // #3 会在这里放格挡时机条。骨架阶段只给一个把输入时刻交给引擎的按钮。
    const resume = document.createElement('button');
    resume.className = 'primary';
    resume.textContent = '继续结算';
    resume.addEventListener('click', () =>
      dispatch({ type: 'execution_input', atMs: performance.now() }),
    );
    section.appendChild(resume);
    return section;
  }

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

import type { CardDefinition, PlayerInput, RunState } from '../engine/types.js';

export type Dispatch = (input: PlayerInput) => void;

/**
 * 把 RunState 画出来。渲染层不持有任何游戏状态，也不做任何规则判断——
 * 它只读状态、发输入。所有规则都在 engine 里（这也是单一测试 seam 成立的原因）。
 */
export function render(
  root: HTMLElement,
  state: RunState,
  dispatch: Dispatch,
  restart: () => void,
): void {
  root.replaceChildren(
    header(state),
    foesView(state),
    playerView(state),
    handView(state, dispatch),
    controls(state, dispatch),
    logView(state),
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
  return el('header', 'header', `Tower of Minds — 第 ${state.floor} 层 · 回合 ${state.encounter.turn}`);
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

function foesView(state: RunState): HTMLElement {
  const section = el('section', 'foes');
  for (const foe of state.encounter.foes) {
    const card = el('div', foe.hp > 0 ? 'foe' : 'foe foe-down');
    card.appendChild(el('h2', undefined, foe.name));
    card.appendChild(meter('HP', foe.hp, foe.maxHp, 'fill-hp'));
    if (foe.block > 0) card.appendChild(el('div', 'block-badge', `格挡 ${foe.block}`));

    if (foe.hp > 0) {
      // 脚本化对手：这里显示的是它写死的下一步，不是 Intent。
      // Intent 是由 LLM 选出来的东西（见 CONTEXT.md），要等 #4。
      const nextAction = foe.script[foe.scriptIndex % foe.script.length];
      if (nextAction) {
        const text =
          nextAction.kind === 'attack'
            ? `下一步：攻击 ${nextAction.amount}`
            : `下一步：格挡 ${nextAction.amount}`;
        card.appendChild(el('div', 'foe-next', text));
      }
    } else {
      card.appendChild(el('div', 'foe-next', '已倒下'));
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
    el(
      'div',
      'piles',
      `抽牌堆 ${player.drawPile.length} · 弃牌堆 ${player.discardPile.length}`,
    ),
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
  const player = state.encounter.player;
  const interactive = state.phase === 'in_encounter' && state.encounter.phase === 'player_turn';

  for (const card of player.hand) {
    const definition = state.cards.find((d) => d.id === card.definitionId);
    if (!definition) continue;

    const affordable = definition.cost <= player.energy;
    const button = document.createElement('button');
    button.className = `card card-${definition.type}`;
    button.disabled = !interactive || !affordable;
    button.appendChild(el('span', 'card-cost', String(definition.cost)));
    button.appendChild(el('span', 'card-name', definition.name));
    button.appendChild(el('span', 'card-text', describe(definition)));
    button.addEventListener('click', () =>
      dispatch({ type: 'play_card', instanceId: card.instanceId }),
    );
    section.appendChild(button);
  }
  return section;
}

function controls(state: RunState, dispatch: Dispatch): HTMLElement {
  const section = el('section', 'controls');

  if (state.encounter.phase === 'awaiting_execution') {
    // #3 会在这里放格挡时机条。骨架阶段只给一个能把结算推下去的按钮。
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
  endTurn.disabled = state.phase !== 'in_encounter' || state.encounter.phase !== 'player_turn';
  endTurn.addEventListener('click', () => dispatch({ type: 'end_turn' }));
  section.appendChild(endTurn);
  return section;
}

function logView(state: RunState): HTMLElement {
  const section = el('section', 'log');
  for (const line of state.log.slice(-8)) section.appendChild(el('p', undefined, line));
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

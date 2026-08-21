import {
  GRADE_LABEL,
  canPlay,
  cardById,
  costFor,
  currentSiding,
  standings,
  defaultTarget,
  definitionOf,
  intendedAction,
  isPlayerActing,
} from '../engine/run.js';
import { MAX_ATOMS_PER_CARD, atomGlyphs, describeAtoms } from '../engine/atoms.js';
import { CARD_POOL, LOADOUT_SIZE, NORMAL_FLOORS } from '../engine/content.js';
import {
  defaultLoadout,
  isLegalLoadout,
  loadoutFactionsOf,
  unlockedCardsOf,
} from '../engine/unlocks.js';
import { describeMemory, summarizeMemory } from '../engine/memory.js';
import { PLAYER_TARGET } from '../engine/types.js';
import type {
  CardDefinition,
  ExecutionKind,
  ExecutionSpec,
  PendingExecution,
  PlayerInput,
  RunState,
} from '../engine/types.js';

export type Dispatch = (input: PlayerInput) => void;

/** 纯粹的界面状态：它不影响规则，所以不进 RunState。 */
export interface View {
  readonly selectedTargetId: string | null;
  readonly onSelectTarget: (combatantId: string) => void;
  /** 高阶 Favor 时正在挑的那两张：它给的一张，和你自己牌库里的一张。 */
  readonly fuseOfferedId: string | null;
  readonly fuseDeckInstanceId: string | null;
  readonly onPickFuse: (offeredId: string | null, deckInstanceId: string | null) => void;
  /** 进塔前正在组的那一副：挑中的 Faction，以及已经放进去的牌。 */
  readonly loadoutFaction: string | null;
  readonly loadoutPicks: readonly string[];
  readonly onPickLoadout: (factionId: string | null, picks: readonly string[]) => void;
}

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
  view: View,
  dispatch: Dispatch,
  restart: () => void,
): void {
  stopTimingBar?.();
  stopTimingBar = null;

  if (state.phase === 'loadout') {
    root.replaceChildren(loadoutView(state, view, dispatch));
    return;
  }

  if (state.phase === 'generating') {
    root.replaceChildren(generatingView(state));
    return;
  }

  root.replaceChildren(
    header(state),
    situationView(state),
    combatantsView(state, view),
    playerView(state),
    handView(state, view, dispatch),
    controls(state, dispatch),
    memoryView(state),
    journalView(state),
    ...(state.phase === 'choosing_favor' ? [favorView(state, view, dispatch)] : []),
    ...(state.phase === 'fusing' ? [fusingView(state)] : []),
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

/**
 * 进塔前组一副 Loadout。只能取自一个 Faction——你带着谁的牌进塔是你的第一次表态，
 * 而它可能和你在塔里的站队打架。
 *
 * 这里只是界面：合不合法由引擎判（isLegalLoadout），非法的一副会被换成默认牌组。
 */
function loadoutView(state: RunState, view: View, dispatch: Dispatch): HTMLElement {
  const section = el('section', 'favor');
  section.appendChild(el('h2', undefined, '进塔前，组一副牌'));
  section.appendChild(
    el('p', 'favor-hint', `只能带一个派系的牌，共 ${LOADOUT_SIZE} 张，可以重复。`),
  );

  const factions = loadoutFactionsOf(state.ledger);
  const picked = view.loadoutFaction ?? factions[0] ?? null;

  const tabs = el('div', 'loadout-tabs');
  for (const factionId of factions) {
    const name = state.agents.find((a) => a.factionId === factionId)?.name ?? factionId;
    const tab = el(
      'button',
      factionId === picked ? 'primary' : 'loadout-tab',
      name,
    ) as HTMLButtonElement;
    // 换派系就得从头挑：混装的一副本来就不合法，留着上一派的牌只会骗人
    tab.addEventListener('click', () => view.onPickLoadout(factionId, []));
    tabs.appendChild(tab);
  }
  section.appendChild(tabs);

  if (picked === null) {
    section.appendChild(el('p', 'favor-hint', '这个存档还没有解锁任何牌。'));
    return section;
  }

  const counts = new Map<string, number>();
  for (const id of view.loadoutPicks) counts.set(id, (counts.get(id) ?? 0) + 1);

  const shelf = el('div', 'hand');
  for (const cardId of unlockedCardsOf(state.ledger, picked)) {
    const definition = CARD_POOL.find((card) => card.id === cardId);
    if (!definition) continue;
    const taken = counts.get(cardId) ?? 0;
    const button = cardButton(definition, taken > 0);
    if (taken > 0) button.appendChild(el('span', 'card-cost', `已带 ${taken} 张`));
    button.disabled = view.loadoutPicks.length >= LOADOUT_SIZE;
    button.addEventListener('click', () => {
      view.onPickLoadout(picked, [...view.loadoutPicks, cardId]);
    });
    shelf.appendChild(button);
  }
  section.appendChild(shelf);

  const bar = el('div', 'loadout-bar');
  bar.appendChild(
    el('span', 'favor-hint', `${view.loadoutPicks.length} / ${LOADOUT_SIZE}`),
  );

  const undo = el('button', 'loadout-tab', '撤一张') as HTMLButtonElement;
  undo.disabled = view.loadoutPicks.length === 0;
  undo.addEventListener('click', () => {
    view.onPickLoadout(picked, view.loadoutPicks.slice(0, -1));
  });
  bar.appendChild(undo);

  const fill = el('button', 'loadout-tab', '凑满') as HTMLButtonElement;
  fill.disabled = view.loadoutPicks.length >= LOADOUT_SIZE;
  fill.addEventListener('click', () => {
    view.onPickLoadout(picked, defaultLoadout(state.ledger, picked));
  });
  bar.appendChild(fill);

  const enter = el('button', 'primary', '进塔') as HTMLButtonElement;
  enter.disabled = !isLegalLoadout(state.ledger, view.loadoutPicks);
  enter.addEventListener('click', () => {
    dispatch({
      type: 'choose_loadout',
      cardIds: view.loadoutPicks,
      atMs: performance.now(),
    });
  });
  bar.appendChild(enter);
  section.appendChild(bar);

  return section;
}

/** 塔还在成形。这一局的局势要先定下来，它整座塔通用。 */
function generatingView(state: RunState): HTMLElement {
  const section = el('section', 'favor');
  section.appendChild(el('h2', undefined, '塔在成形…'));
  section.appendChild(el('p', 'favor-hint', '这一局有哪几方、它们为什么结仇，正在定下来。'));
  for (const agent of state.agents) {
    section.appendChild(el('p', 'favor-hint', `${agent.name}：${agent.persona}`));
  }
  section.appendChild(el('p', 'favor-hint', state.journal.slice(-1)[0] ?? ''));
  return section;
}

/** 这一局的局势。常驻显示——玩家随时该知道自己卷进了谁和谁的事。 */
function situationView(state: RunState): HTMLElement {
  const section = el('section', 'situation');
  const details = el('details', 'situation-detail') as HTMLDetailsElement;
  const summary = el('summary', undefined, state.generation.grievance);
  details.appendChild(summary);
  // 名册：谁跟谁结了仇，各自想要什么。打开一次就够了，所以收在 summary 后面。
  for (const agent of state.agents) {
    details.appendChild(el('p', undefined, `${agent.name}：${agent.goal}`));
  }
  section.appendChild(details);
  return section;
}

function el(tag: string, className?: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function header(state: RunState): HTMLElement {
  const standing = Object.entries(standings(state))
    .map(([factionId, value]) => `${factionNameOf(state, factionId)} ${value}`)
    .join(' · ');

  const wrap = el('header', 'header');
  wrap.appendChild(
    el(
      'span',
      undefined,
      `Tower of Minds — ${state.floor > NORMAL_FLOORS ? '塔顶' : `第 ${state.floor}/${NORMAL_FLOORS} 层`} · 回合 ${state.encounter.turn}` +
        (standing ? `　|　态度：${standing}` : ''),
    ),
  );

  // 你此刻站在谁那边。玩家应该随时知道这件事，而不是打完才发现。
  if (state.phase === 'in_encounter') {
    const siding = currentSiding(state);
    wrap.appendChild(
      el(
        'div',
        'siding',
        siding ? `你正站在${factionNameOf(state, siding)}这边` : '你还没有偏向任何一方',
      ),
    );
  }
  return wrap;
}

/** 层间的报酬：由你偏袒过的那一方给，选一张进 Deck，也可以不要。 */
/** 正在等这一方取舍。玩家只能等——但等的是一个有性格的决定。 */
function fusingView(state: RunState): HTMLElement {
  const request = state.agentRequests.find((r) => r.kind === 'fusion');
  const who = state.agents.find((a) => a.factionId === request?.factionId)?.name ?? '对方';
  const section = el('section', 'favor');
  section.appendChild(
    el('h2', undefined, request?.overload ? `${who}正在往里塞点什么…` : `${who}正在替你取舍…`),
  );
  return section;
}

function favorView(state: RunState, view: View, dispatch: Dispatch): HTMLElement {
  const offer = state.favor;
  const section = el('section', 'favor');
  if (!offer) return section;

  if (!offer.factionId) {
    section.appendChild(el('h2', undefined, '没有哪一方觉得欠你人情'));
  } else {
    const who = factionNameOf(state, offer.factionId);
    section.appendChild(
      el('h2', undefined, offer.tier === 'high' ? `${who}欠你一个大人情` : `${who}记下了这一场`),
    );
  }

  const fusing = offer.tier === 'high' && offer.choices.length > 0;
  if (fusing) {
    section.appendChild(
      el('p', 'favor-hint', '高阶人情给的不是一张牌，而是一次融合：选它给的一张，再选你自己的一张。'),
    );
  }

  const row = el('div', 'hand');
  for (const cardId of offer.choices) {
    const definition = cardById(state, cardId);
    if (!definition) continue;
    const button = cardButton(definition, view.fuseOfferedId === cardId, costFor(state, definition));
    button.addEventListener('click', () => {
      if (fusing) view.onPickFuse(cardId, view.fuseDeckInstanceId);
      else dispatch({ type: 'choose_favor', cardId, atMs: performance.now() });
    });
    row.appendChild(button);
  }
  section.appendChild(row);

  if (fusing) section.appendChild(fusePicker(state, view, dispatch));
  section.appendChild(opponentPrep(state));

  const skip = document.createElement('button');
  skip.className = 'primary';
  skip.textContent = offer.choices.length > 0 ? '什么都不要，上一层' : '上一层';
  skip.addEventListener('click', () =>
    dispatch({ type: 'choose_favor', cardId: null, atMs: performance.now() }),
  );
  section.appendChild(skip);
  return section;
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

function combatantsView(state: RunState, view: View): HTMLElement {
  const section = el('section', 'combatants');
  const target = effectiveTarget(state, view);

  for (const combatant of state.encounter.combatants) {
    const down = combatant.hp <= 0;
    const selected = !down && combatant.id === target;
    const classes = ['combatant'];
    if (down) classes.push('combatant-down');
    if (selected) classes.push('combatant-target');
    const card = el('div', classes.join(' '));
    if (!down) {
      card.addEventListener('click', () => view.onSelectTarget(combatant.id));
    }

    const heading = el('h2', undefined, combatant.name);
    heading.appendChild(el('span', 'combatant-faction', factionNameOf(state, combatant.factionId)));
    card.appendChild(heading);
    card.appendChild(meter('HP', combatant.hp, combatant.maxHp, 'fill-hp'));
    if (combatant.block > 0) card.appendChild(el('div', 'block-badge', `格挡 ${combatant.block}`));

    // 它这一层带上来的牌。玩家看得见自己教会了它什么。
    const learned = combatant.actions.filter((action) => action.id.startsWith('card:'));
    if (learned.length > 0 && !down) {
      card.appendChild(
        el('div', 'combatant-learned', `带着：${learned.map((a) => a.description).join('；')}`),
      );
    }

    if (down) {
      card.appendChild(el('div', 'combatant-next', '已倒下'));
    } else {
      // Intent：它下一回合打算做什么。动作由引擎从合法集里确认过，台词只是叙事。
      const action = intendedAction(combatant);
      if (action) {
        const aim = combatant.intent?.targetId;
        const aimName = aim
          ? (state.encounter.combatants.find((c) => c.id === aim)?.name ?? aim)
          : '';
        // 护同伴用的是另一个动词——「攻向自己人」会把它读反
        const at =
          aim === null || aim === undefined
            ? ''
            : action.kind === 'protect'
              ? `护住${aimName}：`
              : aim === PLAYER_TARGET
                ? '攻向你：'
                : `攻向${aimName}：`;
        card.appendChild(
          el('div', `combatant-next${action.kind === 'protect' ? ' combatant-guarding' : ''}`,
            `意图：${at}${action.description}`),
        );
        const line = combatant.intent?.line;
        if (line) card.appendChild(el('div', 'combatant-line', `「${line}」`));
      }
      // 刻意什么都不显示：Intent 还没到就先空着，等它到了自己出现。
      // 玩家从不因为模型而被挡住，所以界面上也不该有「AI 思考中」这种东西。
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
  const parts = [describeAtoms(definition.atoms)];
  if (definition.execution) parts.push('需要时机判定');
  return parts.filter((part) => part.length > 0).join('；');
}

/** 玩家这一刻打出去会打到谁：选中的那个，选中的死了就退回引擎的默认目标。 */
function effectiveTarget(state: RunState, view: View): string | undefined {
  const chosen = state.encounter.combatants.find((c) => c.id === view.selectedTargetId && c.hp > 0);
  return chosen?.id ?? defaultTarget(state);
}

function factionNameOf(state: RunState, factionId: string): string {
  return state.agents.find((a) => a.factionId === factionId)?.name ?? factionId;
}

function handView(state: RunState, view: View, dispatch: Dispatch): HTMLElement {
  const section = el('section', 'hand');
  const target = effectiveTarget(state, view);

  for (const card of state.encounter.player.hand) {
    const definition = definitionOf(state, card.instanceId);
    if (!definition) continue;

    const button = document.createElement('button');
    button.className = `card card-${definition.type}`;
    button.disabled = !canPlay(state, card.instanceId);
    button.appendChild(el('span', 'card-cost', String(costFor(state, definition))));
    button.appendChild(el('span', 'card-name', definition.name));
    button.appendChild(el('span', 'card-atoms', atomGlyphs(definition.atoms)));
    button.appendChild(el('span', 'card-text', describe(definition)));
    button.addEventListener('click', () =>
      dispatch({
        type: 'play_card',
        instanceId: card.instanceId,
        atMs: performance.now(),
        ...(target ? { targetId: target } : {}),
      }),
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

/** 三种原型各自的提示语。手感不同，说法就得不同——这是玩家认出类别的第一条线索。 */
const EXECUTION_HINT: Record<ExecutionKind, string> = {
  block: '按 空格 定格',
  rhythm: '跟着拍子，按 空格 连打三下',
  charge: '按 空格 起手，撑住，快到头再按一下',
};

/**
 * 时机条：轨道代表整个判定窗口，高亮区是该按的那几拍。三种原型共用这一条轨道，
 * 差别全在**有几个靶子、落在哪**——那正是三种手感的来源。
 *
 * 靶子的位置与宽窄直接读引擎导出的常量，UI 和规则不各写一份。
 */
function timingBar(spec: ExecutionSpec): TimingBar {
  const root = el('section', 'timing');
  root.appendChild(el('div', 'timing-hint', EXECUTION_HINT[spec.kind]));

  const track = el('div', 'timing-track');
  for (const target of spec.targets) {
    track.appendChild(
      zone({ start: target - spec.goodTolerance, end: target + spec.goodTolerance }, 'timing-good'),
    );
  }
  for (const target of spec.targets) {
    track.appendChild(
      zone(
        { start: target - spec.perfectTolerance, end: target + spec.perfectTolerance },
        'timing-perfect',
      ),
    );
  }

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

  const pending = state.encounter.pending;
  if (state.encounter.phase === 'awaiting_execution' && pending) {
    const bar = timingBar(pending.spec);
    // 已经按下的那几次留在轨道上：连击到第几拍了，得看得见
    for (const at of pending.presses) {
      const mark = el('div', 'timing-press');
      mark.style.left = `${Math.min(100, at * 100)}%`;
      bar.track.appendChild(mark);
    }
    section.appendChild(bar.root);
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

/**
 * 它记得你做过什么。看不见的 Memory 等于不存在——玩家必须能验证一个 Faction 的态度
 * 从何而来，否则它的针对性只会像是无理由的刁难。
 */
function memoryView(state: RunState): HTMLElement {
  const section = el('section', 'memories');
  const values = standings(state);

  for (const agent of state.agents) {
    const summary = summarizeMemory(state, agent.factionId);
    if (summary.sided + summary.parley + summary.harm + summary.cards.length === 0) continue;

    const box = document.createElement('details');
    box.className = 'memory';
    const title = document.createElement('summary');
    title.textContent = `${agent.name}　态度 ${values[agent.factionId] ?? 0}`;
    box.appendChild(title);

    const lines = describeMemory(summary, (id) => cardById(state, id)?.name ?? id);
    for (const line of lines) {
      box.appendChild(el('p', undefined, line));
    }
    section.appendChild(box);
  }
  return section;
}

/** 层间对手在干什么：它也在为下一层备牌，备好了就摊开给玩家看。 */
function opponentPrep(state: RunState): HTMLElement {
  const wrap = el('div', 'prep');
  for (const agent of state.agents) {
    const waiting = state.agentRequests.some(
      (request) => request.kind === 'deckbuild' && request.factionId === agent.factionId,
    );
    const picked = state.factionDecks[agent.factionId];

    if (waiting) {
      wrap.appendChild(el('p', 'favor-hint', `${agent.name}正在为下一层备牌…`));
    } else if (picked && picked.length > 0) {
      const names = picked.map((id) => cardById(state, id)?.name ?? id).join('、');
      wrap.appendChild(el('p', 'favor-hint', `${agent.name}备好了：${names}`));
    }
  }
  return wrap;
}

function cardButton(
  definition: CardDefinition,
  selected: boolean,
  cost = definition.cost,
): HTMLButtonElement {
  const button = document.createElement('button');
  button.className = `card card-${definition.type}${selected ? ' card-selected' : ''}`;
  button.appendChild(el('span', 'card-cost', String(cost)));
  button.appendChild(el('span', 'card-name', definition.name));
  button.appendChild(el('span', 'card-atoms', atomGlyphs(definition.atoms)));
  button.appendChild(el('span', 'card-text', describeAtoms(definition.atoms)));
  return button;
}

/** 从自己的 Deck 里挑一张来融，并决定要不要过载。 */
function fusePicker(state: RunState, view: View, dispatch: Dispatch): HTMLElement {
  const wrap = el('div', 'fuse');
  wrap.appendChild(el('p', 'favor-hint', '你的牌库：'));

  const row = el('div', 'hand');
  for (const card of state.deck) {
    const definition = cardById(state, card.definitionId);
    if (!definition) continue;
    const button = cardButton(definition, view.fuseDeckInstanceId === card.instanceId, costFor(state, definition));
    button.addEventListener('click', () => view.onPickFuse(view.fuseOfferedId, card.instanceId));
    row.appendChild(button);
  }
  wrap.appendChild(row);

  const offeredId = view.fuseOfferedId;
  const offered = offeredId ? cardById(state, offeredId) : undefined;
  const mine = state.deck.find((c) => c.instanceId === view.fuseDeckInstanceId);
  const mineDefinition = mine ? cardById(state, mine.definitionId) : undefined;
  if (!offeredId || !offered || !mine || !mineDefinition) return wrap;

  const merged = [...mineDefinition.atoms, ...offered.atoms];
  wrap.appendChild(
    el('p', 'favor-hint', `合并后：${atomGlyphs(merged)}（${merged.length} 个 Atom）`),
  );

  const over = merged.length > MAX_ATOMS_PER_CARD;
  const fuse = document.createElement('button');
  fuse.className = 'primary';
  fuse.textContent = over ? '让它替我取舍' : '融合';
  fuse.addEventListener('click', () =>
    dispatch({
      type: 'fuse',
      offeredCardId: offeredId,
      deckInstanceId: mine.instanceId,
      overload: false,
      atMs: performance.now(),
    }),
  );
  wrap.appendChild(fuse);

  if (over) {
    const overload = document.createElement('button');
    overload.className = 'primary danger';
    overload.textContent = '过载，赌一把';
    overload.addEventListener('click', () =>
      dispatch({
        type: 'fuse',
        offeredCardId: offeredId,
        deckInstanceId: mine.instanceId,
        overload: true,
        atMs: performance.now(),
      }),
    );
    wrap.appendChild(overload);
  }
  return wrap;
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
  // 这一趟挣到的解锁：跨 Run 唯一带得走的东西，也是再开一局的理由。
  if (state.earnedUnlocks.length > 0) {
    section.appendChild(
      el(
        'p',
        'favor-hint',
        `你学会了：${state.earnedUnlocks
          .map((id) => CARD_POOL.find((card) => card.id === id)?.name ?? id)
          .join('、')}。下一局就能带进塔。`,
      ),
    );
  }

  const again = document.createElement('button');
  again.className = 'primary';
  again.textContent = '再来一局';
  again.addEventListener('click', restart);
  section.appendChild(again);
  return section;
}

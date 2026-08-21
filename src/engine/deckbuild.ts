import { effectsOf } from './atoms.js';
import { CARD_POOL, baseCardsOf } from './content.js';
import { summarizeMemory } from './memory.js';
import type { CardDefinition, CombatantAction, RunState } from './types.js';

/**
 * 对手也在构筑。
 *
 * 它的合法牌集只有两个来源：自己 Faction 的 Base Card，以及**玩家在它面前打出过的牌**。
 * 没见过的东西它拿不到——所以「在某一方面前不打核心组合」是玩家真实可用的反制，
 * 而不是一句设定。
 *
 * 挑到的牌不会替换它原有的动作，而是加在后面：它学会的东西是**多出来的选项**，
 * 玩家一眼就能看出自己教了它什么。
 */

/** 一个 Faction 一层最多带几张。数量少，玩家才读得过来。 */
export const DECK_CAPACITY = 2;

/** 合法牌集：自己的 Base Card，加上它亲眼见过玩家打出的牌。 */
export function legalCardsFor(state: RunState, factionId: string): readonly string[] {
  const own = baseCardsOf(factionId).map((card) => card.id);
  const seen = summarizeMemory(state, factionId).cards;
  return [...new Set([...own, ...seen])];
}

/** 答不上来时用的固定预设：自己派系最靠前的几张。 */
export function presetDeckFor(factionId: string): readonly string[] {
  return baseCardsOf(factionId)
    .slice(0, DECK_CAPACITY)
    .map((card) => card.id);
}

/**
 * 把一张 Card 翻成 Combatant 的一个动作。
 *
 * 数值走的是和玩家完全相同的 Atom 展开——它借走你的牌，就要照你的规则用。
 */
export function actionFromCard(card: CardDefinition): CombatantAction | null {
  let damage = 0;
  let block = 0;

  for (const effect of effectsOf(card.atoms, 'target')) {
    if (effect.kind === 'damage') damage += effect.amount * effect.hits;
    else if (effect.kind === 'gain_block') block += effect.amount;
  }

  if (damage > 0) {
    return {
      id: `card:${card.id}`,
      kind: 'attack',
      amount: damage,
      description: `${card.name}：造成 ${damage} 点伤害`,
    };
  }
  if (block > 0) {
    return {
      id: `card:${card.id}`,
      kind: 'defend',
      amount: block,
      description: `${card.name}：获得 ${block} 点格挡`,
    };
  }
  return null;
}

/** 这一派带上这一层的牌，翻成它多出来的动作。 */
export function extraActionsFor(
  state: RunState,
  cardIds: readonly string[],
): readonly CombatantAction[] {
  const actions: CombatantAction[] = [];
  for (const id of cardIds) {
    const card =
      CARD_POOL.find((c) => c.id === id) ?? state.forged.find((c) => c.id === id);
    if (!card) continue;
    const action = actionFromCard(card);
    if (action && !actions.some((a) => a.id === action.id)) actions.push(action);
  }
  return actions;
}

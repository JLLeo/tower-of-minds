import { CARD_POOL, LOADOUT_SIZE } from './content.js';
import type { CardDefinition, CardType, UnlockLedger } from './types.js';

/**
 * Unlock Ledger 是跨 Run 唯一持久的东西（ADR-0009）。Memory、Standing、Deck、
 * 融合产物一律止于 Run 边界。
 *
 * 它只记 Base Card 的 id。融合与突变的产物拿不到 id 之外的身份，因此不可能进这里——
 * 那是有意的：跨 Run 带走一张融合牌等于把这一局的运气变成永久收益，肉鸽就散架了。
 */

/** 新档解锁的那一批：每一派单 Atom 的基本功。它们是「基础牌」。 */
export const NEW_SAVE_LEDGER: UnlockLedger = {
  cardIds: CARD_POOL.filter((card) => card.atoms.length === 1 && !isParley(card.id)).map(
    (card) => card.id,
  ),
};

function isParley(cardId: string): boolean {
  return CARD_POOL.find((card) => card.id === cardId)?.atoms.includes('parley') ?? false;
}

/**
 * 通关时 Standing 最高的那一派解锁它的**组合牌**——你跟着它打了一路，它才肯教你
 * 它真正的手法。
 */
export function unlocksForFavoring(factionId: string): readonly string[] {
  return CARD_POOL.filter(
    (card) => card.faction === factionId && card.atoms.length > 1 && !isParley(card.id),
  ).map((card) => card.id);
}

/** 打倒某一派的首领，解锁它的 Parley 牌——你打服了他们，他们才肯跟你谈。 */
export function unlocksForFelling(factionId: string): readonly string[] {
  return CARD_POOL.filter((card) => card.faction === factionId && isParley(card.id)).map(
    (card) => card.id,
  );
}

/** 这一局挣到了什么。只在通关时结算：死在半路上的塔不教你任何东西。 */
export function earnedUnlocks(
  ledger: UnlockLedger,
  favoredFactionId: string | null,
  felledFactionId: string | null,
): readonly string[] {
  const candidates = [
    ...(favoredFactionId ? unlocksForFavoring(favoredFactionId) : []),
    ...(felledFactionId ? unlocksForFelling(felledFactionId) : []),
  ];
  return candidates.filter((id) => !ledger.cardIds.includes(id));
}

/** 把新解锁的牌并进 Ledger。已有的不重复记。 */
export function grantUnlocks(
  ledger: UnlockLedger,
  cardIds: readonly string[],
): UnlockLedger {
  const added = cardIds.filter((id) => !ledger.cardIds.includes(id));
  return added.length === 0 ? ledger : { cardIds: [...ledger.cardIds, ...added] };
}

/** 某一派里你已经解锁的牌。Loadout 界面列的就是这些。 */
export function unlockedCardsOf(
  ledger: UnlockLedger,
  factionId: string,
): readonly string[] {
  return CARD_POOL.filter(
    (card) => card.faction === factionId && ledger.cardIds.includes(card.id),
  ).map((card) => card.id);
}

/** 能组 Loadout 的 Faction：解锁的牌够凑一副（允许重复，所以有一张就够）。 */
export function loadoutFactionsOf(ledger: UnlockLedger): readonly string[] {
  const factions: string[] = [];
  for (const card of CARD_POOL) {
    if (!ledger.cardIds.includes(card.id)) continue;
    if (!factions.includes(card.faction)) factions.push(card.faction);
  }
  return factions;
}

/**
 * 一副 Loadout 合不合法：张数对得上、每一张都解锁了、而且**全部出自同一个 Faction**。
 *
 * 单派系是这个票的核心约束，不是形式检查：你带着谁的牌进塔是你的第一次表态，而它
 * 可能和你在塔里的站队打架。允许混装就把这个取舍抹平了。
 */
export function isLegalLoadout(ledger: UnlockLedger, cardIds: readonly string[]): boolean {
  if (cardIds.length !== LOADOUT_SIZE) return false;

  let faction: string | null = null;
  for (const id of cardIds) {
    const card = CARD_POOL.find((c) => c.id === id);
    if (!card) return false;
    if (!ledger.cardIds.includes(id)) return false;
    if (faction === null) faction = card.faction;
    else if (card.faction !== faction) return false;
  }
  return faction !== null;
}

/** 一副默认牌组里出手的位置有几个，站住的位置有几个。剩下的留给那一派别的手法。 */
const DEFAULT_ATTACKS = 5;
const DEFAULT_SHIELDS = 4;

/**
 * 玩家没选、或者选了一副非法的，就用这一副。确定性：同一个 Ledger 永远得到同一副，
 * 引擎不掷骰。
 *
 * 它不是把解锁的牌摊平——那样组出来的一副没法打（实测比有意组的一副少撑一整层）。
 * 主力是这一派最便宜的攻与最便宜的守，剩下的位置才轮着发。
 */
export function defaultLoadout(ledger: UnlockLedger, factionId?: string): readonly string[] {
  const faction = factionId ?? loadoutFactionsOf(ledger)[0];
  if (faction === undefined) return [];

  const available = unlockedCardsOf(ledger, faction)
    .map((id) => CARD_POOL.find((card) => card.id === id))
    .filter((card): card is CardDefinition => card !== undefined);
  if (available.length === 0) return [];

  // 同费时按 id 定序：确定性不能靠 CARD_POOL 的书写顺序。
  const cheapest = (type: CardType): CardDefinition | undefined =>
    available
      .filter((card) => card.type === type)
      .sort((a, b) => a.cost - b.cost || a.id.localeCompare(b.id))[0];

  const deck: string[] = [];
  const attack = cheapest('attack');
  const shield = cheapest('shield');
  if (attack) while (deck.length < DEFAULT_ATTACKS) deck.push(attack.id);
  if (shield) while (deck.length < DEFAULT_ATTACKS + DEFAULT_SHIELDS) deck.push(shield.id);
  for (let i = 0; deck.length < LOADOUT_SIZE; i++) deck.push(available[i % available.length]!.id);

  return deck;
}

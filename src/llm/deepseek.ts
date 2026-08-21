import { atomTableForPrompt, describeAtoms } from '../engine/atoms.js';
import { CARD_POOL } from '../engine/content.js';
import type { AgentProvider, AgentTask } from './provider.js';

const NEWLINE = String.fromCharCode(10);

const CARD_POOL_LINES = CARD_POOL.map(
  (card) => `- ${card.name}（${card.cost} 费）：${describeAtoms(card.atoms)}`,
).join('\n');

/**
 * 稳定前缀：规则、回答格式与固定卡池。它在所有请求、所有 Agent 之间完全一致，
 * 因此能命中 context cache。
 * 任何按局变化的东西都必须留到 user 消息里，否则前缀失效、成本翻倍。
 */
const SYSTEM_PROMPT = `你在一款卡牌 roguelike 里扮演塔中的一个角色。
每回合你会收到一份合法动作清单，你只能从中挑一个。你不能发明新动作、新数值或新效果——
清单之外的任何东西都会被引擎丢弃。
用 JSON 回答，形如 {"actionId": "<清单里的 id>", "targetId": "<该动作允许的目标 id>", "line": "<一句不超过 20 字的台词>"}。
targetId 必须原样抄写清单里给出的 id（形如 player、vine-scout），**不要写名字**，写错会被丢弃。
自我防御类动作不需要 targetId。塔里不止一个派系，你可以打外来者，也可以打敌对派系——
清单里列出的就是你这一刻能打的全部目标。
台词要反映你的动机，不要复述动作本身。

所有牌都由固定的 Atom 组成，没有别的东西：
${atomTableForPrompt()}

对手用的牌来自这个固定卡池：
${CARD_POOL_LINES}`;

/**
 * 用户段分两块：Agent 段（性格 + 目标，本局内不变）在前，任务段在后。
 * 全局规则与卡池留在 system 里，对所有 Agent、所有 kind 完全一致，用于命中缓存。
 */
function userPrompt(task: AgentTask): string {
  if (task.kind === 'generation') {
    const rows = task.factions
      .map((f) => `- ${f.id}：这一派用的牌是「${f.cards}」`)
      .join(NEWLINE);
    return `给这一局的塔编一个局势。

塔里有下面这几方。**它们的 id 是固定的，你不能新增、删除或替换**，只能给它们起名字、
定脾气、写清楚它们各自想要什么，以及**它们为什么互相看不顺眼**。
每一派用的牌能透露它们是什么样的人。

${rows}

最要紧的是那条过节：它们之间必须有一个具体的、能让人动手的理由，而不是「都想赶走外来者」。
外来者只是刚好撞进来的第三方。

用 JSON 回答：
{"title":"<塔的名字，不超过 8 个字>",
 "grievance":"<两派为什么结仇，一到两句>",
 "factions":[{"factionId":"<上面的 id>","name":"<不超过 4 个字>","persona":"<脾气，一句>","goal":"<它想要什么，一到两句，要提到它跟另一方的过节>"}]}`;
  }

  const persona = `你是${task.agent.name}。你的性格：${task.agent.persona}
你的目标：${task.agent.goal}

你对这个外来者的态度是 ${task.standing}（正数表示他帮过你们，负数表示他伤过你们）。
你记得的事：
${task.memory}`;

  switch (task.kind) {
    case 'deckbuild': {
      const list = task.cards.map((c) => `- ${c.id}｜${c.name}：${c.text}`).join(NEWLINE);
      return `${persona}

外来者就要上到第 ${task.forFloor} 层了。趁现在给自己备牌。
下面是你**拿得到**的牌：你自己派系的家底，加上你亲眼见过他打出来的那些。
你没见过的东西不在这里——他藏着的牌，你无从知道。

最多带 ${task.capacity} 张。挑什么反映你打算怎么对付他。
如果你觉得两张合起来更趁手，可以把它们融了。

${list}

用 JSON 回答：{"cardIds": ["<上面的 id>", …]}
想融合就再加两个字段：{"fuse": ["<id>", "<id>"], "name": "<不超过 6 个字的牌名>"}`;
    }

    case 'fusion': {
      const [a, b] = task.sourceNames;
      const list = (options: readonly { id: string; name: string; description: string; weight: number }[]): string =>
        options.map((o) => `- ${o.id}（${o.name}，权重 ${o.weight}）：${o.description}`).join('\n');

      if (task.overload) {
        return `${persona}

外来者把「${a}」和「${b}」压在一起，而且拒绝丢掉任何东西——他要过载。
由你决定塞进哪一个禁忌 Atom，并给这张新牌起个名字。

可选的禁忌 Atom：
${list(task.forbidden)}

用 JSON 回答：{"forbiddenAtomId": "<上面的 id>", "name": "<不超过 6 个字的牌名>"}`;
      }

      return `${persona}

外来者要把「${a}」和「${b}」融成一张，但合起来的 Atom 超出了一张牌装得下的数量。
由你决定丢掉哪一个，并给这张新牌起个名字。丢什么反映你看重什么。

合并后的 Atom：
${list(task.atoms)}

用 JSON 回答：{"dropAtomId": "<上面的 id>", "name": "<不超过 6 个字的牌名>"}`;
    }

    case 'intent': {
      const { combatant } = task;
      const options = task.options
        .map((option) => {
          const targets = option.targets.length
            ? option.targets.map((t) => `targetId=${t.id}（${t.name}）`).join('、')
            : '无需目标';
          return `- ${option.actionId}：${option.description}｜可选目标：${targets}`;
        })
        .join('\n');

      const allies = task.allies.length ? task.allies.join('、') : '无';
      const rivals = task.rivals.length ? task.rivals.join('、') : '无';

      return `${persona}

现在由你决定${combatant.name}这一回合做什么。
第 ${task.turn} 回合。它 HP ${combatant.hp}/${combatant.maxHp}，格挡 ${combatant.block}。
外来者 HP ${task.playerHp}/${task.playerMaxHp}，格挡 ${task.playerBlock}，手里还有 ${task.handSize} 张牌。
你的同伴：${allies}
敌对派系：${rivals}

合法动作与目标：
${options}`;
    }
  }
}

export interface DeepSeekOptions {
  /** 浏览器里指向本地代理，key 由 Node 侧注入；Node 里可以直接指向供应商。 */
  readonly baseUrl: string;
  readonly model: string;
  /** 只在 Node 侧传。浏览器永远不传——key 不进前端包。 */
  readonly apiKey?: string;
}

/**
 * 回答的长度上限。Intent 是一句台词，局势是两派的一整段设定——用同一个上限会把
 * 局势截成半截 JSON，解析一失败就整局悄悄回退成内置那份，而且看上去像模型答错了。
 */
function maxTokensFor(task: AgentTask): number {
  return task.kind === 'generation' ? 600 : 120;
}

export function createDeepSeekProvider(options: DeepSeekOptions): AgentProvider {
  return {
    async ask(task: AgentTask, signal: AbortSignal): Promise<unknown> {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (options.apiKey) headers['Authorization'] = `Bearer ${options.apiKey}`;

      const response = await fetch(`${options.baseUrl}/chat/completions`, {
        method: 'POST',
        headers,
        signal,
        body: JSON.stringify({
          model: options.model,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: userPrompt(task) },
          ],
          // 这个模型默认开着 thinking，reasoning token 会吃掉 max_tokens 并推高延迟。
          // 实测只有 { type: 'disabled' } 真的关得掉。
          thinking: { type: 'disabled' },
          response_format: { type: 'json_object' },
          max_tokens: maxTokensFor(task),
          stream: false,
        }),
      });

      if (!response.ok) {
        throw new Error(`供应商返回 HTTP ${response.status}`);
      }

      const body: unknown = await response.json();
      const content = extractContent(body);

      // 解析传输层的 JSON 是适配器的职责；内容合不合法由引擎判断。
      // 解析失败就把原始字符串原样交回去，引擎会把它当作非法响应并回退。
      try {
        return JSON.parse(content) as unknown;
      } catch {
        return content;
      }
    },
  };
}

function extractContent(body: unknown): string {
  if (typeof body !== 'object' || body === null) return '';
  const choices = (body as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return '';
  const message = (choices[0] as { message?: unknown }).message;
  if (typeof message !== 'object' || message === null) return '';
  const content = (message as { content?: unknown }).content;
  return typeof content === 'string' ? content : '';
}

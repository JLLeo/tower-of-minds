import { describeAtoms } from '../engine/atoms.js';
import { CARD_POOL } from '../engine/content.js';
import type { AgentProvider, AgentTask } from './provider.js';

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
用 JSON 回答，形如 {"actionId": "<清单里的 id>", "line": "<一句不超过 20 字的台词>"}。
台词要反映你的动机，不要复述动作本身。

对手用的牌来自这个固定卡池：
${CARD_POOL_LINES}`;

/**
 * 用户段分两块：Agent 段（性格 + 目标，本局内不变）在前，任务段在后。
 * 全局规则与卡池留在 system 里，对所有 Agent、所有 kind 完全一致，用于命中缓存。
 */
function userPrompt(task: AgentTask): string {
  const persona = `你是${task.agent.name}。你的性格：${task.agent.persona}
你的目标：${task.agent.goal}`;

  switch (task.kind) {
    case 'intent': {
      const { combatant } = task;
      const actions = combatant.actions
        .map((action) => `- ${action.id}：${action.description}`)
        .join('\n');

      return `${persona}

现在由你决定${combatant.name}这一回合做什么。
第 ${task.turn} 回合。它 HP ${combatant.hp}/${combatant.maxHp}，格挡 ${combatant.block}。
对手 HP ${task.playerHp}/${task.playerMaxHp}，格挡 ${task.playerBlock}，手里还有 ${task.handSize} 张牌。

合法动作：
${actions}`;
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
          max_tokens: 120,
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

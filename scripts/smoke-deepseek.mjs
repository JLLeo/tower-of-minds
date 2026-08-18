/**
 * 手动 smoke 脚本：对真实供应商发起 Intent 调用，报告连通性与实际延迟。
 *
 * 不属于测试套件——它要花钱、要网络、结果不确定。它存在的目的是回答一个
 * 只有实测能回答的问题：2.5 秒的回合预算到底成不成立。
 *
 *   node --env-file=.env scripts/smoke-deepseek.mjs [次数]
 */

const key = process.env.DEEPSEEK_API_KEY;
const baseUrl = process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com';
const model = process.env.DEEPSEEK_INTENT_MODEL ?? 'deepseek-v4-flash';
const rounds = Number(process.argv[2] ?? 5);

if (!key) {
  console.error('缺少 DEEPSEEK_API_KEY。把 .env.example 复制成 .env 并填入 key，然后用');
  console.error('  node --env-file=.env scripts/smoke-deepseek.mjs');
  process.exit(1);
}

/** 稳定前缀：规则与卡池。真实运行时这部分要命中 context cache。 */
const SYSTEM_PROMPT = `你在一款卡牌 roguelike 里扮演一个角色。
每回合你会收到一份合法动作清单，你只能从中挑一个，不能发明新动作、新数值或新效果。
用 JSON 回答，形如 {"actionId": "<清单里的 id>", "line": "<一句不超过 20 字的台词>"}。
台词要反映你的动机，不要复述动作本身。`;

const LEGAL_ACTIONS = [
  { id: 'slash', description: '攻击玩家，造成 7 点伤害' },
  { id: 'brace', description: '为自己架起 5 点格挡' },
  { id: 'taunt', description: '嘲讽，令玩家下回合抽牌减少 1 张' },
];

function userPrompt() {
  return `你是塔卫，赤环派的守门人。你的目标是把外来者挡在第二层之下。
战况：你 HP 31/45，格挡 0。玩家 HP 27/40，格挡 5，手里还有 3 张牌。
你记得：玩家上一回合放过了青蔓派的伤员。

合法动作：
${LEGAL_ACTIONS.map((a) => `- ${a.id}：${a.description}`).join('\n')}`;
}

async function callOnce() {
  const startedAt = performance.now();
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userPrompt() },
      ],
      // 这个模型默认开着 thinking，reasoning token 会吃掉 max_tokens 并推高延迟。
      // 实测只有 { type: 'disabled' } 真的关得掉：reasoning_effort:'none' 会让模型
      // 明显变笨（返回 actionId:"1"），enable_thinking:false 被直接忽略。
      thinking: { type: 'disabled' },
      response_format: { type: 'json_object' },
      max_tokens: 120,
      stream: false,
    }),
  });

  const elapsedMs = performance.now() - startedAt;
  const text = await response.text();

  if (!response.ok) {
    return { ok: false, elapsedMs, status: response.status, detail: text.slice(0, 300) };
  }

  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return { ok: false, elapsedMs, status: response.status, detail: '响应不是 JSON' };
  }

  const content = body?.choices?.[0]?.message?.content ?? '';
  let intent = null;
  try {
    intent = JSON.parse(content);
  } catch {
    /* 交给下面的合法性检查处理 */
  }

  const legal =
    intent !== null && LEGAL_ACTIONS.some((a) => a.id === intent.actionId);

  return {
    ok: true,
    elapsedMs,
    status: response.status,
    legal,
    intent,
    usage: body?.usage ?? null,
  };
}

console.log(`供应商 ${baseUrl} · 模型 ${model} · ${rounds} 次调用\n`);

const timings = [];
let illegal = 0;

for (let i = 1; i <= rounds; i++) {
  try {
    const result = await callOnce();
    const ms = Math.round(result.elapsedMs);
    if (!result.ok) {
      console.log(`#${i}  ${ms}ms  失败 HTTP ${result.status} :: ${result.detail}`);
      continue;
    }
    timings.push(result.elapsedMs);
    if (!result.legal) illegal++;
    const cached = result.usage?.prompt_cache_hit_tokens ?? 0;
    console.log(
      `#${i}  ${ms}ms  ${result.legal ? '合法' : '非法'}  ` +
        `actionId=${result.intent?.actionId ?? '—'}  「${result.intent?.line ?? '—'}」  ` +
        `tokens in=${result.usage?.prompt_tokens ?? '?'}(cached ${cached}) out=${result.usage?.completion_tokens ?? '?'}`,
    );
  } catch (error) {
    console.log(`#${i}  网络错误 :: ${error instanceof Error ? error.message : String(error)}`);
  }
}

if (timings.length === 0) {
  console.log('\n没有一次成功的调用。');
  process.exit(1);
}

const sorted = [...timings].sort((a, b) => a - b);
const at = (q) => Math.round(sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]);
const mean = Math.round(timings.reduce((sum, t) => sum + t, 0) / timings.length);

console.log(`\n成功 ${timings.length}/${rounds}，其中返回非法 actionId ${illegal} 次`);
console.log(`延迟  最快 ${at(0)}ms · 中位 ${at(0.5)}ms · 最慢 ${at(0.999)}ms · 均值 ${mean}ms`);
console.log(`2.5 秒预算：${at(0.999) <= 2500 ? '本次全部落在预算内' : '有调用超出预算'}`);

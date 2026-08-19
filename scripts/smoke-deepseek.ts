/**
 * 手动 smoke 脚本：用**真实的** provider 与**真实的**引擎校验路径跑一遍 Intent 调用，
 * 报告连通性、延迟与合法率。
 *
 * 它不属于测试套件——要花钱、要网络、结果不确定。它存在的目的是回答一个只有实测
 * 能回答的问题：2.5 秒的回合预算成不成立。
 *
 * 刻意不复制一份 prompt：它 import src/llm/deepseek.ts，所以量到的就是出货代码。
 * 响应也不自己判合法，而是喂进 applyInput，让引擎按 ADR-0001 的规则判——
 * source 是 'agent' 才算模型真的给出了合法选择。
 *
 *   npm run smoke -- [次数]
 */
import { applyInput, startRun } from '../src/engine/run.js';
import { BUILT_IN_GENERATION } from '../src/engine/content.js';
import { createDeepSeekProvider } from '../src/llm/deepseek.js';
import { taskFor } from '../src/llm/provider.js';

try {
  process.loadEnvFile('.env');
} catch {
  // 没有 .env 也行，环境变量可能已经在外面设好了
}

const apiKey = process.env['DEEPSEEK_API_KEY'];
const baseUrl = process.env['DEEPSEEK_BASE_URL'] ?? 'https://api.deepseek.com';
const model = process.env['DEEPSEEK_INTENT_MODEL'] ?? 'deepseek-v4-flash';
const rounds = Number(process.argv[2] ?? 5);

if (!apiKey) {
  console.error('缺少 DEEPSEEK_API_KEY。把 .env.example 复制成 .env 并填入 key。');
  process.exit(1);
}

// Node 侧直连供应商并自己带 key；浏览器走的是 vite 的 /api/llm 中间件。
const provider = createDeepSeekProvider({ baseUrl, model, apiKey });

console.log(`供应商 ${baseUrl} · 模型 ${model} · ${rounds} 次调用\n`);

const timings: number[] = [];
let rejected = 0;

for (let i = 1; i <= rounds; i++) {
  const state = startRun(BUILT_IN_GENERATION, i, { startedAtMs: 0 });
  const request = state.agentRequests[0];
  const task = request ? taskFor(state, request) : undefined;

  if (!request || !task) {
    console.log(`#${i}  引擎没有挂出提问，跳过`);
    continue;
  }

  const startedAt = performance.now();
  try {
    const payload = await provider.ask(task, new AbortController().signal);
    const elapsedMs = performance.now() - startedAt;
    timings.push(elapsedMs);

    // 合法性由引擎判，不在这里另写一份规则。
    const next = applyInput(state, { type: 'agent_response', requestId: request.id, payload });
    const intent = next.encounter.combatants.find((c) => c.id === request.combatantId)?.intent;
    const accepted = intent?.source === 'agent';
    if (!accepted) rejected++;

    console.log(
      `#${i}  ${Math.round(elapsedMs)}ms  ${accepted ? '引擎接受' : '引擎拒绝并回退'}  ` +
        `actionId=${intent?.actionId ?? '—'}  「${intent?.line || '—'}」`,
    );
  } catch (error) {
    console.log(`#${i}  调用失败 :: ${error instanceof Error ? error.message : String(error)}`);
  }
}

if (timings.length === 0) {
  console.log('\n没有一次成功的调用。');
  process.exit(1);
}

const sorted = [...timings].sort((a, b) => a - b);
const at = (q: number): number => Math.round(sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0);
const mean = Math.round(timings.reduce((sum, t) => sum + t, 0) / timings.length);

console.log(`\n成功 ${timings.length}/${rounds}，其中被引擎拒绝 ${rejected} 次`);
console.log(`延迟  最快 ${at(0)}ms · 中位 ${at(0.5)}ms · 最慢 ${at(0.999)}ms · 均值 ${mean}ms`);
console.log(`2.5 秒预算：${at(0.999) <= 2500 ? '本次全部落在预算内' : '有调用超出预算'}`);

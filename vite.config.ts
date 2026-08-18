/// <reference types="vitest/config" />
import { defineConfig, loadEnv, type Plugin } from 'vite';

/**
 * 开发期的 LLM 转发中间件。
 *
 * 浏览器打到 /api/llm/*，这里在 Node 侧补上 Authorization 再转发出去——
 * API key 因此从不进入前端包，也不出现在任何浏览器可见的地方（ADR-0006）。
 * 上线形态需要一个真正的服务端，这一层是它的开发期替身。
 */
function llmProxy(baseUrl: string, apiKey: string): Plugin {
  return {
    name: 'tower-of-minds:llm-proxy',
    configureServer(server) {
      server.middlewares.use('/api/llm', (req, res) => {
        void (async () => {
          try {
            // 只放行 Intent 需要的那一条路径，避免这层变成一个通用的、带 key 的开放代理。
            if (req.url !== '/chat/completions') {
              res.statusCode = 404;
              res.end();
              return;
            }

            const chunks: Uint8Array[] = [];
            for await (const chunk of req) chunks.push(chunk as Uint8Array);

            const upstream = await fetch(`${baseUrl}${req.url ?? ''}`, {
              method: req.method ?? 'POST',
              headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${apiKey}`,
              },
              body: Buffer.concat(chunks),
            });

            const payload = Buffer.from(await upstream.arrayBuffer());
            res.statusCode = upstream.status;
            res.setHeader('Content-Type', 'application/json');
            res.end(payload);
          } catch (error) {
            res.statusCode = 502;
            res.setHeader('Content-Type', 'application/json');
            res.end(
              JSON.stringify({
                error: error instanceof Error ? error.message : '转发失败',
              }),
            );
          }
        })();
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  // 空前缀读取全部变量：DEEPSEEK_API_KEY 故意不带 VITE_ 前缀，
  // 因此它只存在于 Node 侧的这份配置里，永远不会被打进前端包。
  const env = loadEnv(mode, process.cwd(), '');
  const apiKey = env['DEEPSEEK_API_KEY'] ?? '';
  const baseUrl = env['DEEPSEEK_BASE_URL'] ?? 'https://api.deepseek.com';

  if (!apiKey) {
    console.warn('[tower-of-minds] 没有读到 DEEPSEEK_API_KEY，Agent 的每次决策都会回退到启发式。');
  }

  return {
    plugins: [llmProxy(baseUrl, apiKey)],
    define: {
      __INTENT_MODEL__: JSON.stringify(env['DEEPSEEK_INTENT_MODEL'] ?? 'deepseek-v4-flash'),
    },
    test: {
      environment: 'node',
      include: ['src/**/*.test.ts'],
    },
  };
});

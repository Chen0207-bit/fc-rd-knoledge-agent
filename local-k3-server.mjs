import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const HOST = "127.0.0.1";
const PORT = Number(process.env.K3_BRIDGE_PORT || 8765);
const MODEL = process.env.K3_MODEL || "k3";
const SETTINGS_PATH = process.env.CLAUDE_SETTINGS_PATH || join(homedir(), ".claude", "settings.json");

function cors(origin = "") {
  const allowed = /^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(origin);
  return {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": allowed ? origin : "http://127.0.0.1:5173",
    "access-control-allow-headers": "content-type",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    vary: "origin",
  };
}

function send(response, origin, status, body) {
  response.writeHead(status, cors(origin));
  response.end(JSON.stringify(body));
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 256_000) throw new Error("请求内容超过 256 KB");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

async function loadConfig() {
  const settings = JSON.parse(await readFile(SETTINGS_PATH, "utf8"));
  const baseUrl = String(settings?.env?.ANTHROPIC_BASE_URL || "").replace(/\/$/, "");
  const token = String(settings?.env?.ANTHROPIC_AUTH_TOKEN || settings?.env?.ANTHROPIC_API_KEY || "");
  if (!baseUrl || !token) throw new Error("settings.json 缺少 ANTHROPIC_BASE_URL 或认证信息");
  return { baseUrl, token };
}

function buildPrompt(title, sourceText) {
  return `你是一名严谨的中国知识产权材料撰写助手。请仅依据给定研发资料，输出可供专业人员复核的中文 Markdown 初稿。

材料名称：${title}

必须按顺序包含：
1. # 技术交底书
2. ## 技术领域
3. ## 背景技术与现有问题
4. ## 核心创新点（3-5项）
5. ## 技术方案
6. ## 实施方式
7. ## 有益效果
8. # 专利摘要（不超过300字）
9. # 权利要求书初稿（独立方法权利要求、3项从属权利要求、系统权利要求）
10. # 待确认事项

不得编造实验数据、性能指标或法律结论；信息不足处用【待补充】标记；结尾注明“本材料为AI生成初稿，需由知识产权专业人员复核”。

研发资料：
${sourceText.slice(0, 48_000)}`;
}

const server = createServer(async (request, response) => {
  const origin = request.headers.origin || "";
  if (request.method === "OPTIONS") {
    response.writeHead(204, cors(origin));
    return response.end();
  }
  if (request.method === "GET" && request.url === "/health") {
    return send(response, origin, 200, { ok: true, model: MODEL, settings: SETTINGS_PATH });
  }
  if (request.method !== "POST" || request.url !== "/generate") {
    return send(response, origin, 404, { error: "接口不存在" });
  }
  try {
    const body = await readBody(request);
    const title = String(body.title || "研发成果知识产权材料").slice(0, 200);
    const sourceText = String(body.sourceText || "");
    if (sourceText.trim().length < 80) throw new Error("可用于生成的研发资料不足");
    const { baseUrl, token } = await loadConfig();
    const upstream = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": token, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 4200,
        temperature: 0.25,
        messages: [{ role: "user", content: buildPrompt(title, sourceText) }],
      }),
    });
    const payload = await upstream.json().catch(() => ({}));
    if (!upstream.ok) throw new Error(payload?.error?.message || `K3 返回 ${upstream.status}`);
    const markdown = Array.isArray(payload.content)
      ? payload.content.filter((item) => item?.type === "text").map((item) => item.text).join("\n")
      : "";
    if (!markdown.trim()) throw new Error("K3 未返回正文内容");
    return send(response, origin, 200, {
      draft: { id: -Date.now(), title, sourceRefs: "local", markdown, model: MODEL, createdAt: new Date().toISOString() },
    });
  } catch (error) {
    return send(response, origin, 500, { error: error instanceof Error ? error.message : "K3 本地服务异常" });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`K3 本地桥接服务已启动：http://${HOST}:${PORT}`);
  console.log(`模型：${MODEL}；配置：${SETTINGS_PATH}`);
});

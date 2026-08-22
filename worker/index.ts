type D1Statement = {
  bind: (...values: unknown[]) => D1Statement;
  first: <T = Record<string, unknown>>() => Promise<T | null>;
  all: <T = Record<string, unknown>>() => Promise<{ results: T[] }>;
  run: () => Promise<{ success: boolean; meta?: { last_row_id?: number } }>;
};
type D1Database = { prepare: (sql: string) => D1Statement };
type AiBinding = { run: (model: string, input: Record<string, unknown>) => Promise<Record<string, unknown>> };
interface Env {
  DB: D1Database;
  AI: AiBinding;
  DEMO_ACCESS_CODE: string;
  GLM_API_KEY: string;
  ALLOWED_ORIGIN: string;
}

let featureColumnsReady: Promise<void> | null = null;

type Paper = {
  id?: number;
  source: "arxiv" | "semantic_scholar" | "crossref";
  externalId: string;
  title: string;
  authors: string[];
  abstract: string;
  publishedAt?: string;
  url: string;
  pdfUrl?: string;
  status?: "pending" | "approved" | "rejected";
  reviewerNote?: string;
  libraryState?: "in" | "removed";
  groupName?: string;
};

const AI_MODEL = "glm-5.3";
const FALLBACK_AI_MODEL = "@cf/qwen/qwen3-30b-a3b-fp8";
const GLM_API_URL = "https://open.bigmodel.cn/api/paas/v4/chat/completions";
type UserAIConfig = { provider: string; endpoint: string; apiKey: string; model: string };

function userAIConfig(request: Request): UserAIConfig | null {
  const apiKey = (request.headers.get("x-user-ai-key") || "").trim().slice(0, 500);
  const endpoint = (request.headers.get("x-user-ai-endpoint") || "").trim().slice(0, 500);
  if (!apiKey || !endpoint) return null;
  return {
    provider: (request.headers.get("x-user-ai-provider") || "openai-compatible").trim().slice(0, 40),
    endpoint,
    apiKey,
    model: (request.headers.get("x-user-ai-model") || AI_MODEL).trim().slice(0, 120) || AI_MODEL,
  };
}

function chatEndpoint(endpoint: string) {
  const clean = endpoint.replace(/\/$/, "");
  return clean.endsWith("/chat/completions") ? clean : `${clean}/chat/completions`;
}

function responseHeaders(request: Request, env: Env) {
  const origin = request.headers.get("origin") || "";
  const allowed = origin === env.ALLOWED_ORIGIN || /^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(origin);
  return {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": allowed ? origin : env.ALLOWED_ORIGIN,
    "access-control-allow-headers": "content-type,x-demo-code,x-user-ai-provider,x-user-ai-endpoint,x-user-ai-key,x-user-ai-model",
    "access-control-allow-methods": "GET,POST,DELETE,OPTIONS",
    "vary": "origin",
  };
}

function json(request: Request, env: Env, body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: responseHeaders(request, env) });
}

function error(request: Request, env: Env, message: string, status = 400) {
  return json(request, env, { error: message }, status);
}

async function ensureFeatureColumns(env: Env) {
  if (featureColumnsReady) return featureColumnsReady;
  featureColumnsReady = (async () => {
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS projects (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)").run();
  await env.DB.prepare("INSERT INTO projects (id, name, description) SELECT 1, '默认研发项目', '用于演示论文搜集、研发知识沉淀与知识产权转化。' WHERE NOT EXISTS (SELECT 1 FROM projects WHERE id = 1)").run();
  for (const statement of [
    "ALTER TABLE papers ADD COLUMN project_id INTEGER NOT NULL DEFAULT 1",
    "ALTER TABLE documents ADD COLUMN project_id INTEGER NOT NULL DEFAULT 1",
    "ALTER TABLE ip_drafts ADD COLUMN project_id INTEGER NOT NULL DEFAULT 1",
    "ALTER TABLE papers ADD COLUMN library_state TEXT NOT NULL DEFAULT 'in'",
    "ALTER TABLE papers ADD COLUMN group_name TEXT NOT NULL DEFAULT '未分类'",
    "ALTER TABLE documents ADD COLUMN group_name TEXT NOT NULL DEFAULT '未分类'",
    "ALTER TABLE ip_drafts ADD COLUMN group_name TEXT NOT NULL DEFAULT '未分类'",
  ]) {
    try { await env.DB.prepare(statement).run(); } catch { /* existing column */ }
  }
  })();
  return featureColumnsReady;
}

function projectId(url: URL) {
  const value = Number(url.searchParams.get("project_id"));
  return Number.isInteger(value) && value > 0 ? value : 1;
}

function clean(value = "") {
  return value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function decodeXml(value = "") {
  return clean(value)
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'");
}

function xmlValue(block: string, tag: string) {
  const match = block.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return decodeXml(match?.[1] || "");
}

async function searchArxiv(query: string, limit: number): Promise<Paper[]> {
  const url = new URL("https://export.arxiv.org/api/query");
  url.searchParams.set("search_query", `all:${query}`);
  url.searchParams.set("start", "0");
  url.searchParams.set("max_results", String(limit));
  url.searchParams.set("sortBy", "submittedDate");
  url.searchParams.set("sortOrder", "descending");
  const response = await fetch(url, { headers: { "user-agent": "fc-rd-knowledge-agent/1.0 (research demo)" } });
  if (!response.ok) throw new Error(`arXiv 返回 ${response.status}`);
  const xml = await response.text();
  return (xml.match(/<entry>[\s\S]*?<\/entry>/gi) || []).map((entry) => {
    const idUrl = xmlValue(entry, "id");
    const externalId = idUrl.split("/").pop()?.replace(/v\d+$/, "") || crypto.randomUUID();
    const authors = [...entry.matchAll(/<author>[\s\S]*?<name>([\s\S]*?)<\/name>[\s\S]*?<\/author>/gi)].map((match) => decodeXml(match[1]));
    const pdfMatch = entry.match(/<link[^>]+title=["']pdf["'][^>]+href=["']([^"']+)["']/i) || entry.match(/<link[^>]+href=["']([^"']+)["'][^>]+title=["']pdf["']/i);
    return {
      source: "arxiv" as const,
      externalId,
      title: xmlValue(entry, "title"),
      authors,
      abstract: xmlValue(entry, "summary"),
      publishedAt: xmlValue(entry, "published"),
      url: idUrl,
      pdfUrl: pdfMatch?.[1],
    };
  });
}

async function searchSemanticScholar(query: string, limit: number): Promise<Paper[]> {
  const url = new URL("https://api.semanticscholar.org/graph/v1/paper/search");
  url.searchParams.set("query", query);
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("fields", "paperId,title,abstract,authors,year,publicationDate,externalIds,url,openAccessPdf");
  const response = await fetch(url, { headers: { "user-agent": "fc-rd-knowledge-agent/1.0" } });
  if (!response.ok) throw new Error(`Semantic Scholar 返回 ${response.status}`);
  const payload = await response.json() as { data?: Array<Record<string, unknown>> };
  return (payload.data || []).map((item) => {
    const authors = Array.isArray(item.authors) ? item.authors.map((author) => String((author as { name?: string }).name || "")).filter(Boolean) : [];
    const pdf = item.openAccessPdf as { url?: string } | null;
    return {
      source: "semantic_scholar" as const,
      externalId: String(item.paperId || crypto.randomUUID()),
      title: String(item.title || "未命名论文"),
      authors,
      abstract: String(item.abstract || ""),
      publishedAt: String(item.publicationDate || (item.year ? `${item.year}-01-01` : "")),
      url: String(item.url || `https://www.semanticscholar.org/paper/${item.paperId}`),
      pdfUrl: pdf?.url,
    };
  });
}

async function searchCrossref(query: string, limit: number): Promise<Paper[]> {
  const url = new URL("https://api.crossref.org/works");
  url.searchParams.set("query", query);
  url.searchParams.set("rows", String(limit));
  url.searchParams.set("select", "DOI,title,abstract,author,published-online,published-print,URL,link");
  const response = await fetch(url, { headers: { "user-agent": "fc-rd-knowledge-agent/1.0 (mailto:feng85656@gmail.com)" } });
  if (!response.ok) throw new Error(`Crossref 返回 ${response.status}`);
  const payload = await response.json() as { message?: { items?: Array<Record<string, unknown>> } };
  return (payload.message?.items || []).map((item) => {
    const authors = Array.isArray(item.author)
      ? item.author.map((author) => {
          const value = author as { given?: string; family?: string };
          return `${value.given || ""} ${value.family || ""}`.trim();
        }).filter(Boolean)
      : [];
    const dateParts = ((item["published-online"] || item["published-print"]) as { "date-parts"?: number[][] } | undefined)?.["date-parts"]?.[0] || [];
    const publishedAt = dateParts.length ? `${dateParts[0]}-${String(dateParts[1] || 1).padStart(2, "0")}-${String(dateParts[2] || 1).padStart(2, "0")}` : "";
    const links = Array.isArray(item.link) ? item.link as Array<{ URL?: string; "content-type"?: string }> : [];
    const pdfUrl = links.find((link) => link["content-type"] === "application/pdf")?.URL;
    const title = Array.isArray(item.title) ? String(item.title[0] || "未命名论文") : String(item.title || "未命名论文");
    return {
      source: "crossref" as const,
      externalId: String(item.DOI || crypto.randomUUID()),
      title: clean(title),
      authors,
      abstract: clean(String(item.abstract || "")),
      publishedAt,
      url: String(item.URL || (item.DOI ? `https://doi.org/${item.DOI}` : "https://search.crossref.org")),
      pdfUrl,
    };
  });
}

function deduplicate(papers: Paper[]) {
  const seen = new Set<string>();
  return papers.filter((paper) => {
    const key = paper.title.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]/g, "").slice(0, 120);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function rowToPaper(row: Record<string, unknown>): Paper {
  return {
    id: Number(row.id),
    source: row.source as Paper["source"],
    externalId: String(row.external_id),
    title: String(row.title),
    authors: JSON.parse(String(row.authors || "[]")) as string[],
    abstract: String(row.abstract || ""),
    publishedAt: String(row.published_at || ""),
    url: String(row.url || ""),
    pdfUrl: String(row.pdf_url || ""),
    status: row.status as Paper["status"],
    reviewerNote: String(row.reviewer_note || ""),
    libraryState: (row.library_state || "in") as Paper["libraryState"],
    groupName: String(row.group_name || "未分类"),
  };
}

async function enforceGenerationLimit(request: Request, env: Env) {
  const ip = request.headers.get("cf-connecting-ip") || "local";
  const hour = new Date().toISOString().slice(0, 13);
  const key = `generate:${ip}:${hour}`;
  const current = await env.DB.prepare("SELECT count FROM rate_limits WHERE key = ?").bind(key).first<{ count: number }>();
  if ((current?.count || 0) >= 3) return false;
  await env.DB.prepare("INSERT INTO rate_limits (key, count, updated_at) VALUES (?, 1, CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET count = count + 1, updated_at = CURRENT_TIMESTAMP").bind(key).run();
  return true;
}

async function collectSources(env: Env, refs: string[], currentProjectId = 1) {
  const sections: string[] = [];
  for (const ref of refs.slice(0, 6)) {
    const [type, rawId] = ref.split(":");
    const id = Number(rawId);
    if (type === "paper") {
      const row = await env.DB.prepare("SELECT title, abstract FROM papers WHERE id = ? AND project_id = ? AND status = 'approved' AND library_state = 'in'").bind(id, currentProjectId).first<{ title: string; abstract: string }>();
      if (row) sections.push(`【论文：${row.title}】\n${row.abstract}`);
    } else if (type === "document") {
      const row = await env.DB.prepare("SELECT name, text FROM documents WHERE id = ? AND project_id = ?").bind(id, currentProjectId).first<{ name: string; text: string }>();
      if (row) sections.push(`【研发文件：${row.name}】\n${row.text.slice(0, 24_000)}`);
    }
  }
  return sections.join("\n\n").slice(0, 48_000);
}

async function generateAssistantReply(env: Env, messages: Array<{ role: "user" | "assistant"; content: string }>, context: string, customConfig: UserAIConfig | null = null) {
  const system = `你是“研知 Agent”的研发知识顾问，陪伴用户完成“研究方向讨论—论文检索—人工审核—知识入库—知识产权转化”全流程。
回答要简洁、具体、可执行：优先给出检索关键词、筛选标准、下一步操作和风险提示。不要编造论文、实验数据或法律结论；需要更多信息时直接提问。不要输出隐式思维链，只输出结论、依据摘要和建议。
当前页面上下文：${context.slice(0, 12000)}`;
  const payloadMessages = [{ role: "system", content: system }, ...messages.slice(-12).map((item) => ({ role: item.role, content: item.content.slice(0, 4000) }))];
  const apiKey = customConfig?.apiKey || env.GLM_API_KEY;
  if (apiKey) {
    const response = await fetch(customConfig ? chatEndpoint(customConfig.endpoint) : GLM_API_URL, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: customConfig?.model || AI_MODEL, messages: payloadMessages, stream: false, max_tokens: 2200, temperature: 0.35 }),
    });
    const result = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    const content = result.choices?.[0]?.message?.content || "";
    if (response.ok && content.trim()) return { content, model: customConfig?.model || AI_MODEL };
  }
  const fallback = await env.AI.run(FALLBACK_AI_MODEL, { messages: payloadMessages, max_tokens: 2200, temperature: 0.35 });
  const content = typeof fallback.response === "string" ? fallback.response : typeof fallback.result === "string" ? fallback.result : "暂时无法生成建议";
  return { content, model: FALLBACK_AI_MODEL };
}

const worker = {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: responseHeaders(request, env) });
    const url = new URL(request.url);
    if (url.pathname === "/api/health") return json(request, env, { ok: true, service: "fc-rd-knowledge-agent-api" });
    if (!env.DEMO_ACCESS_CODE || request.headers.get("x-demo-code") !== env.DEMO_ACCESS_CODE) return error(request, env, "演示访问码不正确", 401);

    try {
      await ensureFeatureColumns(env);
      if (request.method === "GET" && url.pathname === "/api/projects") {
        const rows = await env.DB.prepare("SELECT id, name, description, created_at, updated_at FROM projects ORDER BY created_at ASC").all<Record<string, unknown>>();
        return json(request, env, { projects: rows.results.map((row) => ({ id: Number(row.id), name: String(row.name), description: String(row.description || ""), createdAt: String(row.created_at), updatedAt: String(row.updated_at) })) });
      }
      if (request.method === "POST" && url.pathname === "/api/projects") {
        const body = await request.json() as { name?: string; description?: string };
        const name = String(body.name || "未命名研发项目").trim().slice(0, 80);
        if (!name) return error(request, env, "项目名称不能为空");
        const insert = await env.DB.prepare("INSERT INTO projects (name, description) VALUES (?, ?)").bind(name, String(body.description || "").slice(0, 500)).run();
        return json(request, env, { project: { id: Number(insert.meta?.last_row_id || 0), name, description: String(body.description || "").slice(0, 500) } }, 201);
      }
      const projectMatch = url.pathname.match(/^\/api\/projects\/(\d+)$/);
      if (request.method === "POST" && projectMatch) {
        const body = await request.json() as { name?: string; description?: string };
        const name = String(body.name || "").trim().slice(0, 80);
        if (!name) return error(request, env, "项目名称不能为空");
        await env.DB.prepare("UPDATE projects SET name = ?, description = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(name, String(body.description || "").slice(0, 500), Number(projectMatch[1])).run();
        return json(request, env, { ok: true });
      }
      const currentProjectId = projectId(url);
      if (request.method === "POST" && url.pathname === "/api/assistant-chat") {
        const body = await request.json() as { messages?: Array<{ role?: string; content?: string }>; context?: string };
        const messages = (body.messages || []).filter((item): item is { role: "user" | "assistant"; content: string } =>
          (item.role === "user" || item.role === "assistant") && Boolean(item.content?.trim()),
        );
        if (!messages.length) return error(request, env, "请输入想讨论的内容");
        const reply = await generateAssistantReply(env, messages, body.context || "暂无页面上下文", userAIConfig(request));
        return json(request, env, { reply: reply.content, model: reply.model });
      }
      if (request.method === "POST" && url.pathname === "/api/assistant-plan") {
        const body = await request.json() as { sourceText?: string; fileName?: string; projectDescription?: string };
        const sourceText = String(body.sourceText || "").slice(0, 48_000);
        if (sourceText.length < 80) return error(request, env, "研发文件内容不足，无法制定计划");
        const planPrompt = `请为研发文件设计一个可执行的研发知识闭环计划。只输出 JSON，不要 Markdown 代码块，不要输出隐式思维链。
JSON 字段必须为：
{"summary":"一句话目标","searchQueries":["检索主题1","检索主题2","检索主题3"],"screeningCriteria":["论文筛选标准1","论文筛选标准2"],"evidenceMap":[{"evidence":"文件中的技术事实或问题","researchDirection":"对应论文研究方向","ipValue":"对方案书的价值"}],"analysisSummary":["基于哪些文件证据确定检索方向","如何判断论文与方案相关"],"steps":["步骤1","步骤2","步骤3"]}
要求：searchQueries 适合 arXiv、Semantic Scholar、Crossref 检索，至少给出 2 组、最多 4 组互补主题（方法、场景、工程约束、评价指标）；evidenceMap 必须把研发文件证据和论文方向、知识产权价值串起来；步骤必须覆盖文件解析、论文搜索、Agent 初审、用户确认入库、知识产权材料生成；不要编造文件中没有的技术事实。
项目介绍：${String(body.projectDescription || "").slice(0, 800)}
文件名：${String(body.fileName || "研发文件")}
研发文件内容：
${sourceText}`;
        const reply = await generateAssistantReply(env, [{ role: "user", content: planPrompt }], "这是一个待用户确认的研发文件 Workflow Plan 生成请求。", userAIConfig(request));
        let plan: { summary: string; searchQueries: string[]; screeningCriteria: string[]; evidenceMap: Array<{ evidence: string; researchDirection: string; ipValue: string }>; analysisSummary: string[]; steps: string[] };
        try {
          const normalized = reply.content.replace(/^```json\s*/i, "").replace(/\s*```$/i, "").trim();
          plan = JSON.parse(normalized) as typeof plan;
        } catch {
          plan = { summary: `围绕“${body.fileName || "研发文件"}”完成论文检索、审核入库与知识产权转化`, searchQueries: ["research intelligence agent", "engineering knowledge extraction", "industrial deployment method"], screeningCriteria: ["与研发主题高度相关", "有明确技术方案或实验依据"], evidenceMap: [{ evidence: "研发文件中的核心技术方案", researchDirection: "相关方法与应用研究", ipValue: "补充背景技术、技术方案和创新点依据" }], analysisSummary: ["从研发文件提取技术对象、方法和工程约束", "通过多主题检索扩展论文覆盖面", "按技术相关性和可引用价值进行初筛"], steps: ["解析研发文件并提炼技术主题", "检索并筛选相关论文", "Agent 初审后交由用户确认入库", "生成知识产权申报材料初稿"] };
        }
        return json(request, env, { plan, model: reply.model });
      }
      if (request.method === "GET" && url.pathname === "/api/papers/search") {
        const query = (url.searchParams.get("q") || "").trim();
        if (query.length < 2) return error(request, env, "请输入至少两个字符的检索主题");
        const source = url.searchParams.get("source") || "all";
        const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 8, 1), 20);
        const tasks: Array<Promise<Paper[]>> = [];
        if (source === "all" || source === "arxiv") tasks.push(searchArxiv(query, limit));
        if (source === "all" || source === "semantic_scholar") tasks.push(searchSemanticScholar(query, limit));
        const settled = await Promise.allSettled(tasks);
        const warnings = settled.filter((item) => item.status === "rejected").map((item) => (item as PromiseRejectedResult).reason?.message || "论文源暂时不可用");
        const collected = settled.flatMap((item) => item.status === "fulfilled" ? item.value : []);
        const semanticRequested = source === "all" || source === "semantic_scholar";
        const semanticAvailable = collected.some((paper) => paper.source === "semantic_scholar");
        if (semanticRequested && !semanticAvailable) {
          try {
            collected.push(...await searchCrossref(query, limit));
            warnings.push("Semantic Scholar 当前限流，已自动切换 Crossref");
          } catch (fallbackError) {
            warnings.push(fallbackError instanceof Error ? fallbackError.message : "Crossref 备用源暂时不可用");
          }
        }
        const papers = deduplicate(collected).slice(0, limit * 2);
        return json(request, env, { papers, warnings });
      }

      if (request.method === "POST" && url.pathname === "/api/papers/import") {
        const paper = await request.json() as Paper;
        if (!paper.title || !paper.externalId || !paper.source) return error(request, env, "论文数据不完整");
        const scopedExternalId = currentProjectId === 1 ? paper.externalId : `${currentProjectId}:${paper.externalId}`;
        await env.DB.prepare(`INSERT INTO papers (project_id, source, external_id, title, authors, abstract, published_at, url, pdf_url, status, library_state, group_name)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'in', ?)
          ON CONFLICT(source, external_id) DO UPDATE SET title=excluded.title, authors=excluded.authors, abstract=excluded.abstract, published_at=excluded.published_at, url=excluded.url, pdf_url=excluded.pdf_url`)
          .bind(currentProjectId, paper.source, scopedExternalId, paper.title.slice(0, 600), JSON.stringify(paper.authors || []), (paper.abstract || "").slice(0, 30_000), paper.publishedAt || "", paper.url || "", paper.pdfUrl || "", String(paper.groupName || "未分类").slice(0, 80)).run();
        const saved = await env.DB.prepare("SELECT id FROM papers WHERE project_id = ? AND source = ? AND external_id = ?").bind(currentProjectId, paper.source, scopedExternalId).first<{ id: number }>();
        return json(request, env, { ok: true, id: Number(saved?.id || 0) }, 201);
      }

      if (request.method === "GET" && url.pathname === "/api/papers") {
        const status = url.searchParams.get("status");
        const statement = status ? env.DB.prepare("SELECT * FROM papers WHERE project_id = ? AND status = ? ORDER BY created_at DESC LIMIT 100").bind(currentProjectId, status) : env.DB.prepare("SELECT * FROM papers WHERE project_id = ? ORDER BY created_at DESC LIMIT 100").bind(currentProjectId);
        const rows = await statement.all<Record<string, unknown>>();
        return json(request, env, { papers: rows.results.map(rowToPaper) });
      }

      const reviewMatch = url.pathname.match(/^\/api\/papers\/(\d+)\/review$/);
      if (request.method === "POST" && reviewMatch) {
        const body = await request.json() as { status?: string; note?: string };
        if (!["approved", "rejected"].includes(body.status || "")) return error(request, env, "审核状态无效");
        await env.DB.prepare("UPDATE papers SET status = ?, library_state = ?, reviewer_note = ?, reviewed_at = CURRENT_TIMESTAMP WHERE id = ? AND project_id = ?").bind(body.status, body.status === "approved" ? "in" : "removed", (body.note || "").slice(0, 1000), Number(reviewMatch[1]), currentProjectId).run();
        return json(request, env, { ok: true });
      }

      const libraryMatch = url.pathname.match(/^\/api\/papers\/(\d+)\/library$/);
      if (request.method === "POST" && libraryMatch) {
        const body = await request.json() as { action?: string };
        if (!["remove", "restore"].includes(body.action || "")) return error(request, env, "出库操作无效");
        await env.DB.prepare("UPDATE papers SET library_state = ? WHERE id = ? AND project_id = ?").bind(body.action === "remove" ? "removed" : "in", Number(libraryMatch[1]), currentProjectId).run();
        return json(request, env, { ok: true });
      }

      const paperGroupMatch = url.pathname.match(/^\/api\/papers\/(\d+)\/group$/);
      if (request.method === "POST" && paperGroupMatch) {
        const body = await request.json() as { groupName?: string };
        await env.DB.prepare("UPDATE papers SET group_name = ? WHERE id = ? AND project_id = ?").bind(String(body.groupName || "未分类").slice(0, 80), Number(paperGroupMatch[1]), currentProjectId).run();
        return json(request, env, { ok: true });
      }

      const paperDeleteMatch = url.pathname.match(/^\/api\/papers\/(\d+)$/);
      if (request.method === "DELETE" && paperDeleteMatch) {
        await env.DB.prepare("DELETE FROM papers WHERE id = ? AND project_id = ?").bind(Number(paperDeleteMatch[1]), currentProjectId).run();
        return json(request, env, { ok: true });
      }

      if (request.method === "POST" && url.pathname === "/api/documents") {
        const body = await request.json() as { name?: string; mimeType?: string; size?: number; text?: string; groupName?: string };
        if (!body.name || !body.text || body.text.trim().length < 80) return error(request, env, "研发文件文本不足");
        if ((body.size || 0) > 15 * 1024 * 1024) return error(request, env, "文件超过 15 MB");
        const insert = await env.DB.prepare("INSERT INTO documents (project_id, name, mime_type, size, text, group_name) VALUES (?, ?, ?, ?, ?, ?)").bind(currentProjectId, body.name.slice(0, 500), body.mimeType || "", body.size || 0, body.text.slice(0, 120_000), String(body.groupName || "未分类").slice(0, 80)).run();
        return json(request, env, { ok: true, id: Number(insert.meta?.last_row_id || 0) }, 201);
      }

      if (request.method === "GET" && url.pathname === "/api/documents") {
        const rows = await env.DB.prepare("SELECT id, name, mime_type, size, substr(text, 1, 260) AS text_preview, created_at, group_name FROM documents WHERE project_id = ? ORDER BY created_at DESC LIMIT 50").bind(currentProjectId).all<Record<string, unknown>>();
        return json(request, env, { documents: rows.results.map((row) => ({ id: Number(row.id), name: String(row.name), mimeType: String(row.mime_type), size: Number(row.size), textPreview: String(row.text_preview || ""), createdAt: String(row.created_at), groupName: String(row.group_name || "未分类") })) });
      }

      const documentMatch = url.pathname.match(/^\/api\/documents\/(\d+)$/);
      if (request.method === "GET" && documentMatch) {
        const row = await env.DB.prepare("SELECT id, name, mime_type, size, text, created_at, group_name FROM documents WHERE id = ? AND project_id = ?").bind(Number(documentMatch[1]), currentProjectId).first<Record<string, unknown>>();
        if (!row) return error(request, env, "研发文件不存在", 404);
        return json(request, env, { document: { id: Number(row.id), name: String(row.name), mimeType: String(row.mime_type), size: Number(row.size), text: String(row.text || ""), createdAt: String(row.created_at), groupName: String(row.group_name || "未分类") } });
      }

      const documentGroupMatch = url.pathname.match(/^\/api\/documents\/(\d+)\/group$/);
      if (request.method === "POST" && documentGroupMatch) {
        const body = await request.json() as { groupName?: string };
        await env.DB.prepare("UPDATE documents SET group_name = ? WHERE id = ? AND project_id = ?").bind(String(body.groupName || "未分类").slice(0, 80), Number(documentGroupMatch[1]), currentProjectId).run();
        return json(request, env, { ok: true });
      }

      const documentDeleteMatch = url.pathname.match(/^\/api\/documents\/(\d+)$/);
      if (request.method === "DELETE" && documentDeleteMatch) {
        await env.DB.prepare("DELETE FROM documents WHERE id = ? AND project_id = ?").bind(Number(documentDeleteMatch[1]), currentProjectId).run();
        return json(request, env, { ok: true });
      }

      if (request.method === "POST" && url.pathname === "/api/ip-drafts") {
        if (!await enforceGenerationLimit(request, env)) return error(request, env, "本小时生成次数已达上限，请稍后再试", 429);
        const body = await request.json() as { title?: string; sources?: string[]; groupName?: string; model?: string; speed?: string };
        const title = (body.title || "研发成果知识产权材料").slice(0, 200);
        const groupName = String(body.groupName || "未分类").slice(0, 80);
        const requestedModel = body.model === "glm-5.3" || body.model === "qwen3" ? body.model : "auto";
        const speed = body.speed === "fast" || body.speed === "deep" ? body.speed : "balanced";
        const customConfig = userAIConfig(request);
        const sourceText = await collectSources(env, body.sources || [], currentProjectId);
        if (sourceText.length < 80) return error(request, env, "没有找到可用于生成的已入库资料");
        const prompt = `你是一名严谨的中国知识产权材料撰写助手。请基于给定研发资料，输出可供专业人员复核的中文 Markdown 初稿。

材料名称：${title}

必须包含并按以下顺序输出：
1. # 技术交底书
2. ## 技术领域
3. ## 背景技术与现有问题
4. ## 核心创新点（3-5项）
5. ## 技术方案
6. ## 实施方式
7. ## 有益效果
8. # 专利摘要（不超过300字）
9. # 权利要求书初稿
   - 权利要求1：独立方法权利要求
   - 权利要求2-4：从属权利要求
   - 权利要求5：系统权利要求
10. # 待确认事项

要求：不得编造资料中不存在的实验数据、性能指标或法律结论；信息不足处用【待补充】标记；避免宣传语；在结尾声明“本材料为AI生成初稿，需由知识产权专业人员复核”。

研发资料：
${sourceText}`;
        const glmResponse = requestedModel !== "qwen3" && (customConfig?.apiKey || env.GLM_API_KEY) ? await fetch(customConfig ? chatEndpoint(customConfig.endpoint) : GLM_API_URL, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${customConfig?.apiKey || env.GLM_API_KEY}` },
          body: JSON.stringify({
            model: customConfig?.model || "glm-5.3",
            messages: [
              { role: "system", content: "你负责把研发证据转化为结构严谨、边界清楚的知识产权材料初稿。" },
              { role: "user", content: prompt },
            ],
            stream: false,
            max_tokens: speed === "fast" ? 2600 : speed === "deep" ? 5600 : 4200,
            temperature: speed === "deep" ? 0.18 : 0.25,
          }),
        }) : null;
        const result = glmResponse ? await glmResponse.json() as { choices?: Array<{ message?: { content?: string } }>; error?: { message?: string } } : {};
        let usedModel = requestedModel === "qwen3" ? FALLBACK_AI_MODEL : customConfig?.model || AI_MODEL;
        let markdown = glmResponse?.ok ? result.choices?.[0]?.message?.content || "" : "";
        if (!markdown.trim()) {
          const fallback = await env.AI.run(FALLBACK_AI_MODEL, {
            messages: [
              { role: "system", content: "你负责把研发证据转化为结构严谨、边界清楚的知识产权材料初稿。" },
              { role: "user", content: prompt },
            ],
            max_tokens: speed === "fast" ? 2600 : speed === "deep" ? 5600 : 4200,
            temperature: speed === "deep" ? 0.18 : 0.25,
          });
          markdown = typeof fallback.response === "string" ? fallback.response : typeof fallback.result === "string" ? fallback.result : "";
          usedModel = FALLBACK_AI_MODEL;
        }
        if (!markdown.trim()) throw new Error("GLM 未返回正文内容");
        const sourceRefs = JSON.stringify(body.sources || []);
        const insert = await env.DB.prepare("INSERT INTO ip_drafts (project_id, title, source_refs, markdown, model, group_name) VALUES (?, ?, ?, ?, ?, ?)").bind(currentProjectId, title, sourceRefs, markdown, usedModel, groupName).run();
        const draft = { id: Number(insert.meta?.last_row_id || 0), title, sourceRefs, markdown, model: usedModel, groupName, createdAt: new Date().toISOString() };
        return json(request, env, { draft }, 201);
      }

      if (request.method === "POST" && url.pathname === "/api/source-context") {
        const body = await request.json() as { sources?: string[] };
        const sourceText = await collectSources(env, body.sources || [], currentProjectId);
        if (sourceText.length < 80) return error(request, env, "没有找到可用于生成的已入库资料");
        return json(request, env, { sourceText });
      }

      if (request.method === "GET" && url.pathname === "/api/ip-drafts") {
        const rows = await env.DB.prepare("SELECT id, title, source_refs, markdown, model, created_at, group_name FROM ip_drafts WHERE project_id = ? ORDER BY created_at DESC LIMIT 20").bind(currentProjectId).all<Record<string, unknown>>();
        return json(request, env, { drafts: rows.results.map((row) => ({ id: Number(row.id), title: String(row.title), sourceRefs: String(row.source_refs), markdown: String(row.markdown), model: String(row.model), groupName: String(row.group_name || "未分类"), createdAt: String(row.created_at) })) });
      }

      const draftGroupMatch = url.pathname.match(/^\/api\/ip-drafts\/(\d+)\/group$/);
      if (request.method === "POST" && draftGroupMatch) {
        const body = await request.json() as { groupName?: string };
        await env.DB.prepare("UPDATE ip_drafts SET group_name = ? WHERE id = ? AND project_id = ?").bind(String(body.groupName || "未分类").slice(0, 80), Number(draftGroupMatch[1]), currentProjectId).run();
        return json(request, env, { ok: true });
      }

      const draftDeleteMatch = url.pathname.match(/^\/api\/ip-drafts\/(\d+)$/);
      if (request.method === "DELETE" && draftDeleteMatch) {
        await env.DB.prepare("DELETE FROM ip_drafts WHERE id = ? AND project_id = ?").bind(Number(draftDeleteMatch[1]), currentProjectId).run();
        return json(request, env, { ok: true });
      }

      if (request.method === "GET" && url.pathname === "/api/stats") {
        const [paperCount, pending, approved, documents, drafts] = await Promise.all([
          env.DB.prepare("SELECT count(*) AS count FROM papers WHERE project_id = ?").bind(currentProjectId).first<{ count: number }>(),
          env.DB.prepare("SELECT count(*) AS count FROM papers WHERE project_id = ? AND status='pending'").bind(currentProjectId).first<{ count: number }>(),
          env.DB.prepare("SELECT count(*) AS count FROM papers WHERE project_id = ? AND status='approved' AND library_state='in'").bind(currentProjectId).first<{ count: number }>(),
          env.DB.prepare("SELECT count(*) AS count FROM documents WHERE project_id = ?").bind(currentProjectId).first<{ count: number }>(),
          env.DB.prepare("SELECT count(*) AS count FROM ip_drafts WHERE project_id = ?").bind(currentProjectId).first<{ count: number }>(),
        ]);
        return json(request, env, { discovered: paperCount?.count || 0, pending: pending?.count || 0, approved: approved?.count || 0, documents: documents?.count || 0, drafts: drafts?.count || 0 });
      }

      return error(request, env, "接口不存在", 404);
    } catch (cause) {
      console.error(cause);
      return error(request, env, cause instanceof Error ? cause.message : "服务暂时不可用", 500);
    }
  },
};

export default worker;

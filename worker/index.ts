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
  ALLOWED_ORIGIN: string;
}

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
};

const AI_MODEL = "@cf/qwen/qwen3-30b-a3b-fp8";

function responseHeaders(request: Request, env: Env) {
  const origin = request.headers.get("origin") || "";
  const allowed = origin === env.ALLOWED_ORIGIN || /^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(origin);
  return {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": allowed ? origin : env.ALLOWED_ORIGIN,
    "access-control-allow-headers": "content-type,x-demo-code",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "vary": "origin",
  };
}

function json(request: Request, env: Env, body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: responseHeaders(request, env) });
}

function error(request: Request, env: Env, message: string, status = 400) {
  return json(request, env, { error: message }, status);
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

async function collectSources(env: Env, refs: string[]) {
  const sections: string[] = [];
  for (const ref of refs.slice(0, 6)) {
    const [type, rawId] = ref.split(":");
    const id = Number(rawId);
    if (type === "paper") {
      const row = await env.DB.prepare("SELECT title, abstract FROM papers WHERE id = ? AND status = 'approved'").bind(id).first<{ title: string; abstract: string }>();
      if (row) sections.push(`【论文：${row.title}】\n${row.abstract}`);
    } else if (type === "document") {
      const row = await env.DB.prepare("SELECT name, text FROM documents WHERE id = ?").bind(id).first<{ name: string; text: string }>();
      if (row) sections.push(`【研发文件：${row.name}】\n${row.text.slice(0, 24_000)}`);
    }
  }
  return sections.join("\n\n").slice(0, 48_000);
}

const worker = {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: responseHeaders(request, env) });
    const url = new URL(request.url);
    if (url.pathname === "/api/health") return json(request, env, { ok: true, service: "fc-rd-knowledge-agent-api" });
    if (!env.DEMO_ACCESS_CODE || request.headers.get("x-demo-code") !== env.DEMO_ACCESS_CODE) return error(request, env, "演示访问码不正确", 401);

    try {
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
        await env.DB.prepare(`INSERT INTO papers (source, external_id, title, authors, abstract, published_at, url, pdf_url, status)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')
          ON CONFLICT(source, external_id) DO UPDATE SET title=excluded.title, authors=excluded.authors, abstract=excluded.abstract, published_at=excluded.published_at, url=excluded.url, pdf_url=excluded.pdf_url`)
          .bind(paper.source, paper.externalId, paper.title.slice(0, 600), JSON.stringify(paper.authors || []), (paper.abstract || "").slice(0, 30_000), paper.publishedAt || "", paper.url || "", paper.pdfUrl || "").run();
        return json(request, env, { ok: true }, 201);
      }

      if (request.method === "GET" && url.pathname === "/api/papers") {
        const status = url.searchParams.get("status");
        const statement = status ? env.DB.prepare("SELECT * FROM papers WHERE status = ? ORDER BY created_at DESC LIMIT 100").bind(status) : env.DB.prepare("SELECT * FROM papers ORDER BY created_at DESC LIMIT 100");
        const rows = await statement.all<Record<string, unknown>>();
        return json(request, env, { papers: rows.results.map(rowToPaper) });
      }

      const reviewMatch = url.pathname.match(/^\/api\/papers\/(\d+)\/review$/);
      if (request.method === "POST" && reviewMatch) {
        const body = await request.json() as { status?: string; note?: string };
        if (!["approved", "rejected"].includes(body.status || "")) return error(request, env, "审核状态无效");
        await env.DB.prepare("UPDATE papers SET status = ?, reviewer_note = ?, reviewed_at = CURRENT_TIMESTAMP WHERE id = ?").bind(body.status, (body.note || "").slice(0, 1000), Number(reviewMatch[1])).run();
        return json(request, env, { ok: true });
      }

      if (request.method === "POST" && url.pathname === "/api/documents") {
        const body = await request.json() as { name?: string; mimeType?: string; size?: number; text?: string };
        if (!body.name || !body.text || body.text.trim().length < 80) return error(request, env, "研发文件文本不足");
        if ((body.size || 0) > 15 * 1024 * 1024) return error(request, env, "文件超过 15 MB");
        await env.DB.prepare("INSERT INTO documents (name, mime_type, size, text) VALUES (?, ?, ?, ?)").bind(body.name.slice(0, 500), body.mimeType || "", body.size || 0, body.text.slice(0, 120_000)).run();
        return json(request, env, { ok: true }, 201);
      }

      if (request.method === "GET" && url.pathname === "/api/documents") {
        const rows = await env.DB.prepare("SELECT id, name, mime_type, size, substr(text, 1, 260) AS text_preview, created_at FROM documents ORDER BY created_at DESC LIMIT 50").all<Record<string, unknown>>();
        return json(request, env, { documents: rows.results.map((row) => ({ id: Number(row.id), name: String(row.name), mimeType: String(row.mime_type), size: Number(row.size), textPreview: String(row.text_preview || ""), createdAt: String(row.created_at) })) });
      }

      if (request.method === "POST" && url.pathname === "/api/ip-drafts") {
        if (!await enforceGenerationLimit(request, env)) return error(request, env, "本小时生成次数已达上限，请稍后再试", 429);
        const body = await request.json() as { title?: string; sources?: string[] };
        const title = (body.title || "研发成果知识产权材料").slice(0, 200);
        const sourceText = await collectSources(env, body.sources || []);
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
        const result = await env.AI.run(AI_MODEL, { messages: [{ role: "system", content: "你负责把研发证据转化为结构严谨、边界清楚的知识产权材料初稿。" }, { role: "user", content: prompt }], max_tokens: 4200, temperature: 0.25 });
        const markdown = typeof result.response === "string" ? result.response : typeof result.result === "string" ? result.result : JSON.stringify(result, null, 2);
        const sourceRefs = JSON.stringify(body.sources || []);
        const insert = await env.DB.prepare("INSERT INTO ip_drafts (title, source_refs, markdown, model) VALUES (?, ?, ?, ?)").bind(title, sourceRefs, markdown, AI_MODEL).run();
        const draft = { id: Number(insert.meta?.last_row_id || 0), title, sourceRefs, markdown, model: AI_MODEL, createdAt: new Date().toISOString() };
        return json(request, env, { draft }, 201);
      }

      if (request.method === "GET" && url.pathname === "/api/ip-drafts") {
        const rows = await env.DB.prepare("SELECT id, title, source_refs, markdown, model, created_at FROM ip_drafts ORDER BY created_at DESC LIMIT 20").all<Record<string, unknown>>();
        return json(request, env, { drafts: rows.results.map((row) => ({ id: Number(row.id), title: String(row.title), sourceRefs: String(row.source_refs), markdown: String(row.markdown), model: String(row.model), createdAt: String(row.created_at) })) });
      }

      if (request.method === "GET" && url.pathname === "/api/stats") {
        const [paperCount, pending, approved, documents, drafts] = await Promise.all([
          env.DB.prepare("SELECT count(*) AS count FROM papers").first<{ count: number }>(),
          env.DB.prepare("SELECT count(*) AS count FROM papers WHERE status='pending'").first<{ count: number }>(),
          env.DB.prepare("SELECT count(*) AS count FROM papers WHERE status='approved'").first<{ count: number }>(),
          env.DB.prepare("SELECT count(*) AS count FROM documents").first<{ count: number }>(),
          env.DB.prepare("SELECT count(*) AS count FROM ip_drafts").first<{ count: number }>(),
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

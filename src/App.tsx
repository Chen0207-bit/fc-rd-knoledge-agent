import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import mammoth from "mammoth";
import * as pdfjs from "pdfjs-dist";
import pdfWorker from "pdfjs-dist/build/pdf.worker.min.mjs?url";

pdfjs.GlobalWorkerOptions.workerSrc = pdfWorker;

type View = "dashboard" | "discover" | "review" | "library" | "ip";
type PaperStatus = "pending" | "approved" | "rejected";
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
  status?: PaperStatus;
  reviewerNote?: string;
};
type DocumentItem = { id: number; name: string; mimeType: string; size: number; textPreview?: string; createdAt: string };
type Draft = { id: number; title: string; sourceRefs: string; markdown: string; model: string; createdAt: string };
type Stats = { discovered: number; pending: number; approved: number; documents: number; drafts: number };

const API_BASE = (
  import.meta.env.VITE_API_BASE_URL ||
  "https://fc-rd-knowledge-agent-api.feng85656.workers.dev"
).replace(/\/$/, "");
const samplePapers: Paper[] = [
  { id: -1, source: "arxiv", externalId: "demo-1", title: "面向复杂工程文档的多智能体检索与证据校验", authors: ["Lin Chen", "Ming Zhou"], abstract: "提出一种面向工程知识文档的多智能体检索、交叉验证与证据追溯方法。", publishedAt: "2026-07-18", url: "https://arxiv.org", status: "pending" },
  { id: -2, source: "semantic_scholar", externalId: "demo-2", title: "Knowledge Graph Grounded Research Intelligence", authors: ["A. Kumar"], abstract: "A knowledge-graph grounded pipeline for research intelligence.", publishedAt: "2026-05-09", url: "https://semanticscholar.org", status: "approved" },
];

function formatDate(value?: string) {
  if (!value) return "日期未知";
  return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "short", day: "numeric" }).format(new Date(value));
}

function sourceLabel(source: Paper["source"]) {
  return source === "arxiv" ? "arXiv" : source === "crossref" ? "Crossref" : "S2";
}

async function extractFile(file: File) {
  if (file.size > 15 * 1024 * 1024) throw new Error("文件不能超过 15 MB");
  const suffix = file.name.toLowerCase().split(".").pop();
  if (suffix === "pdf") {
    const data = new Uint8Array(await file.arrayBuffer());
    const pdf = await pdfjs.getDocument({ data }).promise;
    const pages: string[] = [];
    for (let pageNo = 1; pageNo <= Math.min(pdf.numPages, 80); pageNo += 1) {
      const page = await pdf.getPage(pageNo);
      const content = await page.getTextContent();
      pages.push(content.items.map((item) => ("str" in item ? item.str : "")).join(" "));
    }
    return pages.join("\n\n").slice(0, 120_000);
  }
  if (suffix === "docx") {
    const result = await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
    return result.value.slice(0, 120_000);
  }
  throw new Error("目前仅支持 PDF 和 DOCX");
}

export default function App() {
  const [view, setView] = useState<View>("dashboard");
  const [accessCode, setAccessCode] = useState(() => sessionStorage.getItem("demo-access-code") || "");
  const [codeInput, setCodeInput] = useState("");
  const [connected, setConnected] = useState(false);
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("research intelligence agent");
  const [searchResults, setSearchResults] = useState<Paper[]>([]);
  const [papers, setPapers] = useState<Paper[]>(samplePapers);
  const [documents, setDocuments] = useState<DocumentItem[]>([]);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [stats, setStats] = useState<Stats>({ discovered: 128, pending: 3, approved: 46, documents: 0, drafts: 7 });
  const [selectedSources, setSelectedSources] = useState<string[]>([]);
  const [draftTitle, setDraftTitle] = useState("智能研发知识处理方法及系统");
  const [activeDraft, setActiveDraft] = useState<Draft | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const api = useCallback(async <T,>(path: string, options: RequestInit = {}): Promise<T> => {
    const response = await fetch(`${API_BASE}${path}`, {
      ...options,
      headers: { "content-type": "application/json", ...(accessCode ? { "x-demo-code": accessCode } : {}), ...(options.headers || {}) },
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `请求失败（${response.status}）`);
    return payload as T;
  }, [accessCode]);

  const refresh = useCallback(async () => {
    if (!accessCode) return;
    try {
      const [paperData, documentData, draftData, statData] = await Promise.all([
        api<{ papers: Paper[] }>("/api/papers"),
        api<{ documents: DocumentItem[] }>("/api/documents"),
        api<{ drafts: Draft[] }>("/api/ip-drafts"),
        api<Stats>("/api/stats"),
      ]);
      setPapers(paperData.papers);
      setDocuments(documentData.documents);
      setDrafts(draftData.drafts);
      setStats(statData);
      setConnected(true);
    } catch {
      setConnected(false);
    }
  }, [accessCode, api]);

  useEffect(() => { void refresh(); }, [refresh]);

  const notify = (text: string) => {
    setMessage(text);
    window.setTimeout(() => setMessage(""), 3200);
  };

  async function unlock() {
    if (!codeInput.trim()) return;
    setAccessCode(codeInput.trim());
    sessionStorage.setItem("demo-access-code", codeInput.trim());
    notify("访问码已保存，正在连接 Agent");
  }

  async function searchPapers() {
    if (!query.trim()) return;
    setLoading(true);
    try {
      const data = await api<{ papers: Paper[]; warnings?: string[] }>(`/api/papers/search?q=${encodeURIComponent(query)}&source=all&limit=8`);
      setSearchResults(data.papers);
      setConnected(true);
      notify(`已从双源发现 ${data.papers.length} 篇论文`);
    } catch (error) {
      notify(error instanceof Error ? error.message : "检索失败");
    } finally {
      setLoading(false);
    }
  }

  async function importPaper(paper: Paper) {
    try {
      await api("/api/papers/import", { method: "POST", body: JSON.stringify(paper) });
      notify("已加入待审核列表");
      await refresh();
    } catch (error) {
      notify(error instanceof Error ? error.message : "入库失败");
    }
  }

  async function reviewPaper(id: number, status: "approved" | "rejected") {
    try {
      await api(`/api/papers/${id}/review`, { method: "POST", body: JSON.stringify({ status, note: status === "approved" ? "证据完整，符合研发知识入库要求" : "与当前研发方向相关性不足" }) });
      notify(status === "approved" ? "审核通过，已进入研发知识库" : "已驳回");
      await refresh();
    } catch (error) {
      notify(error instanceof Error ? error.message : "审核失败");
    }
  }

  async function uploadDocument(file?: File) {
    if (!file) return;
    setLoading(true);
    notify("正在本地解析研发文件");
    try {
      const text = await extractFile(file);
      if (text.trim().length < 80) throw new Error("未提取到足够文字，请换用可复制文字的文件");
      await api("/api/documents", { method: "POST", body: JSON.stringify({ name: file.name, mimeType: file.type || "application/octet-stream", size: file.size, text }) });
      notify("文件解析完成，原文件未上传");
      await refresh();
    } catch (error) {
      notify(error instanceof Error ? error.message : "文件导入失败");
    } finally {
      setLoading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  function toggleSource(ref: string) {
    setSelectedSources((current) => current.includes(ref) ? current.filter((item) => item !== ref) : [...current, ref]);
  }

  async function generateDraft() {
    if (!selectedSources.length) return notify("请先选择至少一份论文或研发文件");
    setLoading(true);
    setActiveDraft(null);
    try {
      const data = await api<{ draft: Draft }>("/api/ip-drafts", { method: "POST", body: JSON.stringify({ title: draftTitle, sources: selectedSources }) });
      setActiveDraft(data.draft);
      notify("知识产权材料初稿已生成");
      await refresh();
    } catch (error) {
      notify(error instanceof Error ? error.message : "生成失败");
    } finally {
      setLoading(false);
    }
  }

  function downloadDraft(draft: Draft) {
    const blob = new Blob([draft.markdown], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${draft.title}.md`;
    link.click();
    URL.revokeObjectURL(url);
  }

  const approvedPapers = useMemo(() => papers.filter((paper) => paper.status === "approved"), [papers]);
  const pendingPapers = useMemo(() => papers.filter((paper) => paper.status === "pending"), [papers]);

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand"><span>研</span><div><strong>研知 Agent</strong><small>R&D Intelligence</small></div></div>
        <nav>
          {[
            ["dashboard", "⌂", "工作台"],
            ["discover", "⌕", "论文雷达"],
            ["review", "✓", "审核中心"],
            ["library", "▤", "研发知识库"],
            ["ip", "◇", "知识产权"],
          ].map(([key, icon, label]) => (
            <button className={view === key ? "active" : ""} key={key} onClick={() => setView(key as View)}>
              {icon}<span>{label}</span>{key === "review" && pendingPapers.length > 0 ? <em>{pendingPapers.length}</em> : null}
            </button>
          ))}
        </nav>
        <div className="sidebar-note"><b>LIVE DEMO</b><p>双源检索、人工审核、研发知识沉淀与成果转化。</p></div>
      </aside>
      <main>
        <header>
          <div><p className="eyebrow">研发知识与成果转化中心</p><h1>{view === "dashboard" ? "早上好，研发负责人" : ({ discover: "论文雷达", review: "审核中心", library: "研发知识库", ip: "知识产权材料" } as Record<string, string>)[view]}</h1></div>
          <div className="top-actions"><span className={connected ? "live-dot" : "live-dot offline"}>{connected ? "Agent 在线" : "等待访问码"}</span><button className="avatar" onClick={() => setCodeInput(accessCode)}>FC</button></div>
        </header>

        {view === "dashboard" && (
          <>
            <section className="hero">
              <div><span className="hero-label">AGENT WORKFLOW</span><h2>把分散的研究，<br/>变成可沉淀的创新资产。</h2><p>自动发现论文、审核入库，再从研发资料生成知识产权材料初稿。</p><button className="primary" onClick={() => setView("discover")}>启动论文采集 <span>→</span></button></div>
              <div className="flow-card">
                <div className="flow-head"><span>研发知识闭环</span><b>真实流程</b></div>
                {[["01","发现","arXiv + Semantic Scholar","done"],["02","审核","证据与质量校验","done"],["03","沉淀","论文与研发文件入库","current"],["04","转化","生成知识产权材料",""]].map(([n,t,d,s])=><div className={`flow-row ${s}`} key={n}><i>{s==="done"?"✓":n}</i><div><strong>{t}</strong><span>{d}</span></div><b>{s==="current"?"进行中":"›"}</b></div>)}
              </div>
            </section>
            <section className="stats">
              <article><span>累计发现</span><strong>{stats.discovered}</strong><small>篇论文</small></article>
              <article><span>待审核</span><strong>{stats.pending}</strong><small>项任务</small></article>
              <article><span>知识资产</span><strong>{stats.approved + stats.documents}</strong><small>份资料</small></article>
              <article><span>申报草稿</span><strong>{stats.drafts}</strong><small>份材料</small></article>
            </section>
            <section className="content-grid">
              <div className="panel"><div className="panel-head"><div><p className="eyebrow">LATEST INTELLIGENCE</p><h3>最新知识资产</h3></div><button onClick={() => setView("library")}>查看全部</button></div>{papers.slice(0, 3).map((paper)=><PaperRow paper={paper} key={paper.externalId} />)}</div>
              <div className="panel action-panel"><p className="eyebrow">QUICK ACTION</p><h3>成果转化</h3><p>选择已入库论文或研发文件，Agent 将生成技术交底书、摘要与权利要求初稿。</p><div className="doc-stack"><span></span><span></span><b>知识产权<br/>申报材料</b></div><button className="secondary" onClick={() => setView("ip")}>开始生成 <span>→</span></button></div>
            </section>
          </>
        )}

        {view === "discover" && (
          <section className="workspace">
            <div className="workspace-head"><div><p className="eyebrow">DUAL-SOURCE DISCOVERY</p><h2>自动搜集论文</h2><p>同时检索 arXiv 与 Semantic Scholar；限流时自动切换 Crossref，并合并重复结果。</p></div><span className="source-pill">双源实时检索</span></div>
            <div className="search-box"><input value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => event.key === "Enter" && void searchPapers()} placeholder="输入技术主题，例如：工业视觉缺陷检测 Agent" /><button className="primary" disabled={loading} onClick={() => void searchPapers()}>{loading ? "正在检索…" : "开始检索"}</button></div>
            <div className="result-list">{searchResults.length ? searchResults.map((paper) => <article className="result-card" key={`${paper.source}-${paper.externalId}`}><div className="result-source">{sourceLabel(paper.source)}</div><div><h3>{paper.title}</h3><p className="meta">{paper.authors.slice(0, 3).join(" · ")} · {formatDate(paper.publishedAt)}</p><p className="abstract">{paper.abstract || "暂无摘要"}</p><a href={paper.url} target="_blank" rel="noreferrer">查看原文 ↗</a></div><button onClick={() => void importPaper(paper)}>加入审核</button></article>) : <EmptyState title="输入主题启动双源论文采集" detail="真实结果将在这里显示，并可一键加入审核。" />}</div>
          </section>
        )}

        {view === "review" && (
          <section className="workspace">
            <div className="workspace-head"><div><p className="eyebrow">HUMAN IN THE LOOP</p><h2>审核后入库</h2><p>保留人工判断，确保知识来源可靠、方向相关、证据可追溯。</p></div><span className="source-pill">{pendingPapers.length} 项待处理</span></div>
            <div className="review-grid">{pendingPapers.length ? pendingPapers.map((paper) => <article className="review-card" key={paper.id}><div className="review-top"><span>{sourceLabel(paper.source)}</span><small>{formatDate(paper.publishedAt)}</small></div><h3>{paper.title}</h3><p>{paper.abstract || "暂无摘要"}</p><div className="review-actions"><button className="ghost danger" onClick={() => void reviewPaper(paper.id!, "rejected")}>驳回</button><button className="primary" onClick={() => void reviewPaper(paper.id!, "approved")}>通过并入库</button></div></article>) : <EmptyState title="待审核任务已处理完毕" detail="从论文雷达加入的新论文会出现在这里。" />}</div>
          </section>
        )}

        {view === "library" && (
          <section className="workspace">
            <div className="workspace-head"><div><p className="eyebrow">R&D KNOWLEDGE BASE</p><h2>研发知识库</h2><p>论文与研发文档统一沉淀，为成果转化提供可信上下文。</p></div><><input ref={fileRef} hidden type="file" accept=".pdf,.docx" onChange={(event) => void uploadDocument(event.target.files?.[0])} /><button className="primary" disabled={loading} onClick={() => fileRef.current?.click()}>导入 PDF / DOCX</button></></div>
            <div className="library-columns"><div><h3>已入库论文 <span>{approvedPapers.length}</span></h3>{approvedPapers.length ? approvedPapers.map((paper) => <PaperRow paper={paper} key={paper.externalId} />) : <EmptyState title="暂无已入库论文" detail="先在审核中心通过一篇论文。" />}</div><div><h3>研发文件 <span>{documents.length}</span></h3>{documents.length ? documents.map((doc) => <div className="doc-row" key={doc.id}><i>DOC</i><div><strong>{doc.name}</strong><p>{Math.round(doc.size / 1024)} KB · {formatDate(doc.createdAt)}</p></div><b>已解析</b></div>) : <EmptyState title="尚未导入研发文件" detail="文件在浏览器本地解析，原文件不会上传。" />}</div></div>
          </section>
        )}

        {view === "ip" && (
          <section className="workspace">
            <div className="workspace-head"><div><p className="eyebrow">IP DRAFTING AGENT</p><h2>知识产权材料生成</h2><p>基于选定研发资料，生成技术交底书、摘要和权利要求初稿。</p></div><span className="source-pill">Workers AI · Qwen</span></div>
            <div className="ip-layout">
              <div className="source-selector"><label>材料名称<input value={draftTitle} onChange={(event) => setDraftTitle(event.target.value)} /></label><h3>选择依据材料</h3>
                {[...approvedPapers.map((paper) => ({ ref: `paper:${paper.id}`, name: paper.title, type: "论文" })), ...documents.map((doc) => ({ ref: `document:${doc.id}`, name: doc.name, type: "研发文件" }))].map((item) => <label className="source-option" key={item.ref}><input type="checkbox" checked={selectedSources.includes(item.ref)} onChange={() => toggleSource(item.ref)} /><span><b>{item.type}</b><strong>{item.name}</strong></span></label>)}
                {!approvedPapers.length && !documents.length ? <EmptyState title="暂无可用资料" detail="先审核入库论文或导入研发文件。" /> : null}
                <button className="primary generate" disabled={loading} onClick={() => void generateDraft()}>{loading ? "Agent 正在生成…" : "生成申报材料"}</button>
              </div>
              <div className="draft-preview">{activeDraft ? <><div className="draft-head"><div><small>AI GENERATED DRAFT</small><h3>{activeDraft.title}</h3></div><button onClick={() => downloadDraft(activeDraft)}>下载 Markdown</button></div><pre>{activeDraft.markdown}</pre><p className="disclaimer">AI 初稿仅供内部研讨，提交前须由知识产权专业人员审核。</p></> : <EmptyState title="申报材料预览" detail="选择左侧资料后启动 Agent，生成结果将在此展示。" />}</div>
            </div>
            {drafts.length > 0 ? <div className="history"><h3>最近生成</h3>{drafts.slice(0, 4).map((draft) => <button key={draft.id} onClick={() => setActiveDraft(draft)}><span>{draft.title}</span><small>{formatDate(draft.createdAt)}</small></button>)}</div> : null}
          </section>
        )}
      </main>

      {!accessCode || codeInput ? <div className="modal-backdrop"><div className="access-modal"><span className="seal">研</span><p className="eyebrow">SECURE DEMO</p><h2>进入研知 Agent</h2><p>请输入演示访问码。它只保存在当前浏览器会话中，用于保护 AI 调用额度。</p><input autoFocus value={codeInput} onChange={(event) => setCodeInput(event.target.value)} onKeyDown={(event) => event.key === "Enter" && void unlock()} placeholder="演示访问码" type="password" /><button className="primary" onClick={() => void unlock()}>进入工作台</button>{accessCode ? <button className="text-button" onClick={() => setCodeInput("")}>取消</button> : null}</div></div> : null}
      {message ? <div className="toast">{message}</div> : null}
    </div>
  );
}

function PaperRow({ paper }: { paper: Paper }) {
  return <div className="paper"><span className="source">{sourceLabel(paper.source)}</span><div><strong>{paper.title}</strong><p>{paper.authors.slice(0, 2).join(" · ")} · {formatDate(paper.publishedAt)}</p></div><em className={paper.status === "approved" ? "approved" : ""}>{paper.status === "approved" ? "已入库" : paper.status === "rejected" ? "已驳回" : "待审核"}</em></div>;
}

function EmptyState({ title, detail }: { title: string; detail: string }) {
  return <div className="empty"><i>◇</i><strong>{title}</strong><p>{detail}</p></div>;
}

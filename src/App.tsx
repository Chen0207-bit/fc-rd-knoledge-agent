import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import mammoth from "mammoth";
import * as pdfjs from "pdfjs-dist";
import pdfWorker from "pdfjs-dist/build/pdf.worker.min.mjs?url";

pdfjs.GlobalWorkerOptions.workerSrc = pdfWorker;

type View = "dashboard" | "discover" | "review" | "library" | "ip";
type LayoutMode = "dashboard" | "agent";
type UIPreset = "classic" | "cloudflare" | "gpt";
type ThemePreference = "system" | "light" | "dark";
type AIProvider = "glm" | "openai-compatible" | "k3";
type AIConfig = { enabled: boolean; provider: AIProvider; endpoint: string; apiKey: string; model: string; remember: boolean };
type PaperStatus = "pending" | "approved" | "rejected";
const GROUPS = ["未分类", "算法研究", "产品技术", "专利候选", "竞品情报"];
try { GROUPS.push(...(JSON.parse(localStorage.getItem("rd-custom-groups") || "[]") as string[]).filter((group) => !GROUPS.includes(group))); } catch { /* first visit */ }
type ModelChoice = "auto" | "glm-5.3" | "qwen3" | "k3";
type SpeedChoice = "fast" | "balanced" | "deep";
type ChatMessage = { role: "user" | "assistant"; content: string; model?: string };
type Project = { id: number; name: string; description: string; createdAt?: string; updatedAt?: string };
type WorkflowPlan = { summary: string; searchQueries: string[]; screeningCriteria: string[]; evidenceMap: Array<{ evidence: string; researchDirection: string; ipValue: string }>; analysisSummary: string[]; steps: string[]; model?: string };
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
  libraryState?: "in" | "removed";
  groupName?: string;
};
type DocumentItem = { id: number; name: string; mimeType: string; size: number; textPreview?: string; text?: string; createdAt: string; groupName?: string };
type Draft = { id: number; title: string; sourceRefs: string; markdown: string; model: string; groupName?: string; createdAt: string };
type Stats = { discovered: number; pending: number; approved: number; documents: number; drafts: number };

const DEFAULT_AI_CONFIG: AIConfig = { enabled: false, provider: "glm", endpoint: "https://open.bigmodel.cn/api/paas/v4", apiKey: "", model: "glm-5.3", remember: false };
function readAIConfig(): AIConfig {
  try {
    const raw = sessionStorage.getItem("rd-ai-config") || localStorage.getItem("rd-ai-config");
    return raw ? { ...DEFAULT_AI_CONFIG, ...(JSON.parse(raw) as Partial<AIConfig>) } : DEFAULT_AI_CONFIG;
  } catch { return DEFAULT_AI_CONFIG; }
}

const API_BASE = (
  import.meta.env.VITE_API_BASE_URL ||
  "https://fc-rd-knowledge-agent-api.feng85656.workers.dev"
).replace(/\/$/, "");
const K3_LOCAL_BASE = (import.meta.env.VITE_K3_LOCAL_URL || "http://127.0.0.1:8765").replace(/\/$/, "");
const IS_LOCAL_DEMO = ["127.0.0.1", "localhost"].includes(window.location.hostname);
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
  const [layoutMode, setLayoutMode] = useState<LayoutMode>(() => (localStorage.getItem("rd-layout-mode") as LayoutMode) || "dashboard");
  const [uiPreset, setUiPreset] = useState<UIPreset>(() => (localStorage.getItem("rd-ui-preset") as UIPreset) || "cloudflare");
  const [themePreference, setThemePreference] = useState<ThemePreference>(() => (localStorage.getItem("rd-theme-preference") as ThemePreference) || "system");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [aiConfig, setAIConfig] = useState<AIConfig>(readAIConfig);
  const [projects, setProjects] = useState<Project[]>([]);
  const [activeProjectId, setActiveProjectId] = useState(() => Number(localStorage.getItem("rd-active-project") || 1));
  const [projectModalOpen, setProjectModalOpen] = useState(false);
  const [projectForm, setProjectForm] = useState({ name: "", description: "" });
  const [accessCode, setAccessCode] = useState(() => sessionStorage.getItem("demo-access-code") || "");
  const [codeInput, setCodeInput] = useState("");
  const [connected, setConnected] = useState(false);
  const [message, setMessage] = useState("");
  const [authError, setAuthError] = useState("");
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("research intelligence agent");
  const [searchResults, setSearchResults] = useState<Paper[]>([]);
  const [searchWarnings, setSearchWarnings] = useState<string[]>([]);
  const [papers, setPapers] = useState<Paper[]>(samplePapers);
  const [documents, setDocuments] = useState<DocumentItem[]>([]);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [stats, setStats] = useState<Stats>({ discovered: 128, pending: 3, approved: 46, documents: 0, drafts: 7 });
  const [selectedSources, setSelectedSources] = useState<string[]>([]);
  const [draftTitle, setDraftTitle] = useState("智能研发知识处理方法及系统");
  const [draftGroup, setDraftGroup] = useState("专利候选");
  const [modelChoice, setModelChoice] = useState<ModelChoice>(IS_LOCAL_DEMO ? "k3" : "auto");
  const [speedChoice, setSpeedChoice] = useState<SpeedChoice>("balanced");
  const [generationStep, setGenerationStep] = useState("");
  const [preview, setPreview] = useState<{ kind: "paper" | "document"; title: string; content: string; url?: string } | null>(null);
  const [libraryGroup, setLibraryGroup] = useState("全部分组");
  const [draftGroupFilter, setDraftGroupFilter] = useState("全部分组");
  const [customGroups, setCustomGroups] = useState<string[]>(() => { try { return JSON.parse(localStorage.getItem("rd-custom-groups") || "[]") as string[]; } catch { return []; } });
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => localStorage.getItem("rd-sidebar-collapsed") === "1");
  const [chatOpen, setChatOpen] = useState(false);
  const [chatMinimized, setChatMinimized] = useState(false);
  const [chatInput, setChatInput] = useState("");
  const [chatBusy, setChatBusy] = useState(false);
  const [workflowPlan, setWorkflowPlan] = useState<WorkflowPlan | null>(null);
  const [workflowFile, setWorkflowFile] = useState<File | null>(null);
  const [workflowText, setWorkflowText] = useState("");
  const [workflowStage, setWorkflowStage] = useState("");
  const [workflowCandidates, setWorkflowCandidates] = useState<Paper[]>([]);
  const [workflowDocumentId, setWorkflowDocumentId] = useState<number | null>(null);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>(() => { try { return JSON.parse(sessionStorage.getItem("rd-agent-chat") || "[]") as ChatMessage[]; } catch { return []; } });
  const [activeDraft, setActiveDraft] = useState<Draft | null>(null);
  const [k3Ready, setK3Ready] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const chatFileRef = useRef<HTMLInputElement>(null);

  const api = useCallback(async <T,>(path: string, options: RequestInit = {}): Promise<T> => {
    const target = new URL(`${API_BASE}${path}`);
    target.searchParams.set("project_id", String(activeProjectId));
    const response = await fetch(target.toString(), {
      ...options,
      headers: { "content-type": "application/json", ...(accessCode ? { "x-demo-code": accessCode } : {}), ...(aiConfig.enabled && aiConfig.apiKey ? { "x-user-ai-provider": aiConfig.provider, "x-user-ai-endpoint": aiConfig.endpoint, "x-user-ai-key": aiConfig.apiKey, "x-user-ai-model": aiConfig.model } : {}), ...(options.headers || {}) },
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(payload.error || `请求失败（${response.status}）`) as Error & { status?: number };
      error.status = response.status;
      throw error;
    }
    return payload as T;
  }, [accessCode, activeProjectId, aiConfig]);

  const refresh = useCallback(async () => {
    if (!accessCode) return;
    try {
      const [projectData, paperData, documentData, draftData, statData] = await Promise.all([
        api<{ projects: Project[] }>("/api/projects"),
        api<{ papers: Paper[] }>("/api/papers"),
        api<{ documents: DocumentItem[] }>("/api/documents"),
        api<{ drafts: Draft[] }>("/api/ip-drafts"),
        api<Stats>("/api/stats"),
      ]);
      setProjects(projectData.projects);
      if (!projectData.projects.some((project) => project.id === activeProjectId) && projectData.projects[0]) setActiveProjectId(projectData.projects[0].id);
      setPapers(paperData.papers);
      setDocuments(documentData.documents);
      setDrafts(draftData.drafts);
      setStats(statData);
      setConnected(true);
    } catch (error) {
      setConnected(false);
      if (error instanceof Error && (error as Error & { status?: number }).status === 401) {
        sessionStorage.removeItem("demo-access-code");
        setAccessCode("");
        setCodeInput("");
        setAuthError("访问码已失效，请重新输入");
      }
    }
  }, [accessCode, activeProjectId, api]);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => { localStorage.setItem("rd-custom-groups", JSON.stringify(customGroups)); }, [customGroups]);
  useEffect(() => { localStorage.setItem("rd-active-project", String(activeProjectId)); }, [activeProjectId]);
  useEffect(() => { localStorage.setItem("rd-sidebar-collapsed", sidebarCollapsed ? "1" : "0"); }, [sidebarCollapsed]);
  useEffect(() => { localStorage.setItem("rd-layout-mode", layoutMode); }, [layoutMode]);
  useEffect(() => { localStorage.setItem("rd-ui-preset", uiPreset); }, [uiPreset]);
  useEffect(() => { localStorage.setItem("rd-theme-preference", themePreference); }, [themePreference]);
  useEffect(() => { sessionStorage.setItem("rd-agent-chat", JSON.stringify(chatMessages.slice(-20))); }, [chatMessages]);

  useEffect(() => {
    if (!IS_LOCAL_DEMO) return;
    fetch(`${K3_LOCAL_BASE}/health`).then((response) => response.json()).then((data) => setK3Ready(Boolean(data.ok && data.model === "k3"))).catch(() => setK3Ready(false));
  }, []);

  const notify = (text: string) => {
    setMessage(text);
    window.setTimeout(() => setMessage(""), 3200);
  };

  function saveAISettings() {
    const next = { ...aiConfig, endpoint: aiConfig.endpoint.trim().replace(/\/$/, ""), model: aiConfig.model.trim() || "glm-5.3" };
    setAIConfig(next);
    sessionStorage.setItem("rd-ai-config", JSON.stringify(next));
    if (next.remember) localStorage.setItem("rd-ai-config", JSON.stringify(next));
    else localStorage.removeItem("rd-ai-config");
    setSettingsOpen(false);
    notify(next.enabled ? "自定义模型配置已启用" : "已保存，当前继续使用平台默认模型");
  }

  function choosePreset(preset: UIPreset) {
    setUiPreset(preset);
    if (preset === "gpt") setLayoutMode("agent");
    if (preset === "cloudflare") setLayoutMode("dashboard");
    setChatOpen(false);
    setChatMinimized(false);
  }

  function switchProject(projectId: number) {
    setActiveProjectId(projectId);
    setSearchResults([]);
    setSelectedSources([]);
    setActiveDraft(null);
    setChatMessages([]);
    notify("已切换项目，正在加载独立知识闭环");
  }

  async function saveProject() {
    const name = projectForm.name.trim();
    if (!name) return notify("请填写项目名称");
    try {
      const data = await api<{ project: Project }>("/api/projects", { method: "POST", body: JSON.stringify(projectForm) });
      setProjects((items) => [...items, data.project]);
      setProjectModalOpen(false);
      setProjectForm({ name: "", description: "" });
      switchProject(data.project.id);
    } catch (error) { notify(error instanceof Error ? error.message : "项目创建失败"); }
  }

  async function renameProject() {
    const current = projects.find((project) => project.id === activeProjectId);
    if (!current) return;
    const name = window.prompt("项目名称", current.name)?.trim();
    if (!name || name === current.name) return;
    const description = window.prompt("项目介绍", current.description) ?? current.description;
    try {
      await api(`/api/projects/${activeProjectId}`, { method: "POST", body: JSON.stringify({ name, description }) });
      setProjects((items) => items.map((project) => project.id === activeProjectId ? { ...project, name, description } : project));
      notify("项目资料已更新");
    } catch (error) { notify(error instanceof Error ? error.message : "项目更新失败"); }
  }

  async function unlock() {
    const candidate = codeInput.trim();
    if (!candidate) return;
    setLoading(true);
    setAuthError("");
    try {
      const response = await fetch(`${API_BASE}/api/stats`, { headers: { "x-demo-code": candidate } });
      if (!response.ok) throw new Error("访问码不正确，请重新输入");
      setAccessCode(candidate);
      setCodeInput("");
      sessionStorage.setItem("demo-access-code", candidate);
      notify("访问码已验证，正在连接 Agent");
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : "访问码验证失败");
    } finally {
      setLoading(false);
    }
  }

  async function searchPapers() {
    if (!query.trim()) return;
    setLoading(true);
    try {
      const data = await api<{ papers: Paper[]; warnings?: string[] }>(`/api/papers/search?q=${encodeURIComponent(query)}&source=all&limit=8`);
      setSearchResults(data.papers);
      setSearchWarnings(data.warnings || []);
      setConnected(true);
      notify(data.warnings?.length ? `已发现 ${data.papers.length} 篇，部分来源已降级` : `已从双源发现 ${data.papers.length} 篇论文`);
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

  async function deletePaper(id: number, title: string) {
    if (!window.confirm(`确定删除论文“${title}”？删除后不可恢复。`)) return;
    try {
      await api(`/api/papers/${id}`, { method: "DELETE" });
      notify("论文已删除");
      await refresh();
    } catch (error) { notify(error instanceof Error ? error.message : "论文删除失败"); }
  }

  async function deleteDocument(id: number, name: string) {
    if (!window.confirm(`确定删除研发文件“${name}”？删除后不可恢复。`)) return;
    try { await api(`/api/documents/${id}`, { method: "DELETE" }); notify("研发文件已删除"); await refresh(); }
    catch (error) { notify(error instanceof Error ? error.message : "文件删除失败"); }
  }

  async function deleteDraft(id: number, title: string) {
    if (!window.confirm(`确定删除材料“${title}”？删除后不可恢复。`)) return;
    try { await api(`/api/ip-drafts/${id}`, { method: "DELETE" }); if (activeDraft?.id === id) setActiveDraft(null); notify("知识产权材料已删除"); await refresh(); }
    catch (error) { notify(error instanceof Error ? error.message : "材料删除失败"); }
  }

  async function changeGroup(type: "paper" | "document" | "draft", id: number, groupName: string) {
    try {
      await api(`/api/${type === "paper" ? "papers" : type === "document" ? "documents" : "ip-drafts"}/${id}/group`, { method: "POST", body: JSON.stringify({ groupName }) });
      if (type === "paper") setPapers((items) => items.map((item) => item.id === id ? { ...item, groupName } : item));
      if (type === "document") setDocuments((items) => items.map((item) => item.id === id ? { ...item, groupName } : item));
      if (type === "draft") setDrafts((items) => items.map((item) => item.id === id ? { ...item, groupName } : item));
      notify("分组已更新");
    } catch (error) { notify(error instanceof Error ? error.message : "分组更新失败"); }
  }

  const allGroups = useMemo(() => {
    const storedGroups = [...papers, ...documents, ...drafts].map((item) => (item as { groupName?: string }).groupName).filter((group): group is string => Boolean(group));
    return [...GROUPS, ...customGroups, ...storedGroups].filter((group, index, groups) => groups.indexOf(group) === index);
  }, [customGroups, papers, documents, drafts]);

  function createCustomGroup() {
    const name = window.prompt("请输入新分组名称");
    const trimmed = name?.trim().slice(0, 30);
    if (!trimmed) return;
    if (!allGroups.includes(trimmed)) { GROUPS.push(trimmed); setCustomGroups((groups) => [...groups, trimmed]); }
    notify(`已创建分组：${trimmed}`);
  }

  function chatContext() {
    const context = ({ dashboard: "研发工作台", discover: "论文雷达", review: "审核中心", library: "研发知识库", ip: "知识产权材料" } as Record<View, string>)[view];
    return `当前上下文：${context}；当前项目：${activeProject?.name || "默认研发项目"}；当前检索词：${query}；检索结果：${searchResults.length} 篇；待审核论文：${pendingPapers.length} 篇；已入库论文：${approvedPapers.length} 篇；研发文件：${documents.length} 份；知识产权草稿：${drafts.length} 份。具体论文或文件内容只有在用户主动粘贴到对话框后才会发送。`;
  }

  async function sendChat(contentOverride?: string) {
    const content = (contentOverride ?? chatInput).trim();
    if (!content || chatBusy) return;
    const nextMessages = [...chatMessages, { role: "user" as const, content }];
    setChatMessages(nextMessages);
    setChatInput("");
    setChatBusy(true);
    try {
      const data = await api<{ reply: string; model: string }>("/api/assistant-chat", { method: "POST", body: JSON.stringify({ messages: nextMessages, context: chatContext() }) });
      setChatMessages((messages) => [...messages, { role: "assistant", content: data.reply, model: data.model }]);
    } catch (error) { notify(error instanceof Error ? error.message : "Agent 对话失败"); }
    finally { setChatBusy(false); }
  }

  async function runFileWorkflow(file?: File) {
    if (!file || chatBusy) return;
    setChatBusy(true);
    setChatMessages((messages) => [...messages, { role: "user", content: `请先为研发文件制定 Workflow Plan：${file.name}` }]);
    try {
      setWorkflowStage("正在本地解析文件并提炼计划…");
      const text = await extractFile(file);
      const data = await api<{ plan: WorkflowPlan; model: string }>("/api/assistant-plan", { method: "POST", body: JSON.stringify({ sourceText: text, fileName: file.name, projectDescription: activeProject?.description || "" }) });
      setWorkflowPlan({ ...data.plan, model: data.model });
      setWorkflowFile(file);
      setWorkflowText(text);
      setWorkflowStage("");
      setChatMessages((messages) => [...messages, { role: "assistant", content: "我已经根据文件内容拟好执行计划，请确认后再开始搜索、初审和转化。" }]);
    } catch (error) {
      setWorkflowStage("");
      setChatMessages((messages) => [...messages, { role: "assistant", content: error instanceof Error ? error.message : "Workflow Plan 生成失败" }]);
    } finally {
      setChatBusy(false);
      if (chatFileRef.current) chatFileRef.current.value = "";
    }
  }

  async function confirmFileWorkflow() {
    if (!workflowPlan || !workflowFile || chatBusy) return;
    setChatBusy(true);
    try {
      setWorkflowStage("正在导入研发文件…");
      const documentId = await uploadDocument(workflowFile, workflowText);
      if (!documentId) return;
      setWorkflowDocumentId(documentId);
      setWorkflowStage(`正在搜索 ${workflowPlan.searchQueries.length} 组相关主题…`);
      const searchData = await Promise.all(workflowPlan.searchQueries.slice(0, 4).map((searchQuery) => api<{ papers: Paper[]; warnings?: string[] }>(`/api/papers/search?q=${encodeURIComponent(searchQuery)}&source=all&limit=12`)));
      const merged = searchData.flatMap((result) => result.papers);
      const seen = new Set<string>();
      const papers = merged.filter((paper) => { const key = paper.title.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]/g, ""); if (!key || seen.has(key)) return false; seen.add(key); return true; }).slice(0, 24);
      const candidates = papers.slice(0, 12);
      setWorkflowCandidates(candidates);
      setSearchResults(papers);
      setWorkflowStage("");
      setChatMessages((messages) => [...messages, { role: "assistant", content: `计划已执行到 Agent 初筛：通过 ${workflowPlan.searchQueries.length} 组主题发现 ${papers.length} 篇去重论文，已保留 ${candidates.length} 篇候选。请确认后，我会审核入库并生成知识产权材料。` }]);
    } catch (error) {
      setWorkflowStage("");
      setChatMessages((messages) => [...messages, { role: "assistant", content: error instanceof Error ? error.message : "Workflow 执行失败" }]);
    } finally { setChatBusy(false); }
  }

  async function approveAndConvertWorkflow() {
    if (!workflowPlan || !workflowDocumentId || !workflowCandidates.length || chatBusy) return;
    setChatBusy(true);
    try {
      setWorkflowStage("正在审核并入库候选论文…");
      const paperRefs: string[] = [];
      for (const paper of workflowCandidates) {
        const imported = await api<{ id: number }>("/api/papers/import", { method: "POST", body: JSON.stringify(paper) });
        if (imported.id) {
          await api(`/api/papers/${imported.id}/review`, { method: "POST", body: JSON.stringify({ status: "approved", note: "用户确认 Workflow Plan 后由 Agent 完成初审，建议入库" }) });
          paperRefs.push(`paper:${imported.id}`);
        }
      }
      const refs = [`document:${workflowDocumentId}`, ...paperRefs];
      const title = workflowFile?.name.replace(/\.(pdf|docx)$/i, "") || "研发成果知识产权材料";
      setSelectedSources(refs);
      setDraftTitle(title);
      setView("ip");
      setWorkflowStage("正在生成知识产权申报材料…");
      await generateDraft(refs, title);
      await refresh();
      setWorkflowPlan(null);
      setWorkflowFile(null);
      setWorkflowText("");
      setWorkflowCandidates([]);
      setWorkflowDocumentId(null);
      setWorkflowStage("");
      setChatMessages((messages) => [...messages, { role: "assistant", content: "Workflow 已完成：研发文件已入库，候选论文已审核入库，知识产权申报材料初稿已生成。" }]);
    } catch (error) {
      setWorkflowStage("");
      setChatMessages((messages) => [...messages, { role: "assistant", content: error instanceof Error ? error.message : "审核转化失败" }]);
    } finally { setChatBusy(false); }
  }

  function toggleChatMinimized() {
    setChatMinimized((value) => !value);
  }

  async function previewDocument(id: number) {
    try {
      const data = await api<{ document: DocumentItem }>(`/api/documents/${id}`);
      setPreview({ kind: "document", title: data.document.name, content: data.document.text || "暂无可预览文本" });
    } catch (error) { notify(error instanceof Error ? error.message : "文件预览失败"); }
  }

  function previewPaper(paper: Paper) {
    setPreview({ kind: "paper", title: paper.title, content: `作者：${paper.authors.join("、") || "未知"}\n\n摘要：\n${paper.abstract || "暂无摘要"}`, url: paper.url });
  }

  async function uploadDocument(file?: File, parsedText?: string): Promise<number | undefined> {
    if (!file) return undefined;
    setLoading(true);
    notify("正在本地解析研发文件");
    try {
      const text = parsedText || await extractFile(file);
      if (text.trim().length < 80) throw new Error("未提取到足够文字，请换用可复制文字的文件");
      const data = await api<{ id: number }>("/api/documents", { method: "POST", body: JSON.stringify({ name: file.name, mimeType: file.type || "application/octet-stream", size: file.size, text }) });
      notify("文件解析完成，原文件未上传");
      await refresh();
      return data.id;
    } catch (error) {
      notify(error instanceof Error ? error.message : "文件导入失败");
      return undefined;
    } finally {
      setLoading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  function toggleSource(ref: string) {
    setSelectedSources((current) => current.includes(ref) ? current.filter((item) => item !== ref) : [...current, ref]);
  }

  async function generateDraft(sourceOverride?: string[], titleOverride?: string) {
    const sourceRefs = sourceOverride || selectedSources;
    const materialTitle = titleOverride || draftTitle;
    if (!sourceRefs.length) return notify("请先选择至少一份论文或研发文件");
    if (IS_LOCAL_DEMO && modelChoice !== "k3") return notify("本地页面目前只支持 K3；公网 Demo 可选择 GLM-5.3 或 Workers AI");
    setLoading(true);
    setActiveDraft(null);
    setGenerationStep("正在读取已入库资料…");
    const stepTimer = window.setInterval(() => setGenerationStep((current) => current === "正在读取已入库资料…" ? "正在提炼创新点与技术方案…" : current === "正在提炼创新点与技术方案…" ? "正在组织权利要求结构…" : "正在校验格式与待确认事项…"), 1100);
    try {
      if (IS_LOCAL_DEMO) {
        if (!k3Ready) throw new Error("K3 本地服务未启动，请先运行 npm run k3");
        const context = await api<{ sourceText: string }>("/api/source-context", { method: "POST", body: JSON.stringify({ sources: sourceRefs }) });
        const response = await fetch(`${K3_LOCAL_BASE}/generate`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ title: materialTitle, sourceText: context.sourceText }),
        });
        const localData = await response.json();
        if (!response.ok) throw new Error(localData.error || `K3 请求失败（${response.status}）`);
        const localDraft = { ...(localData.draft as Draft), groupName: draftGroup };
        setActiveDraft(localDraft);
        setDrafts((current) => [localDraft, ...current]);
        notify("K3 已生成知识产权材料初稿");
        return;
      }
      const data = await api<{ draft: Draft }>("/api/ip-drafts", { method: "POST", body: JSON.stringify({ title: materialTitle, sources: sourceRefs, groupName: draftGroup, model: modelChoice, speed: speedChoice }) });
      setActiveDraft(data.draft);
      notify("知识产权材料初稿已生成");
      await refresh();
    } catch (error) {
      notify(error instanceof Error ? error.message : "生成失败");
    } finally {
      window.clearInterval(stepTimer);
      setGenerationStep("");
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

  const approvedPapers = useMemo(() => papers.filter((paper) => paper.status === "approved" && paper.libraryState !== "removed"), [papers]);
  const visibleApprovedPapers = useMemo(() => approvedPapers.filter((paper) => libraryGroup === "全部分组" || (paper.groupName || "未分类") === libraryGroup), [approvedPapers, libraryGroup]);
  const visibleDocuments = useMemo(() => documents.filter((doc) => libraryGroup === "全部分组" || (doc.groupName || "未分类") === libraryGroup), [documents, libraryGroup]);
  const visibleDrafts = useMemo(() => drafts.filter((draft) => draftGroupFilter === "全部分组" || (draft.groupName || "未分类") === draftGroupFilter), [drafts, draftGroupFilter]);
  const activeProject = projects.find((project) => project.id === activeProjectId) || projects[0];
  const flowSteps = useMemo(() => {
    const discovered = stats.discovered > 0;
    const reviewed = discovered && stats.pending === 0;
    const stored = stats.approved + stats.documents > 0;
    const converted = stats.drafts > 0;
    return [
      ["01", "发现", "arXiv + Semantic Scholar", discovered ? "done" : "current"],
      ["02", "审核", "证据与质量校验", reviewed ? "done" : discovered ? "current" : ""],
      ["03", "沉淀", "论文与研发文件入库", stored ? "done" : reviewed ? "current" : ""],
      ["04", "转化", "生成知识产权材料", converted ? "done" : stored ? "current" : ""],
    ] as Array<[string, string, string, string]>;
  }, [stats]);
  const pendingPapers = useMemo(() => papers.filter((paper) => paper.status === "pending"), [papers]);

  const pageTitle = ({ dashboard: "AI 工作台", discover: "论文雷达", review: "审核中心", library: "资源库", ip: "成果材料" } as Record<View, string>)[view];
  const quickPrompts = view === "discover"
    ? ["分析当前论文结果", "筛选最相关的 10 篇", "找出与当前研发方向最接近的论文"]
    : view === "library"
      ? ["总结当前资源库", "找出可以转化为专利的创新点", "查看最近导入的研发文件"]
      : view === "ip"
        ? ["检查当前材料是否完整", "补充权利要求书建议", "优化技术方案和有益效果"]
        : ["如何开始研发知识闭环？", "上传研发文件并制定 Plan", "搜索工业视觉相关论文"];
  const agentSkills = [
    ["研发文件解析 Skill", workflowText ? "已完成" : "待调用", workflowText ? "done" : "idle"],
    ["技术主题规划 Skill", workflowPlan ? "已完成" : "待调用", workflowPlan ? "done" : "idle"],
    ["论文检索 Skill", searchResults.length ? `${searchResults.length} 篇` : "待调用", searchResults.length ? "done" : "idle"],
    ["论文相关性审核 Skill", workflowCandidates.length ? `${workflowCandidates.length} 篇候选` : "等待确认", workflowCandidates.length ? "current" : "idle"],
    ["知识产权生成 Skill", activeDraft ? "已生成" : "等待输入", activeDraft ? "done" : "idle"],
  ];
  const agentContextTitle = view === "discover" ? "论文检索任务" : view === "library" ? "研发知识库" : view === "ip" ? "知识产权材料" : "研发知识闭环";

  return (
    <div className={`app-shell preset-${uiPreset} theme-${themePreference}${sidebarCollapsed ? " sidebar-collapsed" : ""}${chatOpen ? " assistant-open" : ""}${chatOpen && chatMinimized ? " assistant-minimized" : ""}`}>
      <aside className={`sidebar${sidebarCollapsed ? " collapsed" : ""}`}>
        <div className="brand"><span>研</span><div><strong>研知 Agent</strong><small>R&D Intelligence</small></div><button className="sidebar-collapse" onClick={() => setSidebarCollapsed((value) => !value)} title={sidebarCollapsed ? "展开导航" : "折叠导航"}>{sidebarCollapsed ? "›" : "‹"}</button></div>
        <nav>
          {[
            ["dashboard", "✦", "AI 工作台"],
            ["discover", "⌕", "论文雷达"],
            ["library", "▤", "资源库"],
            ["ip", "◇", "成果材料"],
          ].map(([key, icon, label]) => (
            <button className={view === key ? "active" : ""} key={key} onClick={() => setView(key as View)}>
              <b>{icon}</b><span>{label}</span>{key === "library" && pendingPapers.length > 0 ? <em>{pendingPapers.length}</em> : null}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom"><button className="settings-launch" onClick={() => setSettingsOpen(true)}><span>⚙</span><em>设置</em></button>{!sidebarCollapsed ? <div className="sidebar-note"><b>AI COPILOT</b><p>在论文、文件和成果材料页面，随时打开右侧 Agent。</p></div> : null}</div>
      </aside>
      <main>
        <header>
          <div className="header-title"><p className="eyebrow">研发知识与成果转化中心</p><h1>{pageTitle}</h1></div>
          <div className="global-search"><span>⌕</span><input value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { setView("discover"); void searchPapers(); } }} placeholder="搜索论文、研发文件或知识产权材料" /><kbd>Ctrl K</kbd></div>
          <div className="top-actions"><div className="project-switcher"><select value={activeProjectId} onChange={(event) => switchProject(Number(event.target.value))}>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select><button onClick={renameProject} title="编辑当前项目">编辑</button></div><button className="layout-switch" onClick={() => { setLayoutMode((mode) => mode === "dashboard" ? "agent" : "dashboard"); setChatOpen(false); setChatMinimized(false); }}>{layoutMode === "dashboard" ? "Agent 工作台" : "Dashboard 视图"}</button>{layoutMode === "dashboard" ? <button className={`ai-trigger${chatOpen ? " active" : ""}`} onClick={() => { setChatOpen((value) => !value); setChatMinimized(false); }}><span>✦</span> AI 助手</button> : null}<span className={connected ? "live-dot" : "live-dot offline"}>{connected ? "在线" : "离线"}</span><button className="avatar" onClick={() => setCodeInput(accessCode)}>FC</button></div>
        </header>

        {layoutMode === "dashboard" && view === "dashboard" && (
          <>
            <section className="hero">
              <div><span className="hero-label">当前项目 · {activeProject?.name || "默认研发项目"} <button className="project-inline-add" onClick={() => setProjectModalOpen(true)}>＋新增项目</button></span><h2>从搜索开始，<br/>让 Agent 参与每一步研发。</h2><p>{activeProject?.description || "先搜索论文或导入研发文件，右侧 Agent 会根据当前页面提供下一步建议。"}</p><div className="hero-actions"><button className="primary" onClick={() => setView("discover")}>开始搜索 <span>→</span></button><button className="chat-launch" onClick={() => { setChatOpen(true); setChatMinimized(false); }}>打开 AI 助手 <span>✦</span></button></div></div>
              <div className="flow-card">
                <div className="flow-head"><span>研发知识闭环</span><b>真实流程</b></div>
                {flowSteps.map(([n,t,d,s])=><div className={`flow-row ${s}`} key={n}><i>{s==="done"?"✓":n}</i><div><strong>{t}</strong><span>{d}</span></div><b>{s==="current"?"进行中":s==="done"?"已完成":"待开始"}</b></div>)}
              </div>
            </section>
            <section className="stats">
              <article><span>累计发现</span><strong>{stats.discovered}</strong><small>篇论文</small></article>
              <article className="stat-action" onClick={() => setView("review")}><span>待审核</span><strong>{stats.pending}</strong><small>项任务 · 点击查看</small></article>
              <article><span>知识资产</span><strong>{stats.approved + stats.documents}</strong><small>份资料</small></article>
              <article><span>申报草稿</span><strong>{stats.drafts}</strong><small>份材料</small></article>
            </section>
            <section className="content-grid">
              <div className="panel"><div className="panel-head"><div><p className="eyebrow">LATEST INTELLIGENCE</p><h3>最新知识资产</h3></div><button onClick={() => setView("library")}>查看全部</button></div>{papers.slice(0, 3).map((paper)=><PaperRow paper={paper} key={paper.externalId} />)}</div>
              <div className="panel action-panel"><p className="eyebrow">QUICK ACTION</p><h3>成果转化</h3><p>选择已入库论文或研发文件，Agent 将生成技术交底书、摘要与权利要求初稿。</p><div className="doc-stack"><span></span><span></span><b>知识产权<br/>申报材料</b></div><button className="secondary" onClick={() => setView("ip")}>开始生成 <span>→</span></button></div>
            </section>
          </>
        )}

        {layoutMode === "dashboard" && view === "discover" && (
          <section className="workspace">
            <div className="workspace-head"><div><p className="eyebrow">DUAL-SOURCE DISCOVERY</p><h2>自动搜集论文</h2><p>同时检索 arXiv 与 Semantic Scholar；限流时自动切换 Crossref，并合并重复结果。</p></div><span className="source-pill">双源实时检索</span></div>
            <div className="search-box"><input value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => event.key === "Enter" && void searchPapers()} placeholder="输入技术主题，例如：工业视觉缺陷检测 Agent" /><button className="primary" disabled={loading} onClick={() => void searchPapers()}>{loading ? "正在检索…" : "开始检索"}</button></div>
            {searchWarnings.length ? <div className="warning-box"><strong>检索提示</strong>{searchWarnings.map((warning) => <span key={warning}>{warning}</span>)}</div> : null}
            <div className="result-list">{searchResults.length ? searchResults.map((paper) => <article className="result-card" key={`${paper.source}-${paper.externalId}`}><div className="result-source">{sourceLabel(paper.source)}</div><div><h3>{paper.title}</h3><p className="meta">{paper.authors.slice(0, 3).join(" · ")} · {formatDate(paper.publishedAt)}</p><p className="abstract">{paper.abstract || "暂无摘要"}</p><a href={paper.url} target="_blank" rel="noreferrer">查看原文 ↗</a></div><button onClick={() => void importPaper(paper)}>加入审核</button></article>) : <EmptyState title="输入主题启动双源论文采集" detail="真实结果将在这里显示，并可一键加入审核。" />}</div>
          </section>
        )}

        {layoutMode === "dashboard" && view === "review" && (
          <section className="workspace">
            <div className="workspace-head"><div><p className="eyebrow">HUMAN IN THE LOOP</p><h2>审核后入库</h2><p>保留人工判断，确保知识来源可靠、方向相关、证据可追溯。</p></div><span className="source-pill">{pendingPapers.length} 项待处理</span></div>
            <div className="review-grid">{pendingPapers.length ? pendingPapers.map((paper) => <article className="review-card" key={paper.id}><div className="review-top"><span>{sourceLabel(paper.source)}</span><small>{formatDate(paper.publishedAt)}</small></div><h3>{paper.title}</h3><p>{paper.abstract || "暂无摘要"}</p><div className="review-actions"><button className="ghost danger" onClick={() => void reviewPaper(paper.id!, "rejected")}>驳回</button><button className="primary" onClick={() => void reviewPaper(paper.id!, "approved")}>通过并入库</button></div></article>) : <EmptyState title="待审核任务已处理完毕" detail="从论文雷达加入的新论文会出现在这里。" />}</div>
          </section>
        )}

        {layoutMode === "dashboard" && view === "library" && (
          <section className="workspace">
            <div className="workspace-head"><div><p className="eyebrow">R&D KNOWLEDGE BASE</p><h2>研发知识库</h2><p>论文与研发文档统一沉淀，为成果转化提供可信上下文。</p></div><><input ref={fileRef} hidden type="file" accept=".pdf,.docx" onChange={(event) => void uploadDocument(event.target.files?.[0])} /><button className="primary" disabled={loading} onClick={() => fileRef.current?.click()}>导入 PDF / DOCX</button></></div>
            <div className="library-toolbar"><label>当前分组<select value={libraryGroup} onChange={(event) => setLibraryGroup(event.target.value)}><option>全部分组</option>{allGroups.map((group) => <option key={group}>{group}</option>)}</select></label><button className="ghost" onClick={createCustomGroup}>+ 新建分组</button><button className="ghost" onClick={() => setView("review")}>待审核 {pendingPapers.length}</button><span>已入库论文 {approvedPapers.length} 篇</span></div>
            <div className="library-columns"><div><h3>已入库论文 <span>{visibleApprovedPapers.length}</span></h3>{visibleApprovedPapers.length ? visibleApprovedPapers.map((paper) => <div className="library-item" key={paper.externalId}><PaperRow paper={paper} onPreview={() => previewPaper(paper)} /><div className="item-actions"><select value={paper.groupName || "未分类"} onChange={(event) => void changeGroup("paper", paper.id!, event.target.value)}>{allGroups.map((group) => <option key={group}>{group}</option>)}</select><button className="ghost" onClick={() => previewPaper(paper)}>在线预览</button><button className="ghost danger" onClick={() => void deletePaper(paper.id!, paper.title)}>删除</button></div></div>) : <EmptyState title="暂无已入库论文" detail="先在审核中心通过一篇论文。" />}</div><div><h3>研发文件 <span>{visibleDocuments.length}</span></h3>{visibleDocuments.length ? visibleDocuments.map((doc) => <div className="doc-row" key={doc.id}><i>DOC</i><div><strong>{doc.name}</strong><p>{Math.round(doc.size / 1024)} KB · {formatDate(doc.createdAt)} · {doc.groupName || "未分类"}</p></div><select value={doc.groupName || "未分类"} onChange={(event) => void changeGroup("document", doc.id, event.target.value)}>{allGroups.map((group) => <option key={group}>{group}</option>)}</select><button className="ghost" onClick={() => void previewDocument(doc.id)}>预览</button><button className="ghost danger" onClick={() => void deleteDocument(doc.id, doc.name)}>删除</button></div>) : <EmptyState title="尚未导入研发文件" detail="文件在浏览器本地解析，原文件不会上传。" />}</div></div>
          </section>
        )}

        {layoutMode === "dashboard" && view === "ip" && (
          <section className="workspace">
            <div className="workspace-head"><div><p className="eyebrow">IP DRAFTING AGENT</p><h2>知识产权材料生成</h2><p>基于选定研发资料，生成技术交底书、摘要和权利要求初稿。</p></div><span className="source-pill">{IS_LOCAL_DEMO ? (k3Ready ? "本地 K3 · 已连接" : "本地 K3 · 未连接") : "GLM-5.3 · 自动容错"}</span></div>
            <div className="ip-layout">
              <div className="source-selector"><label>材料名称<input value={draftTitle} onChange={(event) => setDraftTitle(event.target.value)} /></label><label>材料分组<select value={draftGroup} onChange={(event) => setDraftGroup(event.target.value)}>{GROUPS.map((group) => <option key={group}>{group}</option>)}</select></label><label>接入模型<select value={modelChoice} onChange={(event) => setModelChoice(event.target.value as ModelChoice)}><option value="auto">自动选择（GLM 优先）</option><option value="glm-5.3">智谱 GLM-5.3</option><option value="qwen3">Workers AI Qwen3</option>{IS_LOCAL_DEMO ? <option value="k3">本机 K3</option> : null}</select></label><label>生成速度<select value={speedChoice} onChange={(event) => setSpeedChoice(event.target.value as SpeedChoice)}><option value="fast">快速：较短初稿</option><option value="balanced">均衡：推荐</option><option value="deep">深度：更完整</option></select></label><h3>选择依据材料</h3>
                {[...approvedPapers.map((paper) => ({ ref: `paper:${paper.id}`, name: paper.title, type: "论文" })), ...documents.map((doc) => ({ ref: `document:${doc.id}`, name: doc.name, type: "研发文件" }))].map((item) => <label className="source-option" key={item.ref}><input type="checkbox" checked={selectedSources.includes(item.ref)} onChange={() => toggleSource(item.ref)} /><span><b>{item.type}</b><strong>{item.name}</strong></span></label>)}
                {!approvedPapers.length && !documents.length ? <EmptyState title="暂无可用资料" detail="先审核入库论文或导入研发文件。" /> : null}
                <button className="primary generate" disabled={loading} onClick={() => void generateDraft()}>{loading ? "Agent 正在生成…" : "生成申报材料"}</button>{loading ? <div className="generation-progress"><div className="progress-track"><i></i></div><strong>{generationStep}</strong><small>展示的是可审计的处理阶段，不暴露模型内部隐式思维。</small></div> : null}
              </div>
              <div className="draft-preview">{activeDraft ? <><div className="draft-head"><div><small>AI GENERATED DRAFT</small><h3>{activeDraft.title}</h3></div><button onClick={() => downloadDraft(activeDraft)}>下载 Markdown</button></div><pre>{activeDraft.markdown}</pre><p className="disclaimer">AI 初稿仅供内部研讨，提交前须由知识产权专业人员审核。</p></> : <EmptyState title="申报材料预览" detail="选择左侧资料后启动 Agent，生成结果将在此展示。" />}</div>
            </div>
            {drafts.length > 0 ? <div className="history"><div className="history-head"><h3>最近生成</h3><select value={draftGroupFilter} onChange={(event) => setDraftGroupFilter(event.target.value)}><option>全部分组</option>{GROUPS.map((group) => <option key={group}>{group}</option>)}</select></div>{visibleDrafts.slice(0, 8).map((draft) => <div className="history-row" key={draft.id}><button onClick={() => setActiveDraft(draft)}><span>{draft.title}</span><small>{draft.groupName || "未分类"} · {formatDate(draft.createdAt)}</small></button><select value={draft.groupName || "未分类"} onChange={(event) => void changeGroup("draft", draft.id, event.target.value)}>{GROUPS.map((group) => <option key={group}>{group}</option>)}</select><button className="ghost danger compact-delete" onClick={() => void deleteDraft(draft.id, draft.title)}>删除</button></div>)}</div> : null}
          </section>
        )}

        {layoutMode === "agent" && (
          <section className="agent-workspace">
            <div className="agent-chat-column">
              <div className="agent-welcome"><p className="eyebrow">RESEARCH OPERATING SYSTEM</p><h2>你好，我是研知 Agent</h2><p>从一份研发文件、一组论文或一个问题开始，我会帮你规划任务、调用技能并沉淀成果。</p><div className="agent-quick-grid">{["上传研发文件并制定 Plan", "搜索当前技术方向论文", "分析研发文件中的创新点", "生成发明专利技术交底书"].map((prompt) => <button key={prompt} onClick={() => prompt.startsWith("上传") ? chatFileRef.current?.click() : void sendChat(prompt)}><span>✦</span>{prompt}<b>→</b></button>)}</div></div>
              <div className="agent-message-list">{chatMessages.length ? chatMessages.map((item, index) => <div className={`chat-bubble ${item.role}`} key={`${item.role}-${index}`}><p>{item.content}</p>{item.model ? <small>{item.model}</small> : null}</div>) : <div className="agent-empty-hint"><span>⌁</span><strong>从对话开始你的研发任务</strong><p>你可以直接上传 PDF / DOCX，或告诉我你想查找的技术方向。</p></div>}{workflowStage ? <div className="workflow-status">{workflowStage}</div> : null}{workflowPlan ? <div className="workflow-card agent-plan-card"><div className="agent-card-title"><strong>Agent 执行计划</strong><span>{workflowPlan.model || "自动模型"}</span></div><p>{workflowPlan.summary}</p><small>检索主题：{workflowPlan.searchQueries.join("；")}</small><ul>{workflowPlan.steps.map((step) => <li key={step}>{step}</li>)}</ul>{workflowPlan.evidenceMap.slice(0, 2).map((item) => <div className="evidence-map" key={item.evidence}><b>研发证据：</b>{item.evidence}<br/><b>论文方向：</b>{item.researchDirection}<br/><b>转化价值：</b>{item.ipValue}</div>)}{!workflowCandidates.length ? <div className="workflow-actions"><button className="primary" disabled={chatBusy} onClick={() => void confirmFileWorkflow()}>确认 Plan，开始执行</button><button className="ghost" onClick={() => { setWorkflowPlan(null); setWorkflowFile(null); setWorkflowText(""); }}>取消</button></div> : <div className="workflow-result">已发现 {workflowCandidates.length} 篇候选论文，等待确认入库。</div>}</div> : null}{chatBusy ? <div className="chat-bubble assistant typing">Agent 正在调用 Skill 并整理结果…</div> : null}</div>
              <div className="agent-composer"><div className="composer-tools"><input ref={chatFileRef} hidden type="file" accept=".pdf,.docx" onChange={(event) => void runFileWorkflow(event.target.files?.[0])} /><button className="chat-upload" disabled={chatBusy} onClick={() => chatFileRef.current?.click()}>＋ 文件</button><select value={modelChoice} onChange={(event) => setModelChoice(event.target.value as ModelChoice)}><option value="auto">自动模型</option><option value="glm-5.3">GLM-5.3</option><option value="qwen3">Qwen3</option>{IS_LOCAL_DEMO ? <option value="k3">K3</option> : null}</select><select value={speedChoice} onChange={(event) => setSpeedChoice(event.target.value as SpeedChoice)}><option value="fast">快速</option><option value="balanced">均衡</option><option value="deep">深度</option></select></div><div className="composer-input"><textarea value={chatInput} onChange={(event) => setChatInput(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void sendChat(); } }} placeholder="描述你的研发任务，或询问当前项目…" rows={3} /><button className="primary" disabled={chatBusy || !chatInput.trim()} onClick={() => void sendChat()}>发送 ↑</button></div><small>Agent 会在执行关键动作前征求确认，重要结果均可追溯。</small></div>
            </div>
            <aside className="agent-context-column">
              <div className="context-section"><div className="context-title"><span>当前项目</span><button onClick={renameProject}>编辑</button></div><strong>{activeProject?.name || "默认研发项目"}</strong><p>{activeProject?.description || "尚未填写项目说明"}</p></div>
              <div className="context-section"><div className="context-title"><span>执行计划</span><b>{workflowStage || (workflowPlan ? "待确认" : "等待输入")}</b></div><div className="mini-timeline"><div className="mini-step active"><i>1</i><span>理解任务</span></div><div className={`mini-step ${workflowPlan ? "active" : ""}`}><i>2</i><span>制定 Plan</span></div><div className={`mini-step ${searchResults.length ? "active" : ""}`}><i>3</i><span>检索与审核</span></div><div className={`mini-step ${activeDraft ? "active" : ""}`}><i>4</i><span>沉淀成果</span></div></div></div>
              <div className="context-section"><div className="context-title"><span>Skill 调用</span><button onClick={() => notify("Skill 配置将在下一版开放")}>管理</button></div><div className="skill-list">{agentSkills.map(([name, status, state]) => <div className="skill-row" key={name}><i className={state}>{state === "done" ? "✓" : state === "current" ? "·" : "○"}</i><span>{name}</span><small>{status}</small></div>)}</div></div>
              <div className="context-section"><div className="context-title"><span>证据链</span><b>{workflowPlan?.evidenceMap.length || 0} 条</b></div>{workflowPlan?.evidenceMap.length ? workflowPlan.evidenceMap.slice(0, 2).map((item) => <div className="context-evidence" key={item.evidence}><strong>{item.evidence}</strong><span>→ {item.researchDirection}</span></div>) : <p className="context-empty">上传研发文件或选中论文后，Agent 会在这里展示证据关联。</p>}</div>
              <div className="context-section"><div className="context-title"><span>任务产物</span><button onClick={() => { setLayoutMode("dashboard"); setView("library"); }}>查看资源库</button></div><div className="artifact-list">{workflowFile ? <button onClick={() => notify(`当前文件：${workflowFile.name}`)}><i>PDF</i><span>{workflowFile.name}<small>研发文件</small></span></button> : null}{workflowCandidates.length ? <button onClick={() => { setLayoutMode("dashboard"); setView("discover"); }}><i>论文</i><span>{workflowCandidates.length} 篇候选论文<small>Agent 初筛结果</small></span></button> : null}{activeDraft ? <button onClick={() => { setLayoutMode("dashboard"); setView("ip"); }}><i>IP</i><span>{activeDraft.title}<small>知识产权材料</small></span></button> : null}{!workflowFile && !workflowCandidates.length && !activeDraft ? <p className="context-empty">完成任务后，文件、论文和材料会出现在这里。</p> : null}</div></div>
            </aside>
          </section>
        )}
      </main>

      {layoutMode === "dashboard" && chatOpen ? <aside className={`assistant-panel${chatMinimized ? " minimized" : ""}`}>
        <div className="assistant-panel-head"><div><p className="eyebrow">AI COPILOT</p><strong>研知 Agent</strong><small>当前页面：{pageTitle} · {activeProject?.name || "默认项目"}</small></div><div className="chat-window-actions"><button title={chatMinimized ? "展开 AI 面板" : "折叠 AI 面板"} onClick={toggleChatMinimized}>{chatMinimized ? "‹" : "›"}</button><button title="关闭 AI 面板" onClick={() => setChatOpen(false)}>×</button></div></div>
        {!chatMinimized ? <>
          <div className="assistant-context"><span>当前上下文</span><strong>{view === "discover" ? `论文检索结果 ${searchResults.length} 篇` : view === "library" ? `资源库 ${approvedPapers.length + documents.length} 项` : view === "ip" ? "成果材料工作区" : "研发知识工作台"}</strong><small>Agent 会根据当前页面和项目状态给出建议</small></div>
          <div className="assistant-quick"><span>快捷操作</span><div>{quickPrompts.map((prompt) => <button key={prompt} disabled={chatBusy} onClick={() => void sendChat(prompt)}>✦ {prompt}</button>)}</div></div>
          <div className="chat-body">{chatMessages.length ? chatMessages.map((item, index) => <div className={`chat-bubble ${item.role}`} key={`${item.role}-${index}`}><p>{item.content}</p>{item.model ? <small>{item.model}</small> : null}</div>) : <div className="chat-welcome"><strong>你好，我是研知 Agent</strong><p>我会围绕当前页面协助你搜索论文、查看研发文件、审核知识和生成成果材料。</p><div className="welcome-hint">试试说：“帮我分析当前页面”</div></div>}{workflowStage ? <div className="workflow-status">{workflowStage}</div> : null}{workflowPlan ? <div className="workflow-card"><strong>Workflow Plan</strong><p>{workflowPlan.summary}</p><small>检索主题：{workflowPlan.searchQueries.join("；")}</small><ul>{workflowPlan.steps.map((step) => <li key={step}>{step}</li>)}</ul><small>分析摘要：{workflowPlan.analysisSummary.join("；")}</small><small>筛选标准：{workflowPlan.screeningCriteria.join("；")}</small>{workflowPlan.evidenceMap.slice(0, 3).map((item) => <div className="evidence-map" key={item.evidence}><b>研发证据：</b>{item.evidence}<br/><b>论文方向：</b>{item.researchDirection}<br/><b>转化价值：</b>{item.ipValue}</div>)}{!workflowCandidates.length ? <div className="workflow-actions"><button className="primary" disabled={chatBusy} onClick={() => void confirmFileWorkflow()}>确认 Plan，开始执行</button><button className="ghost" onClick={() => { setWorkflowPlan(null); setWorkflowFile(null); setWorkflowText(""); }}>取消</button></div> : <><p className="workflow-result">Agent 初筛保留 {workflowCandidates.length} 篇候选论文。</p><div className="workflow-actions"><button className="primary" disabled={chatBusy} onClick={() => void approveAndConvertWorkflow()}>确认入库并完成转化</button><button className="ghost" onClick={() => setWorkflowCandidates([])}>重新确认</button></div></>}</div> : null}{chatBusy ? <div className="chat-bubble assistant typing">Agent 正在处理文件或整理建议…</div> : null}</div>
          <div className="chat-compose"><input ref={chatFileRef} hidden type="file" accept=".pdf,.docx" onChange={(event) => void runFileWorkflow(event.target.files?.[0])} /><button className="chat-upload" disabled={chatBusy} onClick={() => chatFileRef.current?.click()}>导入文件</button><textarea value={chatInput} onChange={(event) => setChatInput(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void sendChat(); } }} placeholder="询问当前页面的内容…" rows={2} /><button className="primary" disabled={chatBusy || !chatInput.trim()} onClick={() => void sendChat()}>发送</button></div>
        </> : <button className="assistant-minimized-label" onClick={toggleChatMinimized}>展开 AI 助手</button>}
      </aside> : null}
      {preview ? <div className="modal-backdrop" onClick={() => setPreview(null)}><div className="preview-modal" onClick={(event) => event.stopPropagation()}><div className="preview-head"><div><p className="eyebrow">ONLINE PREVIEW</p><h2>{preview.title}</h2></div><button className="ghost" onClick={() => setPreview(null)}>关闭</button></div>{preview.kind === "paper" && preview.url ? <a href={preview.url} target="_blank" rel="noreferrer">打开原文 ↗</a> : null}<pre>{preview.content}</pre></div></div> : null}
      {settingsOpen ? <div className="settings-backdrop" onClick={() => setSettingsOpen(false)}><section className="settings-modal" onClick={(event) => event.stopPropagation()}><div className="settings-head"><div><p className="eyebrow">WORKSPACE SETTINGS</p><h2>工作台设置</h2><p>切换界面风格、主题和 Agent 接入方式。</p></div><button className="settings-close" onClick={() => setSettingsOpen(false)}>×</button></div><div className="settings-content"><section className="settings-section"><h3>界面风格</h3><div className="preset-grid"><button className={uiPreset === "classic" ? "selected" : ""} onClick={() => choosePreset("classic")}><span className="preset-preview classic-preview"><i></i><b></b></span><strong>经典研知</strong><small>原始深绿侧栏与研发后台风格</small></button><button className={uiPreset === "cloudflare" ? "selected" : ""} onClick={() => choosePreset("cloudflare")}><span className="preset-preview cloudflare-preview"><i></i><b></b><em></em></span><strong>Cloudflare 风格</strong><small>白色 Dashboard + 橙色 AI 入口</small></button><button className={uiPreset === "gpt" ? "selected" : ""} onClick={() => choosePreset("gpt")}><span className="preset-preview gpt-preview"><i></i><b></b></span><strong>GPT 工作台</strong><small>中间对话 + 右侧上下文和任务</small></button></div></section><section className="settings-section"><h3>外观主题</h3><div className="theme-options">{([["system", "跟随系统", "自动适配白天/夜晚"], ["light", "浅色模式", "清晰的研发后台界面"], ["dark", "深色模式", "适合夜间长时间使用"]] as Array<[ThemePreference, string, string]>).map(([value, label, detail]) => <button className={themePreference === value ? "selected" : ""} key={value} onClick={() => setThemePreference(value)}><span>{value === "system" ? "◐" : value === "light" ? "☼" : "☾"}</span><strong>{label}</strong><small>{detail}</small></button>)}</div></section><section className="settings-section"><div className="settings-section-title"><div><h3>AI 模型接入</h3><p>可配置自己的 GLM 或 OpenAI 兼容接口。</p></div><label className="switch-row"><input type="checkbox" checked={aiConfig.enabled} onChange={(event) => setAIConfig((config) => ({ ...config, enabled: event.target.checked }))} /><span>启用自定义配置</span></label></div><div className="settings-form"><label>服务类型<select value={aiConfig.provider} onChange={(event) => setAIConfig((config) => ({ ...config, provider: event.target.value as AIProvider }))}><option value="glm">智谱 GLM 官方接口</option><option value="openai-compatible">OpenAI 兼容接口</option><option value="k3">本地 K3 / 自定义接口</option></select></label><label>接口地址<input value={aiConfig.endpoint} onChange={(event) => setAIConfig((config) => ({ ...config, endpoint: event.target.value }))} placeholder="https://open.bigmodel.cn/api/paas/v4" /></label><label>模型名称<input value={aiConfig.model} onChange={(event) => setAIConfig((config) => ({ ...config, model: event.target.value }))} placeholder="glm-5.3" /></label><label>API Key<input type="password" value={aiConfig.apiKey} onChange={(event) => setAIConfig((config) => ({ ...config, apiKey: event.target.value }))} placeholder="输入你自己的 API Key" /></label></div><label className="remember-key"><input type="checkbox" checked={aiConfig.remember} onChange={(event) => setAIConfig((config) => ({ ...config, remember: event.target.checked }))} />在本机浏览器保存配置（不写入代码）</label><p className="settings-security">安全提示：启用后，API Key 会随 AI 请求发送到当前项目 Worker。演示环境建议使用专用低额度 Key，不要填写生产主 Key。</p></section></div><div className="settings-actions"><button className="ghost" onClick={() => setSettingsOpen(false)}>取消</button><button className="primary" onClick={saveAISettings}>保存设置</button></div></section></div> : null}
      {projectModalOpen ? <div className="modal-backdrop" onClick={() => setProjectModalOpen(false)}><div className="project-modal" onClick={(event) => event.stopPropagation()}><p className="eyebrow">NEW PROJECT</p><h2>新增研发项目</h2><p>项目之间的论文、研发文件、审核任务和申报材料相互隔离。</p><label>项目名称<input autoFocus value={projectForm.name} onChange={(event) => setProjectForm((form) => ({ ...form, name: event.target.value }))} placeholder="例如：工业视觉缺陷检测" /></label><label>项目介绍<textarea value={projectForm.description} onChange={(event) => setProjectForm((form) => ({ ...form, description: event.target.value }))} placeholder="描述研发目标、范围或负责人关注点" rows={4} /></label><div className="project-modal-actions"><button className="ghost" onClick={() => setProjectModalOpen(false)}>取消</button><button className="primary" onClick={() => void saveProject()}>创建并进入</button></div></div></div> : null}
      {!accessCode || codeInput ? <div className="modal-backdrop"><div className="access-modal"><span className="seal">研</span><p className="eyebrow">SECURE DEMO</p><h2>进入研知 Agent</h2><p>请输入演示访问码。它只保存在当前浏览器会话中，用于保护 AI 调用额度。</p><input autoFocus value={codeInput} onChange={(event) => { setCodeInput(event.target.value); setAuthError(""); }} onKeyDown={(event) => event.key === "Enter" && void unlock()} placeholder="演示访问码" type="password" />{authError ? <div className="form-error">{authError}</div> : null}<button className="primary" disabled={loading} onClick={() => void unlock()}>{loading ? "正在验证…" : "进入工作台"}</button>{accessCode ? <button className="text-button" onClick={() => setCodeInput("")}>取消</button> : null}</div></div> : null}
      {message ? <div className="toast">{message}</div> : null}
    </div>
  );
}

function PaperRow({ paper, onPreview }: { paper: Paper; onPreview?: () => void }) {
  return <div className="paper" onDoubleClick={onPreview}><span className="source">{sourceLabel(paper.source)}</span><div><strong>{paper.title}</strong><p>{paper.authors.slice(0, 2).join(" · ")} · {formatDate(paper.publishedAt)} · {paper.groupName || "未分类"}</p></div><em className={paper.status === "approved" ? "approved" : ""}>{paper.status === "approved" ? "已入库" : paper.status === "rejected" ? "已驳回" : "待审核"}</em></div>;
}

function EmptyState({ title, detail }: { title: string; detail: string }) {
  return <div className="empty"><i>◇</i><strong>{title}</strong><p>{detail}</p></div>;
}

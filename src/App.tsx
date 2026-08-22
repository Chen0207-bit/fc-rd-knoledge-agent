import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import mammoth from "mammoth";
import * as pdfjs from "pdfjs-dist";
import pdfWorker from "pdfjs-dist/build/pdf.worker.min.mjs?url";

pdfjs.GlobalWorkerOptions.workerSrc = pdfWorker;

type View = "dashboard" | "discover" | "review" | "library" | "ip";
type UIPreset = "classic" | "cloudflare" | "gpt";
type ThemePreference = "system" | "light" | "dark";
type AIProvider = "glm" | "openai-compatible" | "k3";
type AIConfig = { enabled: boolean; provider: AIProvider; endpoint: string; apiKey: string; model: string; remember: boolean };
type TraceStep = { label: string; detail: string; status: "pending" | "active" | "done" | "error" };
type ResumeTask = { fileName: string; stage: string; updatedAt: string };
type PaperStatus = "pending" | "approved" | "rejected";
const GROUPS = ["未分类", "算法研究", "产品技术", "专利候选", "竞品情报"];
try { GROUPS.push(...(JSON.parse(localStorage.getItem("rd-custom-groups") || "[]") as string[]).filter((group) => !GROUPS.includes(group))); } catch { /* first visit */ }
type ModelChoice = "auto" | "glm-5.3" | "qwen3" | "k3";
type SpeedChoice = "fast" | "balanced" | "deep";
type ChatMessage = { role: "user" | "assistant"; content: string; model?: string };
type Project = { id: number; name: string; description: string; createdAt?: string; updatedAt?: string };
type WorkflowPlan = { summary: string; searchQueries: string[]; screeningCriteria: string[]; evidenceMap: Array<{ evidence: string; researchDirection: string; ipValue: string }>; analysisSummary: string[]; steps: string[]; model?: string };
type SkillDocument = { id: string; name: string; description: string; content: string; enabled: boolean; source: "built-in" | "uploaded"; updatedAt: string };
type SkillRun = { id: string; name: string; input: string; output: string; status: "running" | "done" | "error"; startedAt: string; duration?: number };
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
type DraftStage = "ai_draft" | "rd_review" | "ip_review" | "agency" | "final";
type Stats = { discovered: number; pending: number; approved: number; documents: number; drafts: number };

const DEFAULT_AI_CONFIG: AIConfig = { enabled: false, provider: "glm", endpoint: "https://open.bigmodel.cn/api/paas/v4", apiKey: "", model: "glm-5.3", remember: false };
function readAIConfig(): AIConfig {
  try {
    const raw = sessionStorage.getItem("rd-ai-config") || localStorage.getItem("rd-ai-config");
    return raw ? { ...DEFAULT_AI_CONFIG, ...(JSON.parse(raw) as Partial<AIConfig>) } : DEFAULT_AI_CONFIG;
  } catch { return DEFAULT_AI_CONFIG; }
}
function readResumeTask(): ResumeTask | null {
  try { return JSON.parse(sessionStorage.getItem("rd-resume-task") || "null") as ResumeTask | null; } catch { return null; }
}

const SKILL_LIBRARY_VERSION = 2;
const DEFAULT_SKILLS: SkillDocument[] = [
  { id: "research-dialogue", name: "研发任务对话 Skill", description: "把自然语言研发诉求转成可确认、可恢复、可追溯的任务计划。", content: `---
name: research-dialogue
description: 将研发人员的自然语言需求转为可执行的检索、审核和知识产权任务。
triggers: 研发需求、技术调研、帮我找论文、从文件开始、生成专利材料
outputs: 任务摘要、关键追问、检索计划、审核门槛、待确认事项
---
# 研发任务对话 Skill

## 目标与边界
把对话变成结构化研发任务，不替用户作未经确认的技术事实、实验结论或法律判断。所有后续步骤必须能回到项目、文件、论文和人工确认记录。

## 何时启用
- 用户描述了一个研发问题、方案、技术路线或希望从文件开始工作。
- 用户要求扩大论文范围、比较方案、提取创新点或生成知识产权材料。

## 执行流程
1. 识别技术对象、应用场景、目标指标、已知约束、时间范围和期望产物。
2. 缺少关键信息时一次只问最影响结果的 1—3 个问题，并解释为什么需要。
3. 生成可编辑 Plan：输入、步骤、检索主题、筛选规则、输出格式、风险和人工确认点。
4. 用户确认后再调用文件解析、论文检索、审核和生成 Skill；每一步报告输入、依据、产物和下一步。

## 输出契约
必须包含：任务摘要；已知事实/待确认假设；建议的检索主题；预计产物；风险提示；需要用户确认的选项。Plan 步骤使用可勾选状态，支持暂停、继续、重跑和修改。

## 质量门
不得把推测写成事实；不得声称已访问未访问的数据库；检索范围、结果数量和失败原因必须透明；涉及专利新颖性或侵权时明确提示需专业人员复核。
`, enabled: true, source: "built-in", updatedAt: new Date().toISOString() },
  { id: "document-parser", name: "研发文件解析 Skill", description: "按证据层级解析 PDF/DOCX，提取技术对象、方案、指标、缺口和可检索线索。", content: `---
name: document-parser
description: 从研发文件提取可引用的技术事实，并建立章节、页码、原文片段与技术要素的映射。
triggers: 上传研发文件、解析 PDF、阅读方案书、提取技术方案
outputs: 文档摘要、技术要素表、证据片段、检索词、信息缺口
---
# 研发文件解析 Skill

## 输入
PDF/DOCX 文本、文件名、项目上下文。优先保留章节标题、页码、表格标题和原文片段；扫描件或图片文字识别不完整时必须标记。

## 解析方法
1. 先给出文档类型、版本、时间和可读性检查。
2. 按“问题—对象—输入—处理—输出—指标—约束—效果”拆分技术方案。
3. 将内容分为：原文事实、作者主张、Agent 推断、待补充信息四类。
4. 提取同义词、缩写、上下位概念、工程约束和指标范围，生成后续论文检索词。

## 证据契约
每个关键技术要素都要带章节/页码/原文摘录；无法定位时写“定位缺失”。不要补写文件没有的参数、实验数据、发明人或因果关系。

## 输出
输出结构化摘要、技术要素表、可检索关键词组、证据清单、冲突点和待向研发人员确认的问题。摘要之后必须附“解析局限”。

## 失败处理
文本为空、乱码、页数超限或表格丢失时停止下游自动转化，只给出可恢复的解析结果并请求重新上传或人工补录。
`, enabled: true, source: "built-in", updatedAt: new Date().toISOString() },
  { id: "paper-search", name: "论文检索 Skill", description: "以主题分解、多来源检索、去重和筛选器形成可复核的论文候选集。", content: `---
name: paper-search
description: 根据研发文件证据设计多组互补查询，在可用学术来源中检索、去重并排序论文。
triggers: 搜索论文、扩大检索、找现有技术、补充学术依据
outputs: 查询矩阵、候选论文、来源状态、筛选统计、检索缺口
---
# 论文检索 Skill

## 检索原则
先把技术拆成方法、对象/场景、工程约束、评价指标、替代方案五类概念，再生成同义词、英文词、缩写和组合查询。不要只用一条宽泛查询。

## 检索矩阵
至少覆盖：核心方法；应用场景；关键部件/数据；性能指标；工程部署；相邻领域替代方案。每组查询记录关键词、来源、时间范围、命中数和是否受限。

## 来源与筛选
优先使用可访问的 arXiv、Semantic Scholar、Crossref 等来源；保留 DOI、作者、年份、摘要、URL、PDF 可用性和来源。来源不可访问时不能伪造结果，需显示“未核验”。支持年份、作者、来源、全文、相关度和排序筛选。

## 排序与去重
综合标题/摘要技术匹配、与研发文件的证据关联、年份、引用或影响指标、全文可用性和来源可信度排序。用 DOI、规范化标题和作者年份去重；相似论文合并时保留各自来源。

## 输出契约
输出查询矩阵、候选清单、每篇的匹配理由、证据状态和排除原因，并报告“检索覆盖了什么、没有覆盖什么”。不得把搜索摘要当作全文结论。

## 人工确认
论文是否入库、是否作为现有技术、是否支持某个创新点必须由用户确认；Agent 只给建议，不给新颖性或侵权的确定结论。
`, enabled: true, source: "built-in", updatedAt: new Date().toISOString() },
  { id: "paper-review", name: "论文相关性审核 Skill", description: "逐篇给出可解释的纳入/排除建议，并把论文证据关联到研发文件和创新点。", content: `---
name: paper-review
description: 对论文进行技术相关性、证据质量、时效性和知识产权价值的分层审核。
triggers: 审核论文、批量审核、判断相关性、论文入库
outputs: 审核结论、评分维度、证据摘要、关联技术点、人工待办
---
# 论文相关性审核 Skill

## 审核维度
1. 问题相似度：是否解决同类技术问题。
2. 方案相似度：关键步骤、结构或系统组件是否可比。
3. 证据质量：摘要、全文、DOI、作者和来源是否可核验。
4. 工程相关性：是否涉及相同约束、指标、数据或部署环境。
5. 研发/IP 价值：能否支持背景技术、对比方案、差异点或创新点分析。

## 结论规则
“建议纳入”必须列出至少两条证据和对应研发文件技术点；“建议排除”必须写清排除理由；证据不足、技术边界不清或来源冲突时只能给“需要人工确认”。

## 输出格式
结论 + 维度评分/等级 + 证据摘要 + 对应文件章节 + 对创新点的价值 + 风险与缺口 + 建议动作。禁止只输出一个总分，禁止把关键词命中当作技术等同。

## 批量质量控制
批量审核前先展示评分标准；审核后报告纳入/排除/待确认数量、重复项、缺全文项和低置信度项。入库时保存审核人、时间、版本和备注。

## 人工门
论文入库、作为现有技术引用、用于形成权利要求依据，均保留人工确认记录；Agent 不替代专利代理师或法律意见。
`, enabled: true, source: "built-in", updatedAt: new Date().toISOString() },
  { id: "paper-deep-read", name: "论文深度阅读与证据核验 Skill", description: "把已选论文拆成方法、实验、限制和可引用证据，避免用摘要过度推断。", content: `---
name: paper-deep-read
description: 对重点论文进行结构化精读、证据定位和结论边界核验。
triggers: 深度阅读、精读论文、核验实验、提取论文证据
outputs: 论文卡片、方法流程、实验表、局限性、可引用证据、与研发方案的差异
---
# 论文深度阅读与证据核验 Skill

## 阅读顺序
先确认元数据和全文可用性，再按摘要/问题、方法、数据、实验、结果、限制、结论阅读。区分作者报告的结果、作者解释、Agent 推断和无法验证的内容。

## 必提字段
研究问题；技术方案步骤；关键参数；数据集/样本；基线；评价指标；实验结果；消融或对比；限制与适用边界；与当前研发文件的相同点、差异点和不可比点。

## 证据规则
关键数字必须带页码/章节/表格定位；只看到摘要时标记“摘要级证据”；论文没有报告的内容不得补全。若不同章节或来源冲突，保留冲突并交给用户判断。

## 输出
先给一页可读摘要，再给结构化论文卡片和证据清单，最后给“能支持什么/不能支持什么”。引用建议使用论文原始链接、DOI和定位信息。
`, enabled: true, source: "built-in", updatedAt: new Date().toISOString() },
  { id: "ip-drafting", name: "知识产权生成 Skill", description: "把研发事实、论文证据和人工确认的创新点组织成接近生产使用的技术交底书初稿。", content: `---
name: ip-drafting
description: 根据研发文件与已审核证据生成可审阅、可追溯、保留缺口的知识产权材料草稿。
triggers: 生成交底书、提取创新点、准备专利材料、生成知识产权申报材料
outputs: 技术交底书、创新点表、权利要求建议、证据映射、待补字段
---
# 知识产权生成 Skill

## 前置条件
只有在研发文件已解析、论文已审核且创新点经过用户确认后生成正式草稿；前置证据不足时输出“待补信息清单”，不得假装材料完整。

## 生产级结构
文档编号/版本/密级；项目和发明人信息；技术领域；背景技术及其证据；要解决的技术问题；完整技术方案；关键步骤/模块；有益效果与验证依据；附图说明；具体实施方式；可替代实施例；创新点与对比表；摘要；权利要求书建议；风险和待代理师确认事项。

## 证据映射
每个核心技术特征关联研发文件章节和论文/实验依据；区分“研发已实现”“方案设想”“论文支持”“待验证”。不擅自添加参数、效果、发明人、申请人或法律结论。

## 权利要求建议
围绕必要技术特征组织独立项，围绕可选模块、参数范围、步骤关系和替代实现组织从属项；只提出技术表达建议，不宣称已满足新颖性、创造性或授权条件。

## 交付与审核
输出 Markdown 可审阅稿、字段缺口、证据链和版本号；默认进入“AI 初稿”，由研发负责人、知识产权负责人和代理机构依次审核。支持逐段修改、评论和重新生成。
`, enabled: true, source: "built-in", updatedAt: new Date().toISOString() },
  { id: "ip-quality-gate", name: "知识产权材料质量门 Skill", description: "在材料交付前检查事实、证据、结构、缺口和权利要求表达风险。", content: `---
name: ip-quality-gate
description: 对知识产权材料做交付前的完整性、可追溯性和风险检查，不替代专业法律审查。
triggers: 检查专利材料、材料质检、提交前审核、检查交底书
outputs: 质量门报告、阻塞项、警告项、证据覆盖率、修改建议
---
# 知识产权材料质量门 Skill

## 阻塞项
缺少项目/发明人/申请人等必填信息；核心技术特征没有研发文件依据；关键效果没有验证或来源；权利要求出现未在说明书展开的特征；引用论文无法定位；将推断写成已实现事实。

## 检查项
- 文档结构是否齐全、标题和编号是否一致。
- 技术问题、方案、效果是否形成因果闭环。
- 创新点是否能映射到具体实施方式和证据。
- 术语、参数、缩写是否统一，是否存在互相矛盾。
- 摘要、权利要求和正文是否描述同一技术范围。
- 是否清楚标记 AI 生成、人工确认和待代理机构修改内容。

## 输出
按阻塞/高风险/建议三档报告；给出字段、段落或证据定位；统计核心特征覆盖率；生成修订清单和下一位审核角色。没有足够材料时只报告缺口，不编造通过结论。

## 安全边界
明确声明这不是专利法律意见、授权保证或侵权判断；最终提交前必须由有资质的知识产权人员审核。
`, enabled: true, source: "built-in", updatedAt: new Date().toISOString() },
];

function readSkills() {
  try {
    const saved = JSON.parse(localStorage.getItem("rd-skill-documents") || "null") as SkillDocument[] | null;
    if (!saved?.length) return DEFAULT_SKILLS;
    const version = Number(localStorage.getItem("rd-skill-library-version") || 0);
    if (version < SKILL_LIBRARY_VERSION) {
      const savedById = new Map(saved.map((skill) => [skill.id, skill]));
      const migrated = DEFAULT_SKILLS.map((skill) => {
        const old = savedById.get(skill.id);
        const looksUserEdited = old?.source === "uploaded" || (old?.content?.length || 0) > 500;
        return looksUserEdited && old ? old : { ...skill, enabled: old?.enabled ?? skill.enabled };
      });
      const defaultsIds = new Set(DEFAULT_SKILLS.map((skill) => skill.id));
      const custom = saved.filter((skill) => !defaultsIds.has(skill.id));
      const result = [...migrated, ...custom];
      localStorage.setItem("rd-skill-documents", JSON.stringify(result));
      localStorage.setItem("rd-skill-library-version", String(SKILL_LIBRARY_VERSION));
      return result;
    }
    return saved;
  } catch { return DEFAULT_SKILLS; }
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

const DRAFT_STAGES: Array<[DraftStage, string, string]> = [
  ["ai_draft", "AI 初稿", "Agent 已生成，等待研发负责人检查"],
  ["rd_review", "研发负责人审核", "核对技术事实、数据和研发文件依据"],
  ["ip_review", "知识产权审核", "核对创新点、权利要求和保护范围"],
  ["agency", "代理机构修改", "补充格式、法律表达和申请文件细节"],
  ["final", "最终定稿", "完成内部确认，可进入申报流程"],
];

function stageLabel(stage: DraftStage) {
  return DRAFT_STAGES.find(([value]) => value === stage)?.[1] || "AI 初稿";
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character] || character));
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
  const [aiFocus, setAIFocus] = useState(false);
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
  const [reasoningTrace, setReasoningTrace] = useState<TraceStep[]>([]);
  const [selectedReviewIds, setSelectedReviewIds] = useState<number[]>([]);
  const [resumeTask, setResumeTask] = useState<ResumeTask | null>(readResumeTask);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>(() => { try { return JSON.parse(sessionStorage.getItem("rd-agent-chat") || "[]") as ChatMessage[]; } catch { return []; } });
  const [activeDraft, setActiveDraft] = useState<Draft | null>(null);
  const [draftStages, setDraftStages] = useState<Record<number, DraftStage>>(() => { try { return JSON.parse(localStorage.getItem("rd-draft-stages") || "{}") as Record<number, DraftStage>; } catch { return {}; } });
  const [skillDetail, setSkillDetail] = useState<string | null>(null);
  const [skills, setSkills] = useState<SkillDocument[]>(readSkills);
  const [skillRuns, setSkillRuns] = useState<SkillRun[]>([]);
  const [skillLibraryOpen, setSkillLibraryOpen] = useState(false);
  const [skillEditor, setSkillEditor] = useState<SkillDocument | null>(null);
  const [planDraft, setPlanDraft] = useState<WorkflowPlan | null>(null);
  const [feishuDemoOpen, setFeishuDemoOpen] = useState(false);
  const [feishuConfig, setFeishuConfig] = useState({ appId: "", appSecret: "", tenant: "", space: "研发知识空间", syncFiles: true, notify: true, approval: true });
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
  useEffect(() => { localStorage.setItem("rd-ui-preset", uiPreset); }, [uiPreset]);
  useEffect(() => { localStorage.setItem("rd-theme-preference", themePreference); }, [themePreference]);
  useEffect(() => { sessionStorage.setItem("rd-agent-chat", JSON.stringify(chatMessages.slice(-20))); }, [chatMessages]);
  useEffect(() => { localStorage.setItem("rd-draft-stages", JSON.stringify(draftStages)); }, [draftStages]);
  useEffect(() => {
    localStorage.setItem("rd-skill-documents", JSON.stringify(skills));
    localStorage.setItem("rd-skill-library-version", String(SKILL_LIBRARY_VERSION));
  }, [skills]);

  useEffect(() => {
    if (!IS_LOCAL_DEMO) return;
    fetch(`${K3_LOCAL_BASE}/health`).then((response) => response.json()).then((data) => setK3Ready(Boolean(data.ok && data.model === "k3"))).catch(() => setK3Ready(false));
  }, []);

  const notify = (text: string) => {
    setMessage(text);
    window.setTimeout(() => setMessage(""), 3200);
  };

  function startTrace(steps: Array<[string, string]>) {
    setReasoningTrace(steps.map(([label, detail], index) => ({ label, detail, status: index === 0 ? "active" : "pending" })));
  }

  function advanceTrace(index: number, detail?: string) {
    setReasoningTrace((steps) => steps.map((step, stepIndex) => ({ ...step, status: stepIndex < index ? "done" : stepIndex === index ? "active" : "pending", detail: stepIndex === index && detail ? detail : step.detail })));
  }

  function finishTrace(detail?: string, error = false) {
    setReasoningTrace((steps) => steps.map((step, index) => ({ ...step, status: error && index === steps.length - 1 ? "error" : "done", detail: detail && index === steps.length - 1 ? detail : step.detail })));
  }

  function saveResumeTask(fileName: string, stage: string) {
    const task = { fileName, stage, updatedAt: new Date().toISOString() };
    setResumeTask(task);
    sessionStorage.setItem("rd-resume-task", JSON.stringify(task));
  }

  function clearResumeTask() {
    setResumeTask(null);
    sessionStorage.removeItem("rd-resume-task");
  }

  function enabledSkillContext() {
    return skills.filter((skill) => skill.enabled).map((skill) => `### ${skill.name}\n${skill.content.slice(0, 6000)}`).join("\n\n").slice(0, 24_000);
  }

  function startSkillRun(name: string, input: string) {
    const run = { id: `${Date.now()}-${name}`, name, input: input.slice(0, 180), output: "正在执行并等待结果…", status: "running" as const, startedAt: new Date().toISOString() };
    setSkillRuns((runs) => [run, ...runs].slice(0, 8));
    return run.id;
  }

  function finishSkillRun(id: string, output: string, error = false) {
    setSkillRuns((runs) => runs.map((run) => run.id === id ? { ...run, output: output.slice(0, 240), status: error ? "error" : "done", duration: Date.now() - new Date(run.startedAt).getTime() } : run));
  }

  function openSkillEditor(skill?: SkillDocument) {
    setSkillEditor(skill ? { ...skill } : { id: `uploaded-${Date.now()}`, name: "新 Skill", description: "", content: "# 新 Skill\n\n## 目标\n\n## 输入\n\n## 输出\n", enabled: true, source: "uploaded", updatedAt: new Date().toISOString() });
  }

  function saveSkill(skill: SkillDocument) {
    const next = { ...skill, name: skill.name.trim() || "未命名 Skill", description: skill.description.trim(), content: skill.content.trim(), updatedAt: new Date().toISOString() };
    setSkills((items) => items.some((item) => item.id === next.id) ? items.map((item) => item.id === next.id ? next : item) : [next, ...items]);
    setSkillEditor(null);
    notify(`Skill「${next.name}」已保存，可被 Agent 调用`);
  }

  async function importSkillFile(file?: File) {
    if (!file) return;
    const content = await file.text();
    const heading = content.match(/^#\s+(.+)$/m)?.[1]?.trim() || file.name.replace(/\.(md|markdown|txt)$/i, "");
    openSkillEditor({ id: `uploaded-${Date.now()}`, name: heading, description: "从 Markdown 文件导入", content, enabled: true, source: "uploaded", updatedAt: new Date().toISOString() });
  }

  function openPlanEditor() {
    if (!workflowPlan) return notify("当前还没有可编辑的执行计划");
    setPlanDraft(JSON.parse(JSON.stringify(workflowPlan)) as WorkflowPlan);
  }

  function savePlanEditor() {
    if (!planDraft) return;
    const cleaned = { ...planDraft, summary: planDraft.summary.trim(), searchQueries: planDraft.searchQueries.map((item) => item.trim()).filter(Boolean), screeningCriteria: planDraft.screeningCriteria.map((item) => item.trim()).filter(Boolean), analysisSummary: planDraft.analysisSummary.map((item) => item.trim()).filter(Boolean), steps: planDraft.steps.map((item) => item.trim()).filter(Boolean), evidenceMap: planDraft.evidenceMap.filter((item) => item.evidence.trim() || item.researchDirection.trim() || item.ipValue.trim()) };
    if (!cleaned.summary || !cleaned.searchQueries.length || !cleaned.steps.length) return notify("计划至少需要目标、一个检索主题和一个执行步骤");
    setWorkflowPlan(cleaned);
    setPlanDraft(null);
    saveResumeTask(workflowFile?.name || "研发文件", "等待执行已编辑 Workflow Plan");
    notify("Workflow Plan 已保存，下一步可确认执行");
  }

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
    const skillRunId = startSkillRun("论文检索 Skill", query);
    try {
      const data = await api<{ papers: Paper[]; warnings?: string[] }>(`/api/papers/search?q=${encodeURIComponent(query)}&source=all&limit=8`);
      setSearchResults(data.papers);
      setSearchWarnings(data.warnings || []);
      setConnected(true);
      finishSkillRun(skillRunId, `已从论文源返回 ${data.papers.length} 篇结果`);
      notify(data.warnings?.length ? `已发现 ${data.papers.length} 篇，部分来源已降级` : `已从双源发现 ${data.papers.length} 篇论文`);
    } catch (error) {
      finishSkillRun(skillRunId, error instanceof Error ? error.message : "论文检索 Skill 失败", true);
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
    const skillRunId = startSkillRun("论文相关性审核 Skill", `${status === "approved" ? "通过" : "驳回"} 论文 #${id}`);
    try {
      await api(`/api/papers/${id}/review`, { method: "POST", body: JSON.stringify({ status, note: status === "approved" ? "证据完整，符合研发知识入库要求" : "与当前研发方向相关性不足" }) });
      finishSkillRun(skillRunId, status === "approved" ? "已审核通过并进入知识库" : "已标记为不纳入");
      notify(status === "approved" ? "审核通过，已进入研发知识库" : "已驳回");
      await refresh();
    } catch (error) {
      finishSkillRun(skillRunId, error instanceof Error ? error.message : "论文审核 Skill 失败", true);
      notify(error instanceof Error ? error.message : "审核失败");
    }
  }

  async function batchReview(status: "approved" | "rejected") {
    if (!selectedReviewIds.length) return notify("请先选择论文");
    const count = selectedReviewIds.length;
    setLoading(true);
    startTrace([["读取审核队列", `选择了 ${count} 篇待审核论文`], ["逐项核验", "检查来源、摘要和当前项目相关性"], ["批量写入结果", status === "approved" ? "通过并写入研发知识库" : "驳回并标记为不纳入"], ["刷新待办", "更新审核队列和知识资产统计"]]);
    try {
      advanceTrace(1);
      await Promise.all(selectedReviewIds.map((id) => api(`/api/papers/${id}/review`, { method: "POST", body: JSON.stringify({ status, note: status === "approved" ? "批量审核通过，来源和相关性符合当前研发方向" : "批量审核驳回，与当前研发方向相关性不足" }) })));
      advanceTrace(2);
      await refresh();
      setSelectedReviewIds([]);
      finishTrace(`已完成 ${status === "approved" ? "通过" : "驳回"} ${count} 篇论文`);
      notify(status === "approved" ? `已批量入库 ${count} 篇论文` : `已批量驳回 ${count} 篇论文`);
    } catch (error) { finishTrace(error instanceof Error ? error.message : "批量审核失败", true); notify(error instanceof Error ? error.message : "批量审核失败"); }
    finally { setLoading(false); }
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
    const skillRunId = startSkillRun("研发任务对话 Skill", content);
    startTrace([["识别任务", `识别为对话请求：${content.slice(0, 46)}`], ["读取上下文", "读取当前项目、页面和已有任务状态"], ["组织回答", "调用已启用模型生成可执行建议"], ["边界检查", "检查是否包含无依据结论或需要人工确认的动作"]]);
    try {
      advanceTrace(1);
      const data = await api<{ reply: string; model: string }>("/api/assistant-chat", { method: "POST", body: JSON.stringify({ messages: nextMessages, context: chatContext(), skillContext: enabledSkillContext() }) });
      advanceTrace(2, `已使用 ${data.model} 返回结果`);
      setChatMessages((messages) => [...messages, { role: "assistant", content: data.reply, model: data.model }]);
      finishSkillRun(skillRunId, `已生成对话建议，模型：${data.model}`);
      finishTrace("回答已生成，可继续追问或确认下一步");
    } catch (error) { finishSkillRun(skillRunId, error instanceof Error ? error.message : "Skill 调用失败", true); finishTrace(error instanceof Error ? error.message : "Agent 对话失败", true); notify(error instanceof Error ? error.message : "Agent 对话失败"); }
    finally { setChatBusy(false); }
  }

  async function runFileWorkflow(file?: File) {
    if (!file || chatBusy) return;
    setChatBusy(true);
    const skillRunId = startSkillRun("研发文件解析 Skill", file.name);
    saveResumeTask(file.name, "正在生成 Workflow Plan");
    setChatMessages((messages) => [...messages, { role: "user", content: `请先为研发文件制定 Workflow Plan：${file.name}` }]);
    startTrace([["识别输入", `收到研发文件：${file.name}`], ["提取文本", "在浏览器本地读取 PDF / DOCX 文本"], ["提炼技术事实", "提取对象、方法、工程约束和评价指标"], ["制定检索 Plan", "生成互补检索主题、筛选标准和证据映射"], ["等待确认", "计划生成后由用户确认再执行"]]);
    try {
      setWorkflowStage("正在本地解析文件并提炼计划…");
      saveResumeTask(file.name, "等待确认 Workflow Plan");
      advanceTrace(1);
      const text = await extractFile(file);
      advanceTrace(2, `已提取 ${text.length.toLocaleString()} 个字符`);
      const data = await api<{ plan: WorkflowPlan; model: string }>("/api/assistant-plan", { method: "POST", body: JSON.stringify({ sourceText: text, fileName: file.name, projectDescription: activeProject?.description || "", skillContext: enabledSkillContext() }) });
      advanceTrace(3, `已生成 ${data.plan.searchQueries.length} 组检索主题`);
      setWorkflowPlan({ ...data.plan, model: data.model });
      setWorkflowFile(file);
      setWorkflowText(text);
      setWorkflowStage("");
      finishSkillRun(skillRunId, `已提取文件并完成计划输入：${text.length.toLocaleString()} 字符`);
      finishTrace("Plan 已生成，等待用户确认");
      setChatMessages((messages) => [...messages, { role: "assistant", content: "我已经根据文件内容拟好执行计划，请确认后再开始搜索、初审和转化。" }]);
    } catch (error) {
      finishSkillRun(skillRunId, error instanceof Error ? error.message : "文件解析 Skill 失败", true);
      setWorkflowStage("");
      finishTrace(error instanceof Error ? error.message : "Workflow Plan 生成失败", true);
      setChatMessages((messages) => [...messages, { role: "assistant", content: error instanceof Error ? error.message : "Workflow Plan 生成失败" }]);
    } finally {
      setChatBusy(false);
      if (chatFileRef.current) chatFileRef.current.value = "";
    }
  }

  async function confirmFileWorkflow() {
    if (!workflowPlan || !workflowFile || chatBusy) return;
    setChatBusy(true);
    const searchSkillRunId = startSkillRun("论文检索 Skill", workflowPlan.searchQueries.join("；"));
    startTrace([["确认 Plan", "用户已确认执行检索计划"], ["导入研发文件", "保存文件文本并绑定当前项目"], ["拆分检索主题", `${workflowPlan.searchQueries.length} 组互补主题并行检索`], ["合并去重", "按标题归一化并去除重复论文"], ["初筛候选", "保留高相关度论文，等待用户确认入库"]]);
    try {
      setWorkflowStage("正在导入研发文件…");
      saveResumeTask(workflowFile?.name || "研发文件", "正在检索论文");
      advanceTrace(1);
      const documentId = await uploadDocument(workflowFile, workflowText);
      if (!documentId) return;
      setWorkflowDocumentId(documentId);
      setWorkflowStage(`正在搜索 ${workflowPlan.searchQueries.length} 组相关主题…`);
      advanceTrace(2);
      const searchData = await Promise.all(workflowPlan.searchQueries.slice(0, 4).map((searchQuery) => api<{ papers: Paper[]; warnings?: string[] }>(`/api/papers/search?q=${encodeURIComponent(searchQuery)}&source=all&limit=12`)));
      const merged = searchData.flatMap((result) => result.papers);
      advanceTrace(3, `收集到 ${merged.length} 条原始结果`);
      const seen = new Set<string>();
      const papers = merged.filter((paper) => { const key = paper.title.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]/g, ""); if (!key || seen.has(key)) return false; seen.add(key); return true; }).slice(0, 24);
      const candidates = papers.slice(0, 12);
      setWorkflowCandidates(candidates);
      setSearchResults(papers);
      finishSkillRun(searchSkillRunId, `已调用 ${workflowPlan.searchQueries.length} 组主题，得到 ${papers.length} 篇去重结果`);
      const reviewSkillRunId = startSkillRun("论文相关性审核 Skill", `${candidates.length} 篇候选论文`);
      finishSkillRun(reviewSkillRunId, `已完成初筛，保留 ${candidates.length} 篇待人工确认候选`);
      setWorkflowStage("");
      finishTrace(`初筛完成：${papers.length} 篇去重结果，${candidates.length} 篇候选待确认`);
      setChatMessages((messages) => [...messages, { role: "assistant", content: `计划已执行到 Agent 初筛：通过 ${workflowPlan.searchQueries.length} 组主题发现 ${papers.length} 篇去重论文，已保留 ${candidates.length} 篇候选。请确认后，我会审核入库并生成知识产权材料。` }]);
    } catch (error) {
      finishSkillRun(searchSkillRunId, error instanceof Error ? error.message : "论文检索 Skill 失败", true);
      setWorkflowStage("");
      finishTrace(error instanceof Error ? error.message : "Workflow 执行失败", true);
      setChatMessages((messages) => [...messages, { role: "assistant", content: error instanceof Error ? error.message : "Workflow 执行失败" }]);
    } finally { setChatBusy(false); }
  }

  async function approveAndConvertWorkflow() {
    if (!workflowPlan || !workflowDocumentId || !workflowCandidates.length || chatBusy) return;
    setChatBusy(true);
    startTrace([["确认入库", "用户确认候选论文进入知识库"], ["论文审核", `逐篇写入审核意见，共 ${workflowCandidates.length} 篇`], ["建立证据链", "绑定研发文件、论文与项目上下文"], ["生成申报材料", "按技术交底书结构生成可复核初稿"], ["完成交付", "保存材料并返回任务结果"]]);
    try {
      setWorkflowStage("正在审核并入库候选论文…");
      saveResumeTask(workflowFile?.name || "研发文件", "正在审核论文并生成材料");
      advanceTrace(1);
      const paperRefs: string[] = [];
      for (const paper of workflowCandidates) {
        const imported = await api<{ id: number }>("/api/papers/import", { method: "POST", body: JSON.stringify(paper) });
        if (imported.id) {
          await api(`/api/papers/${imported.id}/review`, { method: "POST", body: JSON.stringify({ status: "approved", note: "用户确认 Workflow Plan 后由 Agent 完成初审，建议入库" }) });
          paperRefs.push(`paper:${imported.id}`);
        }
      }
      const refs = [`document:${workflowDocumentId}`, ...paperRefs];
      advanceTrace(2, `已建立 ${refs.length} 条来源引用`);
      const title = workflowFile?.name.replace(/\.(pdf|docx)$/i, "") || "研发成果知识产权材料";
      setSelectedSources(refs);
      setDraftTitle(title);
      setView("ip");
      setWorkflowStage("正在生成知识产权申报材料…");
      advanceTrace(3);
      await generateDraft(refs, title);
      await refresh();
      setWorkflowPlan(null);
      setWorkflowFile(null);
      setWorkflowText("");
      setWorkflowCandidates([]);
      setWorkflowDocumentId(null);
      setWorkflowStage("");
      clearResumeTask();
      finishTrace("研发文件、论文和知识产权材料已完成闭环");
      setChatMessages((messages) => [...messages, { role: "assistant", content: "Workflow 已完成：研发文件已入库，候选论文已审核入库，知识产权申报材料初稿已生成。" }]);
    } catch (error) {
      setWorkflowStage("");
      finishTrace(error instanceof Error ? error.message : "审核转化失败", true);
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
    const skillRunId = startSkillRun("知识产权生成 Skill", `${sourceRefs.length} 份来源资料 · ${materialTitle}`);
    setActiveDraft(null);
    if (!reasoningTrace.some((step) => step.status === "active")) startTrace([["读取资料", `读取 ${sourceRefs.length} 份已入库资料`], ["提炼创新点", "识别技术问题、技术方案和可保护特征"], ["组织材料", "按技术交底书结构组织章节和权利要求建议"], ["质量校验", "标记待补充信息，检查证据与结论边界"]]);
    setGenerationStep("正在读取已入库资料…");
    const stepTimer = window.setInterval(() => setGenerationStep((current) => current === "正在读取已入库资料…" ? "正在提炼创新点与技术方案…" : current === "正在提炼创新点与技术方案…" ? "正在组织权利要求结构…" : "正在校验格式与待确认事项…"), 1100);
    try {
      if (IS_LOCAL_DEMO) {
        if (!k3Ready) throw new Error("K3 本地服务未启动，请先运行 npm run k3");
        advanceTrace(1);
        const context = await api<{ sourceText: string }>("/api/source-context", { method: "POST", body: JSON.stringify({ sources: sourceRefs }) });
        advanceTrace(2, `已读取 ${context.sourceText.length.toLocaleString()} 个字符的证据`);
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
        finishTrace("材料初稿已生成，可进入人工复核");
        finishSkillRun(skillRunId, "已生成技术交底书结构、摘要和权利要求建议");
        notify("K3 已生成知识产权材料初稿");
        return;
      }
      advanceTrace(1);
      const data = await api<{ draft: Draft }>("/api/ip-drafts", { method: "POST", body: JSON.stringify({ title: materialTitle, sources: sourceRefs, groupName: draftGroup, model: modelChoice, speed: speedChoice, skillContext: enabledSkillContext() }) });
      advanceTrace(2, `已生成 ${data.draft.title}`);
      setActiveDraft(data.draft);
      finishTrace("材料初稿已生成，可进入人工复核");
      finishSkillRun(skillRunId, `已生成材料：${data.draft.title}`);
      notify("知识产权材料初稿已生成");
      await refresh();
    } catch (error) {
      finishSkillRun(skillRunId, error instanceof Error ? error.message : "知识产权生成 Skill 失败", true);
      finishTrace(error instanceof Error ? error.message : "生成失败", true);
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

  function downloadDraftWord(draft: Draft) {
    const html = `<html><head><meta charset="utf-8"><title>${escapeHtml(draft.title)}</title></head><body><h1>${escapeHtml(draft.title)}</h1><p>审核阶段：${stageLabel(draftStages[draft.id] || "ai_draft")}</p><pre style="white-space:pre-wrap;font-family:Microsoft YaHei, sans-serif;line-height:1.7">${escapeHtml(draft.markdown)}</pre></body></html>`;
    const blob = new Blob([html], { type: "application/msword;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${draft.title}.doc`;
    link.click();
    URL.revokeObjectURL(url);
    notify("已导出 Word 兼容文档");
  }

  function printDraft(draft: Draft) {
    const printWindow = window.open("", "_blank", "noopener,noreferrer,width=960,height=720");
    if (!printWindow) return notify("浏览器阻止了打印窗口，请允许弹窗后重试");
    printWindow.document.write(`<html><head><title>${escapeHtml(draft.title)}</title><style>body{font-family:Microsoft YaHei,sans-serif;padding:40px;line-height:1.8;color:#17202a}pre{white-space:pre-wrap;font:inherit}</style></head><body><h1>${escapeHtml(draft.title)}</h1><p>审核阶段：${stageLabel(draftStages[draft.id] || "ai_draft")}</p><pre>${escapeHtml(draft.markdown)}</pre><script>window.onload=()=>window.print();</script></body></html>`);
    printWindow.document.close();
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
  const todoItems = useMemo(() => [
    pendingPapers.length ? { key: "review", label: "论文待审核", detail: `${pendingPapers.length} 篇论文等待人工确认`, action: "去审核" } : null,
    workflowPlan ? { key: "plan", label: "Workflow Plan 待确认", detail: workflowPlan.summary, action: "查看计划" } : null,
    resumeTask ? { key: "resume", label: "继续上次研发任务", detail: `${resumeTask.fileName} · ${resumeTask.stage}`, action: "继续任务" } : null,
    drafts.length ? { key: "draft", label: "最近生成材料", detail: `${drafts[0]?.title || "知识产权材料"} · ${stageLabel(draftStages[drafts[0]?.id] || "ai_draft")}`, action: "查看材料" } : null,
  ].filter(Boolean) as Array<{ key: string; label: string; detail: string; action: string }>, [draftStages, drafts, pendingPapers, resumeTask, workflowPlan]);

  const pageTitle = view === "dashboard" ? (aiFocus ? "AI 工作台" : "任务中心") : ({ discover: "论文雷达", review: "审核中心", library: "资源库", ip: "成果材料" } as Record<Exclude<View, "dashboard">, string>)[view];
  const quickPrompts = view === "discover"
    ? ["分析当前论文结果", "筛选最相关的 10 篇", "找出与当前研发方向最接近的论文"]
    : view === "library"
      ? ["总结当前资源库", "找出可以转化为专利的创新点", "查看最近导入的研发文件"]
      : view === "ip"
        ? ["检查当前材料是否完整", "补充权利要求书建议", "优化技术方案和有益效果"]
        : ["如何开始研发知识闭环？", "上传研发文件并制定 Plan", "搜索工业视觉相关论文"];
  const agentSkills = skills.map((skill) => {
    const latestRun = skillRuns.find((run) => run.name === skill.name);
    return [skill.name, latestRun ? `${latestRun.status === "running" ? "执行中" : latestRun.status === "error" ? "失败" : "已完成"} · ${latestRun.output}` : skill.enabled ? "已启用 · 待调用" : "已停用", latestRun?.status === "running" ? "current" : latestRun?.status === "done" ? "done" : latestRun?.status === "error" ? "error" : "idle"] as [string, string, string];
  });
  const agentContextTitle = view === "discover" ? "论文检索任务" : view === "library" ? "研发知识库" : view === "ip" ? "知识产权材料" : "研发知识闭环";

  return (
    <div className={`app-shell preset-${uiPreset} theme-${themePreference}${sidebarCollapsed ? " sidebar-collapsed" : ""}${chatOpen ? " assistant-open" : ""}${chatOpen && chatMinimized ? " assistant-minimized" : ""}`}>
      <aside className={`sidebar${sidebarCollapsed ? " collapsed" : ""}`}>
        <div className="brand"><span>研</span><div><strong>研知 Agent</strong><small>R&D Intelligence</small></div><button className="sidebar-collapse" onClick={() => setSidebarCollapsed((value) => !value)} title={sidebarCollapsed ? "展开导航" : "折叠导航"}>{sidebarCollapsed ? "›" : "‹"}</button></div>
        <nav>
          {[
            ["home", "⌂", "任务中心"],
            ["dashboard", "✦", "AI 工作台"],
            ["discover", "⌕", "论文雷达"],
            ["library", "▤", "资源库"],
            ["ip", "◇", "成果材料"],
          ].map(([key, icon, label]) => (
            <button className={(key === "home" ? view === "dashboard" && !aiFocus : key === "dashboard" ? aiFocus : view === key) ? "active" : ""} key={key} onClick={() => { if (key === "home") { setView("dashboard"); setAIFocus(false); } else if (key === "dashboard") { setView("dashboard"); setAIFocus(true); } else { setView(key as View); setAIFocus(false); } setChatOpen(false); setChatMinimized(false); }}>
              <b>{icon}</b><span>{label}</span>{key === "library" && pendingPapers.length > 0 ? <em>{pendingPapers.length}</em> : null}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom"><button className="settings-launch" onClick={() => setSettingsOpen(true)}><span>⚙</span><em>设置</em></button>{!sidebarCollapsed ? <div className="sidebar-note"><b>AI COPILOT</b><p>在论文、文件和成果材料页面，随时打开右侧 Agent。</p></div> : null}</div>
      </aside>
      <main>
        <header>
          <div className="header-title"><p className="eyebrow">研发知识与成果转化中心</p><h1>{pageTitle}</h1></div>
          <div className="global-search"><span>⌕</span><input value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { setAIFocus(false); setView("discover"); void searchPapers(); } }} placeholder="搜索论文、研发文件或知识产权材料" /><kbd>Ctrl K</kbd></div>
          <div className="top-actions"><div className="project-switcher"><select value={activeProjectId} onChange={(event) => switchProject(Number(event.target.value))}>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select><button onClick={renameProject} title="编辑当前项目">编辑</button></div>{aiFocus ? <button className="focus-back" onClick={() => { setAIFocus(false); setView("dashboard"); }}>← 返回任务中心</button> : null}{!aiFocus ? <button className={`ai-trigger${chatOpen ? " active" : ""}`} onClick={() => { setChatOpen((value) => !value); setChatMinimized(false); }}><span>✦</span> AI 助手</button> : null}<span className={connected ? "live-dot" : "live-dot offline"}>{connected ? "在线" : "离线"}</span><button className="avatar" onClick={() => setCodeInput(accessCode)}>FC</button></div>
        </header>

        {!aiFocus && view === "dashboard" && (
          <>
            <section className="task-center-hero">
              <div><span className="hero-label">当前项目 · {activeProject?.name || "默认研发项目"} <button className="project-inline-add" onClick={() => setProjectModalOpen(true)}>＋新增项目</button></span><h2>今天要推进哪项研发任务？</h2><p>{activeProject?.description || "把论文、研发文件和成果材料集中到一个项目里，Agent 会帮你持续推进。"}</p><div className="hero-actions"><button className="primary" onClick={() => setView("discover")}>搜索论文 <span>→</span></button><button className="chat-launch" onClick={() => { setAIFocus(true); setChatOpen(false); setChatMinimized(false); }}>与 Agent 对话 <span>✦</span></button><button className="secondary" onClick={() => { setView("library"); setTimeout(() => fileRef.current?.click(), 0); }}>导入研发文件</button></div></div>
              <div className="task-center-summary"><div><span>当前闭环</span><strong>{flowSteps.filter(([, , , status]) => status === "done").length}/4</strong><small>个阶段已完成</small></div><div><span>待我处理</span><strong>{todoItems.length}</strong><small>项待办任务</small></div></div>
            </section>
            <section className="task-center-grid">
              <div className="panel task-panel"><div className="panel-head"><div><p className="eyebrow">MY TASKS</p><h3>待我处理</h3></div><span className="count-badge">{todoItems.length}</span></div>{todoItems.length ? <div className="todo-list">{todoItems.map((item) => <button className="todo-item" key={item.key} onClick={() => { if (item.key === "review") { setView("review"); setAIFocus(false); } else if (item.key === "draft") { setView("ip"); setAIFocus(false); } else { setAIFocus(true); } }}><i>{item.key === "review" ? "⌕" : item.key === "draft" ? "◇" : "✦"}</i><span><strong>{item.label}</strong><small>{item.detail}</small></span><b>{item.action} →</b></button>)}</div> : <EmptyState title="暂时没有待处理任务" detail="你可以从搜索论文或导入研发文件开始。" />}</div>
              <div className="panel task-panel"><div className="panel-head"><div><p className="eyebrow">QUICK START</p><h3>快速开始</h3></div></div><div className="quick-start-list"><button onClick={() => setView("discover")}><i>01</i><span><strong>搜索论文</strong><small>从技术主题发现外部研究证据</small></span><b>→</b></button><button onClick={() => { setView("library"); setTimeout(() => fileRef.current?.click(), 0); }}><i>02</i><span><strong>导入研发文件</strong><small>让 Agent 先读懂方案再制定 Plan</small></span><b>→</b></button><button onClick={() => setView("ip")}><i>03</i><span><strong>生成成果材料</strong><small>把已有资料转成可审核的申报初稿</small></span><b>→</b></button></div></div>
            </section>
            <section className="task-center-lower">
              <div className="panel"><div className="panel-head"><div><p className="eyebrow">RECENT ASSETS</p><h3>最近打开</h3></div><button onClick={() => setView("library")}>查看资源库</button></div>{papers.slice(0, 3).map((paper) => <PaperRow paper={paper} key={paper.externalId} />)}{!papers.length && !documents.length ? <EmptyState title="还没有研发资产" detail="搜索论文或导入研发文件后，这里会自动显示。" /> : null}</div>
              <div className="panel flow-panel"><div className="panel-head"><div><p className="eyebrow">WORKFLOW STATUS</p><h3>研发知识闭环</h3></div><button onClick={() => setAIFocus(true)}>打开 AI 专注模式</button></div><div className="compact-flow">{flowSteps.map(([n, t, d, s]) => <div className={`compact-flow-row ${s}`} key={n}><i>{s === "done" ? "✓" : n}</i><span><strong>{t}</strong><small>{d}</small></span><b>{s === "current" ? "进行中" : s === "done" ? "已完成" : "待开始"}</b></div>)}</div></div>
            </section>
          </>
        )}

        {!aiFocus && view === "discover" && (
          <section className="workspace">
            <div className="workspace-head"><div><p className="eyebrow">DUAL-SOURCE DISCOVERY</p><h2>自动搜集论文</h2><p>同时检索 arXiv 与 Semantic Scholar；限流时自动切换 Crossref，并合并重复结果。</p></div><span className="source-pill">双源实时检索</span></div>
            <div className="search-box"><input value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => event.key === "Enter" && void searchPapers()} placeholder="输入技术主题，例如：工业视觉缺陷检测 Agent" /><button className="primary" disabled={loading} onClick={() => void searchPapers()}>{loading ? "正在检索…" : "开始检索"}</button></div>
            {searchWarnings.length ? <div className="warning-box"><strong>检索提示</strong>{searchWarnings.map((warning) => <span key={warning}>{warning}</span>)}</div> : null}
            <div className="result-list">{searchResults.length ? searchResults.map((paper) => <article className="result-card" key={`${paper.source}-${paper.externalId}`}><div className="result-source">{sourceLabel(paper.source)}</div><div><h3>{paper.title}</h3><p className="meta">{paper.authors.slice(0, 3).join(" · ")} · {formatDate(paper.publishedAt)}</p><p className="abstract">{paper.abstract || "暂无摘要"}</p><a href={paper.url} target="_blank" rel="noreferrer">查看原文 ↗</a></div><button onClick={() => void importPaper(paper)}>加入审核</button></article>) : <EmptyState title="输入主题启动双源论文采集" detail="真实结果将在这里显示，并可一键加入审核。" />}</div>
          </section>
        )}

        {!aiFocus && view === "review" && (
          <section className="workspace">
            <div className="workspace-head"><div><p className="eyebrow">HUMAN IN THE LOOP</p><h2>审核后入库</h2><p>保留人工判断，确保知识来源可靠、方向相关、证据可追溯。</p></div><div className="review-summary"><span>{pendingPapers.length} 项待处理</span><label><input type="checkbox" checked={pendingPapers.length > 0 && selectedReviewIds.length === pendingPapers.length} onChange={(event) => setSelectedReviewIds(event.target.checked ? pendingPapers.map((paper) => paper.id!).filter(Boolean) : [])} />全选</label></div></div>
            {selectedReviewIds.length ? <div className="batch-toolbar"><strong>已选择 {selectedReviewIds.length} 篇</strong><button className="primary" disabled={loading} onClick={() => void batchReview("approved")}>批量通过并入库</button><button className="ghost danger" disabled={loading} onClick={() => void batchReview("rejected")}>批量驳回</button><button className="ghost" onClick={() => setSelectedReviewIds([])}>取消选择</button></div> : null}
            <div className="review-grid">{pendingPapers.length ? pendingPapers.map((paper) => <article className={`review-card${selectedReviewIds.includes(paper.id!) ? " selected" : ""}`} key={paper.id}><div className="review-top"><label className="review-check"><input type="checkbox" checked={selectedReviewIds.includes(paper.id!)} onChange={(event) => setSelectedReviewIds((ids) => event.target.checked ? [...ids, paper.id!] : ids.filter((id) => id !== paper.id))} />选择</label><span>{sourceLabel(paper.source)}</span><small>{formatDate(paper.publishedAt)}</small></div><h3>{paper.title}</h3><p>{paper.abstract || "暂无摘要"}</p><div className="review-actions"><button className="ghost danger" onClick={() => void reviewPaper(paper.id!, "rejected")}>驳回</button><button className="primary" onClick={() => void reviewPaper(paper.id!, "approved")}>通过并入库</button></div></article>) : <EmptyState title="待审核任务已处理完毕" detail="从论文雷达加入的新论文会出现在这里。" />}</div>
          </section>
        )}

        {!aiFocus && view === "library" && (
          <section className="workspace">
            <div className="workspace-head"><div><p className="eyebrow">R&D KNOWLEDGE BASE</p><h2>研发知识库</h2><p>论文与研发文档统一沉淀，为成果转化提供可信上下文。</p></div><><input ref={fileRef} hidden type="file" accept=".pdf,.docx" onChange={(event) => void uploadDocument(event.target.files?.[0])} /><button className="primary" disabled={loading} onClick={() => fileRef.current?.click()}>导入 PDF / DOCX</button></></div>
            <div className="library-toolbar"><label>当前分组<select value={libraryGroup} onChange={(event) => setLibraryGroup(event.target.value)}><option>全部分组</option>{allGroups.map((group) => <option key={group}>{group}</option>)}</select></label><button className="ghost" onClick={createCustomGroup}>+ 新建分组</button><button className="ghost" onClick={() => setView("review")}>待审核 {pendingPapers.length}</button><span>已入库论文 {approvedPapers.length} 篇</span></div>
            <div className="library-columns"><div><h3>已入库论文 <span>{visibleApprovedPapers.length}</span></h3>{visibleApprovedPapers.length ? visibleApprovedPapers.map((paper) => <div className="library-item" key={paper.externalId}><PaperRow paper={paper} onPreview={() => previewPaper(paper)} /><div className="item-actions"><select value={paper.groupName || "未分类"} onChange={(event) => void changeGroup("paper", paper.id!, event.target.value)}>{allGroups.map((group) => <option key={group}>{group}</option>)}</select><button className="ghost" onClick={() => previewPaper(paper)}>在线预览</button><button className="ghost danger" onClick={() => void deletePaper(paper.id!, paper.title)}>删除</button></div></div>) : <EmptyState title="暂无已入库论文" detail="先在审核中心通过一篇论文。" />}</div><div><h3>研发文件 <span>{visibleDocuments.length}</span></h3>{visibleDocuments.length ? visibleDocuments.map((doc) => <div className="doc-row" key={doc.id}><i>DOC</i><div><strong>{doc.name}</strong><p>{Math.round(doc.size / 1024)} KB · {formatDate(doc.createdAt)} · {doc.groupName || "未分类"}</p></div><select value={doc.groupName || "未分类"} onChange={(event) => void changeGroup("document", doc.id, event.target.value)}>{allGroups.map((group) => <option key={group}>{group}</option>)}</select><button className="ghost" onClick={() => void previewDocument(doc.id)}>预览</button><button className="ghost danger" onClick={() => void deleteDocument(doc.id, doc.name)}>删除</button></div>) : <EmptyState title="尚未导入研发文件" detail="文件在浏览器本地解析，原文件不会上传。" />}</div></div>
          </section>
        )}

        {!aiFocus && view === "ip" && (
          <section className="workspace">
            <div className="workspace-head"><div><p className="eyebrow">IP DRAFTING AGENT</p><h2>知识产权材料生成</h2><p>基于选定研发资料，生成技术交底书、摘要和权利要求初稿。</p></div><span className="source-pill">{IS_LOCAL_DEMO ? (k3Ready ? "本地 K3 · 已连接" : "本地 K3 · 未连接") : "GLM-5.3 · 自动容错"}</span></div>
            <div className="ip-layout">
              <div className="source-selector"><label>材料名称<input value={draftTitle} onChange={(event) => setDraftTitle(event.target.value)} /></label><label>材料分组<select value={draftGroup} onChange={(event) => setDraftGroup(event.target.value)}>{GROUPS.map((group) => <option key={group}>{group}</option>)}</select></label><label>接入模型<select value={modelChoice} onChange={(event) => setModelChoice(event.target.value as ModelChoice)}><option value="auto">自动选择（GLM 优先）</option><option value="glm-5.3">智谱 GLM-5.3</option><option value="qwen3">Workers AI Qwen3</option>{IS_LOCAL_DEMO ? <option value="k3">本机 K3</option> : null}</select></label><label>生成速度<select value={speedChoice} onChange={(event) => setSpeedChoice(event.target.value as SpeedChoice)}><option value="fast">快速：较短初稿</option><option value="balanced">均衡：推荐</option><option value="deep">深度：更完整</option></select></label><h3>选择依据材料</h3>
                {[...approvedPapers.map((paper) => ({ ref: `paper:${paper.id}`, name: paper.title, type: "论文" })), ...documents.map((doc) => ({ ref: `document:${doc.id}`, name: doc.name, type: "研发文件" }))].map((item) => <label className="source-option" key={item.ref}><input type="checkbox" checked={selectedSources.includes(item.ref)} onChange={() => toggleSource(item.ref)} /><span><b>{item.type}</b><strong>{item.name}</strong></span></label>)}
                {!approvedPapers.length && !documents.length ? <EmptyState title="暂无可用资料" detail="先审核入库论文或导入研发文件。" /> : null}
                <button className="primary generate" disabled={loading} onClick={() => void generateDraft()}>{loading ? "Agent 正在生成…" : "生成申报材料"}</button>{loading ? <div className="generation-progress"><div className="progress-track"><i></i></div><strong>{generationStep}</strong><small>展示的是可审计的处理阶段，不暴露模型内部隐式思维。</small></div> : null}
              </div>
              <div className="draft-preview">{activeDraft ? <><div className="draft-head"><div><small>AI GENERATED DRAFT · {stageLabel(draftStages[activeDraft.id] || "ai_draft")}</small><h3>{activeDraft.title}</h3></div><div className="draft-export-actions"><button onClick={() => downloadDraft(activeDraft)}>Markdown</button><button onClick={() => downloadDraftWord(activeDraft)}>Word</button><button onClick={() => printDraft(activeDraft)}>PDF / 打印</button></div></div><div className="draft-review-bar"><label>审核阶段<select value={draftStages[activeDraft.id] || "ai_draft"} onChange={(event) => { const stage = event.target.value as DraftStage; setDraftStages((stages) => ({ ...stages, [activeDraft.id]: stage })); notify(`材料已进入：${stageLabel(stage)}`); }}><option value="ai_draft">AI 初稿</option><option value="rd_review">研发负责人审核</option><option value="ip_review">知识产权审核</option><option value="agency">代理机构修改</option><option value="final">最终定稿</option></select></label><span>{DRAFT_STAGES.find(([value]) => value === (draftStages[activeDraft.id] || "ai_draft"))?.[2]}</span></div><pre>{activeDraft.markdown}</pre><p className="disclaimer">AI 初稿仅供内部研讨；阶段变更保存在当前浏览器，正式版本仍需由知识产权专业人员审核。</p></> : <EmptyState title="申报材料预览" detail="选择左侧资料后启动 Agent，生成结果将在此展示。" />}</div>
            </div>
            {drafts.length > 0 ? <div className="history"><div className="history-head"><div><h3>最近生成</h3><small>材料审核阶段与版本导出</small></div><select value={draftGroupFilter} onChange={(event) => setDraftGroupFilter(event.target.value)}><option>全部分组</option>{GROUPS.map((group) => <option key={group}>{group}</option>)}</select></div>{visibleDrafts.slice(0, 8).map((draft) => <div className="history-row" key={draft.id}><button onClick={() => setActiveDraft(draft)}><span>{draft.title}</span><small>{draft.groupName || "未分类"} · {stageLabel(draftStages[draft.id] || "ai_draft")} · {formatDate(draft.createdAt)}</small></button><select value={draftStages[draft.id] || "ai_draft"} onChange={(event) => setDraftStages((stages) => ({ ...stages, [draft.id]: event.target.value as DraftStage }))}><option value="ai_draft">AI 初稿</option><option value="rd_review">研发审核</option><option value="ip_review">知识产权审核</option><option value="agency">代理机构</option><option value="final">最终定稿</option></select><select value={draft.groupName || "未分类"} onChange={(event) => void changeGroup("draft", draft.id, event.target.value)}>{GROUPS.map((group) => <option key={group}>{group}</option>)}</select><button className="ghost danger compact-delete" onClick={() => void deleteDraft(draft.id, draft.title)}>删除</button></div>)}</div> : null}
          </section>
        )}

        {aiFocus && (
          <section className="agent-workspace">
            <div className="agent-chat-column">
              <div className="agent-welcome"><p className="eyebrow">RESEARCH OPERATING SYSTEM</p><h2>你好，我是研知 Agent</h2><p>从一份研发文件、一组论文或一个问题开始，我会帮你规划任务、调用技能并沉淀成果。</p>{resumeTask ? <div className="resume-banner"><span>↻</span><div><strong>发现上次未完成任务</strong><small>{resumeTask.fileName} · {resumeTask.stage}</small></div><button onClick={() => chatFileRef.current?.click()}>重新导入继续</button></div> : null}<div className="agent-quick-grid">{["上传研发文件并制定 Plan", "搜索当前技术方向论文", "分析研发文件中的创新点", "生成发明专利技术交底书"].map((prompt) => <button key={prompt} onClick={() => prompt.startsWith("上传") ? chatFileRef.current?.click() : void sendChat(prompt)}><span>✦</span>{prompt}<b>→</b></button>)}</div></div>
              <div className="agent-message-list">{chatMessages.length ? chatMessages.map((item, index) => <div className={`chat-bubble ${item.role}`} key={`${item.role}-${index}`}><p>{item.content}</p>{item.model ? <small>{item.model}</small> : null}</div>) : <div className="agent-empty-hint"><span>⌁</span><strong>从对话开始你的研发任务</strong><p>你可以直接上传 PDF / DOCX，或告诉我你想查找的技术方向。</p></div>}{workflowStage ? <div className="workflow-status">{workflowStage}</div> : null}{workflowPlan ? <div className="workflow-card agent-plan-card"><div className="agent-card-title"><strong>Agent 执行计划</strong><span>{workflowPlan.model || "自动模型"}</span><button className="ghost" onClick={openPlanEditor}>编辑 Plan</button></div><p>{workflowPlan.summary}</p><div className="plan-preview-grid"><small><b>检索主题</b>{workflowPlan.searchQueries.join("；")}</small><small><b>筛选标准</b>{workflowPlan.screeningCriteria.join("；")}</small><small><b>分析依据</b>{workflowPlan.analysisSummary.join("；")}</small><small><b>执行步骤</b>{workflowPlan.steps.join(" → ")}</small></div>{workflowPlan.evidenceMap.slice(0, 3).map((item) => <div className="evidence-map" key={item.evidence}><b>研发证据：</b>{item.evidence}<br/><b>论文方向：</b>{item.researchDirection}<br/><b>转化价值：</b>{item.ipValue}</div>)}{!workflowCandidates.length ? <div className="workflow-actions"><button className="primary" disabled={chatBusy} onClick={() => void confirmFileWorkflow()}>确认 Plan，开始执行</button><button className="ghost" onClick={() => { setWorkflowPlan(null); setWorkflowFile(null); setWorkflowText(""); }}>取消</button></div> : <div className="workflow-result">已发现 {workflowCandidates.length} 篇候选论文，等待确认入库。</div>}</div> : null}{chatBusy ? <div className="chat-bubble assistant typing">Agent 正在调用 Skill 并整理结果…</div> : null}</div>
              <div className="agent-composer"><div className="composer-tools"><input ref={chatFileRef} hidden type="file" accept=".pdf,.docx" onChange={(event) => void runFileWorkflow(event.target.files?.[0])} /><button className="chat-upload" disabled={chatBusy} onClick={() => chatFileRef.current?.click()}>＋ 文件</button><select value={modelChoice} onChange={(event) => setModelChoice(event.target.value as ModelChoice)}><option value="auto">自动模型</option><option value="glm-5.3">GLM-5.3</option><option value="qwen3">Qwen3</option>{IS_LOCAL_DEMO ? <option value="k3">K3</option> : null}</select><select value={speedChoice} onChange={(event) => setSpeedChoice(event.target.value as SpeedChoice)}><option value="fast">快速</option><option value="balanced">均衡</option><option value="deep">深度</option></select></div><div className="composer-input"><textarea value={chatInput} onChange={(event) => setChatInput(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void sendChat(); } }} placeholder="描述你的研发任务，或询问当前项目…" rows={3} /><button className="primary" disabled={chatBusy || !chatInput.trim()} onClick={() => void sendChat()}>发送 ↑</button></div><small>Agent 会在执行关键动作前征求确认，重要结果均可追溯。</small></div>
            </div>
            <aside className="agent-context-column">
              <div className="context-section"><div className="context-title"><span>当前项目</span><button onClick={renameProject}>编辑</button></div><strong>{activeProject?.name || "默认研发项目"}</strong><p>{activeProject?.description || "尚未填写项目说明"}</p></div>
              <div className="context-section"><div className="context-title"><span>执行计划</span><div className="context-title-actions"><b>{workflowStage || (workflowPlan ? "待确认" : "等待输入")}</b>{workflowPlan ? <button onClick={openPlanEditor}>编辑</button> : null}</div></div><div className="mini-timeline"><div className="mini-step active"><i>1</i><span>理解任务</span></div><div className={`mini-step ${workflowPlan ? "active" : ""}`}><i>2</i><span>制定 Plan</span></div><div className={`mini-step ${searchResults.length ? "active" : ""}`}><i>3</i><span>检索与审核</span></div><div className={`mini-step ${activeDraft ? "active" : ""}`}><i>4</i><span>沉淀成果</span></div></div>{workflowPlan ? <div className="plan-context-details"><strong>{workflowPlan.summary}</strong><small>检索主题：{workflowPlan.searchQueries.join("；")}</small><small>筛选标准：{workflowPlan.screeningCriteria.join("；")}</small><small>分析依据：{workflowPlan.analysisSummary.join("；")}</small><small>执行步骤：{workflowPlan.steps.join(" → ")}</small><small>证据映射：{workflowPlan.evidenceMap.length} 条</small></div> : <p className="context-empty">上传研发文件后，Agent 会在这里生成可编辑的完整计划。</p>}</div>
              <div className="context-section"><div className="context-title"><span>Skill 调用</span><button onClick={() => setSkillLibraryOpen(true)}>管理文档</button></div><div className="skill-list">{agentSkills.map(([name, status, state]) => { const skill = skills.find((item) => item.name === name); const latestRun = skillRuns.find((run) => run.name === name); return <div className="skill-item" key={name}><button className="skill-row" onClick={() => setSkillDetail(skillDetail === name ? null : name)}><i className={state}>{state === "done" ? "✓" : state === "error" ? "!" : state === "current" ? "·" : "○"}</i><span><strong>{name}</strong><small>{status}</small></span><b>{skillDetail === name ? "⌃" : "⌄"}</b></button>{skillDetail === name ? <div className="skill-detail"><p><strong>文档：</strong>{skill?.source === "uploaded" ? "用户上传 Markdown" : "内置 Markdown"} · {skill?.enabled ? "已启用" : "已停用"}</p><p><strong>输入：</strong>{latestRun?.input || "等待实际任务输入"}</p><p><strong>输出：</strong>{latestRun?.output || skill?.description || "暂无调用记录"}</p><div><small>模型：{aiConfig.enabled ? aiConfig.model : "平台默认"}{latestRun?.duration ? ` · ${latestRun.duration}ms` : ""}</small><button className="ghost" onClick={() => void sendChat(`重新执行${name}，并严格按照该 Skill 的 Markdown 规则输出结果`)}>重新执行</button></div></div> : null}</div>; })}</div>{skillRuns.length ? <div className="skill-run-log"><strong>最近实际调用</strong>{skillRuns.slice(0, 3).map((run) => <small key={run.id}>● {run.name} · {run.status === "running" ? "执行中" : run.status === "done" ? "已完成" : "失败"} · {run.output}</small>)}</div> : <p className="context-empty">执行任务后，这里会显示实际调用的 Skill、输入、输出和耗时。</p>}</div>
              <div className="context-section reasoning-section"><div className="context-title"><span>AI 分析步骤</span><b>{reasoningTrace.some((step) => step.status === "active") ? "进行中" : "可追溯"}</b></div><ReasoningTrace steps={reasoningTrace} /></div>
              <div className="context-section"><div className="context-title"><span>证据链</span><b>{workflowPlan?.evidenceMap.length || 0} 条</b></div>{workflowPlan?.evidenceMap.length ? workflowPlan.evidenceMap.slice(0, 2).map((item) => <div className="context-evidence" key={item.evidence}><strong>{item.evidence}</strong><span>→ {item.researchDirection}</span></div>) : <p className="context-empty">上传研发文件或选中论文后，Agent 会在这里展示证据关联。</p>}</div>
              <div className="context-section"><div className="context-title"><span>任务产物</span><button onClick={() => { setAIFocus(false); setView("library"); }}>查看资源库</button></div><div className="artifact-list">{workflowFile ? <button onClick={() => notify(`当前文件：${workflowFile.name}`)}><i>PDF</i><span>{workflowFile.name}<small>研发文件</small></span></button> : null}{workflowCandidates.length ? <button onClick={() => { setAIFocus(false); setView("discover"); }}><i>论文</i><span>{workflowCandidates.length} 篇候选论文<small>Agent 初筛结果</small></span></button> : null}{activeDraft ? <button onClick={() => { setAIFocus(false); setView("ip"); }}><i>IP</i><span>{activeDraft.title}<small>知识产权材料</small></span></button> : null}{!workflowFile && !workflowCandidates.length && !activeDraft ? <p className="context-empty">完成任务后，文件、论文和材料会出现在这里。</p> : null}</div></div>
            </aside>
          </section>
        )}
      </main>

      {!aiFocus && chatOpen ? <aside className={`assistant-panel${chatMinimized ? " minimized" : ""}`}>
        <div className="assistant-panel-head"><div><p className="eyebrow">AI COPILOT</p><strong>研知 Agent</strong><small>当前页面：{pageTitle} · {activeProject?.name || "默认项目"}</small></div><div className="chat-window-actions"><button title={chatMinimized ? "展开 AI 面板" : "折叠 AI 面板"} onClick={toggleChatMinimized}>{chatMinimized ? "‹" : "›"}</button><button title="关闭 AI 面板" onClick={() => setChatOpen(false)}>×</button></div></div>
        {!chatMinimized ? <>
          <div className="assistant-context"><span>当前上下文</span><strong>{view === "discover" ? `论文检索结果 ${searchResults.length} 篇` : view === "library" ? `资源库 ${approvedPapers.length + documents.length} 项` : view === "ip" ? "成果材料工作区" : "研发知识工作台"}</strong><small>Agent 会根据当前页面和项目状态给出建议</small></div>
          <div className="assistant-quick"><span>快捷操作</span><div>{quickPrompts.map((prompt) => <button key={prompt} disabled={chatBusy} onClick={() => void sendChat(prompt)}>✦ {prompt}</button>)}</div></div><div className="assistant-trace"><div className="assistant-trace-title"><span>AI 分析步骤</span><small>展示依据摘要，不展示隐式原始思维链</small></div><ReasoningTrace steps={reasoningTrace} compact /></div>
          <div className="chat-body">{chatMessages.length ? chatMessages.map((item, index) => <div className={`chat-bubble ${item.role}`} key={`${item.role}-${index}`}><p>{item.content}</p>{item.model ? <small>{item.model}</small> : null}</div>) : <div className="chat-welcome"><strong>你好，我是研知 Agent</strong><p>我会围绕当前页面协助你搜索论文、查看研发文件、审核知识和生成成果材料。</p><div className="welcome-hint">试试说：“帮我分析当前页面”</div></div>}{workflowStage ? <div className="workflow-status">{workflowStage}</div> : null}{workflowPlan ? <div className="workflow-card"><strong>Workflow Plan</strong><p>{workflowPlan.summary}</p><small>检索主题：{workflowPlan.searchQueries.join("；")}</small><ul>{workflowPlan.steps.map((step) => <li key={step}>{step}</li>)}</ul><small>分析摘要：{workflowPlan.analysisSummary.join("；")}</small><small>筛选标准：{workflowPlan.screeningCriteria.join("；")}</small>{workflowPlan.evidenceMap.slice(0, 3).map((item) => <div className="evidence-map" key={item.evidence}><b>研发证据：</b>{item.evidence}<br/><b>论文方向：</b>{item.researchDirection}<br/><b>转化价值：</b>{item.ipValue}</div>)}{!workflowCandidates.length ? <div className="workflow-actions"><button className="primary" disabled={chatBusy} onClick={() => void confirmFileWorkflow()}>确认 Plan，开始执行</button><button className="ghost" onClick={() => { setWorkflowPlan(null); setWorkflowFile(null); setWorkflowText(""); }}>取消</button></div> : <><p className="workflow-result">Agent 初筛保留 {workflowCandidates.length} 篇候选论文。</p><div className="workflow-actions"><button className="primary" disabled={chatBusy} onClick={() => void approveAndConvertWorkflow()}>确认入库并完成转化</button><button className="ghost" onClick={() => setWorkflowCandidates([])}>重新确认</button></div></>}</div> : null}{chatBusy ? <div className="chat-bubble assistant typing">Agent 正在处理文件或整理建议…</div> : null}</div>
          <div className="chat-compose"><input ref={chatFileRef} hidden type="file" accept=".pdf,.docx" onChange={(event) => void runFileWorkflow(event.target.files?.[0])} /><button className="chat-upload" disabled={chatBusy} onClick={() => chatFileRef.current?.click()}>导入文件</button><textarea value={chatInput} onChange={(event) => setChatInput(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void sendChat(); } }} placeholder="询问当前页面的内容…" rows={2} /><button className="primary" disabled={chatBusy || !chatInput.trim()} onClick={() => void sendChat()}>发送</button></div>
        </> : <button className="assistant-minimized-label" onClick={toggleChatMinimized}>展开 AI 助手</button>}
      </aside> : null}
      {preview ? <div className="modal-backdrop" onClick={() => setPreview(null)}><div className="preview-modal" onClick={(event) => event.stopPropagation()}><div className="preview-head"><div><p className="eyebrow">ONLINE PREVIEW</p><h2>{preview.title}</h2></div><button className="ghost" onClick={() => setPreview(null)}>关闭</button></div>{preview.kind === "paper" && preview.url ? <a href={preview.url} target="_blank" rel="noreferrer">打开原文 ↗</a> : null}<pre>{preview.content}</pre></div></div> : null}
      {settingsOpen ? <div className="settings-backdrop" onClick={() => setSettingsOpen(false)}><section className="settings-modal" onClick={(event) => event.stopPropagation()}><div className="settings-head"><div><p className="eyebrow">WORKSPACE SETTINGS</p><h2>工作台设置</h2><p>切换界面风格、主题和 Agent 接入方式。</p></div><button className="settings-close" onClick={() => setSettingsOpen(false)}>×</button></div><div className="settings-content"><section className="settings-section"><h3>界面风格</h3><div className="preset-grid"><button className={uiPreset === "classic" ? "selected" : ""} onClick={() => choosePreset("classic")}><span className="preset-preview classic-preview"><i></i><b></b></span><strong>经典研知</strong><small>原始深绿侧栏与研发后台风格</small></button><button className={uiPreset === "cloudflare" ? "selected" : ""} onClick={() => choosePreset("cloudflare")}><span className="preset-preview cloudflare-preview"><i></i><b></b><em></em></span><strong>Cloudflare 风格</strong><small>白色 Dashboard + 橙色 AI 入口</small></button><button className={uiPreset === "gpt" ? "selected" : ""} onClick={() => choosePreset("gpt")}><span className="preset-preview gpt-preview"><i></i><b></b></span><strong>GPT 工作台</strong><small>中间对话 + 右侧上下文和任务</small></button></div></section><section className="settings-section"><h3>外观主题</h3><div className="theme-options">{([["system", "跟随系统", "自动适配白天/夜晚"], ["light", "浅色模式", "清晰的研发后台界面"], ["dark", "深色模式", "适合夜间长时间使用"]] as Array<[ThemePreference, string, string]>).map(([value, label, detail]) => <button className={themePreference === value ? "selected" : ""} key={value} onClick={() => setThemePreference(value)}><span>{value === "system" ? "◐" : value === "light" ? "☼" : "☾"}</span><strong>{label}</strong><small>{detail}</small></button>)}</div></section><section className="settings-section"><div className="settings-section-title"><div><h3>AI 模型接入</h3><p>可配置自己的 GLM 或 OpenAI 兼容接口。</p></div><label className="switch-row"><input type="checkbox" checked={aiConfig.enabled} onChange={(event) => setAIConfig((config) => ({ ...config, enabled: event.target.checked }))} /><span>启用自定义配置</span></label></div><div className="settings-form"><label>服务类型<select value={aiConfig.provider} onChange={(event) => setAIConfig((config) => ({ ...config, provider: event.target.value as AIProvider }))}><option value="glm">智谱 GLM 官方接口</option><option value="openai-compatible">OpenAI 兼容接口</option><option value="k3">本地 K3 / 自定义接口</option></select></label><label>接口地址<input value={aiConfig.endpoint} onChange={(event) => setAIConfig((config) => ({ ...config, endpoint: event.target.value }))} placeholder="https://open.bigmodel.cn/api/paas/v4" /></label><label>模型名称<input value={aiConfig.model} onChange={(event) => setAIConfig((config) => ({ ...config, model: event.target.value }))} placeholder="glm-5.3" /></label><label>API Key<input type="password" value={aiConfig.apiKey} onChange={(event) => setAIConfig((config) => ({ ...config, apiKey: event.target.value }))} placeholder="输入你自己的 API Key" /></label></div><label className="remember-key"><input type="checkbox" checked={aiConfig.remember} onChange={(event) => setAIConfig((config) => ({ ...config, remember: event.target.checked }))} />在本机浏览器保存配置（不写入代码）</label><p className="settings-security">安全提示：启用后，API Key 会随 AI 请求发送到当前项目 Worker。演示环境建议使用专用低额度 Key，不要填写生产主 Key。</p></section></div><div className="settings-actions"><button className="ghost" onClick={() => setSettingsOpen(false)}>取消</button><button className="primary" onClick={saveAISettings}>保存设置</button></div></section></div> : null}
      {projectModalOpen ? <div className="modal-backdrop" onClick={() => setProjectModalOpen(false)}><div className="project-modal" onClick={(event) => event.stopPropagation()}><p className="eyebrow">NEW PROJECT</p><h2>新增研发项目</h2><p>项目之间的论文、研发文件、审核任务和申报材料相互隔离。</p><label>项目名称<input autoFocus value={projectForm.name} onChange={(event) => setProjectForm((form) => ({ ...form, name: event.target.value }))} placeholder="例如：工业视觉缺陷检测" /></label><label>项目介绍<textarea value={projectForm.description} onChange={(event) => setProjectForm((form) => ({ ...form, description: event.target.value }))} placeholder="描述研发目标、范围或负责人关注点" rows={4} /></label><div className="project-modal-actions"><button className="ghost" onClick={() => setProjectModalOpen(false)}>取消</button><button className="primary" onClick={() => void saveProject()}>创建并进入</button></div></div></div> : null}
      {!accessCode || codeInput ? <div className="modal-backdrop"><div className="access-modal"><span className="seal">研</span><p className="eyebrow">SECURE DEMO</p><h2>进入研知 Agent</h2><p>请输入演示访问码。它只保存在当前浏览器会话中，用于保护 AI 调用额度。</p><input autoFocus value={codeInput} onChange={(event) => { setCodeInput(event.target.value); setAuthError(""); }} onKeyDown={(event) => event.key === "Enter" && void unlock()} placeholder="演示访问码" type="password" />{authError ? <div className="form-error">{authError}</div> : null}<button className="primary" disabled={loading} onClick={() => void unlock()}>{loading ? "正在验证…" : "进入工作台"}</button>{accessCode ? <button className="text-button" onClick={() => setCodeInput("")}>取消</button> : null}</div></div> : null}
      {settingsOpen ? <button className="settings-feishu-tab" onClick={() => setFeishuDemoOpen(true)}>⚙ 集成中心 · 飞书</button> : null}
      {feishuDemoOpen ? <div className="modal-backdrop" onClick={() => setFeishuDemoOpen(false)}><section className="feishu-modal" onClick={(event) => event.stopPropagation()}><div className="settings-head"><div><p className="eyebrow">INTEGRATION CENTER · DEMO</p><h2>飞书研发协同</h2><p>演示模块：展示未来如何连接飞书文档、群通知和审批流。</p></div><button className="settings-close" onClick={() => setFeishuDemoOpen(false)}>×</button></div><div className="feishu-status"><span className="demo-badge">演示模式</span><strong>未连接真实飞书应用</strong><small>当前配置只保存在浏览器本地，不会发送到任何服务。</small></div><div className="feishu-capability-grid"><div>✓ 飞书文档同步<small>研发文件进入当前项目资源库</small></div><div>✓ Agent 任务通知<small>Plan、失败和完成结果提醒</small></div><div>✓ 审批提醒<small>论文审核与材料定稿提醒负责人</small></div><div>✓ 组织权限映射<small>按飞书成员同步项目访问范围</small></div></div><div className="settings-form feishu-form"><label>App ID<input value={feishuConfig.appId} onChange={(event) => setFeishuConfig((config) => ({ ...config, appId: event.target.value }))} placeholder="cli_xxxxxxxxx" /></label><label>App Secret<input type="password" value={feishuConfig.appSecret} onChange={(event) => setFeishuConfig((config) => ({ ...config, appSecret: event.target.value }))} placeholder="演示占位，不会提交" /></label><label>租户 / 团队<input value={feishuConfig.tenant} onChange={(event) => setFeishuConfig((config) => ({ ...config, tenant: event.target.value }))} placeholder="研发中心" /></label><label>默认同步空间<input value={feishuConfig.space} onChange={(event) => setFeishuConfig((config) => ({ ...config, space: event.target.value }))} /></label></div><div className="feishu-switches"><label><input type="checkbox" checked={feishuConfig.syncFiles} onChange={(event) => setFeishuConfig((config) => ({ ...config, syncFiles: event.target.checked }))} />同步研发文件</label><label><input type="checkbox" checked={feishuConfig.notify} onChange={(event) => setFeishuConfig((config) => ({ ...config, notify: event.target.checked }))} />发送任务通知</label><label><input type="checkbox" checked={feishuConfig.approval} onChange={(event) => setFeishuConfig((config) => ({ ...config, approval: event.target.checked }))} />发送审批提醒</label></div><div className="feishu-flow"><span>飞书研发群</span><i>→</i><span>上传文件</span><i>→</i><span>Agent Plan</span><i>→</i><span>负责人确认</span><i>→</i><span>材料审批</span></div><div className="settings-actions"><button className="ghost" onClick={() => setFeishuDemoOpen(false)}>关闭</button><button className="primary" onClick={() => { setFeishuDemoOpen(false); notify("已保存飞书演示配置；真实接入需配置飞书应用凭据"); }}>保存演示配置</button></div></section></div> : null}
      {planDraft ? <PlanEditorModal plan={planDraft} onChange={setPlanDraft} onSave={savePlanEditor} onClose={() => setPlanDraft(null)} /> : null}
      {skillLibraryOpen ? <SkillLibraryModal skills={skills} onClose={() => setSkillLibraryOpen(false)} onToggle={(id) => setSkills((items) => items.map((item) => item.id === id ? { ...item, enabled: !item.enabled } : item))} onEdit={openSkillEditor} onDelete={(id) => setSkills((items) => items.filter((item) => item.id !== id))} onUpload={(file) => void importSkillFile(file)} onCreate={() => openSkillEditor()} /> : null}
      {skillEditor ? <SkillEditorModal skill={skillEditor} onChange={setSkillEditor} onClose={() => setSkillEditor(null)} onSave={() => saveSkill(skillEditor)} /> : null}
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

function ReasoningTrace({ steps, compact = false }: { steps: TraceStep[]; compact?: boolean }) {
  if (!steps.length) return <p className="trace-empty">执行任务后，这里会显示 Agent 的分析依据和决策步骤。</p>;
  return <div className={`reasoning-trace${compact ? " compact" : ""}`}>{steps.map((step, index) => <div className={`trace-step ${step.status}`} key={`${step.label}-${index}`}><i>{step.status === "done" ? "✓" : step.status === "error" ? "!" : step.status === "active" ? "·" : index + 1}</i><div><strong>{step.label}</strong><small>{step.detail}</small></div></div>)}</div>;
}

function PlanEditorModal({ plan, onChange, onSave, onClose }: { plan: WorkflowPlan; onChange: (plan: WorkflowPlan) => void; onSave: () => void; onClose: () => void }) {
  const updateList = (key: "searchQueries" | "screeningCriteria" | "analysisSummary" | "steps", value: string) => onChange({ ...plan, [key]: value.split("\n") } as WorkflowPlan);
  const updateEvidence = (index: number, key: "evidence" | "researchDirection" | "ipValue", value: string) => onChange({ ...plan, evidenceMap: plan.evidenceMap.map((item, itemIndex) => itemIndex === index ? { ...item, [key]: value } : item) });
  return <div className="modal-backdrop" onClick={onClose}><section className="plan-editor-modal" onClick={(event) => event.stopPropagation()}><div className="settings-head"><div><p className="eyebrow">WORKFLOW PLAN EDITOR</p><h2>编辑执行计划</h2><p>修改后会作为下一次论文检索、审核和成果转化的执行依据。</p></div><button className="settings-close" onClick={onClose}>×</button></div><div className="plan-editor-content"><label>任务目标<input value={plan.summary} onChange={(event) => onChange({ ...plan, summary: event.target.value })} /></label><label>检索主题 <small>每行一个主题</small><textarea rows={4} value={plan.searchQueries.join("\n")} onChange={(event) => updateList("searchQueries", event.target.value)} /></label><label>论文筛选标准 <small>每行一条标准</small><textarea rows={4} value={plan.screeningCriteria.join("\n")} onChange={(event) => updateList("screeningCriteria", event.target.value)} /></label><label>分析依据 <small>每行一个判断依据</small><textarea rows={4} value={plan.analysisSummary.join("\n")} onChange={(event) => updateList("analysisSummary", event.target.value)} /></label><label>执行步骤 <small>每行一个步骤</small><textarea rows={5} value={plan.steps.join("\n")} onChange={(event) => updateList("steps", event.target.value)} /></label><div className="plan-evidence-editor"><div className="editor-label"><strong>证据映射</strong><button className="ghost" onClick={() => onChange({ ...plan, evidenceMap: [...plan.evidenceMap, { evidence: "", researchDirection: "", ipValue: "" }] })}>＋新增映射</button></div>{plan.evidenceMap.map((item, index) => <div className="evidence-edit-row" key={`${index}-${item.evidence}`}><input value={item.evidence} onChange={(event) => updateEvidence(index, "evidence", event.target.value)} placeholder="研发文件证据" /><input value={item.researchDirection} onChange={(event) => updateEvidence(index, "researchDirection", event.target.value)} placeholder="对应论文方向" /><input value={item.ipValue} onChange={(event) => updateEvidence(index, "ipValue", event.target.value)} placeholder="知识产权价值" /><button className="ghost danger" onClick={() => onChange({ ...plan, evidenceMap: plan.evidenceMap.filter((_, itemIndex) => itemIndex !== index) })}>删除</button></div>)}</div></div><div className="settings-actions"><button className="ghost" onClick={onClose}>取消</button><button className="primary" onClick={onSave}>保存并返回计划</button></div></section></div>;
}

function SkillLibraryModal({ skills, onClose, onToggle, onEdit, onDelete, onUpload, onCreate }: { skills: SkillDocument[]; onClose: () => void; onToggle: (id: string) => void; onEdit: (skill?: SkillDocument) => void; onDelete: (id: string) => void; onUpload: (file?: File) => void; onCreate: () => void }) {
  return <div className="modal-backdrop" onClick={onClose}><section className="skill-library-modal" onClick={(event) => event.stopPropagation()}><div className="settings-head"><div><p className="eyebrow">SKILL DOCUMENTS</p><h2>Skill 能力库</h2><p>每个 Skill 都是一份可编辑 Markdown 文档，启用后会真实注入 Agent 请求。</p></div><button className="settings-close" onClick={onClose}>×</button></div><div className="skill-library-toolbar"><label className="skill-upload-button">↑ 上传 Markdown<input hidden type="file" accept=".md,.markdown,.txt" onChange={(event) => { void onUpload(event.target.files?.[0]); event.currentTarget.value = ""; }} /></label><button className="primary" onClick={onCreate}>＋ 新建 Skill</button></div><div className="skill-library-list">{skills.map((skill) => <article className={`skill-doc-card${skill.enabled ? " enabled" : ""}`} key={skill.id}><div className="skill-doc-head"><div><strong>{skill.name}</strong><small>{skill.source === "uploaded" ? "用户上传" : "内置文档"} · 更新于 {formatDate(skill.updatedAt)}</small></div><label className="skill-toggle"><input type="checkbox" checked={skill.enabled} onChange={() => onToggle(skill.id)} /><span>{skill.enabled ? "已启用" : "已停用"}</span></label></div><p>{skill.description || "暂无说明"}</p><pre>{skill.content.slice(0, 520)}{skill.content.length > 520 ? "\n…" : ""}</pre><div className="skill-doc-actions"><button className="ghost" onClick={() => onEdit(skill)}>编辑 Markdown</button>{skill.source === "uploaded" ? <button className="ghost danger" onClick={() => onDelete(skill.id)}>删除</button> : null}</div></article>)}</div></section></div>;
}

function SkillEditorModal({ skill, onChange, onClose, onSave }: { skill: SkillDocument; onChange: (skill: SkillDocument) => void; onClose: () => void; onSave: () => void }) {
  return <div className="modal-backdrop" onClick={onClose}><section className="skill-editor-modal" onClick={(event) => event.stopPropagation()}><div className="settings-head"><div><p className="eyebrow">EDIT MARKDOWN SKILL</p><h2>编辑 Skill</h2><p>修改保存后，后续 Agent 请求会使用最新文档。</p></div><button className="settings-close" onClick={onClose}>×</button></div><div className="skill-editor-content"><label>Skill 名称<input value={skill.name} onChange={(event) => onChange({ ...skill, name: event.target.value })} /></label><label>用途说明<input value={skill.description} onChange={(event) => onChange({ ...skill, description: event.target.value })} /></label><label>Markdown 内容<textarea className="skill-markdown-editor" rows={18} value={skill.content} onChange={(event) => onChange({ ...skill, content: event.target.value })} /></label><label className="remember-key"><input type="checkbox" checked={skill.enabled} onChange={(event) => onChange({ ...skill, enabled: event.target.checked })} />保存后启用此 Skill</label></div><div className="settings-actions"><button className="ghost" onClick={onClose}>取消</button><button className="primary" onClick={onSave}>保存 Skill</button></div></section></div>;
}

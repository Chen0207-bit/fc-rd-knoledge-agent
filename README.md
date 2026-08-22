# 研知 Agent

一个可直接演示的研发知识管理 Agent：自动检索论文、人工审核入库，并把研发资料整理成知识产权申报初稿。

- 在线演示：<https://fc-rd-knowledge-agent.pages.dev>
- 演示口令：`YANZHI-8264`
- 无需自有服务器或域名，前端使用 Cloudflare Pages，API 使用 Workers，数据存储在 D1。

## 演示场景

1. **论文情报**：同时查询 arXiv 与 Semantic Scholar，合并并去重结果；Semantic Scholar 限流时自动切换 Crossref。
2. **审核入库**：候选论文先进入待审区，经人工批准后成为研发知识库资料。
3. **研发资料导入**：浏览器本地解析 PDF/DOCX，仅把提取后的文字发送给 API，原文件不上传。
4. **知识产权材料**：基于已导入资料，通过智谱官方 GLM API 生成技术交底书、专利摘要和权利要求初稿。

## 在线演示说明

### 访问方式

1. 打开 [研知 Agent 在线 Demo](https://fc-rd-knowledge-agent.pages.dev)。
2. 输入演示口令：`YANZHI-8264`。
3. 进入后可直接使用预置的论文、研发文件和知识产权草稿数据；重复演示不会影响代码仓库。

### 推荐演示流程（约 5 分钟）

#### 1. 自动搜集论文

进入“论文雷达”，输入一个研发主题，例如：

```text
industrial visual inspection
```

点击“开始检索”。系统会从 arXiv、Semantic Scholar 获取候选论文，并在 Semantic Scholar 限流时自动使用 Crossref 兜底。演示时可重点说明：结果会合并去重，并保留来源、摘要、作者和发布时间。

点击一篇论文的“送审”，它会进入“审核中心”，而不是直接进入知识库。

#### 2. 人工审核后入库

进入“审核中心”，打开刚刚送审的论文，查看摘要和来源，点击“批准入库”。

回到“研发知识库”，可以看到该论文状态由“待审”变为“已入库”。这一步体现了 Agent 负责搜集和整理，人负责最终审核。

#### 3. 研发文件导入与知识产权材料生成

在“研发知识库”点击“导入研发文件”，选择 PDF 或 DOCX 文件。文件会在浏览器本地提取文字，原始文件不会上传；系统只将提取出的文字保存为可检索的研发资料。

进入“知识产权助手”，选择一篇已入库论文或研发文件，填写技术名称后点击“生成申报初稿”。系统会生成：

- 技术交底书
- 专利摘要
- 权利要求书初稿

生成后可在页面中查看并下载 Markdown 文件。演示时应强调：这是申报材料初稿，正式提交前需要研发负责人和专利代理师复核。

### 推荐讲解话术

> 这不是一个替代 PLM 的大而全系统，而是一个研发知识 Agent 的轻量 MVP：先自动搜集论文，再经过人工审核入库；研发文件可以在没有 PLM 的情况下集中整理；最后基于已审核资料生成知识产权申报初稿。整个 Demo 不需要自有服务器或域名，适合先验证研发场景和协同流程。

### 模型与数据说明

- 公网 Demo 优先调用智谱官方 GLM-5.3；如果 API 余额、模型权限或服务状态不可用，Worker 会自动切换到 Workers AI，保证演示流程可以继续。
- 本地开发可运行 `npm run k3`，读取本机 `~/.claude/settings.json` 中的 K3 配置；密钥只在本机使用，不会进入前端或仓库。
- Demo 使用的是示例研发资料，不建议上传真实涉密文件。正式环境需要接入企业身份认证、细粒度权限、审计日志和加密存储。

## 架构

```text
React/Vite (Pages)
  ├─ arXiv + Semantic Scholar 检索
  ├─ PDF.js / Mammoth 本地解析
  └─ x-demo-code 访问口令
            │
Cloudflare Worker API
  ├─ D1：论文、文档、申报草稿、限流记录
  └─ 智谱官方 API：优先使用 GLM-5.3；账户不可用时由 Workers AI 容错
```

## 本地运行

需要 Node.js 22+ 和一个 Cloudflare 账户。

```bash
npm install
npm run dev
```

发布前检查：

```bash
npm test
pwsh -NoProfile -File scripts/smoke.ps1
```

Worker 本地运行：

```bash
npx wrangler dev -c worker/wrangler.jsonc
```

### 使用本机 settings.json 的 K3

本地页面会优先使用只监听 `127.0.0.1` 的 K3 桥接服务。它运行时读取 `~/.claude/settings.json`，密钥不会复制到项目、浏览器或 Cloudflare：

```bash
npm run k3
```

保持该命令运行，再打开 `npm run dev` 启动的本地页面。知识产权页面显示“本地 K3 · 已连接”后，生成操作即使用模型 `k3`。公网 Demo 使用配置在 Cloudflare Secret 中的智谱官方 GLM API。

如需切换 API 地址，设置 `VITE_API_BASE_URL`。部署前需在 `worker/wrangler.jsonc` 中替换 D1 数据库 ID，并设置演示口令：

```bash
npx wrangler secret put DEMO_ACCESS_CODE -c worker/wrangler.jsonc
npx wrangler secret put GLM_API_KEY -c worker/wrangler.jsonc
```

## 部署

```bash
npm run build
npx wrangler deploy -c worker/wrangler.jsonc
npx wrangler pages deploy dist --project-name fc-rd-knowledge-agent
```

## 说明

这是用于方案沟通的 MVP，不是 PLM 替代品。自动生成内容仅作为知识产权申报初稿，正式提交前应由研发负责人和专利代理师复核。生产环境还应接入企业身份系统、细粒度权限、审计日志、加密存储和数据保留策略。

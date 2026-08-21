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

/**
 * dsh-memory: DeepSeek Harness 跨会话记忆插件。
 *
 * 能力：
 * 1. 会话开始注入记忆 digest（用户画像、偏好、相关项目、环境事实）
 * 2. 模型工具：memory_add / memory_search / memory_read / memory_list
 * 3. 自动提炼：每隔一段时间从最近对话中提炼新事实（ctx.llm 一次性调用）
 * 4. 语义检索：Ollama 本地嵌入（bge-m3）+ SQLite 向量存储
 * 5. git 自动提交 + 推送（NAS 远程仓库）
 *
 * 安装：在 profile 的 cordis.patch.yml 中以 loader entry 注册本插件。
 */
import z from "@deepseek-ai/schemastery";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { createMemoryStore } from "./store.js";
import { createVectorStore } from "./vectors.js";
import { registerMemoryTools } from "./tools.js";
import { createExtractor } from "./extract.js";
import { basename } from "node:path";

// 加载标记：用于确认插件模块在 GUI 进程中被加载（调试用，可删除）
console.error("[dsh-memory] MODULE LOADED at " + new Date().toISOString());

export const name = "dsh-memory";
export const inject = ["tools", "llm"];

export const Config = z.object({
  memoryDir: z.string(),
  archiveDir: z.string(),
  gitRemote: z.string(),
  digestMaxBytes: z.number().default(6000),
  attentionThreshold: z.number().default(0.58),
  maxAttentionBlocks: z.number().default(3),
  maxAttentionBytes: z.number().default(2400),
  lowConfidenceThreshold: z.number().default(0.25),
  consolidate: z.boolean().default(true),
  consolidateIntervalMs: z.number().default(6 * 60 * 60 * 1000),
  pruneStaleDays: z.number().default(30),
  autoExtract: z.boolean().default(true),
  extractMinTurns: z.number().default(10),
  extractIntervalMs: z.number().default(30 * 60 * 1000),
  extractIdleMs: z.number().default(120 * 1000),
  gitCommit: z.boolean().default(true),
  gitPush: z.boolean().default(true),
  semanticSearch: z.boolean().default(true),
  embedModel: z.string().default("bge-m3"),
  ollamaUrl: z.string().default("http://127.0.0.1:11434")
});

const DEFAULTS = {
  digestMaxBytes: 6000,  autoExtract: true,
  archiveDir: undefined,
  attentionThreshold: 0.58,
  maxAttentionBlocks: 3,
  maxAttentionBytes: 2400,
  lowConfidenceThreshold: 0.25,
  consolidate: true,
  consolidateIntervalMs: 6 * 60 * 60 * 1000,
  pruneStaleDays: 30,
  extractMinTurns: 10,
  extractIntervalMs: 30 * 60 * 1000,
  extractIdleMs: 120 * 1000,
  gitCommit: true,
  gitPush: true,
  semanticSearch: true,
  embedModel: "bge-m3",
  ollamaUrl: "http://127.0.0.1:11434"
};

export function apply(ctx, config = {}) {
  const cfg = { ...DEFAULTS, ...config };
  const store = createMemoryStore(ctx, cfg);
  const { escapeReminder } = store;
  const vectors = createVectorStore(ctx, cfg, store);
  registerMemoryTools(ctx, cfg, store, vectors);
  const extractor = createExtractor(ctx, cfg, store, vectors);

  ctx.logger?.info(
    `[dsh-memory] 记忆系统已启动：仓库 ${store.root}` +
    (cfg.semanticSearch ? `，语义检索 ${cfg.embedModel}（${cfg.ollamaUrl}）` : "，语义检索关闭") +
    (cfg.autoExtract ? `，自动提炼每 ${Math.round(cfg.extractIntervalMs / 60000)} 分钟` : "，自动提炼关闭")
  );
  console.error(`[dsh-memory] APPLIED at ${new Date().toISOString()} repo=${store.root}`);

  /** 启动时全量重建向量索引（异步，不阻塞；保证存量记忆可被语义检索）。 */
  if (cfg.semanticSearch) {
    void (async () => {
      try {
        const files = store.list().filter((f) => f !== "MEMORY.md");
        for (const file of files) {
          await vectors.indexFile(file);
        }
        ctx.logger?.info(`[dsh-memory] 向量索引就绪：${files.length} 个记忆文件已索引`);
      } catch (error) {
        ctx.logger?.warn("[dsh-memory] 启动索引失败：", error?.message ?? error);
      }
    })();
  }

  /** 注意力式按需读取记忆 digest。
   *
   * 设计（2026-08-15 按用户要求重构，学 Codex 记忆管理 + 注意力机制原理）：
   * - 零常驻、零预读：不默认注入任何记忆（不读 user/preferences/项目）。
   * - 注意力读取：每条用户消息作为 query，对记忆块做语义检索（query 嵌入 vs
   *   记忆块嵌入的余弦相似度，Ollama bge-m3 本地计算）——命中才读，不命中压根不读。
   * - 相似度超过阈值的记忆块才注入（仅注入压缩正文，原文不存不读）。
   * - 关键词主题检测（store.detectTopics）作为语义检索不可用时的轻量兜底。
   * - 会话级缓存：injectedKeys 记录已注入的记忆块（file+title），同一块不重复注入。
   */
  const injectedKeys = new WeakMap(); // session -> Set<"file#title">
  const attnCache = new Map(); // query 嵌入缓存：query -> qvec（相同消息不重复嵌入）

  /** 从消息列表提取用户文本（跳过注入类消息）。 */
  function extractUserText(messages) {
    return (Array.isArray(messages) ? messages : [])
      .filter((m) => m?.role === "user" || m?.type === "user/message")
      .map((m) => {
        const content = Array.isArray(m.content) ? m.content : [];
        const texts = content
          .filter((b) => b?.type === "text" && typeof b.text === "string")
          .map((b) => b.text);
        const sourceKind = m.source?.kind ?? m.data?.source?.kind;
        return sourceKind === "memory-digest" ? "" : texts.join("\n");
      })
      .filter(Boolean)
      .join("\n")
      .slice(0, 4000);
  }

  /** 把命中的记忆块组装成注入消息（压缩正文，带来源标注）。 */
  function buildAttentionMessage(hits, slug) {
    const sections = hits.map((hit, i) => {
      const label = hit.title || hit.file;
      const body = String(hit.content ?? "").slice(0, 1200);
      return `### ${i + 1}. ${label}（来自 ${hit.file}）\n\n${body}`;
    });
    const text = [
      "<system-reminder>",
      "以下是你（dsh-memory）按需读取到的相关跨会话记忆（仅与当前话题相关的压缩内容）。",
      "完整内容可用 memory_read / memory_search 查询；学到新的持久事实时用 memory_add 写入。",
      "",
      escapeReminder(sections.join("\n\n")),
      "</system-reminder>"
    ].join("\n");
    return {
      text,
      files: [...new Set(hits.map((h) => h.file))],
      slug,
      keys: hits.map((h) => `${h.file}#${h.title}`)
    };
  }

  ctx.on("agent/pre-step", async ({ agent, messages, step, signal }, next) => {
    const decision = await next();
    if (decision.kind === "reject") return decision;
    const session = agent?.session;
    if (!session) return decision;
    const cwd = session.header?.cwd;
    if (!cwd) return decision;
    const slug = store.projectSlug(cwd);

    const state = injectedKeys.get(session) ?? new Set();
    injectedKeys.set(session, state);

    const userText = extractUserText(messages);
    if (!userText) return decision; // 非用户消息步骤（工具调用等）不触发读取

    // —— 注意力读取：语义检索（query 嵌入 → 余弦相似度）——
    let hits = [];
    const cacheKey = userText.slice(0, 200);
    if (cfg.semanticSearch) {
      let qvec;
      const cachedVec = attnCache.get(cacheKey);
      if (cachedVec !== undefined) qvec = cachedVec;
      else {
        try {
          qvec = (await vectors.embed([userText]))[0];
          attnCache.set(cacheKey, qvec);
        } catch {
          qvec = undefined;
        }
      }
      if (qvec !== undefined) {
        try {
          // 多取一些候选（top-8），阈值过滤后再裁剪，保证高相关块不因 top-N 太小被漏掉
          hits = await vectors.search(userText, 8, qvec);
        } catch {
          hits = [];
        }
      }
    }

    // 阈值过滤：只注入足够相关的记忆块（注意力权重高才"看"）
    const threshold = cfg.attentionThreshold ?? 0.58;
    let relevant = hits.filter((h) => h.score >= threshold);

    // 语义检索不可用/无命中时，关键词兜底——但只做【块级】匹配：
    // 用主题路由的关键词集合逐块检查，绝不整文件注入（记忆臃肿后整文件 = 全量读取）。
    if (relevant.length === 0) {
      const topics = store.detectTopics(userText);
      if (topics.length > 0) {
        const files = [];
        for (const t of topics) for (const f of store.topicFiles(t)) if (!files.includes(f)) files.push(f);
        // 收集命中主题的全部关键词（小写），用于逐块匹配
        const topicKeywords = [];
        for (const t of topics) {
          const route = store.TOPIC_ROUTES.find((r) => r.topic === t);
          if (route) for (const kw of route.keywords) topicKeywords.push(String(kw).toLowerCase());
        }
        const userLower = userText.toLowerCase();
        const activeKeywords = topicKeywords.filter((kw) => userLower.includes(kw));
        for (const f of files) {
          const content = store.read(f);
          if (!content) continue;
          // 按 ## 章节切块，只保留「含用户命中关键词」的块（块级注意力）
          const chunks = content.split(/^##\s/m);
          for (const c of chunks) {
            if (!c.trim()) continue;
            const firstLine = c.split("\n")[0].trim();
            const lower = c.toLowerCase();
            const matched = activeKeywords.filter((kw) => lower.includes(kw)).length;
            if (matched === 0) continue; // 无关块不读
            relevant.push({ file: f, title: firstLine || basename(f, ".md"), content: c.trim().slice(0, 1200), score: 0.4 + Math.min(matched, 5) * 0.04 });
          }
        }
      }
    }

    // —— 注意力裁剪：即使都相关，也只注入最相关的少数块，控制 token ——
    // 数量上限：最多注入 maxAttentionBlocks 块（默认 3）
    // 体积上限：注入总量不超过 maxAttentionBytes（默认 2400 字节）
    const maxBlocks = cfg.maxAttentionBlocks ?? 3;
    const maxBytes = cfg.maxAttentionBytes ?? 2400;
    relevant.sort((a, b) => b.score - a.score);
    const picked = [];
    let pickedBytes = 0;
    for (const h of relevant) {
      if (picked.length >= maxBlocks) break;
      const blockBytes = Buffer.byteLength(String(h.content ?? ""), "utf8");
      if (pickedBytes + blockBytes > maxBytes && picked.length > 0) break;
      picked.push(h);
      pickedBytes += blockBytes;
    }

    // —— 置信度过滤（用后学习闭环）：低置信度记忆隔离，不注入 ——
    const lowConfidence = cfg.lowConfidenceThreshold ?? 0.25;
    const confByTitle = new Map(store.listEntries().map((e) => [e.title, e.confidence]));
    const pickedWithConfidence = [];
    for (const h of picked) {
      const conf = confByTitle.get(String(h.title ?? "").trim()) ?? 0.6;
      if (conf >= lowConfidence) pickedWithConfidence.push({ ...h, confidence: conf });
    }

    // 只注入尚未注入过的记忆块（会话级去重）
    const fresh = pickedWithConfidence.filter((h) => !state.has(`${h.file}#${h.title}`));
    if (fresh.length === 0) return decision;
    for (const h of fresh) state.add(`${h.file}#${h.title}`);

    // 记录使用时间（供过期剪枝判断；只在确实注入时更新，不注入不"续命"）
    for (const h of fresh) store.markUsed(h.title, h.file);

    const digest = buildAttentionMessage(fresh, slug);
    signal.throwIfAborted();
    const message = createUserMessage({
      content: [{ type: "text", text: digest.text }],
      source: { kind: "memory-digest", version: 3, files: digest.files, slug, keys: digest.keys, attention: true }
    });
    return { ...decision, messages: [...decision.messages, message] };
  });

  /** 会话摘要 + 重复任务检测（学 Codex Memories 的时机设计，更精准）：
   *  - 会话结束：只生成轻量摘要存 summaries.jsonl（不提炼记忆——同一对话框内
   *    模型自带上下文，提炼是浪费）。
   *  - 新会话首条消息：detectTopics 检测主题 → matchSummariesByTopic 发现
   *    「相同主题的历史摘要」= 用户新开窗口重复做同一件事 → 注入历史摘要，
   *    让模型恢复上下文（与注意力读取互补：摘要是"上次做到哪"，记忆是"长期事实"）。
   */
  if (cfg.autoExtract) {
    // 会话结束 → 摘要
    ctx.on("session/disposed", (session) => {
      setTimeout(() => {
        void extractor.summarize(session).catch(() => {});
      }, cfg.extractIdleMs ?? 120 * 1000);
    });

    // 新会话首条消息 → 重复任务检测 → 注入摘要
    const summaryInjected = new WeakSet();
    ctx.on("agent/pre-step", async ({ agent, messages, step, signal }, next) => {
      const decision = await next();
      if (decision.kind === "reject") return decision;
      const session = agent?.session;
      if (!session || summaryInjected.has(session) || step !== 1) return decision;
      const userText = extractUserText(messages);
      if (!userText) return decision;
      const topics = store.detectTopics(userText);
      const matches = store.matchSummariesByTopic(topics, 2);
      if (matches.length === 0) return decision;
      summaryInjected.add(session);
      const sections = matches.map((m, i) =>
        `### 上次会话 #${i + 1}（${m.topic}，${new Date(m.endedAt).toLocaleDateString()}）\n\n${m.summary}`
      );
      const text = [
        "<system-reminder>",
        "以下是历史会话摘要（检测到你正在做与之前相同的事情，帮你恢复上下文）：",
        "",
        escapeReminder(sections.join("\n\n")),
        "</system-reminder>"
      ].join("\n");
      signal.throwIfAborted();
      const message = createUserMessage({
        content: [{ type: "text", text }],
        source: { kind: "memory-digest", version: 4, slug: store.projectSlug(session.header?.cwd), summary: true }
      });
      return { ...decision, messages: [...decision.messages, message] };
    });
  }

  /** 记忆巩固 + 过期剪枝（学 dsh-mneme 的 autoDream + Codex 的 aging-out）：
   *  - 巩固：低频合并重复/相似条目，记忆自我瘦身（纯本地规则，零 LLM、零 token）。
   *  - 剪枝：超过 pruneStaleDays（默认 30 天）未使用的记忆从索引移除，
   *    防止记忆库无限膨胀（文件正文保留，git 可回溯）。
   *  只在条目数量超过阈值时才做，避免空转。
   */
  if (cfg.consolidate) {
    let consolidateTimer;
    const runConsolidation = () => {
      try {
        // 过期剪枝（先剪再巩固，减少无效比对）
        const pruned = store.pruneStale((cfg.pruneStaleDays ?? 30) * 24 * 60 * 60 * 1000);
        if (pruned.length > 0) {
          ctx.logger?.info(`[dsh-memory] 记忆剪枝：移除 ${pruned.length} 条超过 ${cfg.pruneStaleDays ?? 30} 天未使用的记忆`);
        }
        const entries = store.listEntries();
        if (entries.length < 8) return; // 条目太少不需要巩固
        const groups = store.findNearDuplicates();
        if (groups.length === 0) return;
        const removed = store.consolidateDuplicates(groups);
        if (removed.length > 0) {
          ctx.logger?.info(`[dsh-memory] 记忆巩固：合并 ${removed.length} 条重复条目`);
        }
      } catch (error) {
        ctx.logger?.warn("[dsh-memory] 记忆巩固失败：", error?.message ?? error);
      }
    };
    // 启动后先跑一次，再按间隔定时
    setTimeout(runConsolidation, 60 * 1000);
    consolidateTimer = setInterval(runConsolidation, cfg.consolidateIntervalMs);
    ctx.effect(() => () => {
      clearInterval(consolidateTimer);
    }, "dsh-memory: consolidate");
  }

  /** 停用时冲刷未提交的记忆。 */
  return () => {
    void store.flushNow();
  };
}

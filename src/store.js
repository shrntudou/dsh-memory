/**
 * dsh-memory: 跨会话记忆存储层。
 *
 * 记忆仓库是一个普通 Markdown 目录（默认 ~/.dsh/memory/），git 管理，
 * 自动提交并推送到远程（NAS）。人类可读、可编辑、可回滚。
 *
 * 文件布局：
 *   MEMORY.md          索引（自动维护）
 *   user.md            用户画像
 *   preferences.md     工作偏好
 *   facts.md           通用事实
 *   projects/<slug>.md 项目记忆（slug 取自 cwd 的最近 .git 祖先目录名）
 *   .meta.json         条目去重索引（git 跟踪）
 */
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import os from "node:os";

const GIT_AUTHOR = ["-c", "user.name=shrntudou", "-c", "user.email=shrntudou1917@gmail.com"];

/**
 * 主题路由表：关键词 → 主题 → 记忆文件。
 * 用于"按需注入"：会话开始时只注入基础层（user 画像 + 协作偏好），
 * 当用户消息命中某个主题的关键词时，才增量注入该主题的记忆文件。
 * 这样"说到交易才读交易记忆，不说就不读"，避免每次对话全量读盘/全量注入。
 */
export const TOPIC_ROUTES = [
  {
    topic: "trading",
    label: "交易系统",
    keywords: [
      "交易", "期货", "行情", "策略", "信号", "合约", "量化", "CTP", "AKShare",
      "TradingMind", "futures", "飞书", "n8n", "NAS", "SMB", "持仓", "K线"
    ],
    files: ["projects/futures-trading-system.md"]
  },
  {
    topic: "tools",
    label: "工具与协作偏好",
    keywords: [
      "工具", "推荐", "Coze", "Aider", "Claude Code", "Opal", "可视化",
      "工作流", "自动化", "插件", "软件", "选型"
    ],
    files: ["preferences.md"]
  },
  {
    topic: "memory",
    label: "记忆系统",
    keywords: [
      "记忆", "digest", "dsh-memory", "索引", "向量", "语义检索",
      "embedding", "嵌入", "会话文件", "zstd", "提炼"
    ],
    files: ["projects/dsh-test.md"]
  },
  {
    topic: "env",
    label: "环境与基础设施",
    keywords: [
      "环境", "Docker", "局域网", "路由器", "Mac", "Ollama", "bge-m3",
      "部署", "基础设施", "IP", "端口"
    ],
    files: ["facts.md"]
  }
];

/** 基础层：任何会话都注入（用户画像 + 协作偏好核心），体积小、常驻。 */
const BASE_LAYER_FILES = ["user.md", "preferences.md"];

/** 会话摘要库文件：记录每个已结束会话的 {topic, summary, sessionId, cwd, endedAt}。 */
const SUMMARIES_FILE = "summaries.jsonl";

function sha1(text) {
  return createHash("sha1").update(text).digest("hex");
}

function escapeReminder(text) {
  return text.replace(/<\/system-reminder>/g, "<\\/system-reminder>");
}

function runGit(args, cwd) {
  return new Promise((resolvePromise) => {
    execFile("git", args, { cwd, timeout: 30000 }, (error, stdout, stderr) => {
      if (error) resolvePromise({ ok: false, error: stderr || String(error) });
      else resolvePromise({ ok: true, output: stdout });
    });
  });
}

/** 从 cwd 推导项目 slug：最近包含 .git 的祖先目录名，否则 cwd 目录名。 */
export function projectSlug(cwd) {
  if (!cwd) return undefined;
  let dir = resolve(cwd);
  while (true) {
    if (existsSync(join(dir, ".git"))) return sanitizeSlug(basename(dir));
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return sanitizeSlug(basename(resolve(cwd)));
}

function sanitizeSlug(name) {
  return String(name).replace(/[^\w\u4e00-\u9fa5.-]+/g, "-").replace(/^-+|-+$/g, "") || "default";
}

export function createMemoryStore(ctx, cfg) {
  const root = resolve(cfg.memoryDir ?? join(os.homedir(), ".dsh", "memory"));
  const metaFile = join(root, ".meta.json");
  const indexFile = join(root, "MEMORY.md");
  let meta = { entries: {} };
  let commitTimer = undefined;
  let commitPending = false;
  /** 文件内容缓存：{ [absPath]: { mtimeMs, content } }，mtime 未变则复用，避免反复读盘。 */
  const fileCache = new Map();

  function log(...args) {
    (ctx.logger ?? console).info("[dsh-memory]", ...args);
  }
  function warn(...args) {
    (ctx.logger ?? console).warn("[dsh-memory]", ...args);
  }

  function ensureDir() {
    if (!existsSync(root)) mkdirSync(root, { recursive: true });
    for (const sub of ["projects"]) {
      const d = join(root, sub);
      if (!existsSync(d)) mkdirSync(d, { recursive: true });
    }
  }

  function loadMeta() {
    try {
      if (existsSync(metaFile)) meta = JSON.parse(readFileSync(metaFile, "utf8"));
    } catch (error) {
      warn("meta 文件损坏，重建索引：", error.message);
      meta = { entries: {} };
    }
    if (!meta || typeof meta.entries !== "object") meta = { entries: {} };
  }

  function saveMeta() {
    writeFileSync(metaFile, JSON.stringify(meta, null, 2) + "\n");
  }

  function scopeFile(scope, cwd) {
    switch (scope) {
      case "user": return "user.md";
      case "preferences": return "preferences.md";
      case "fact": return "facts.md";
      case "project": {
        const slug = projectSlug(cwd);
        return slug ? join("projects", `${slug}.md`) : "facts.md";
      }
      default: return "facts.md";
    }
  }

  function readFileSafe(file) {
    const full = resolve(join(root, file));
    if (!full.startsWith(root + sep) && full !== root) {
      throw new Error(`memory: 路径越界 ${file}`);
    }
    if (!existsSync(full)) return "";
    try {
      const stat = statSync(full);
      const cached = fileCache.get(full);
      if (cached !== undefined && cached.mtimeMs === stat.mtimeMs) return cached.content;
      const content = readFileSync(full, "utf8");
      fileCache.set(full, { mtimeMs: stat.mtimeMs, content });
      return content;
    } catch (error) {
      // 文件被并发删除/移动等瞬时错误 → 回退到直接读取
      if (existsSync(full)) return readFileSync(full, "utf8");
      return "";
    }
  }

  /** 清掉缓存条目（写入后调用，保证下一次读取拿到新内容）。 */
  function invalidateCache(file) {
    const full = resolve(join(root, file));
    fileCache.delete(full);
  }

  /**
   * 从消息文本检测命中的主题（按关键词子串匹配，中文/英文/大小写不敏感）。
   * @param text - 用户消息或任意文本。
   * @returns 命中的主题 topic 数组（保持路由表顺序，去重）。
   */
  function detectTopics(text) {
    if (!text) return [];
    const lower = String(text).toLowerCase();
    const hits = [];
    for (const route of TOPIC_ROUTES) {
      const matched = route.keywords.some((kw) => lower.includes(String(kw).toLowerCase()));
      if (matched) hits.push(route.topic);
    }
    return hits;
  }

  /** 主题 → 记忆文件（含该主题路由的 files）。 */
  function topicFiles(topic) {
    const route = TOPIC_ROUTES.find((r) => r.topic === topic);
    return route ? route.files : [];
  }

  /** 主题 → 展示标题。 */
  function topicLabel(topic) {
    const route = TOPIC_ROUTES.find((r) => r.topic === topic);
    return route ? route.label : topic;
  }

  /**
   * 写入一条记忆：
   * - 目标文件里已有同名 `## 标题` 节 → 替换该节内容（更新，支持纠错）
   * - 无同名节但 title+body 哈希命中 meta → 视为重复跳过
   * - 否则追加为新节
   * 更新索引，异步 git 提交+推送。
   */
  /**
   * 写入一条记忆（压缩正文；不存原文，原文成本高且无需追溯）。
   * @param scope - user/preferences/project/fact
   * @param title - 简短标题（markdown 二级标题）
   * @param body - 压缩提炼后的正文
   * @param cwd - 会话工作目录（project 作用域定位项目文件）
   */
  function add(scope, title, body, cwd) {
    ensureDir();
    loadMeta();
    const cleanTitle = String(title).trim();
    const cleanBody = String(body).trim();
    if (!cleanTitle || !cleanBody) throw new Error("memory_add: title 和 body 不能为空");
    const hash = sha1(`${cleanTitle}\n${cleanBody}`);
    const file = scopeFile(scope, cwd);
    if (meta.entries[hash]) return { added: false, reason: "duplicate", file: meta.entries[hash].file };
    const full = join(root, file);
    const existing = existsSync(full) ? readFileSync(full, "utf8") : "";
    const lines = existing.split("\n");
    const heading = `## ${cleanTitle}`;
    let start = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trim() === heading) {
        start = i;
        break;
      }
    }
    if (start !== -1) {
      // 同标题节存在 → 更新（替换到下一个 ## 标题或文件尾）
      let end = lines.length;
      for (let i = start + 1; i < lines.length; i++) {
        if (/^##\s/.test(lines[i])) {
          end = i;
          break;
        }
      }
      const updated = [
        ...lines.slice(0, start),
        heading,
        "",
        ...cleanBody.split("\n"),
        "",
        ...lines.slice(end)
      ].join("\n").replace(/\n{3,}/g, "\n\n").replace(/^\n+/, "");
      writeFileSync(full, updated);
      invalidateCache(file);
      meta.entries[hash] = { file, title: cleanTitle, addedAt: Date.now(), updated: true, confidence: 0.6, usedCount: 0, helpedCount: 0, lastUsedAt: Date.now() };
      saveMeta();
      rebuildIndex();
      queueCommit(`记忆更新: ${cleanTitle}`);
      return { added: true, updated: true, file };
    }
    const section = `## ${cleanTitle}\n\n${cleanBody}\n`;
    writeFileSync(full, existing.endsWith("\n") ? existing + section : existing + "\n" + section);
    invalidateCache(file);
    meta.entries[hash] = { file, title: cleanTitle, addedAt: Date.now(), confidence: 0.6, usedCount: 0, helpedCount: 0, lastUsedAt: Date.now() };
    saveMeta();
    rebuildIndex();
    queueCommit(`记忆: ${cleanTitle}`);
    return { added: true, file };
  }

  /** 重建 MEMORY.md 索引。 */
  function rebuildIndex() {
    const lines = ["# Memory Index", ""];
    const seen = new Set();
    const files = listMarkdownFiles();
    for (const file of files) {
      if (file === "MEMORY.md") continue;
      if (file.startsWith(".")) continue;
      const content = existsSync(join(root, file)) ? readFileSync(join(root, file), "utf8") : "";
      const first = content.split("\n").find((line) => line.startsWith("# "));
      const label = first ? first.replace(/^#\s*/, "").trim() : file;
      if (seen.has(label)) continue;
      seen.add(label);
      lines.push(`- [${label}](${file})`);
    }
    writeFileSync(indexFile, lines.join("\n") + "\n");
  }

  function listMarkdownFiles() {
    const out = [];
    for (const name of readdirSync(root)) {
      const full = join(root, name);
      if (statSync(full).isFile() && name.endsWith(".md")) out.push(name);
    }
    const projDir = join(root, "projects");
    if (existsSync(projDir)) {
      for (const name of readdirSync(projDir)) {
        if (name.endsWith(".md")) out.push(join("projects", name));
      }
    }
    return out.sort();
  }

  /** 关键词检索（按空白/标点分词，任一 token 命中即算；多命中排序靠前，供语义检索不可用时的回退）。 */
  function keywordSearch(query, limit = 10) {
    const tokens = String(query)
      .toLowerCase()
      .split(/[\s,，。、;；:：!！?？"'（）()【】\[\]{}<>《》\/\\|_\-—…]+/)
      .filter((t) => t.length >= 2);
    if (tokens.length === 0) return [];
    const hits = [];
    for (const file of listMarkdownFiles()) {
      const content = readFileSafe(file);
      const lines = content.split("\n");
      let section = "";
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (/^##\s/.test(line)) section = line.replace(/^##\s*/, "").trim();
        const lower = line.toLowerCase();
        const matched = tokens.filter((t) => lower.includes(t)).length;
        if (matched > 0) {
          hits.push({ file, section, line: line.trim().slice(0, 200), lineNumber: i + 1, matched });
        }
      }
    }
    hits.sort((a, b) => b.matched - a.matched);
    return hits.slice(0, limit);
  }

  /** 枚举所有记忆条目（从 .meta.json 读出 title/confidence/使用统计，供巩固与反馈用）。 */
  function listEntries() {
    loadMeta();
    return Object.entries(meta.entries).map(([hash, e]) => ({
      hash,
      file: e.file,
      title: e.title,
      confidence: typeof e.confidence === "number" ? e.confidence : 0.6,
      usedCount: e.usedCount ?? 0,
      helpedCount: e.helpedCount ?? 0,
      addedAt: e.addedAt ?? 0,
      lastUsedAt: typeof e.lastUsedAt === "number" ? e.lastUsedAt : e.addedAt ?? 0
    }));
  }

  /**
   * 用后反馈更新置信度（学 dsh-memory-gate 的 CBDC 用后学习）。
   * - helped（有用）→ confidence 上调，上限 0.95
   * - harmful（有害/过时）→ confidence 下调，下限 0.05
   * - 置信度低于低水位（0.25）的记忆会在注入时被隔离（不读）。
   */
  function feedback(hash, outcome, note) {
    loadMeta();
    const entry = meta.entries[hash];
    if (!entry) return { ok: false, reason: "not-found" };
    const prev = typeof entry.confidence === "number" ? entry.confidence : 0.6;
    let next = prev;
    if (outcome === "helped") {
      next = Math.min(0.95, prev + 0.15);
      entry.helpedCount = (entry.helpedCount ?? 0) + 1;
    } else if (outcome === "harmful") {
      next = Math.max(0.05, prev - 0.25);
    } else {
      return { ok: false, reason: "invalid-outcome" };
    }
    entry.usedCount = (entry.usedCount ?? 0) + 1;
    entry.confidence = Math.round(next * 100) / 100;
    if (note) entry.note = String(note).slice(0, 200);
    saveMeta();
    // 隔离（低置信度）不删文件，只标记，注入时跳过
    queueCommit(`记忆反馈: ${entry.title} → ${outcome}`);
    return { ok: true, confidence: entry.confidence, usedCount: entry.usedCount };
  }

  /**
   * 查找疑似重复/相似条目（供巩固合并用）。
   * 用标题 + 正文前 60 字符的归一化相似度做轻量检测（不调 LLM/向量，
   * 零成本；真正的语义合并由巩固流程用 LLM 完成）。
   * @returns 相似条目分组：[[entryA, entryB], ...]
   */
  function findNearDuplicates() {
    loadMeta();
    const entries = Object.entries(meta.entries).map(([hash, e]) => ({ hash, ...e }));
    const norm = (s) => String(s ?? "").toLowerCase().replace(/[\s，。、；：!！?？"'（）()【】\[\]{}<>《》\/\\|_\-—…]+/g, "").slice(0, 80);
    const groups = [];
    const used = new Set();
    for (let i = 0; i < entries.length; i++) {
      if (used.has(entries[i].hash)) continue;
      const a = entries[i];
      const na = norm(a.title);
      const pair = [a];
      for (let j = i + 1; j < entries.length; j++) {
        if (used.has(entries[j].hash)) continue;
        const b = entries[j];
        const nb = norm(b.title);
        // 标题归一化后相同或一方包含另一方（且同文件）→ 疑似重复
        if (a.file === b.file && (na === nb || (na && nb && (na.includes(nb) || nb.includes(na))))) {
          pair.push(b);
          used.add(b.hash);
        }
      }
      if (pair.length > 1) {
        groups.push(pair);
        used.add(a.hash);
      }
    }
    return groups;
  }

  /**
   * 合并一组重复条目：保留第一条（最新添加的靠前），其余标记为
   * 重复并从 meta 移除（文件内容不动，避免破坏人工编辑；下次
   * rebuildIndex 时会自然收敛）。返回被合并的 hash 列表。
   */
  function consolidateDuplicates(groups) {
    loadMeta();
    const removed = [];
    for (const group of groups) {
      // group[0] 保留，其余移除
      for (const dup of group.slice(1)) {
        if (meta.entries[dup.hash]) {
          delete meta.entries[dup.hash];
          removed.push({ hash: dup.hash, title: dup.title, kept: group[0].title });
        }
      }
    }
    if (removed.length > 0) {
      saveMeta();
      queueCommit(`记忆巩固: 合并 ${removed.length} 条重复`);
    }
    return removed;
  }

  /**
   * 记录一条记忆被"使用"（注入进上下文时调用，学 Codex 的剪枝依据）。
   * 更新 lastUsedAt，供过期剪枝判断"多久没用了"。
   * @param title - 记忆标题（与注入块 title 对应）。
   * @param file - 记忆文件（可选，缩小匹配范围）。
   */
  function markUsed(title, file) {
    loadMeta();
    const cleanTitle = String(title ?? "").trim();
    if (!cleanTitle) return 0;
    let updated = 0;
    for (const [hash, e] of Object.entries(meta.entries)) {
      if (e.title !== cleanTitle) continue;
      if (file !== undefined && e.file !== file) continue;
      e.lastUsedAt = Date.now();
      e.usedCount = (e.usedCount ?? 0) + 1;
      updated++;
    }
    if (updated > 0) saveMeta();
    return updated;
  }

  /**
   * 把一条记忆条目归档到 archive/ 目录（剪枝前调用）。
   * 归档文件：archive/<原文件>.md，追加 `## 标题（归档于 YYYY-MM-DD）` 章节。
   * 归档后记忆不再注入/检索（不在 meta 索引），但可随时用 memory_search 找回
   * ——学 Codex：两年前的记忆都能回忆，只是平时不占成本。
   * @returns 归档是否成功。
   */
  function archiveEntry(hash) {
    loadMeta();
    const entry = meta.entries[hash];
    if (!entry) return false;
    try {
      const archiveDir = join(root, "archive");
      if (!existsSync(archiveDir)) mkdirSync(archiveDir, { recursive: true });
      const archiveFile = join(archiveDir, basename(entry.file));
      const section = extractSection(entry.file, entry.title);
      if (!section) return false;
      const date = new Date().toISOString().slice(0, 10);
      const block = `## ${entry.title}（归档于 ${date}）\n\n${section}\n`;
      const existing = existsSync(archiveFile) ? readFileSync(archiveFile, "utf8") : "";
      writeFileSync(archiveFile, existing.endsWith("\n") ? existing + block : existing + "\n" + block);
      return true;
    } catch (error) {
      warn("记忆归档失败：", error.message);
      return false;
    }
  }

  /** 从记忆文件中提取某个 ## 标题章节的正文（不含标题行）。 */
  function extractSection(file, title) {
    const content = readFileSafe(file);
    if (!content) return "";
    const lines = content.split("\n");
    const heading = `## ${title}`;
    let start = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trim() === heading) { start = i + 1; break; }
    }
    if (start === -1) return "";
    let end = lines.length;
    for (let i = start; i < lines.length; i++) {
      if (/^##\s/.test(lines[i])) { end = i; break; }
    }
    return lines.slice(start, end).join("\n").trim();
  }

  /**
   * 过期剪枝（学 Codex Memories 的 aging-out，剪枝 = 归档不删除）：
   * 超过 maxAgeMs 未使用的记忆条目从 meta 索引移除（不再注入/检索），
   * 但正文先归档到 archive/ 目录——需要时可随时检索回来。
   * @param maxAgeMs - 过期阈值，默认 30 天。
   * @returns 被剪枝（归档）的条目列表。
   */
  function pruneStale(maxAgeMs = 30 * 24 * 60 * 60 * 1000) {
    loadMeta();
    const now = Date.now();
    const removed = [];
    for (const [hash, e] of Object.entries(meta.entries)) {
      const lastUsed = typeof e.lastUsedAt === "number" ? e.lastUsedAt : e.addedAt;
      if (now - lastUsed > maxAgeMs) {
        // 先归档，归档失败则跳过（宁可不剪也不丢数据）
        const archived = archiveEntry(hash);
        if (!archived) {
          warn(`记忆剪枝跳过（归档失败）：${e.title}`);
          continue;
        }
        removed.push({ hash, file: e.file, title: e.title, lastUsedAt: lastUsed, ageMs: now - lastUsed, archived: true });
        delete meta.entries[hash];
      }
    }
    if (removed.length > 0) {
      saveMeta();
      queueCommit(`记忆剪枝: 归档 ${removed.length} 条过期记忆`);
    }
    return removed;
  }

  /** 归档目录中所有文件（供检索回退）。 */
  function listArchiveFiles() {
    const archiveDir = join(root, "archive");
    if (!existsSync(archiveDir)) return [];
    return readdirSync(archiveDir)
      .filter((name) => name.endsWith(".md"))
      .map((name) => join("archive", name))
      .sort();
  }

  /** 关键词检索归档记忆（活跃索引搜不到时回退到这里，两年前的事也能想起）。 */
  function searchArchive(query, limit = 5) {
    const tokens = String(query)
      .toLowerCase()
      .split(/[\s,，。、;；:：!！?？"'（）()【】\[\]{}<>《》\/\\|_\-—…]+/)
      .filter((t) => t.length >= 2);
    if (tokens.length === 0) return [];
    const hits = [];
    for (const file of listArchiveFiles()) {
      const content = readFileSafe(file);
      const lines = content.split("\n");
      let section = "";
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (/^##\s/.test(line)) section = line.replace(/^##\s*/, "").trim();
        const lower = line.toLowerCase();
        const matched = tokens.filter((t) => lower.includes(t)).length;
        if (matched > 0) {
          hits.push({ file, section, line: line.trim().slice(0, 200), lineNumber: i + 1, matched, archived: true });
        }
      }
    }
    hits.sort((a, b) => b.matched - a.matched);
    return hits.slice(0, limit);
  }

  /**
   * 构造记忆 digest（分层按需注入）。
   *
   * - 基础层（user.md + preferences.md）总是注入：了解用户是谁、怎么协作，
   *   体积小（约 3.3KB），是每次会话的常驻上下文。
   * - 主题层（可选 topics）：按会话中检测到的主题增量注入对应记忆文件，
   *   "说到交易才读交易记忆，不说就不读"。
   *
   * 构建结果按 (slug + topics + 文件 mtime 签名) 缓存，文件未变时直接复用，
   * 不重复读盘、不重复拼接。
   *
   * @param cwd - 会话工作目录（用于推导项目 slug）。
   * @param maxBytes - 总预算（基础层 + 主题层）。
   * @param opts.topics - 要注入的主题数组（额外层）；省略则只注入基础层。
   * @returns { text, files, slug, topics } 或 undefined（无任何内容）。
   */
  const digestCache = new Map();
  /**
   * 会话摘要库（学 Codex Memories 的会话总结时机）：
   * - 会话结束后生成 {topic, summary} 追加到 summaries.jsonl（轻量，一行一条）
   * - 新会话首条消息检测到「相同主题的历史摘要」时（重复做同一件事），
   *   才把摘要注入新会话——同一对话框内模型自带上下文，无需总结。
   */

  /** 追加一条会话摘要。 */
  function addSummary(summary) {
    if (!summary || !summary.topic) return false;
    try {
      const file = join(root, SUMMARIES_FILE);
      const line = JSON.stringify({
        topic: String(summary.topic).slice(0, 120),
        summary: String(summary.summary ?? "").slice(0, 800),
        sessionId: summary.sessionId,
        cwd: summary.cwd,
        endedAt: Date.now()
      });
      const existing = existsSync(file) ? readFileSync(file, "utf8") : "";
      writeFileSync(file, existing.endsWith("\n") ? existing + line + "\n" : existing + line + "\n");
      return true;
    } catch {
      return false;
    }
  }

  /** 读取最近的会话摘要（按 endedAt 倒序，limit 条）。 */
  function listSummaries(limit = 50) {
    const file = join(root, SUMMARIES_FILE);
    if (!existsSync(file)) return [];
    try {
      return readFileSync(file, "utf8")
        .split("\n")
        .filter((l) => l.trim())
        .map((l) => {
          try { return JSON.parse(l); } catch { return null; }
        })
        .filter(Boolean)
        .sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))
        .slice(0, limit);
    } catch {
      return [];
    }
  }

  /** 按主题匹配历史摘要：返回同一主题（topic 关键词命中）最近的摘要列表。 */
  function matchSummariesByTopic(topics, limit = 2) {
    if (!Array.isArray(topics) || topics.length === 0) return [];
    // 收集命中主题的全部关键词（小写）
    const keywords = [];
    for (const t of topics) {
      const route = TOPIC_ROUTES.find((r) => r.topic === t);
      if (route) for (const kw of route.keywords) keywords.push(String(kw).toLowerCase());
    }
    if (keywords.length === 0) return [];
    const matches = [];
    for (const s of listSummaries(50)) {
      const topicLower = String(s.topic ?? "").toLowerCase();
      const hit = keywords.some((kw) => topicLower.includes(kw));
      if (hit) {
        matches.push(s);
        if (matches.length >= limit) break;
      }
    }
    return matches;
  }

  function buildDigest(cwd, maxBytes = 6000, opts = {}) {
    ensureDir();
    const topics = Array.isArray(opts.topics) ? opts.topics : [];
    const includeBase = opts.includeBase !== false;
    const slug = projectSlug(cwd);

    // 决定注入哪些文件：基础层（可选）+ 各主题层文件（去重、保持顺序）
    const files = includeBase ? [...BASE_LAYER_FILES] : [];
    for (const topic of topics) {
      for (const f of topicFiles(topic)) {
        if (!files.includes(f)) files.push(f);
      }
    }
    if (files.length === 0) return undefined;

    // 缓存键：slug + 文件顺序 + 每个文件的 mtime 签名（读 stat 很快，不读内容）
    let sig = slug + "|" + files.join(",");
    for (const f of files) {
      const full = resolve(join(root, f));
      let m = "x";
      try {
        if (existsSync(full)) m = String(statSync(full).mtimeMs);
      } catch {}
      sig += "|" + m;
    }
    const cacheKey = sig;
    const cached = digestCache.get(cacheKey);
    if (cached !== undefined) return cached;

    const parts = [];
    const presentFiles = [];
    const added = new Set();
    for (const f of files) {
      if (added.has(f)) continue;
      added.add(f);
      const content = readFileSafe(f).trim();
      if (!content) continue;
      // 去掉 frontmatter（--- 之间）与首行 # 标题
      const text = content.replace(/^---[\s\S]*?---\s*/, "").replace(/^#\s[^\n]*\n?/, "").trim();
      if (!text) continue;
      const heading = f === "user.md" ? "用户画像"
        : f === "preferences.md" ? "工作偏好"
        : f === "facts.md" ? "环境事实"
        : f.startsWith("projects/") ? `相关项目：${basename(f, ".md")}`
        : basename(f, ".md");
      parts.push(`### ${heading}\n\n${text}`);
      presentFiles.push(f);
    }
    if (parts.length === 0) return undefined;

    // 预算控制（分层优先）：
    // - 主题层（opts.topics 命中的文件）优先保证注入——用户此刻正在聊这个主题，必须读到
    // - 基础层（user/preferences）常驻但可压缩：先保主题层完整，超预算再从基础层尾部截断
    let joined = parts.join("\n\n");
    let truncated = false;
    if (Buffer.byteLength(joined, "utf8") > maxBytes) {
      const baseCount = includeBase ? BASE_LAYER_FILES.filter((f) => presentFiles.includes(f)).length : 0;
      const topicCount = presentFiles.length - baseCount;
      if (topicCount > 0) {
        // 有主题层：基础层整体让位，主题层完整保留
        const topicStart = baseCount; // parts 顺序 = files 顺序：基础层在前，主题层在后
        const topicPart = parts.slice(topicStart).join("\n\n");
        const topicBytes = Buffer.byteLength(topicPart, "utf8");
        const baseBudget = Math.max(0, maxBytes - topicBytes);
        let basePart = parts.slice(0, topicStart).join("\n\n");
        if (Buffer.byteLength(basePart, "utf8") > baseBudget && baseBudget > 200) {
          const ratio = baseBudget / Buffer.byteLength(basePart, "utf8");
          basePart = basePart.slice(0, Math.floor(basePart.length * ratio)) + "\n…(基础层截断)";
          truncated = true;
        }
        joined = [basePart, topicPart].filter(Boolean).join("\n\n");
      } else {
        // 只有基础层：整体比例截断
        const budget = Buffer.byteLength(joined, "utf8");
        const ratio = maxBytes / budget;
        joined = joined.slice(0, Math.floor(joined.length * ratio)) + "\n…(截断)";
        truncated = true;
      }
    }

    const text = [
      "<system-reminder>",
      "以下是你（dsh-memory）的跨会话记忆 digest。这些内容来自历史会话，用于了解用户及其项目。",
      "完整内容可用 memory_read / memory_search 查询；学到新的持久事实时用 memory_add 写入。",
      "",
      escapeReminder(joined),
      ...(truncated ? ["", "（记忆超出注入预算已截断，可用 memory_read 读取完整文件）"] : []),
      "</system-reminder>"
    ].join("\n");
    const result = { text, files: presentFiles, slug, topics };
    digestCache.set(cacheKey, result);
    return result;
  }

  async function ensureRepo() {
    if (!existsSync(join(root, ".git"))) {
      const ok = await runGit(["init", "-b", "main"], root);
      if (!ok.ok) warn("git init 失败：", ok.error);
    }
    // 配置了 gitRemote 且当前没有 remote 时自动添加（首次初始化/新机器场景）
    if (cfg.gitRemote) {
      const remotes = await runGit(["remote"], root);
      if (remotes.ok && !remotes.output.trim()) {
        const add = await runGit(["remote", "add", "origin", cfg.gitRemote], root);
        if (!add.ok) warn("git remote add 失败：", add.error);
      }
    }
  }

  /** 提交 + 推送（去抖 3 秒，失败仅告警不抛错）。 */
  function queueCommit(message) {
    if (!cfg.gitCommit) return;
    if (commitTimer !== undefined) clearTimeout(commitTimer);
    commitPending = true;
    commitTimer = setTimeout(() => {
      commitTimer = undefined;
      if (!commitPending) return;
      commitPending = false;
      void flushCommit(message);
    }, 3000);
  }

  async function flushCommit(message) {
    try {
      ensureRepo();
      await runGit(["add", "-A"], root);
      const status = await runGit(["status", "--porcelain"], root);
      if (!status.ok) return;
      if (!status.output.trim()) return;
      const res = await runGit([...GIT_AUTHOR, "commit", "-m", message], root);
      if (!res.ok) {
        warn("git commit 失败：", res.error);
        return;
      }
      log("已提交：", message);
      if (cfg.gitPush) {
        const remotes = await runGit(["remote"], root);
        if (remotes.ok && remotes.output.trim()) {
          const push = await runGit(["push", "-u", "origin", "HEAD"], root);
          if (!push.ok) warn("git push 失败（下次提交重试）：", push.error.trim());
          else log("已推送到远程（NAS）");
        }
      }
    } catch (error) {
      warn("记忆提交异常：", error.message);
    }
  }

  /** 立即提交（用于测试/关停前）。 */
  function flushNow() {
    if (commitTimer !== undefined) {
      clearTimeout(commitTimer);
      commitTimer = undefined;
    }
    return flushCommit("记忆更新");
  }

  ensureDir();
  void ensureRepo().catch((error) => warn("git init 异常：", error.message));
  loadMeta();
  rebuildIndex();

  return {
    root,
    add,
    read: readFileSafe,
    list: listMarkdownFiles,
    keywordSearch,
    buildDigest,
    detectTopics,
    topicFiles,
    topicLabel,
    TOPIC_ROUTES,
    BASE_LAYER_FILES,
    escapeReminder,
    listEntries,
    feedback,
    findNearDuplicates,
    consolidateDuplicates,
    markUsed,
    pruneStale,
    archiveEntry,
    searchArchive,
    listArchiveFiles,
    addSummary,
    listSummaries,
    matchSummariesByTopic,
    projectSlug,
    flushNow,
    meta: () => meta
  };
}

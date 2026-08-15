/**
 * dsh-memory: 模型可调用的记忆工具。
 *   memory_add     写入一条记忆（user/preferences/project/fact）
 *   memory_search  检索记忆（语义优先，回退关键词）
 *   memory_read    读取一个记忆文件
 *   memory_list    列出记忆文件与条目
 */
import { defineTool } from "@deepseek-ai/dsh-tools";

function textBlocks(text) {
  return [{ type: "text", text }];
}

function cwdOf(exec) {
  return exec?.agent?.session?.header?.cwd;
}

export function registerMemoryTools(ctx, cfg, store, vectors) {
  ctx.tools.register(defineTool({
    name: "memory_add",
    description:
      "写入一条跨会话持久记忆。当用户说出持久的个人事实、工作偏好、项目决策、环境信息，或你学到跨会话有价值的知识时调用。" +
      "只存持久稳定的事实，一次性的任务细节不要存；内容用简洁的 Markdown 短语，避免空话。scope 决定写入哪个记忆文件：" +
      "user=用户画像，preferences=工作偏好，project=当前项目记忆（自动定位项目），fact=通用事实。",
    parameters: {
      scope: {
        type: "string",
        required: true,
        enum: ["user", "preferences", "project", "fact"],
        description: "记忆类别：user/preferences/project/fact"
      },
      title: {
        type: "string",
        required: true,
        description: "简短标题（将作为 markdown 二级标题）"
      },
      body: {
        type: "string",
        required: true,
        description: "记忆内容（Markdown，简洁、结构化、可独立理解）"
      }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          added: { type: "boolean", required: true },
          updated: { type: "boolean", required: true },
          file: { type: "string", required: true },
          reason: { type: "string" }
        }
      },
      render: (_args, value) => textBlocks(
        value.added
          ? (value.updated ? `记忆已更新 ${value.file}` : `记忆已写入 ${value.file}`)
          : `未写入：${value.reason}（内容与已有记忆重复）`
      )
    },
    async execute(args, exec) {
      const result = store.add(args.scope, args.title, args.body, cwdOf(exec));
      if (result.added) {
        // 异步索引语义向量（不阻塞工具返回）
        void vectors.indexFile(result.file).catch(() => {});
      }
      // 只包含有值的键：undefined 值不满足 dsh 的 lossless JSON 要求
      const out = { added: result.added, updated: result.updated ?? false, file: result.file };
      if (result.reason !== undefined) out.reason = result.reason;
      return out;
    },
    presentCall: (args) => ({
      card: "generic",
      title: `写入记忆 [${args.scope}] ${args.title}`,
      kind: "other",
      rawInput: args.title
    })
  }));

  ctx.tools.register(defineTool({
    name: "memory_search",
    description:
      "跨会话记忆检索。查询过往会话中积累的关于用户、项目、决策、偏好的信息。" +
      "优先本地语义检索（Ollama 嵌入，支持中文）；语义检索不可用时回退关键词匹配。" +
      "当记忆 digest 不完整、或需要回忆历史细节时使用。",
    parameters: {
      query: {
        type: "string",
        required: true,
        description: "检索关键词或自然语言描述（如：用户对工具的偏好、futures_scanner 的架构决策）"
      },
      limit: {
        type: "number",

        description: "返回条数上限（默认 5，最大 10）"
      }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          hits: {
            type: "array",
            required: true,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                file: { type: "string", required: true },
                title: { type: "string", required: true },
                content: { type: "string", required: true },
                score: { type: "number",  },
                line: { type: "string",  },
                archived: { type: "boolean",  }
              }
            }
          }
        }
      },
      render: (_args, value) => {
        if (value.hits.length === 0) return textBlocks("没有找到相关记忆（含归档）。");
        const archivedNote = value.hits.some((h) => h.archived)
          ? "\n\n⚠️ 以上来自【归档记忆】（已过期剪枝的备份，可能过时，仅供参考）"
          : "";
        return textBlocks(
          value.hits.map((hit, i) =>
            `${i + 1}. [${hit.file}${hit.score !== undefined ? ` · 相关度 ${hit.score}` : ""}] ${hit.title}\n${hit.content.slice(0, 300)}`
          ).join("\n\n") + archivedNote
        );
      }
    },
    async execute(args, exec) {
      const limit = Math.min(Math.max(Number(args.limit) || 5, 1), 10);
      const semantic = cfg.semanticSearch ? await vectors.search(args.query, limit) : [];
      if (semantic.length > 0) return { hits: semantic };
      // 活跃记忆关键词检索
      const kw = store.keywordSearch(args.query, limit).map((hit) => ({
        file: hit.file,
        title: hit.section || hit.file,
        content: hit.line,
        line: `L${hit.lineNumber}`
      }));
      if (kw.length > 0) return { hits: kw };
      // 活跃记忆搜不到 → 回退检索归档（剪枝备份的两年前记忆，仍可回忆）
      const archived = store.searchArchive(args.query, limit).map((hit) => ({
        file: hit.file,
        title: hit.section || hit.file,
        content: hit.line,
        line: `L${hit.lineNumber}`,
        archived: true
      }));
      return { hits: archived };
    },
    presentCall: (args) => ({
      card: "generic",
      title: `检索记忆：${args.query}`,
      kind: "read",
      rawInput: args.query
    })
  }));

  ctx.tools.register(defineTool({
    name: "memory_read",
    description:
      "读取一个记忆文件的完整内容（~/.dsh/memory/ 下的 Markdown 文件）。" +
      "记忆 digest 被截断或不完整时，用本工具读取完整文件；也用于在写入前查看现有内容以避免重复。",
    parameters: {
      file: {
        type: "string",
        required: true,
        description: "记忆文件名，如 user.md、preferences.md、facts.md、projects/futures-trading-system.md"
      }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          file: { type: "string", required: true },
          content: { type: "string", required: true }
        }
      },
      render: (_args, value) => textBlocks(value.content || "（空文件）")
    },
    async execute(args, exec) {
      return { file: args.file, content: store.read(args.file) };
    },
    presentCall: (args) => ({
      card: "generic",
      title: `读取记忆文件 ${args.file}`,
      kind: "read",
      rawInput: args.file
    })
  }));

  ctx.tools.register(defineTool({
    name: "memory_list",
    description: "列出记忆库中所有的记忆文件（含标题），用于快速了解记忆全貌。",
    parameters: {},
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          files: {
            type: "array",
            required: true,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                file: { type: "string", required: true },
                title: { type: "string",  }
              }
            }
          },
          entries: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                hash: { type: "string", required: true },
                file: { type: "string", required: true },
                title: { type: "string", required: true },
                confidence: { type: "number" },
                usedCount: { type: "number" }
              }
            }
          }
        }
      },
      render: (_args, value) => textBlocks(
        value.files.length === 0
          ? "记忆库为空。"
          : value.files.map((f) => `- ${f.file}${f.title ? ` — ${f.title}` : ""}`).join("\n")
      )
    },
    async execute() {
      return {
        files: store.list().filter((f) => f !== "MEMORY.md").map((file) => {
          const content = store.read(file);
          const first = content.split("\n").find((line) => line.startsWith("# "));
          return { file, title: first ? first.replace(/^#\s*/, "").trim() : undefined };
        }),
        entries: store.listEntries().map((e) => ({
          hash: e.hash,
          file: e.file,
          title: e.title,
          confidence: e.confidence,
          usedCount: e.usedCount
        }))
      };
    },
    presentCall: () => ({
      card: "generic",
      title: "列出记忆文件",
      kind: "read"
    })
  }));

  ctx.tools.register(defineTool({
    name: "memory_feedback",
    description:
      "用后反馈：标记一条记忆是否有用（helped=有用/正确，harmful=有害/过时/错误）。" +
      "反馈会更新记忆的置信度：helped 上调、harmful 下调；置信度太低的记忆将被隔离（不再注入上下文）。" +
      "当发现注入的记忆帮助了你、或发现某条记忆过时/误导时调用，让记忆越用越准。",
    parameters: {
      hash: {
        type: "string",
        required: true,
        description: "记忆条目的 hash（从 memory_list 或 memory_search 结果中获取）"
      },
      outcome: {
        type: "string",
        required: true,
        enum: ["helped", "harmful"],
        description: "helped=这条记忆有用；harmful=这条记忆有害/过时/错误"
      },
      note: {
        type: "string",
        description: "可选：简短说明（记录在案，便于审计）"
      }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          ok: { type: "boolean", required: true },
          confidence: { type: "number" },
          usedCount: { type: "number" },
          reason: { type: "string" }
        }
      },
      render: (_args, value) => {
        if (!value.ok) return textBlocks(`反馈未生效：${value.reason ?? "未知原因"}`);
        return textBlocks(`✅ 记忆反馈已记录（${_args.outcome}），当前置信度 ${value.confidence}（使用 ${value.usedCount} 次）`);
      }
    },
    async execute(args) {
      return store.feedback(args.hash, args.outcome, args.note);
    },
    presentCall: (args) => ({
      card: "generic",
      title: `记忆反馈：${args.outcome} ${args.hash.slice(0, 8)}…`,
      kind: "other",
      rawInput: args.outcome
    })
  }));
}

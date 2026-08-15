/**
 * dsh-memory: 自动记忆提炼。
 *
 * 每隔 extractIntervalMs（且累计 extractMinTurns 轮对话后）用会话自身的
 * provider/model 发起一次一次性 LLM 调用，从最近对话中提炼新的持久事实，
 * 写入记忆库。去重由 store.add 的哈希索引保证；提炼失败仅告警，不影响会话。
 */
import { createUserMessage } from "@deepseek-ai/dsh-llm";

const SKIP_SOURCE_KINDS = new Set(["memory-digest", "agent-instructions", "session-reference", "tool"]);

const SYSTEM_PROMPT =
  "你是记忆提炼器。从用户与 AI 助手的对话中提炼值得跨会话保存的持久事实。\n" +
  "只提炼：用户的个人事实、工作偏好、项目架构决策、环境信息、明确的纠正与更新。\n" +
  "不要提炼：一次性任务细节、临时状态、寒暄、代码实现的具体步骤（除非是重要决策）。\n" +
  "输出必须是纯 JSON 数组，每个元素：{\"scope\":\"user|preferences|project|fact\",\"title\":\"简短标题\",\"body\":\"简洁的 Markdown 内容\"}。\n" +
  "没有新事实时输出 []。不要输出 JSON 以外的任何文字。";

const SUMMARY_PROMPT =
  "用一句话总结这次会话：用户在做什么、完成了什么、下一步是什么。\n" +
  "输出必须是纯 JSON 对象：{\"topic\":\"主题关键词（3-6个字，如：交易信号系统、记忆插件优化）\",\"summary\":\"一句话总结（50字以内）\"}。\n" +
  "不要输出 JSON 以外的任何文字。";

function contentToText(content) {
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

function parseJsonArray(text) {
  const cleaned = String(text).trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  const start = cleaned.indexOf("[");
  const end = cleaned.lastIndexOf("]");
  if (start === -1 || end === -1 || end <= start) return [];
  try {
    const parsed = JSON.parse(cleaned.slice(start, end + 1));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function createExtractor(ctx, cfg, store, vectors) {
  let running = false;
  const lastExtractedAt = new Map(); // sessionId -> timestamp

  function isEligible(session) {
    const last = lastExtractedAt.get(session.id);
    return last === undefined || Date.now() - last >= (cfg.extractIntervalMs ?? 30 * 60 * 1000);
  }

  async function run(session) {
    if (running || !cfg.autoExtract) return;
    if (!isEligible(session)) return;
    const events = session.events ?? [];
    if (events.length < (cfg.extractMinTurns ?? 10)) return;

    // 取最近的 request/header 得到 provider/model
    let provider, model;
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i];
      if (event.type === "request/header") {
        provider = event.data?.header?.config?.provider;
        model = event.data?.header?.config?.model;
        break;
      }
    }
    if (!provider || !model) {
      ctx.logger?.warn("[dsh-memory] 自动提炼：未找到会话的 provider/model，跳过");
      return;
    }

    // 组装最近对话（跳过注入类消息与工具消息）
    const lines = [];
    for (const event of events) {
      if (event.type === "user/message") {
        if (SKIP_SOURCE_KINDS.has(event.data?.source?.kind)) continue;
        const text = contentToText(event.data?.content);
        if (text) lines.push(`用户：${text}`);
      } else if (event.type === "assistant/message") {
        const text = contentToText(event.data?.content);
        if (text) lines.push(`助手：${text.slice(0, 600)}`);
      }
    }
    const transcript = lines.slice(-80).join("\n").slice(-14000);
    if (transcript.length < 200) return;

    running = true;
    try {
      ctx.logger?.info("[dsh-memory] 自动提炼：开始分析最近对话…");
      const messages = [createUserMessage({ content: [{ type: "text", text: `以下是最近对话（可能含中英文）：\n\n${transcript}\n\n请提炼新的持久记忆，输出 JSON 数组。` }] })];
      const stream = ctx.llm.stream({
        provider,
        model,
        messages,
        system: SYSTEM_PROMPT,
        temperature: 0.2,
        maxTokens: 800,
        signal: AbortSignal.timeout(90000)
      });
      let text = "";
      for await (const chunk of stream) {
        if (chunk.type === "text-delta") text += chunk.text;
        else if (chunk.type === "finish" && chunk.reason?.kind === "error") {
          ctx.logger?.warn("[dsh-memory] 自动提炼：模型调用失败", chunk.reason.failure?.message ?? "");
          return;
        }
      }
      const items = parseJsonArray(text);
      let added = 0;
      for (const item of items) {
        const scope = ["user", "preferences", "project", "fact"].includes(item?.scope) ? item.scope : "fact";
        const title = String(item?.title ?? "").trim();
        const body = String(item?.body ?? "").trim();
        if (!title || !body) continue;
        try {
          const result = store.add(scope, title, body, session.header?.cwd);
          if (result.added) {
            added++;
            void vectors.indexFile(result.file).catch(() => {});
          }
        } catch (error) {
          ctx.logger?.warn("[dsh-memory] 自动提炼：写入失败", error.message);
        }
      }
      lastExtractedAt.set(session.id, Date.now());
      ctx.logger?.info(`[dsh-memory] 自动提炼完成：新增 ${added} 条记忆`);
    } catch (error) {
      ctx.logger?.warn("[dsh-memory] 自动提炼异常：", error.message);
    } finally {
      running = false;
    }
  }

  /**
   * 会话摘要（轻量）：会话结束后生成 {topic, summary} 存 summaries.jsonl。
   * 不做记忆提炼——同一对话框内模型自带上下文，提炼等「新会话重复同一件事」时再做。
   */
  async function summarize(session) {
    if (running) return undefined;
    const events = session.events ?? [];
    if (events.length < 4) return undefined; // 太短的会话不值得摘要

    let provider, model;
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i];
      if (event.type === "request/header") {
        provider = event.data?.header?.config?.provider;
        model = event.data?.header?.config?.model;
        break;
      }
    }
    if (!provider || !model) return undefined;

    // 组装对话骨架（用户消息 + 助手首条回复，足够总结主题）
    const lines = [];
    for (const event of events) {
      if (event.type === "user/message") {
        if (SKIP_SOURCE_KINDS.has(event.data?.source?.kind)) continue;
        const text = contentToText(event.data?.content);
        if (text) lines.push(`用户：${text.slice(0, 200)}`);
      } else if (event.type === "assistant/message") {
        const text = contentToText(event.data?.content);
        if (text) lines.push(`助手：${text.slice(0, 300)}`);
      }
    }
    const transcript = lines.slice(-40).join("\n").slice(-6000);
    if (transcript.length < 100) return undefined;

    running = true;
    try {
      const messages = [createUserMessage({ content: [{ type: "text", text: `以下是最近对话：\n\n${transcript}\n\n请总结这次会话。` }] })];
      const stream = ctx.llm.stream({
        provider,
        model,
        messages,
        system: SUMMARY_PROMPT,
        temperature: 0.2,
        maxTokens: 200,
        signal: AbortSignal.timeout(60000)
      });
      let text = "";
      for await (const chunk of stream) {
        if (chunk.type === "text-delta") text += chunk.text;
        else if (chunk.type === "finish" && chunk.reason?.kind === "error") return undefined;
      }
      const cleaned = String(text).trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
      const start = cleaned.indexOf("{");
      const end = cleaned.lastIndexOf("}");
      if (start === -1 || end <= start) return undefined;
      const parsed = JSON.parse(cleaned.slice(start, end + 1));
      const result = {
        topic: String(parsed?.topic ?? "").trim(),
        summary: String(parsed?.summary ?? "").trim(),
        sessionId: session.id,
        cwd: session.header?.cwd
      };
      if (!result.topic) return undefined;
      store.addSummary(result);
      return result;
    } catch {
      return undefined;
    } finally {
      running = false;
    }
  }

  return { run, summarize };
}

/**
 * dsh-memory: 语义检索层。
 *
 * 嵌入模型用本地 Ollama（默认 bge-m3，中文效果好，数据不出本机），
 * 向量存 SQLite（node:sqlite，~/.dsh/memory/.vectors.sqlite）。
 * 所有操作 best-effort：Ollama 不可用或检索失败时返回空结果，
 * 上层工具自动回退到关键词检索。
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

function sha1(text) {
  return createHash("sha1").update(text).digest("hex");
}

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  const len = a.length;
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

/** 按 ## 标题把 markdown 文件切成语义块。 */
function chunkMarkdown(content) {
  const chunks = [];
  let currentTitle = "（前言）";
  let current = [];
  const flush = () => {
    const text = current.join("\n").trim();
    if (text) chunks.push({ title: currentTitle, text });
    current = [];
  };
  for (const line of content.split("\n")) {
    if (/^##\s/.test(line)) {
      flush();
      currentTitle = line.replace(/^##\s*/, "").trim();
    } else {
      current.push(line);
      if (current.join("\n").length > 1200) flush();
    }
  }
  flush();
  return chunks;
}

export function createVectorStore(ctx, cfg, store) {
  const root = store.root;
  const dbFile = join(root, ".vectors.sqlite");
  const ollamaUrl = cfg.ollamaUrl ?? "http://127.0.0.1:11434";
  const model = cfg.embedModel ?? "bge-m3";
  let db;

  function log(...args) {
    (ctx.logger ?? console).info("[dsh-memory/vectors]", ...args);
  }
  function warn(...args) {
    (ctx.logger ?? console).warn("[dsh-memory/vectors]", ...args);
  }

  function openDb() {
    if (db) return db;
    mkdirSync(root, { recursive: true });
    db = new DatabaseSync(dbFile);
    db.exec(`
      CREATE TABLE IF NOT EXISTS chunks (
        id TEXT PRIMARY KEY,
        file TEXT NOT NULL,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        embedding TEXT NOT NULL,
        updatedAt INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_chunks_file ON chunks(file);
    `);
    return db;
  }

  async function ollamaReady() {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2000);
      const res = await fetch(`${ollamaUrl}/api/tags`, { signal: controller.signal });
      clearTimeout(timer);
      return res.ok;
    } catch {
      return false;
    }
  }

  async function embed(texts) {
    const res = await fetch(`${ollamaUrl}/api/embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, input: texts })
    });
    if (!res.ok) throw new Error(`Ollama embed 失败: HTTP ${res.status}`);
    const data = await res.json();
    if (!data.embeddings || data.embeddings.length !== texts.length) {
      throw new Error("Ollama embed 返回格式异常");
    }
    return data.embeddings;
  }

  /** 索引一个记忆文件（按章节分块嵌入）。失败仅告警。 */
  async function indexFile(file) {
    try {
      if (!(await ollamaReady())) return false;
      const content = store.read(file);
      if (!content.trim()) return false;
      const chunks = chunkMarkdown(content);
      if (chunks.length === 0) return false;
      const dbc = openDb();
      dbc.prepare("DELETE FROM chunks WHERE file = ?").run(file);
      // 分批嵌入，避免一次请求过大
      const BATCH = 8;
      for (let i = 0; i < chunks.length; i += BATCH) {
        const batch = chunks.slice(i, i + BATCH);
        const vectors = await embed(batch.map((c) => c.text));
        const upsert = dbc.prepare(
          "INSERT OR REPLACE INTO chunks (id, file, title, content, embedding, updatedAt) VALUES (?, ?, ?, ?, ?, ?)"
        );
        for (let j = 0; j < batch.length; j++) {
          const c = batch[j];
          upsert.run(sha1(file + c.title + c.text.slice(0, 200)), file, c.title, c.text, JSON.stringify(vectors[j]), Date.now());
        }
      }
      log(`已索引 ${file}（${chunks.length} 块）`);
      return true;
    } catch (error) {
      warn(`索引 ${file} 失败：`, error.message);
      return false;
    }
  }

  /** 语义检索：query 嵌入后与所有块做余弦相似度（注意力式读取的核心）。
   *  @param qvec - 可选：已算好的 query 嵌入向量，避免重复调用 Ollama。
   */
  async function search(query, limit = 5, qvec) {
    try {
      if (!(await ollamaReady())) return [];
      if (qvec === undefined) {
        const [qv] = await embed([String(query)]);
        qvec = qv;
      }
      const dbc = openDb();
      const rows = dbc.prepare("SELECT file, title, content, embedding FROM chunks").all();
      const scored = [];
      for (const row of rows) {
        let vec;
        try {
          vec = JSON.parse(row.embedding);
        } catch {
          continue;
        }
        const score = cosine(qvec, vec);
        if (Number.isFinite(score)) scored.push({ file: row.file, title: row.title, content: row.content, score });
      }
      scored.sort((a, b) => b.score - a.score);
      return scored.slice(0, limit).map((hit) => ({ ...hit, score: Math.round(hit.score * 1000) / 1000 }));
    } catch (error) {
      warn("语义检索失败：", error.message);
      return [];
    }
  }

  /** 删除文件的所有向量块。 */
  function removeFile(file) {
    try {
      const dbc = openDb();
      dbc.prepare("DELETE FROM chunks WHERE file = ?").run(file);
    } catch {
      /* best-effort */
    }
  }

  /** 检查 sqlite 文件是否可写（健康检查）。 */
  function healthy() {
    try {
      openDb();
      return true;
    } catch {
      return false;
    }
  }

  return { indexFile, search, removeFile, healthy, embed };
}

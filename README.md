# dsh-memory

DeepSeek Harness（DSH）跨会话记忆插件 v1.0.0 —— **注意力式按需读取 + 压缩写入 + 自我维护**。

> 记忆不是黑盒：Markdown 人类可读、git 可回溯、token 成本按话题走，不按会话走。

## ✨ 能力一览

| 环节 | 机制 | 成本 |
|------|------|------|
| **写入** | 压缩提炼（title + body），不存原文 | 一次性 |
| **读取** | 注意力机制：语义检索（bge-m3 嵌入 + 余弦相似度），阈值 0.58 才注入 | 按需 |
| **注入封顶** | 最多 3 块 / 2400 字节，记忆再多成本恒定 | 锁死 |
| **会话摘要** | 会话结束生成一行摘要；新窗口重复同一任务时自动恢复 | 轻量 |
| **巩固** | 定时合并重复条目，记忆自我瘦身 | 零 LLM |
| **反馈** | 用后反馈（helped/harmful）更新置信度，低置信隔离 | 零成本 |
| **剪枝** | 30 天未用 → 归档到 archive/（不删除），随时可检索回来 | 零成本 |
| **同步** | git 自动提交 + 推送（NAS 备份） | 零成本 |

## 📦 安装

### 方式一：插件包安装

```bash
dsh plugin --profile web add dsh-memory
dsh web
```

### 方式二：本地目录（推荐，便于查看/修改源码）

1. 把插件包放到 `<profile>/plugins/dsh-memory/`（profile 默认 `~/.dsh/profiles/web/`）
2. 在 `<profile>/cordis.patch.yml` 注册（参考 `cordis.patch.yml` 示例）
3. 重启 dsh web

## ⚙️ 配置

| 配置项 | 默认 | 说明 |
|--------|------|------|
| `memoryDir` | `~/.dsh/memory` | 记忆仓库（Markdown + git） |
| `gitRemote` | 空 | NAS/远程备份仓库地址 |
| `attentionThreshold` | `0.58` | 语义检索注入阈值（调高更省、调低更勤） |
| `maxAttentionBlocks` | `3` | 单次最多注入记忆块数 |
| `maxAttentionBytes` | `2400` | 单次注入体积上限 |
| `lowConfidenceThreshold` | `0.25` | 置信度低于此值的记忆隔离 |
| `pruneStaleDays` | `30` | 未使用天数超过此值 → 归档（不删除） |
| `consolidateIntervalMs` | `6h` | 记忆巩固 + 剪枝周期 |

## 🛠️ 模型工具

| 工具 | 作用 |
|------|------|
| `memory_add` | 写入记忆（压缩正文） |
| `memory_search` | 检索记忆（语义 → 关键词 → 归档回退） |
| `memory_read` | 读取记忆文件全文 |
| `memory_list` | 列出记忆文件与条目（含 hash/置信度） |
| `memory_feedback` | 用后反馈：helped / harmful → 置信度更新 |

## 🗂️ 数据布局

```
~/.dsh/memory/
├── user.md              # 用户画像
├── preferences.md       # 工作偏好
├── facts.md             # 环境事实
├── projects/*.md        # 项目记忆
├── summaries.jsonl      # 会话摘要库（重复任务检测）
├── archive/             # 剪枝归档（可检索回来）
├── .meta.json           # 条目索引（含置信度/使用统计）
└── .vectors.sqlite      # 语义向量库（bge-m3）
```

## 🔧 架构

```
写入层   会话摘要（结束轻量生成）+ 重复任务检测（新窗口命中才总结）
存储层   Markdown + git 同步 + summaries.jsonl + archive/ 归档库
巩固层   重复合并 + 30 天归档剪枝（备份不删除）
读取层   注意力语义检索 + 3 块/2400B 封顶 + 置信度过滤 + 摘要恢复
学习层   用后反馈 + 注入续命 + 归档回退检索
成本层   零常驻 + 同对话框零总结 + 归档零成本
```

## 🙏 欢迎指正与改进

本项目是个人在 DeepSeek Harness 插件生态中的学习实践，机制设计参考了：
- Claude Code 的 CLAUDE.md + Auto Memory 双轨制
- OpenAI Codex 的 AGENTS.md + Memories（空闲总结、过期剪枝、密钥擦除）
- Kimi 的 Context Caching 成本优化思路
- 社区插件 dsh-mneme（autoDream 巩固）、dsh-memory-gate（置信度门控）

**欢迎大神们指正、批评、提出改进意见！** 任何问题（Issue）、建议、PR 都非常欢迎：
- 注意力阈值标定是否合理？（当前 0.58）
- 会话摘要的重复任务检测是否够准？
- 置信度反馈机制有没有更好的设计？
- token 成本还能怎么省？

请到 [Issues](../../issues) 开贴，或直接提 PR。

## 📄 License

MIT

# Amy Creator Studio 写作控制改进设计

状态：提案（Proposed）
最后更新：2026-08-19
适用分支：`codex/codex-subscription`

本文档定义 Amy Creator Studio 在现有 Character Card、World Info、Story
Plan、Story State、原子记忆和 checkpoint 工作流之上的写作控制改进方案。
目标是让 Agent 稳定理解作者偏好，同时减少人物特征、意象、句式和剧情提示
被不必要地反复表现。

本文是实现设计，不代表功能已经完成。现有用户操作规范仍以
[`CREATOR_STUDIO_WORKFLOW.md`](./CREATOR_STUDIO_WORKFLOW.md) 为准。

## 1. 背景与问题

当前实现已经具备以下基础：

- Character Card V3 与关联 World Info；
- 可审核的原子记忆与 `amy_story_state_v1`；
- `amy_story_plan_v1`，完整计划保存在聊天元数据中；
- 只把当前章、当前场景、目标、约束和共享 `styleGuide` 镜像到一个活动
  Story Plan 世界书条目；
- 所有持久化写入需要用户确认；
- checkpoint、分支隔离和来源聊天校验。

现有 Story Plan 解决了“当前要写什么”，但还没有完整解决“应该怎样写”和
“哪些已知事实本轮不应主动表现”。主要痛点如下。

### 1.1 写作偏好缺少结构

`styleGuide` 当前是自由文本数组，无法可靠表达：

- 硬约束与软偏好的区别；
- 全书、章节、场景和局部 Beat 的作用域；
- 适用条件、排除条件和冲突优先级；
- 对话、动作、心理和环境描写的目标范围；
- 正面范例、反例和作者认可的声音；
- 一条技巧在同一场景中允许出现多少次。

把全部偏好长期拼进一个高优先级常驻提示，会增加上下文成本，也可能让模型
把“可选技巧”误当成“每段必须展示的内容”。

### 1.2 参考事实与表现指令混在一起

人物卡中的外貌、性格和背景是稳定事实。模型需要知道这些事实以保持一致，
但“知道”不等于“本轮必须描写”。如果一条具体外貌长期出现在固定上下文中，
模型可能在无剧情原因时反复提及，或用同义表达重复提及。

### 1.3 比例不是可直接执行的指令

“感情线占 25%”或“对话占 40%”如果只作为自然语言提示，模型很难在长篇
范围内稳定满足。比例需要转换成章节/场景预算，并根据已完成内容动态修正。

### 1.4 缺少可观测性

作者目前很难确认：

- 本轮究竟注入了哪些规则；
- 某条规则为什么被选中；
- 哪些未来剧情被排除；
- 某个人物事实最近是否已经表现过；
- 当前场景对全章目标比例造成了什么影响。

## 2. 设计目标

### 2.1 必须实现

1. 用结构化、可审核、可导入导出的格式保存写作偏好。
2. 每次只编译当前场景需要的最小写作上下文。
3. 明确区分正史事实、作者计划、写作规则和本轮表现许可。
4. 支持人物特征与写作技巧的触发条件、次数上限和场景冷却。
5. 把比例转换成范围和场景预算，而不是要求模型直接维持全书百分比。
6. 向用户展示“本轮 Agent 实际看到的写作上下文”及选择原因。
7. 保持现有确认、来源聊天校验、分支隔离和无 Story Plan 降级行为。
8. 优先使用 SillyTavern 原生 World Info、聊天元数据和 Prompt 机制，不引入
   新数据库或外部服务。

### 2.2 非目标

- 不直接修改闭源模型内部 attention head。
- 不承诺自然语言生成严格达到数学比例。
- 不自动重写用户已接受的正文。
- 不从正文推断并永久保存作者偏好。
- 不把完整 Writing Profile、完整 Story Plan 或未来章节注入每轮上下文。
- 不引入第二套分支图、角色卡格式或世界书存储格式。
- 第一阶段不依赖 embeddings 决定硬性写作规则；硬规则必须是确定性的。

## 3. 核心原则

### 3.1 存储完整，注入最小

完整计划、完整偏好、统计账本都可以保存在聊天元数据中；每轮只注入经过
编译的当前场景子集。

### 3.2 事实只保证一致性，指令才要求表现

上下文必须给信息标注职责：

- `canon_reference`：只用于一致性，不要求主动写出；
- `author_intent`：当前计划，不是已经发生的事实；
- `writing_contract`：全局硬规则；
- `scene_directive`：当前场景的局部写法；
- `portrayal_permission`：当前场景允许表现的稳定事实；
- `suppression`：由于冷却、上限或缺少触发条件，本轮不应主动表现的内容。

### 3.3 权重用于选择，不直接交给模型

`priority: 80` 用来让编译器选择规则，不应原样变成“请以 80% 权重遵守”。
模型只接收最终选中的自然语言规则和可执行范围。

### 3.4 硬规则确定性，软偏好可变化

- POV、时态、内容边界和禁止提前揭示属于硬规则；
- 感官描写、句式节奏、意象选择属于软偏好；
- Trigger Probability 和 Inclusion Group 只用于可接受变化的软偏好；
- 正史、剧情约束和安全边界不得依赖概率。

### 3.5 先规则选择，再生成，再审校

不要让一次模型调用同时负责读取全书、规划、写作、统计和自我纠错。推荐流程
为：上下文编译 → 正文生成 → 可选审校 → 用户决定是否接受或局部修改。

## 4. 总体架构

```text
Writing Profile library (extension settings, reusable templates)
                         │ apply as reviewed snapshot
                         ▼
Chat metadata ──────────────────────────────────────────────┐
  ├─ Story Plan v1                                         │
  ├─ Story Plan progress                                   │
  ├─ reviewed Writing Profile v1                            │
  ├─ Narrative Ledger v1                                   │
  └─ Story State v1                                        │
                                                            ▼
                                                Context Compiler
                                                            │
                         ┌──────────────────────────────────┼──────────────┐
                         ▼                                  ▼              ▼
               active plan focus                 selected rules   portrayal policy
                         └──────────────────────────────────┼──────────────┘
                                                            ▼
                                      one replaceable active context entry
                                                            │
                                                            ▼
                                                   model generation
                                                            │
                                               optional critic / scene close
                                                            │ reviewed save
                                                            ▼
                                                  Narrative Ledger update
```

实现上将复杂的纯逻辑从当前 `studio-core.js` 中拆出，避免继续扩大单文件：

- `public/scripts/extensions/third-party/codex-oauth/studio-writing-core.js`
  - schema 规范化；
  - 规则选择；
  - 比例预算计算；
  - 上下文编译；
  - ledger 合并；
  - 不访问 DOM、网络、SillyTavern 全局状态。
- `public/scripts/extensions/third-party/codex-oauth/studio-writing.js`
  - Writing Profile UI；
  - chat metadata 持久化；
  - 世界书同步；
  - 上下文预览；
  - 与现有 `studio.js` 的窄接口。
- `plugins/codex-oauth/tests/studio-writing-core.test.js`
  - 使用 Node 内置测试运行器测试纯函数。

现有 `studio.js` 继续负责顶层编排和生命周期，不复制 schema 逻辑。

## 5. 数据模型

### 5.1 Writing Profile

新增 schema：`amy_writing_profile_v1`。

```json
{
  "schema": "amy_writing_profile_v1",
  "id": "restrained-third-person",
  "name": "克制的第三人称限知",
  "contract": {
    "language": "zh-CN",
    "pov": "第三人称限知",
    "tense": "过去时",
    "narrativeDistance": "近距离",
    "hardRules": [
      "不得写出当前 POV 人物无法知道的信息",
      "不得提前实现未到当前场景的 Story Plan 事件"
    ]
  },
  "rules": [
    {
      "id": "emotion-through-action",
      "label": "用动作承载情绪",
      "instruction": "优先通过动作、停顿和环境互动表现情绪，避免紧接着解释同一情绪。",
      "kind": "soft",
      "priority": 80,
      "scope": "scene",
      "includeTags": ["dialogue", "conflict", "aftermath"],
      "excludeTags": ["outline-only"],
      "maxApplicationsPerScene": 3
    }
  ],
  "targets": [
    {
      "id": "dialogue-share",
      "metric": "dialogue_word_share",
      "scope": "chapter",
      "min": 0.3,
      "max": 0.45
    }
  ],
  "portrayalPolicies": [
    {
      "id": "stable-appearance",
      "label": "稳定外貌",
      "mode": "reference_only",
      "includeTags": ["first-observation", "appearance-change", "physical-consequence"],
      "maxMentionsPerScene": 1,
      "cooldownScenes": 3,
      "matchTerms": []
    }
  ],
  "examples": [
    {
      "id": "tense-dialogue-example",
      "label": "克制的紧张对话",
      "tags": ["dialogue", "conflict"],
      "text": "示例正文……",
      "notes": "短句、停顿和动作推进，不解释已经表现出的情绪。"
    }
  ]
}
```

#### 字段约束

- `id`：小写 ASCII、数字、`-`、`_`，最多 80 字符；同层唯一。
- `hardRules`：最多 20 条，每条最多 500 字符。
- `rules`：最多 100 条；每轮最多选择 6 条软规则。
- `kind`：`hard | soft`。`hard` 规则不可使用概率选择。
- `scope`：`global | chapter | scene | beat`。
- `priority`：0–100，仅用于本地排序。
- `includeTags` / `excludeTags`：确定性匹配当前场景标签。
- `targets`：范围必须满足 `0 <= min <= max <= 1`。
- `examples`：最多 30 段，每段正文最多 2,000 字符；每轮最多选择 2 段，
  合计受上下文预算限制。
- `matchTerms`：仅用于本地检测直接或近似复述，不自动作为提示词反复注入。

### 5.2 Story Plan v1 的兼容扩展

不更改 `amy_story_plan_v1` 的核心语义，只允许 Chapter 和 Scene 新增可选字段：

```json
{
  "tags": ["dialogue", "conflict", "first-observation"],
  "styleRuleIds": ["emotion-through-action"],
  "disabledStyleRuleIds": ["lyrical-environment"],
  "targetOverrides": {
    "dialogue_word_share": [0.4, 0.55]
  },
  "portrayalTriggers": ["stable-appearance"]
}
```

兼容规则：

- 旧计划没有这些字段时行为不变；
- 当前 `styleGuide` 继续接受；
- 编译时把 `styleGuide` 转成 `legacy-soft` 规则候选，但不再无条件全部注入；
- 未识别的 rule ID 产生预览警告，不导致旧计划无法使用；
- 规范化仍不得保留未来章节到活动上下文。

### 5.3 Narrative Ledger

新增 schema：`amy_narrative_ledger_v1`。

```json
{
  "schema": "amy_narrative_ledger_v1",
  "sceneIndex": 12,
  "chapterId": "chapter-3",
  "acceptedMetrics": {
    "words": 8240,
    "dialogueWords": 2810,
    "actionWords": 1920,
    "interiorityWords": 1180
  },
  "factMentions": {
    "stable-appearance": {
      "lastSceneIndex": 11,
      "countInCurrentScene": 0,
      "countInChapter": 2
    }
  },
  "recentMotifs": [
    { "text": "雨声", "lastSceneIndex": 11 },
    { "text": "指尖发冷", "lastSceneIndex": 10 }
  ],
  "recentPhrases": [
    { "text": "空气仿佛凝固", "lastSceneIndex": 11 }
  ]
}
```

Ledger 不是正史，不能覆盖 Story State。它只记录已接受正文的写作统计和近期
表现痕迹。更新规则如下：

- 默认在“保存已审核场景收束草稿”时一并更新；
- 未经确认的模型输出不得进入 Ledger；
- 用户可以在保存前编辑或删除错误检测；
- checkpoint 继承 Ledger；分支在世界书隔离后仍通过各自聊天元数据独立推进；
- 删除或重写历史正文后，系统应把 Ledger 标记为 `stale`，提示重新分析，而
  不是静默相信旧统计。

### 5.4 聊天状态

在现有 Creator Studio chat metadata 中新增：

```json
{
  "writingProfile": {},
  "pendingWritingProfile": "",
  "writingProfileSourceId": "",
  "writingControlActive": false,
  "narrativeLedger": {},
  "compiledWritingContext": {
    "text": "",
    "reasons": [],
    "warnings": [],
    "sourceHash": ""
  }
}
```

可复用 Profile 模板保存在用户级 extension settings；应用模板时，把审核后的
快照复制到聊天元数据。聊天快照是当前作品的权威版本，后续修改模板不得静默
改变已有作品。

## 6. Context Compiler

### 6.1 输入

- 已审核 Writing Profile；
- Story Plan 与当前 progress；
- 当前 Story State；
- Narrative Ledger；
- 当前 Scene 的 tags、显式 rule IDs、target overrides 和 portrayal triggers；
- 当前用户指令，但用户文本不得被永久写回 Profile；
- 上下文预算。

### 6.2 确定性选择顺序

1. 加入 `contract` 和全部硬规则。
2. 加入当前用户明确要求且不违反更高层约束的规则。
3. 加入 Scene/Chapter 的显式 `styleRuleIds`。
4. 排除 `disabledStyleRuleIds` 和 `excludeTags` 命中的规则。
5. 对 `includeTags` 命中的软规则评分：
   - Scene 显式选择：+1000；
   - Scene tag 命中：每个 +100；
   - Chapter tag 命中：每个 +30；
   - `priority`：直接加分；
   - 已达到场景次数上限：排除；
   - 处于冷却：排除。
6. 按分数、priority、稳定 ID 排序，最多选择 6 条软规则。
7. 在匹配的示例中最多选择 2 段；超预算时先删示例，再删低优先级软规则，
   不删除硬规则和当前场景剧情约束。

同样输入必须产生同样输出，便于复现、测试和解释。

### 6.3 人物事实表现判定

对于每个 `portrayalPolicy`：

1. 当前场景是否显式包含对应 `portrayalTriggers` 或匹配 `includeTags`；
2. 是否达到 `maxMentionsPerScene`；
3. 是否仍处于 `cooldownScenes`；
4. 当前 Story State 是否显示该事实发生变化或对动作有物理影响；
5. 若无触发条件，只输出通用规则：稳定外貌和背景仅用于一致性，本场不主动
   重述；不要在 suppress 指令中反复列出具体外貌词。

第一阶段不尝试自动理解任意 Character Card 中的每一个事实。只有用户在
Writing Profile 中创建了 portrayal policy，或将来通过可审核迁移草稿显式
建立关联，才启用次数与冷却控制。

### 6.4 比例预算

比例只在 Scene 或 Chapter 范围内作为目标区间处理。

编译器根据 Ledger 计算当前欠账：

```text
currentShare = acceptedMetric / acceptedWords
targetMidpoint = (min + max) / 2
direction = targetMidpoint - currentShare
```

然后生成可执行的当前场景范围，例如：

```text
本场预计约 1,000–1,200 字。对话约 350–500 字；不要为了达到比例填充无效对白。
```

约束：

- 输出范围必须 clamp 到合理区间；
- 当历史样本不足时直接使用 Profile 范围，不进行欠账修正；
- 不向模型发送全章原始计数；
- 情节线占比优先转换成 Scene/Beat 数量，而不是词级百分比；
- 比例只能作为软目标，剧情因果和场景完整性优先。

### 6.5 编译输出

建议每轮活动上下文使用固定分区，避免自然语言混成一段：

```text
[WRITING CONTRACT]
- POV: 第三人称限知；只写当前 POV 可感知或推断的信息。
- Tense: 过去时。

[CURRENT AUTHOR INTENT — NOT CANON]
- Chapter: 失踪的港口
- Scene: 空白海图
- Goals: 取得第一条可验证线索。
- Constraints: 幕后人物不能正式登场。

[ACTIVE PROSE DIRECTIONS]
- 优先通过动作、停顿和环境互动表现情绪。
- 对话约占本场 35%–50%，不要用无效对白凑比例。

[REFERENCE REALIZATION POLICY]
- 稳定人物外貌和背景只用于一致性；除非本场标记了观察、变化或物理影响，
  不要主动重述。

[RECENT REPETITION GUARD]
- 避免再次使用最近场景已高频出现的雨声和“空气凝固”意象；选择与本场动作
  有因果关系的新细节。
```

预算建议：

| 分区 | 建议上限 |
|---|---:|
| Writing Contract | 250 tokens |
| 当前章/场景意图 | 350 tokens |
| Active Prose Directions | 250 tokens |
| 表现与重复策略 | 150 tokens |
| 示例 | 剩余预算，最多 2 段 |
| 总计 | 默认不超过 1,000 tokens |

优先调用 SillyTavern 现有 token estimator；不可用时使用保守字符上限作为降级。

## 7. SillyTavern 原生能力映射

### 7.1 第一阶段采用

| SillyTavern 能力 | 用法 |
|---|---|
| Chat metadata | 保存完整 Profile、Plan、Ledger 和编译预览 |
| Chat-bound World Info | 保存一个可替换的活动写作上下文条目 |
| Constant entry | 只常驻“已编译的最小活动上下文”，不常驻完整 Profile |
| Insertion order / position | 初期维持当前兼容位置；通过预览和 eval 决定是否调整 |
| Confirmation popup | 保存 Profile、启用/刷新/停用活动上下文时继续确认 |
| Checkpoint | 继承 chat metadata；分支写入前继续要求世界书隔离 |

活动条目建议改名为 `Amy Active Writing Context v1`。迁移时同时识别并清理旧的
`Amy Active Story Plan v1`，避免两个常驻条目并存。

### 7.2 第二阶段可采用

| 能力 | 合适用途 | 限制 |
|---|---|---|
| Sticky | 一个局部技巧在连续多轮组成的同一场景中保持 | 不代表模型已经实际使用该技巧 |
| Cooldown | 防止同一可选技巧或 lore 条目连续重新注入 | 不能识别同义改写，仍需 Ledger |
| Delay | 避免某些风格或剧情提示在故事开头过早启用 | 以消息数而非场景数计算 |
| Inclusion Group | 多个可替代风格技巧同时命中时只取一个 | 硬规则不得随机选择 |
| Group Scoring | 匹配更具体场景标签的规则胜出 | 需要稳定的 tags |
| Trigger Probability | 低风险的创意变化 | 不用于正史、边界和剧情约束 |
| Outlet | 高级用户精确决定注入位置 | 依赖 Prompt Manager 配置，首版不强制 |
| Vectorized entries | 历史记忆和模糊相关资料 | 不用于决定硬规则；检索结果不可完全预测 |

### 7.3 不直接采用 Phrase Bias

NovelAI 的 Phrase Bias 和“生成后撤销 bias”适合控制特定 token，但 Codex
订阅兼容接口当前没有稳定公开的逐 token bias 合同。不得为了模仿该功能向
凭证桥接增加未经验证的私有参数。首版使用 Ledger、规则选择和可选 Critic
实现语义层控制。

## 8. 用户体验

### 8.1 默认简单模式

在 Creator Studio 增加“写作控制”页：

1. Profile：选择模板、从模板复制、导入、导出。
2. 基础声音：语言、POV、时态、叙述距离。
3. 偏好规则：可排序的规则列表，每条显示作用域、优先级和触发标签。
4. 比例目标：使用范围输入，不使用单点百分比。
5. 表现控制：默认提供“稳定外貌仅在相关时描写”的开关和冷却场景数。
6. 风格样例：粘贴短样例并添加标签、备注。
7. 高级 JSON：可查看和编辑完整 `amy_writing_profile_v1`。

默认工作流：

1. 选择或创建 Profile；
2. 审核草稿；
3. 保存到当前聊天；
4. 在 Planning 页选择当前 Scene；
5. 查看“本轮上下文预览”；
6. 确认启用；
7. 正常写作；
8. 场景结束时在现有 Scene Close 流程中审核 Ledger 更新。

### 8.2 Context Inspector

预览必须展示：

- 完整编译文本；
- token/字符估算；
- 每条规则的来源：硬规则、Scene 显式选择、tag 命中或 legacy styleGuide；
- 被排除规则及原因：冷却、次数上限、排除标签、预算或显式禁用；
- 是否包含未来章节：必须始终显示 `No`；
- 活动条目写入的目标世界书名称；
- source hash，用于判断保存后是否因 Profile、Plan 或 Ledger 变化而过期。

任何编译警告都不得阻止用户查看和复制预览；只有结构非法、来源聊天变化或
未来计划泄漏才阻止启用。

### 8.3 可选 Critic

Critic 默认关闭，开启后只生成审核报告，不自动改正文：

```json
{
  "unnecessaryFactMentions": [
    { "policyId": "stable-appearance", "excerpt": "……", "reason": "与动作和 POV 无关" }
  ],
  "repeatedMotifs": [],
  "ruleViolations": [],
  "targetEstimates": {
    "dialogue_word_share": 0.42
  },
  "suggestedEdits": []
}
```

用户可以选择忽略、复制建议或对选中段落进行局部重写。Critic 失败不得阻止
保留初稿，也不得把报告自动写入正史或长期记忆。

## 9. 持久化与安全边界

- Profile 模板存储在现有用户级 extension settings，不含 API Key。
- 当前作品的已审核 Profile 快照和 Ledger 存储在 chat metadata。
- 活动编译文本存入当前聊天绑定的 World Info，按固定 comment 原地更新。
- Profile 样例和正文片段视为私密创作内容：不得进入服务器日志、审计摘要或
  凭证文件。
- 本地审计只记录动作类型、Profile ID、Scene ID、规则数量和状态，不记录
  样例、正文、完整提示或模型输出。
- 导出 Profile 必须由用户显式触发；不得随 Character Card 自动导出作者的
  私有风格样例。
- 异步编译、Critic 或模型结果返回后必须重新验证 source chat。
- 分支未隔离聊天世界书时，不得写入不同的活动上下文、Story State 或 Ledger。

## 10. 兼容与迁移

### 10.1 无 Profile

没有 Writing Profile 时：

- 现有 Character、World Info、Memory、Story State、Story Plan 和 checkpoint
  行为保持不变；
- 不创建活动写作上下文条目；
- 现有 Story Plan 仍可按当前实现启用。

### 10.2 旧 Story Plan `styleGuide`

第一次打开写作控制页时可以准备迁移草稿：

- 每个 `styleGuide` 字符串转换为一条 `legacy-style-N` soft rule；
- `scope = global`，`priority = 50`；
- 不自动保存、不删除原字段；
- 用户确认 Profile 后，编译器优先使用 Profile；
- 为兼容导出，原 Story Plan `styleGuide` 继续保留，直到未来明确版本迁移。

### 10.3 活动世界书条目

- 启用新写作控制时查找旧 `STORY_PLAN_ENTRY_COMMENT`；
- 用户确认后，将其内容迁移为新的活动写作上下文条目或原地替换；
- 同一聊天世界书最多存在一个 Studio 活动上下文条目；
- 停用时同时清理新旧 comment，完整 Plan/Profile 仍保留在 metadata；
- 保存或同步失败时不改变旧条目和 pending draft。

### 10.4 Schema 策略

- 只增加可选字段时保持 v1；
- 改变字段语义或删除字段才创建 v2；
- 所有 normalize 函数必须返回新对象，不修改调用方输入；
- 未知 namespaced extension 字段继续保留；
- 规范化必须有数量、长度和类型上限，防止异常 JSON 占满上下文或 UI。

## 11. 测试与评估

### 11.1 单元测试

至少覆盖：

- Writing Profile JSON 与对象输入规范化；
- 重复 ID、非法范围、过长字段和未知枚举；
- 旧 `styleGuide` 迁移草稿；
- 硬规则始终保留；
- include/exclude tags 与显式规则优先级；
- 冷却、场景次数上限和稳定排序；
- 示例和规则超预算裁剪；
- 比例欠账计算与 clamp；
- 无历史数据时的降级；
- portrayal trigger 与 reference-only 行为；
- 编译内容不含 future chapter、完整 premise 和 `authorPlans`；
- 相同输入产生相同文本和 source hash；
- Ledger 合并、stale 标记和 checkpoint 元数据继承；
- 新旧活动条目 comment 迁移。

### 11.2 集成测试

- 无 Profile、无 Plan、只有 Profile、只有 Plan、两者都有四种组合；
- 保存、启用、刷新和停用均要求确认；
- 模型返回前切换聊天时拒绝落盘；
- 分支共享世界书时阻止不同活动上下文写入；
- Profile 模板变更不修改已有聊天快照；
- locale 英文、简体中文、繁体中文 key 集合一致；
- Context Inspector 与实际世界书内容一致；
- server log 不含 Profile 示例、正文和完整编译提示。

### 11.3 创作行为回归集

建立固定的小型 eval corpus，不以单次主观感受替代回归：

1. **稳定外貌过度提及**：人物卡含一个显著外貌特征，连续生成 10 个与外貌
   无关的场景，比较启用控制前后的无必要提及率。
2. **必要触发**：首次见面、伪装识别、受伤变化和物理影响场景必须允许表现。
3. **同义复述**：检测直接词和语义改写，避免只通过关键词测试。
4. **风格作用域**：对话规则不能泄漏到纯大纲整理；动作场景规则不能永久
   影响后续安静场景。
5. **比例目标**：用多个场景观察章节范围趋势，不要求单段精确命中。
6. **未来剧情隔离**：当前场景输出不得提及后续章节专有事实。
7. **长上下文**：历史和世界书增大后，当前硬规则和 Scene intent 仍可用。

首版验收建议：

- 未来剧情泄漏测试为 0；
- 活动上下文默认不超过 1,000 tokens；
- 每轮 soft rules 不超过 6，样例不超过 2；
- 无关场景中的显著外貌提及率相对基线下降至少 50%；
- 必要触发场景保持人物一致性，不因 suppress 规则完全丢失事实；
- 所有写入、切换聊天和分支保护测试通过。

行为 eval 结果受模型版本和采样影响，报告必须记录模型、reasoning effort、
速度模式、上下文配置和运行日期。

## 12. 分阶段实施

### Phase 1：Profile、编译器与预览

- 新增 `amy_writing_profile_v1` 纯函数与测试；
- 新增 Profile 简单模式和高级 JSON；
- 扩展 Story Plan 可选 tags/rule IDs；
- 编译最小活动上下文；
- 新增 Context Inspector；
- 保持 current Story Plan entry 兼容迁移；
- 暂不实现 Critic 和自动 Ledger 分析。

交付价值：作者可以可靠表达偏好，并知道本轮哪些规则进入了上下文。

### Phase 2：Portrayal Policy 与 Narrative Ledger

- Scene Close 草稿增加可审核 Ledger delta；
- 加入事实提及次数、场景冷却和近期意象；
- 支持首次观察、变化和物理影响 tags；
- 根据 Ledger 调整当前场景目标范围；
- 必要时映射 World Info Sticky/Cooldown，但 Ledger 仍是场景级权威。

交付价值：直接解决稳定外貌、意象和技巧的反复表现。

### Phase 3：可选 Critic 与局部修订

- 新增只读 Critic 报告；
- 支持选中问题段落局部修订；
- 不自动接受修改，不自动更新正史；
- 记录安全、成本和延迟指标。

交付价值：覆盖同义复述、隐性风格偏移和难以纯规则检测的问题。

### Phase 4：高级原生集成

- Inclusion Group / Group Scoring 风格变体；
- Sticky/Cooldown UI 映射；
- Outlet 和 Prompt Manager 高级放置；
- 大型风格样例库的本地检索；
- 在有充分 eval 后再考虑自动推荐规则，推荐仍必须审核。

## 13. 维护不变量

后续实现必须保持：

- Profile、Plan、State、Ledger 四种数据职责不混用；
- `canon_reference` 不自动变成 `scene_directive`；
- 完整 Profile 和未来 Plan 不进入活动世界书条目；
- `authorPlans` 不进入角色可见上下文；
- 相同输入的编译结果稳定且可解释；
- 硬规则不受概率、embeddings 或随机 group selection 控制；
- 任何自动分析都先形成草稿，用户确认后才持久化；
- 不新增服务端凭证，不记录私密正文和风格样例；
- 没有启用写作控制时现有功能行为不变；
- 不要求用户理解 token、World Info position 或 prompt internals 才能使用默认模式；
- UI 只暴露常用概念，高级字段保留在 JSON 和 Context Inspector；
- 纯逻辑放在 `studio-writing-core.js`，DOM 和持久化不进入纯函数；
- 英文、简体中文、繁体中文同步维护；
- 修改后运行插件测试、目标 ESLint、locale JSON 解析、`git diff --check` 和
  创作行为回归集。

## 14. 关键设计决策

### 为什么不直接扩大 `styleGuide`

自由文本适合作为迁移入口，不适合承担作用域、优先级、触发、冷却、比例和
可观测性。保留它用于兼容，但长期权威应是 Writing Profile。

### 为什么 Profile 模板与聊天快照分开

模板便于复用；快照避免作者调整模板后，旧作品的文风和生成行为突然改变。

### 为什么只保留一个活动世界书条目

一个原地更新的编译结果更容易预览、回滚、停用和分支隔离，也避免大量生成
条目与用户已有 World Info 混杂。具体人物 lore 仍由原生世界书管理。

### 为什么不完全依赖 World Info Cooldown

Cooldown 记录“条目是否注入”，不知道模型是否真的使用了该事实，也无法识别
同义表达。它是有用的底层信号，但不能替代场景级 Ledger 和可选语义 Critic。

### 为什么第一阶段不用 embeddings 选择写作规则

写作硬规则需要可预测、可解释和可回归。Scene tags 与显式 rule IDs 更适合
控制；embeddings 保留给历史事实和大规模示例库的软检索。

## 15. 参考思路

- [SillyTavern World Info](https://docs.sillytavern.app/usage/core-concepts/worldinfo/)：
  条件激活、位置、预算、Inclusion Group、Sticky、Cooldown、Delay、Outlet 和
  vectorized entries。
- [NovelCrafter](https://www.novelcrafter.com/) 及其
  [上下文函数](https://feedback.novelcrafter.com/changelog/june-1st-2024)：
  可查询 Codex、场景 Beat、前后场景上下文和字段级 AI 可见性。
- Sudowrite 的
  [Scene 局部指令](https://feedback.sudowrite.com/changelog/notebook-setting-the-scene-for-better-prose)
  与[风格正文样例](https://feedback.sudowrite.com/changelog/adding-style-examples-to-excellent)。
- [NovelAI Lorebook](https://docs.novelai.net/en/text/lorebook/)：条件激活、
  组合 keys 和生成后解除 Phrase Bias 的思路。
- AI Dungeon 的
  [上下文分层](https://help.aidungeon.com/faq/what-goes-into-the-context-sent-to-the-ai)
  与[记忆系统](https://help.aidungeon.com/faq/the-memory-system)：Required /
  Dynamic Context、Story Summary 与相关记忆检索。
- [Re3](https://aclanthology.org/2022.emnlp-main.296/)、
  [DOC](https://aclanthology.org/2023.acl-long.190/) 与
  [Dramatron](https://deepmind.google/research/publications/13609/)：分层规划、
  逐段生成、重排/审校与人类审核。

这些系统提供设计启发，不构成本项目对其私有实现的复制。本方案只使用公开
文档描述的概念，并以 SillyTavern 当前公开数据格式和本分支现有架构落地。

# Amy Creator Studio 写作控制 Agent 执行手册

状态：可执行规范
适用版本：Amy Creator Studio 0.6.0 及以上
适用分支：codex/codex-subscription

本文是 Agent 使用写作控制功能时的单一入口。目标是让不了解实现细节的 Agent
只阅读本文，也能安全完成需求整理、Writing Profile 草稿、Story Plan 场景
标注、上下文审核、启用、场景收束和故障恢复。

面向人的完整小说工作流见 CREATOR_STUDIO_WORKFLOW.md；字段设计、选择算法和
维护不变量见 WRITING_CONTROL_DESIGN.md。两者与本文冲突时：

1. 数据与安全不变量以 WRITING_CONTROL_DESIGN.md 为准；
2. Agent 的实际操作顺序和完成条件以本文为准；
3. 用户当前明确指令始终优先，但不得绕过凭证、来源聊天和确认边界。

## 1. Agent 的任务边界

Agent 可以：

- 读取当前聊天绑定的 Story Project，把它当作非独占的资源导航；
- 根据用户偏好准备 Writing Profile JSON 草稿；
- 根据作品大纲准备或修改 Story Plan 草稿；
- 解释编译预览中的规则来源、排除原因和警告；
- 建议当前场景 tags、显式规则、比例覆盖和人物表现触发；
- 审核 Scene Close 返回的 Story State、记忆和 Narrative Ledger delta；
- 建议使用只读 Critic，并解释报告；
- 在具备界面操作能力时填写草稿、点击无副作用的预览按钮；
- 在用户确认后执行界面已经提供确认框的持久化操作。

Agent 不得：

- 把 Story Project 的人物或 World Info 引用理解为独占关系或自动注入指令；
- 未经用户确认保存 Profile、启用或停用活动上下文、写入世界书或接受 Ledger；
- 把人物卡中的稳定事实自动转换成每场都要描写的指令；
- 把 Story Plan、authorPlans、猜测、预言或未发生事件写入 canon；
- 把完整 Profile、完整 premise、未来章节或后续场景复制进活动上下文；
- 为了满足比例填充无效对白、动作或环境描写；
- 自动接受 Critic 建议或自动重写用户已认可正文；
- 把 Profile 样例、正文、完整编译提示或 Critic 报告写入日志、凭证或审计摘要；
- 在 checkpoint 尚未隔离聊天世界书时，假定分支写入只影响分支；
- 直接修改 Codex Desktop/CLI 的凭证文件。

## 2. 四种数据必须分开

Story Project 位于这四种创作数据之外：它只回答“这套小说通常使用哪些资源和
默认草稿”，不是正史、活动上下文或权限边界。同一人物和 World Info 可以被
多个项目引用；聊天绑定项目也不会自动载入任何内容。生成正文继续保存在用户
私有的原生聊天文件，项目只保存聊天引用，不得把正文复制进项目 manifest、
源码目录或 Git 提交。

项目内人物引用应优先使用 avatar 文件名；仅在人物名称唯一时，才允许把旧名称
自动迁移为 avatar。JSON“项目设置”文件不包含故事聊天绑定；正文或完整项目迁移
必须使用对应 `.amy-story.zip` 模式。

| 数据 | 回答的问题 | 权威存储 | 是否是正史 |
|---|---|---|---:|
| Writing Profile | 应该怎样写 | 当前聊天元数据中的已审核快照 | 否 |
| Story Plan | 当前准备写什么 | 当前聊天元数据 | 否 |
| 本场编辑版 | 这一场最终按什么完整提示写 | 当前聊天元数据 | 否 |
| Story State | 已发生什么、当前状态是什么 | 聊天元数据和常驻世界书条目 | 是 |
| Narrative Ledger | 哪些写法最近用过、比例趋势如何 | 当前聊天元数据 | 否 |

Agent 每次准备写入前必须判断目标属于哪一种数据。无法确定时停止写入，只生成
待审核草稿。

典型映射：

- “主角左眼是金色”：Character Card 或 World Info 的稳定事实；
- “本场第一次注意到主角的左眼”：Story Plan 的 portrayalTriggers 或 tags；
- “不要每场重复写左眼”：Writing Profile 的 portrayal policy；
- “本场左眼已经被提到一次”：Narrative Ledger delta；
- “左眼在打斗中受伤”：已发生后进入 Story State 和原子记忆。

## 3. 总状态机

Agent 必须按以下状态推进，不得跨过审核状态直接持久化：

    NO_PROFILE
      |
      | 准备草稿
      v
    PROFILE_DRAFT
      |
      | 用户审核并确认保存
      v
    PROFILE_SAVED
      |
      | 选择当前章/场景并编译
      v
    CONTEXT_PREVIEW
      |
      | 预览检查通过，用户确认启用
      v
    CONTEXT_ACTIVE
      |
      | 正常创作
      v
    SCENE_COMPLETE
      |
      | 生成 Scene Close 草稿
      v
    SCENE_REVIEW
      |
      | 用户审核并确认保存
      v
    LEDGER_AND_STATE_SAVED
      |
      | 选择下一场并刷新
      +---------------------> CONTEXT_PREVIEW

任何阶段均可：

- 预览失败：回到 PROFILE_DRAFT 或修改 Story Plan 当前场景；
- 停用：从 CONTEXT_ACTIVE 回到 PROFILE_SAVED；
- 历史正文被修改：Ledger 进入 STALE，刷新前不得把旧统计当成可靠事实；
- 切换聊天：放弃未归属当前聊天的异步结果；
- 创建 checkpoint：继承状态，但分支写入前必须确认世界书已隔离。

## 4. 开始任务前的检查

Agent 开始操作前依次检查：

0. 当前聊天是否绑定 Story Project；若项目已保存剧情快照和默认 Profile，且
   用户同意一次持久化确认，优先在“本场创作”点击“准备并写作”。按钮完成绑定、载入、
   合法场景选择和活动上下文刷新；项目选择器下方状态行同时出现“可以开始写作”
   和“模型上下文已验证”，且准备收据中的预计输出不低于本场目标，才算成功。
   不得因此假定项目清单中的人物全部在场；

1. 当前是否打开了目标聊天；
2. 当前聊天是否已经保存 Writing Profile；
3. 写作控制是否启用；
4. 是否存在 Story Plan；
5. 当前 Chapter 和 Scene 是否正确；
6. 当前是否是 checkpoint；
7. checkpoint 是否已复制并重新绑定聊天世界书；
8. Narrative Ledger 是否标记 stale；
9. 用户要求的是全局偏好、章节偏好、场景偏好还是一次性指令；
10. 用户是否已经明确授权任何会产生持久化写入的动作。

只读说明、生成草稿和编译预览不需要扩大授权。保存、启用、刷新、停用、
Scene Close 落盘和模板保存必须经过界面确认。

### 4.1 Agent 一次性准备协议

具备界面操作能力的 Agent 不应再分别执行“绑定项目 → 载入 Story Plan 草稿 →
保存 → 选章/场 → 启用 → 载入 Profile → 保存 → 启用”。在项目及默认值已经由
用户审核保存的前提下，使用“本场创作 → 准备并写作”，接受一次汇总确认即可。

需要调整时，先点击“编辑本场”。界面会把当前章与场景的 summary、goals 和
constraints 合并去重后复制到可编辑字段；Agent 直接审核或修改这份完整版本，
不得再生成另一层补丁。保存后必须重新准备；编译器应省略原章/场计划细节，只
注入本场编辑版。“重新载入原场景计划”只重填编辑器，仍需用户保存确认。本场
编辑版是作者意图，不得写入 canon，也不得覆盖已审核关系或 Profile 硬规则。

完成后必须读取项目页状态行，并同时检查：

- `绑定：就绪`；
- 项目有剧情快照时 `计划：就绪`；
- 项目有默认 Profile 时 `写作模板：就绪`；
- 状态明确显示“模型上下文已验证”；
- 状态明确显示“未注入未来剧情”；
- 准备收据中的总 Context、输入预算、单次回复、World Info 预算和本场目标均可见；
- 预计输出达到本场目标；不足时必须先由用户确认“应用推荐写作容量”；
- 当前输入框仍未自动发送正文请求。

按钮可重复执行。已在同一项目中推进到合法后续章/场时应保留当前焦点；切换到
另一个项目或首次准备时才默认选择第一章第一场。项目没有剧情快照或 Profile
时，对应步骤按可选项跳过，Agent 不得为凑齐状态而伪造配置。人物和 World Info
引用不由该按钮复制或强制关联。聊天切换到另一个项目且新项目缺少默认值时，
旧项目来源的活动计划或 Profile 必须停用，不能以“可选”为由继续携带旧剧情。
本场目标字数可在“本场创作”直接修改；修改会使旧编译上下文过期，Agent 必须
再次执行“准备并写作”（或技术详情中的“一键准备当前聊天”），不能沿用修改前
的验证收据。

需要调整焦点时，点击“本场创作”的“调整章节 / 场景焦点”；它应跳到“剧情计划”页
顶部的两个选择器。选择后必须点击“确认并启用所选焦点”，并再次检查项目页的
“模型上下文已验证”。完整计划编辑器位于下方折叠区，不是确认当前焦点的必经
步骤。若正在写第一章且 Story State 为空，应理解为“尚无既有正史”，不得据此
再次向用户索要已经启用的焦点、POV、场景或出场人物。

编译上下文的证据顺序必须是：最新已审核 Story State 当前正史与硬规则 > 已保存
的本场完整编辑版（没有编辑版时才使用当前 Story Plan 焦点）> 项目 World Info
中匹配当前人物/焦点的初始关系和稳定事实。后两者不得覆盖已经发生的关系变化；未来章/场不得
进入。全部就绪后，“准备并写作”会把请求放入输入框。Agent 必须审核请求
确实指向当前章/场并包含正确目标字数；按钮只填入输入框，不会发送。若输入框原
有内容仍有价值，应先提醒用户复制保存或取消，不得未经确认覆盖。请求进入输入框
后，发送仍是一次独立的外部模型调用，由用户使用正常发送按钮确认。

## 5. 需求采集

### 5.1 最小采集

用户没有提供完整偏好时，Agent 最多补问真正会改变结果的问题。通常先从现有
文本和明确要求准备草稿，不要求用户理解 JSON。

最小信息：

- 主要语言；
- POV；
- 时态；
- 叙事距离；
- 绝不能违反的硬规则；
- 最重要的两到六条文风偏好；
- 是否需要对话、动作或心理描写比例范围；
- 哪些稳定特征最容易被模型重复；
- 是否有一段用户认可的短样例。

如果缺少非关键项，使用保守默认值并在审核摘要中说明，不得把猜测伪装成用户
偏好。

### 5.2 自然语言到字段

| 用户表达 | 放置位置 | 处理方式 |
|---|---|---|
| “只能写主角知道的内容” | contract.hardRules | 硬规则 |
| “第三人称限知、过去时” | contract.pov / tense | 基础声音 |
| “对话时多用动作停顿” | rules | soft，includeTags 包含 dialogue |
| “打斗场景少写长心理分析” | rules | soft，includeTags 包含 action，指令写成可执行约束 |
| “感情线大约三成” | targets 或 Story Plan Beat 数 | 优先转换成场景/Beat 预算，不承诺精确词比 |
| “对话占 35% 到 50%” | targets | dialogue_word_share 范围 |
| “银发不要反复提” | portrayalPolicies | reference_only，加冷却 |
| “第一次见面可以描写银发” | Scene tags / portrayalTriggers | first-observation 或对应 policy ID |
| “这一场必须用某技巧” | Scene styleRuleIds | 显式选择 |
| “这一场不要用抒情天气” | Scene disabledStyleRuleIds | 显式排除 |
| “这是我喜欢的文字” | examples | 短样例和 notes，不复制句子 |

### 5.3 硬规则与软偏好

满足任一条件时才是硬规则：

- POV、知识边界或时态不能违反；
- 内容边界或安全边界；
- 不得提前揭示剧情；
- 用户使用“必须、绝不、禁止”且含义明确；
- 违反后会造成正史、人物知识或作品结构错误。

其他描写技巧通常是软偏好。不得把“可以、偏好、尽量”升级为每段必须展示。

## 6. Writing Profile 完整格式

### 6.1 可直接使用的基础示例

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
          "不得写出当前 POV 人物无法知道的信息。",
          "不得把后续 Story Plan 事件当成已经发生的事实。"
        ]
      },
      "rules": [
        {
          "id": "emotion-through-action",
          "label": "用动作承载情绪",
          "instruction": "优先通过动作、停顿和环境互动表现情绪，避免紧接着解释同一情绪。",
          "kind": "soft",
          "priority": 80,
          "includeTags": ["dialogue", "conflict", "aftermath"],
          "excludeTags": ["outline-only"],
          "maxApplicationsPerScene": 3,
          "cooldownScenes": 0
        },
        {
          "id": "causal-sensory-detail",
          "label": "因果相关的感官细节",
          "instruction": "只选择会影响人物判断或动作的感官细节，避免装饰性意象堆叠。",
          "kind": "soft",
          "priority": 65,
          "includeTags": [],
          "excludeTags": [],
          "maxApplicationsPerScene": null,
          "cooldownScenes": 0
        }
      ],
      "targets": [
        {
          "id": "dialogue-share",
          "metric": "dialogue_word_share",
          "min": 0.3,
          "max": 0.5
        }
      ],
      "portrayalPolicies": [
        {
          "id": "stable-appearance",
          "label": "稳定外貌",
          "mode": "reference_only",
          "includeTags": [
            "first-observation",
            "appearance-change",
            "physical-consequence"
          ],
          "maxMentionsPerScene": 1,
          "cooldownScenes": 3,
          "matchTerms": []
        }
      ],
      "examples": [
        {
          "id": "approved-dialogue",
          "label": "克制的紧张对话",
          "tags": ["dialogue", "conflict"],
          "text": "在这里放一段不超过 2000 字符的用户认可样例。",
          "notes": "参考节奏、视角和动作停顿，不要逐句复制。"
        }
      ]
    }

### 6.2 字段字典

#### 顶层

| 字段 | 必需 | 约束 |
|---|---:|---|
| schema | 是 | 固定为 amy_writing_profile_v1 |
| id | 是 | 小写 ASCII、数字、连字符或下划线，最多 80 字符 |
| name | 是 | 用户可读名称，最多 200 字符 |
| contract | 是 | 基础声音和硬规则 |
| rules | 是 | 最多 100 条 |
| targets | 是 | 最多 20 条 |
| portrayalPolicies | 是 | 最多 50 条 |
| examples | 是 | 最多 30 段 |

#### contract

| 字段 | 含义 |
|---|---|
| language | 正文主要语言，例如 zh-CN |
| pov | 叙事视角 |
| tense | 时态 |
| narrativeDistance | 叙事距离 |
| hardRules | 最多 20 条，每条最多 500 字符 |

#### rules

| 字段 | 允许值或含义 |
|---|---|
| id | 同层唯一稳定 ID |
| label | 用户可读名称 |
| instruction | 给模型的可执行自然语言指令 |
| kind | hard 或 soft |
| priority | 0 到 100，仅用于本地选择 |
| includeTags | 至少一个命中时成为候选；空数组表示通用候选 |
| excludeTags | 任一命中即排除 |
| maxApplicationsPerScene | null 表示不设次数上限；0 表示本场不得使用 |
| cooldownScenes | 使用后等待多少个场景 |

注意：priority 不是百分比，不得把它解释成“80% 遵守”。

#### targets

当前支持：

- dialogue_word_share；
- action_word_share；
- interiority_word_share。

min 和 max 必须满足 0 <= min <= max <= 1。比例是软范围。章节统计不足时直接
使用配置范围；已有已审核统计时，编译器只做有上限的欠账修正。

#### portrayalPolicies

| 字段 | 含义 |
|---|---|
| mode | reference_only、when_triggered 或 always |
| includeTags | 允许表现该事实的场景标签 |
| maxMentionsPerScene | 本场最大主动表现次数 |
| cooldownScenes | 最近表现后需要冷却的场景数 |
| matchTerms | 预留的人工审核辅助词；当前版本不自动检测，也不参与编译 |

默认优先使用 reference_only。always 只适合确实每场都必须体现的物理状态，不
适合普通外貌和背景。

#### examples

样例最多 2000 字符，每轮最多选择两段。notes 必须说明要借鉴什么，并提醒不要
逐句复制。不得未经用户同意把私密正文保存为可复用模板。

### 6.3 Profile 生成检查

Agent 输出 Profile 草稿前逐项检查：

- schema 正确；
- 所有 ID 合法且同层无重复；
- 硬规则没有被放进概率性或冷却逻辑；
- soft rules 不超过实际需要；
- includeTags 和 excludeTags 没有自相矛盾；
- min 不大于 max；
- null 与 0 没有混淆；
- 外貌事实没有直接复制成“每场描写”；
- 样例没有超过长度，且 notes 禁止逐句复制；
- 没有凭证、API Key、私人路径或不相关聊天正文。

## 7. Story Plan 的写作控制字段

Chapter 和 Scene 都可使用：

    {
      "tags": ["dialogue", "conflict", "first-observation"],
      "styleRuleIds": ["emotion-through-action"],
      "disabledStyleRuleIds": ["lyrical-weather"],
      "targetOverrides": {
        "dialogue_word_share": [0.4, 0.55]
      },
      "portrayalTriggers": ["stable-appearance"]
    }

选择原则：

1. tags 描述场景客观类型，不写抽象愿望；
2. styleRuleIds 只用于本场明确需要的规则；
3. disabledStyleRuleIds 用于本场明确不适合的规则；
4. targetOverrides 只做局部范围覆盖，不修改 Profile；
5. portrayalTriggers 只在观察、变化或物理影响确实与剧情相关时加入；
6. 未识别 ID 必须作为警告报告给用户，不得自行伪造规则；
7. 不得把未来章节内容复制到当前 Scene 的 summary、goals 或 constraints。

常用 tags：

- dialogue；
- conflict；
- aftermath；
- action；
- quiet；
- investigation；
- first-observation；
- appearance-change；
- physical-consequence；
- outline-only。

tags 是项目约定，不是固定枚举。新增 tag 时使用简短、稳定、可复用的小写
ASCII 名称。

## 8. 标准执行流程

### 8.1 准备 Profile 草稿

1. 阅读用户偏好和已有样例；
2. 按第 5 节完成字段映射；
3. 优先从内置“克制叙事”复制；
4. 只添加确实需要的规则；
5. 在高级 Profile JSON 中形成完整草稿；
6. 给用户摘要：
   - 硬规则；
   - 最多六条主要软规则；
   - 比例范围；
   - 表现控制；
   - 样例是否会保存；
7. 等待用户审核。

不得因为用户说“按你判断”就跳过界面确认。Agent 可以代拟，但最终保存仍由
确认框完成。

### 8.2 保存已审核 Profile

前置条件：

- 当前聊天 ID 存在；
- JSON 校验通过；
- 用户已看到摘要；
- checkpoint 下已提醒世界书隔离风险。

操作：

1. 点击“保存已审核配置”；
2. 核对确认框中的 Profile 名称；
3. 用户确认后保存聊天快照；
4. 若写作控制已经启用，保存会刷新活动上下文；
5. 保存后检查状态显示“已保存配置”或“写作控制已启用”。

模板保存是另一项操作。不得把“保存当前作品 Profile”理解为“覆盖全局模板”。

### 8.3 编译预览

1. 在规划页选择当前 Chapter 和 Scene；
2. 回到写作控制页；
3. 设置合理的本场预计字数；
4. 点击“编译预览”；
5. 检查 Context Inspector。

必须检查：

- future chapters included 为 No；
- Writing Contract 中包含 POV、时态和全部硬规则；
- Current Author Intent 只包含当前章和当前场景；
- author intent 被明确标为 NOT CANON；
- Active Prose Directions 不超过六条 soft rules；
- Reference Realization Policy 没有无理由许可稳定外貌；
- Recent Repetition Guard 没有错误引用过期 Ledger；
- warnings 中没有未知规则、非法覆盖或 stale；
- source hash 非空；
- 默认估算不超过 1000 tokens；超预算时先删除样例和低优先级软规则。

未来章节泄漏、结构非法或来源聊天变化属于阻塞问题，不得启用。预算、未知软
规则等普通警告应先修正；用户明确接受前不要忽略。

### 8.4 启用或刷新

1. 预览通过；
2. 点击“启用 / 刷新”；
3. 确认写入；
4. 系统在聊天世界书中只保留一个 Amy 活动条目；
5. 旧 Amy Active Story Plan v1 被原地迁移或清理；
6. 新条目 comment 为 Amy Active Writing Context v1；
7. 状态显示写作控制已启用。

在 checkpoint 中，确认框会提示先复制并重新绑定世界书。Agent 不得替用户
假设隔离已经完成。

### 8.5 正常创作

写作时：

- 把活动上下文视为写法与当前作者意图，不视为角色已知事实；
- Character Card 和 World Info 只负责一致性；
- Story State 优先于冲突的计划；
- 用户当前明确指令可以覆盖软偏好，不能静默违反硬规则；
- 不需要每轮刷新上下文；
- 第一章没有 reviewed Story State 时，按已验证的活动焦点直接创作；空状态不等于
  焦点缺失，也不得重复索要已进入活动上下文的启动信息；
- Profile、Scene、预计字数或 Ledger 变化后，状态若提示过期，应在下一次
  生成前刷新。

### 8.6 场景结束

1. 确认最近消息窗口覆盖完整场景；
2. 点击“生成场景收束草稿”；
3. 异步请求返回前不得切换到其他聊天；
4. 审核 memories；
5. 审核完整 Story State；
6. 审核 narrativeLedgerDelta；
7. 用户确认后点击“保存已审核草稿”。

Ledger delta 示例：

    {
      "sceneIndex": 12,
      "chapterId": "chapter-3",
      "metrics": {
        "words": 1100,
        "dialogueWords": 430,
        "actionWords": 260,
        "interiorityWords": 180
      },
      "factMentions": {
        "stable-appearance": {
          "lastSceneIndex": 12,
          "countInCurrentScene": 1,
          "countInChapter": 0
        }
      },
      "ruleApplications": {
        "emotion-through-action": {
          "lastSceneIndex": 12,
          "countInCurrentScene": 2,
          "countInChapter": 0
        }
      },
      "recentMotifs": [
        {
          "text": "雨声",
          "lastSceneIndex": 12
        }
      ],
      "recentPhrases": []
    }

审核规则：

- metrics 只统计本场已接受正文；
- countInChapter 由合并器维护，草稿中的累计值不作为权威；
- 只记录实际出现的 Profile policy/rule ID；
- 删除 policy-id、rule-id 等占位条目；
- 只保留真正显著的近期意象和短语；
- 不把剧情事实放进 Ledger；
- 没有有效 delta 时可以保存 Story State 而不更新 Ledger；
- 未经确认的模型输出不得合并。

### 8.7 推进到下一场

1. 在 Story Plan 选择下一 Scene；
2. 检查 tags、显式规则、覆盖和触发；
3. 点击“编译预览”；
4. 比较 source hash 和规则原因；
5. 用户确认“启用 / 刷新”；
6. 再开始下一场。

## 9. 只读 Critic

使用条件：

- 当前聊天已有已保存 Profile；
- 最近一条助手消息确实是需要审核的正文；
- 用户希望检查重复、偏离或比例，而不是直接重写。

操作：

1. 点击“审核最近回复”；
2. Critic 只读取最近一条助手正文、当前 Profile 和已编译上下文；
3. 审核报告包含：
   - unnecessaryFactMentions；
   - repeatedMotifs；
   - ruleViolations；
   - targetEstimates；
   - suggestedEdits；
4. Agent 向用户解释最重要的问题；
5. 用户可复制报告，自行选择是否局部修改。

Critic 报告不是正史、不是 Ledger，也不是自动编辑命令。Critic 失败不得删除
初稿或阻止用户保留正文。

## 10. 模板、导入与导出

### 保存模板

- 必须由用户显式点击“保存为可复用模板”；
- 模板保存在用户级扩展设置；
- 模板包含样例，保存前必须提醒其私密性；
- 同 ID 模板会被新版本替换；
- 已有聊天快照不会随模板变化。

### 应用模板

- 选择模板只加载待审核草稿；
- 点击“保存已审核配置”后才成为当前作品权威快照；
- 不得因为模板已审核过就跳过当前作品的确认。

### 导入

- 只接受合法 amy_writing_profile_v1 JSON；
- 导入只形成草稿；
- Agent 必须检查 ID、范围、样例和隐私内容；
- 导入文件不得包含凭证。

### 导出

- 必须由用户显式触发；
- 只导出 Profile，不自动附带 Character Card、Story Plan、Ledger 或正文；
- Agent 不得把导出当成云同步或备份已经完成的证明。

### Story Project 迁移包

本节与上面的 Writing Profile 单文件导入导出不同。Agent 必须先确认用户所需
模式，不得自行扩大私人数据范围。

**仅正文包**：

- 选择“仅导出故事正文”；
- 使用 JSONL 容器，只保证已选中的可见消息、说话者、时间和章节顺序可迁移；
- 必须剥离项目简介、标签、原人物/群组归属、系统消息、swipe 备选、模型附加
  信息和聊天元数据；
- 不声称包含人物卡、World Info、Story Plan、Story State、记忆、Ledger、
  Writing Profile 或群组设定；
- 导入到已有当前人物，或由系统创建中性归档人物。

**完整项目包**：

- 选择“导出完整小说项目”；
- 应包含项目故事、人物卡、项目 World Info、聊天连续性世界书、群组关系、
  Story Plan、项目备注和可用默认 Writing Profile；
- 导出报告缺少人物、群组、聊天、世界书或已引用 Writing Profile 时，先修复
  引用，不得把不完整包交付为完整迁移；
- 导入前向用户展示模式与资源数量；导入只创建副本并重写引用，不覆盖已有
  项目或资源；
- 多资源导入中途失败时不得声称已完成；自动回滚不会运行，先协助用户辨认并
  清理本次新增的 `Imported` 副本，再重试；
- 完成后抽查正文、聊天世界书、群组成员和项目索引，再声称迁移成功。

两种包都不得包含 OAuth 凭证。迁移包只在用户显式点击导出后进入下载目录，
Agent 不得自动上传、提交到 Git 或发给第三方。

## 11. checkpoint 与分支

创建 checkpoint 会继承聊天元数据和当时绑定的世界书。若分支仍共享同一个
聊天世界书，则以下操作可能同时影响父时间线：

- 保存已启用的 Profile；
- 启用或刷新活动上下文；
- 停用活动上下文；
- 保存不同 Story State；
- 合并不同 Ledger delta。

分支写入前：

1. 确认当前是 checkpoint；
2. 复制聊天世界书；
3. 把 checkpoint 重新绑定到副本；
4. 再执行写入；
5. 检查父时间线世界书未改变。

如果 Agent 无法验证世界书是否隔离，必须明确报告不确定性，并让用户确认；
不得声称“只影响分支”。

## 12. 故障恢复

### Profile JSON 无效

症状：保存或预览提示 Writing Profile 无效。

处理：

1. 不覆盖已保存 Profile；
2. 打开高级 Profile JSON；
3. 检查 schema、ID、重复项、枚举和比例范围；
4. 保留原草稿副本；
5. 修正后重新预览；
6. 未通过前不得启用。

### 未知 rule ID

症状：Inspector warnings 出现 Unknown style rule id。

处理：

1. 检查 Chapter/Scene 的 styleRuleIds 和 disabledStyleRuleIds；
2. 与当前已保存 Profile 的 rules 对照；
3. 更正拼写、删除失效引用，或在 Profile 中新增经过审核的规则；
4. 重新编译；不得忽略后直接声称该规则生效。

### 上下文过期

症状：状态显示活动预览已经过期。

原因可能是 Profile、当前 Scene、预计字数或 Ledger 变化。

处理：

1. 不必停用；
2. 重新编译预览；
3. 比较 source hash、选中规则和警告；
4. 用户确认刷新；
5. 刷新前不要用旧预览解释下一轮行为。

### Ledger stale

症状：历史消息编辑、删除或 swipe 后出现 stale 警告。

处理：

1. 不删除旧 Ledger；
2. 编译器和 Scene Close 会自动忽略旧比例、冷却和重复统计；
3. 普通 Scene Close 增量不会清除 stale 标记；
4. 当前版本不能自动重建全部历史统计；
5. 向用户说明重置会丢弃写作统计，但不会改变正文、Story State、记忆、Profile
   或 Plan；
6. 用户确认后点击“重置过期账本”；
7. 重新编译并确认刷新活动上下文；
8. 从后续已审核场景重新累计；
9. 不得通过手工删除 stale 字段伪装成已经完成重算。

### 切换了聊天

症状：草稿来源聊天与当前聊天不一致。

处理：

1. 拒绝保存；
2. 回到来源聊天；
3. 确认消息范围仍有效；
4. 必要时重新生成草稿；
5. 不得把旧草稿改写 chatId 后强行保存。

### 世界书保存失败

处理：

1. 不修改聊天中的 active 状态标记；
2. 保留 pending 草稿；
3. 检查当前聊天是否有聊天世界书；
4. 检查 checkpoint 绑定；
5. 重试前重新确认来源聊天；
6. 不创建多个活动条目作为绕过方案。

### Critic 报告无效

处理：

1. 保留原正文；
2. 不写入 Story State 或 Ledger；
3. 可重新运行一次；
4. 仍失败时由 Agent按 Profile 人工审核；
5. 不得把未解析的模型文本伪装成结构化报告。

## 13. 禁止模式

以下做法视为错误：

- 把所有软偏好改成 hard；
- 每条规则都设为 global；
- 为了“更有记忆点”每场重复人物标志性外貌；
- 在 suppress 指令中反复列出具体外貌词；
- 把 priority 当成生成概率；
- 用一句“感情线 30%”代替场景预算；
- 每轮注入完整风格样例库；
- 在当前 Scene summary 中提前复制后续章节秘密；
- Critic 一报告问题就自动重写全文；
- 修改模板后自动覆盖所有已有聊天；
- 删除旧活动条目失败时继续创建新活动条目；
- 把 Ledger 当成 canon 或把 Story State 当成写作偏好；
- 把确认框当作形式步骤，由 Agent自行确认用户意图。

## 14. Agent 输出模板

### 14.1 Profile 草稿摘要

    已准备 Writing Profile 草稿：
    - 基础声音：<语言 / POV / 时态 / 叙事距离>
    - 硬规则：<数量与摘要>
    - 软偏好：<数量与最重要规则>
    - 比例范围：<targets 或无>
    - 表现控制：<policy 与冷却>
    - 风格样例：<是否包含私密正文>
    - 尚未保存：是

    请审核高级 JSON。确认后再点击“保存已审核配置”。

### 14.2 Context Inspector 审核

    当前编译预览：
    - 当前焦点：<Chapter / Scene>
    - future chapters included：No
    - 硬规则：<完整 / 缺失>
    - 选中软规则：<IDs>
    - 排除规则：<ID 与原因>
    - 表现许可：<允许 / reference-only>
    - Ledger：<有效 / stale>
    - token：<数量>
    - source hash：<值>
    - 阻塞问题：<无或列表>

    <可以启用 / 修正后再启用>。

### 14.3 Scene Close 审核

    场景收束草稿审核：
    - 来源聊天与消息范围：<一致 / 不一致>
    - 原子记忆：<保存数 / 删除数 / 原因>
    - Story State：<关键变化>
    - authorPlans 泄漏：<无 / 有>
    - Ledger metrics：<合理 / 需调整>
    - facts/rules：<实际出现的 IDs>
    - motifs/phrases：<保留项>
    - 尚未落盘：是

    请确认后再执行“保存已审核草稿”。

## 15. 机器可检查的完成标准

### Profile 完成

- JSON 可被规范化；
- schema 正确；
- ID 合法且唯一；
- min/max 有效；
- 用户已看过摘要；
- 已通过确认保存；
- 聊天状态显示已保存 Profile。

### 启用完成

- 当前 Chapter/Scene 正确；
- Inspector 显示未来章节为 No；
- source hash 非空；
- 无阻塞警告；
- 用户确认启用；
- 世界书中只有一个 Amy 活动条目；
- comment 为 Amy Active Writing Context v1；
- 状态显示写作控制已启用。

### 场景收束完成

- source.chatId 与当前聊天一致；
- memories 和 Story State 已审核；
- authorPlans 没有被模型自行创建；
- Ledger delta 只含本场已接受正文；
- 用户确认保存；
- pending 草稿被清空；
- Story State 和 Ledger 在当前聊天更新；
- 下一场开始前已重新编译和刷新。

## 16. 最短 Agent 检查清单

Agent 每次只需记住以下十项：

1. 先分清 Profile、Plan、State、Ledger；
2. 所有模型结果先是草稿；
3. 完整 Profile 和未来 Plan 不注入；
4. 硬规则始终保留；
5. 软规则最多六条；
6. 稳定外貌默认 reference-only；
7. 比例是范围，不凑数；
8. Ledger 只记录已接受正文；
9. checkpoint 写入前确认世界书隔离；
10. 保存、启用、停用和落盘都必须由用户确认。

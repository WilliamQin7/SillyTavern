# Amy Creator Studio 小说工作流

本文档是 Amy Creator Studio 的用户与 Agent 操作规范，适用于复杂人物、
多人物关系、长篇剧情、复杂世界观和分支创作。

Agent 应优先遵守本文的“必须 / 不得”约束。界面按钮名称以中文版为主，
括号内给出英文名。

需要由 Agent 从需求采集一直执行到场景收束时，应先完整阅读
[`WRITING_CONTROL_AGENT_GUIDE.md`](./WRITING_CONTROL_AGENT_GUIDE.md)。该文档
提供单一入口、状态机、完整字段字典、输出模板、恢复流程和机器验收标准。

## 一分钟流程

1. 在“角色”页生成或迁移 Character Card，校验后导入。
2. **可选**：已有章纲时，在“规划”页整理并保存 Story Plan，再只启用当前
   章或场景；没有 Story Plan 时，以下流程完全不变。
3. **可选**：在“写作控制”页审核并保存 Writing Profile，预览当前场景实际
   会看到的上下文，再确认启用。
4. 正常写一个场景，不要在每轮对话后整理全部状态。
5. 场景结束时点击“生成场景收束草稿”（Prepare scene close）。
6. 审核记忆、`storyState` 与 `narrativeLedgerDelta`，尤其检查正史、作者
   计划、人物关系和重复痕迹。
7. 点击“保存已审核草稿”（Save reviewed draft）。
8. 到达重要分歧点时创建 checkpoint；若要在分支保存不同状态，先复制并
   重新绑定聊天世界书。

## 核心约束

- 所有模型输出都只是草稿。未经用户确认，不得写入角色、世界书或聊天状态。
- `canon` 只保存已发生或已由用户明确确认的事实。
- `authorPlans` 是作者意图，不是故事中已经发生的事实。
- Story Plan 也是作者意图，不是正史；未启用时不得影响生成，启用时也只能
  注入当前章和当前场景，不得注入后续章节或完整故事 premise。
- Agent 不得从对白、猜测、预言或叙述暗示中自行创建 `authorPlans`。
- 人物关系是有方向的。`A → B` 不得自动当成 `B → A`。
- `storyState` 是完整的当前快照，不是只包含本场变化的 delta。
- 原子记忆用于长期检索；Story State 用于保持当前场景连续性。两者不能互相
  替代。
- 草稿带有来源聊天和消息范围。不得把一个聊天的草稿保存到另一个聊天。
- checkpoint 分支若继续共用聊天世界书，分支写入会影响主线。准备保存
  分支专属正史前，必须先复制并重新绑定世界书。
- 不实现或维护第二套自动剧情图。分支结构交给 SillyTavern checkpoint 和
  Timelines。

## 数据与职责

| 数据 | 存储位置 | 是否进入后续生成上下文 | 用途 |
|---|---|---:|---|
| Character Card V3 | 角色卡；含嵌入 `character_book` | 是 | 稳定角色身份、提示和便携世界设定 |
| 关联 World Info | 独立世界书；通过 `extensions.world` 关联 | 按世界书规则 | 世界观、地点、组织和静态知识 |
| 原子记忆 | 当前聊天世界书中的向量条目 | 检索命中时 | 已发生事件、事实、目标和关系变化 |
| Story State | 聊天元数据 + 一个常驻世界书条目 | 是，但不含作者计划 | 当前场景、人物状态、关系、线索和正史 |
| `authorPlans` | Story State 的聊天元数据副本 | 否 | 作者协调；防止计划提前泄漏到角色扮演提示 |
| 完整 Story Plan | 聊天元数据 | 否 | 已审核的作品定位、章节与场景规划 |
| 活动 Story Plan 焦点 | 一个可移除的聊天世界书常驻条目 | 是 | 只提供当前章/场景的目标与约束；明确标记为非正史 |
| Writing Profile | 用户模板 + 当前聊天已审核快照 | 完整数据不进入 | POV、时态、硬规则、软偏好、比例目标、表现策略与样例 |
| Narrative Ledger | 聊天元数据 | 仅编译后的重复防护进入 | 已接受场景的比例统计、表现次数和近期意象；不是正史 |
| 活动写作上下文 | 一个可替换的聊天世界书常驻条目 | 是 | 当前场景所需的最小契约、意图、写法、表现许可和重复防护 |
| checkpoint | SillyTavern 原生聊天快照 | 继承创建时的聊天元数据 | 剧情分歧、回退与 Timelines 展示 |

## 流程 A：新建 Character Card V3

### 操作

1. 打开 **Extensions → Amy Creator Studio → 角色**。
2. 在“角色构想”中说明：
   - 角色身份与稳定特征；
   - 与用户及其他角色的关系；
   - 世界背景与初始场景；
   - 语气、叙事视角和内容边界；
   - 多人物故事中该角色知道什么、不知道什么。
3. 点击“生成草稿”。
4. 审核 JSON，然后点击“校验格式”。
5. 点击“导入角色卡和世界书”，在确认框中确认。

### Agent 审核规则

- `card.spec` 必须是 `chara_card_v3`，`spec_version` 必须是 `3.0`。
- `name` 与 `first_mes` 不得为空。
- 群聊专用开场只能放在 `group_only_greetings`。
- 稳定世界设定应拆成短小、可独立理解的 lorebook 条目。
- 普通触发条目必须有 `keys`；只有确实应常驻的条目才用 `constant: true`。
- `extensions` 中的未知命名空间不得删除。
- 生成头像、表情和背景不会自动改写草稿中的 V3 `assets`。如需对外导出
  完整素材清单，必须另行审核并更新卡片。
- 当前只以 V3.0 为目标，不采用尚未定稿的 V3.1 字段。

### 最小 Studio 草稿结构

```json
{
  "schema": "amy_creator_studio_v1",
  "card": {
    "spec": "chara_card_v3",
    "spec_version": "3.0",
    "data": {
      "name": "Mira",
      "description": "A cartographer.",
      "personality": "Curious but cautious.",
      "scenario": "At sea.",
      "first_mes": "The compass is moving again.",
      "mes_example": "",
      "creator_notes": "",
      "system_prompt": "",
      "post_history_instructions": "",
      "alternate_greetings": [],
      "group_only_greetings": [],
      "tags": ["adventure"],
      "creator": "Amy Creator Studio",
      "character_version": "1.0",
      "extensions": {}
    }
  },
  "lorebook": {
    "name": "Mira Lore",
    "entries": [
      {
        "keys": ["shifting atlas"],
        "content": "The shifting atlas records islands that move each night.",
        "comment": "Shifting atlas",
        "constant": false,
        "selective": false,
        "secondary_keys": [],
        "order": 100
      }
    ]
  },
  "visual": {
    "anchor": "silver hair, blue coat, brass compass",
    "style": "watercolor adventure illustration"
  }
}
```

校验会把 `lorebook` 同步为标准 V3 `card.data.character_book`。导入时会同时
创建不覆盖已有文件的独立 World Info，并通过 `extensions.world` 保持关联。

## 流程 B：迁移 Character Card V2

Studio 接受的是带 `schema`、`card`、`lorebook` 和 `visual` 的 Studio 草稿，
不是裸 V2 Card JSON。

1. 把旧卡放进 Studio 草稿的 `card` 字段。
2. 保持 `card.spec = "chara_card_v2"` 和 `spec_version = "2.0"`。
3. 把原有世界书内容放进顶层 `lorebook`；没有世界书时使用空 `entries`。
4. 点击“校验格式”。
5. 审核规范化结果：它应已经变成 V3.0，且
   `group_only_greetings` 默认为空数组。
6. 重点比较名称、开场白、备用开场、扩展字段和世界书条目数量，再导入。

不得用文本替换直接把 `v2` 改成 `v3`。迁移还需要补充 V3 必需字段并转换
嵌入世界书。

## 流程 C：导入已有设定和章节大纲（可选）

Story Plan 是增强层，不是使用 Studio 的前置条件。没有章纲、希望探索式创作，
或暂时不想让规划影响续写时，可以完全跳过本流程。

### 哪些内容放在哪里

- 不随剧情改变的世界规则、地点、组织和人物背景：放入 Character Card 或
  World Info。
- 已经发生并确认的事实：放入已审核 Story State 与原子记忆。
- 未来章节的大致走向、场景目标、伏笔安排和“现在还不能发生”的事项：放入
  Story Plan。

不得为了省事把完整世界设定和全书剧情都塞进当前焦点。这样既浪费上下文，
也容易让人物提前知道尚未发生的事实。

### 首次导入

1. 打开 **Extensions → Amy Creator Studio → 规划**。
2. 把已有作品设定和章纲粘贴到“已有大纲”。Markdown、普通文本或 Story
   Plan JSON 都可以。
3. 点击“整理为结构化规划”（Prepare structured plan）。合法 JSON 会直接在
   本地规范化；普通文本会交给模型整理。此操作只生成待审核草稿。
4. 审核每章和每个场景，尤其区分：
   - `summary`：本章或本场的大致方向；
   - `goals`：本阶段必须推进的事项；
   - `constraints`：本阶段暂时不能发生、不能揭示的事项。
5. 点击“保存已审核规划”（Save reviewed plan）并确认。完整规划只保存在当前
   聊天元数据中；首次保存不会自动注入写作上下文。
6. 选择“当前章”和“当前场景”，点击“启用所选焦点”（Activate selected
   focus）并确认。

最小可用 JSON 如下；`id` 可以省略，系统会生成稳定标识：

```json
{
  "schema": "amy_story_plan_v1",
  "title": "潮汐地图",
  "premise": "两名制图师追查一座每天移动的岛。",
  "styleGuide": ["第三人称限知", "克制", "不提前解释地图来源"],
  "chapters": [
    {
      "title": "失踪的港口",
      "summary": "主角确认旧港并非被毁，而是从海图上消失。",
      "goals": ["建立两位主角的利益冲突"],
      "constraints": ["不得揭示岛屿移动的真正原因"],
      "scenes": [
        {
          "title": "空白海图",
          "summary": "两人在档案馆发现同一天的海图互相矛盾。",
          "goals": ["取得第一条可验证线索"],
          "constraints": ["幕后人物不能正式登场"]
        }
      ]
    }
  ]
}
```

### 日常推进

- 写完一个场景后，先按下一流程收束 Story State，再选择下一个场景并重新
  点击“启用所选焦点”。
- 启用操作会原地更新固定的活动焦点条目，不会为每个场景累积一条规划。
- 活动焦点只包含作品标题、风格指引、当前章、当前场景、目标和约束；不会
  包含 `premise`、其他章节或未来场景。
- 活动焦点中的长文本和列表会做长度限制；完整已审核规划仍保留在聊天元数据，
  不会为了每次生成反复占用上下文。
- 点击“停用规划”只移除活动焦点；已保存的完整 Story Plan 不会丢失。停用后
  继续使用原有角色卡、世界书、记忆和 Story State 流程。
- 修改并重新保存完整 Story Plan 时，如果当前已有活动焦点，会同步刷新该
  焦点；因此 checkpoint 分支仍需先隔离聊天世界书。

整理模型不得擅自补写章纲中没有的反转、结局、事实或场景。若输入含糊，宁可
保持概括，也不要把模型猜测升级成作者决定。

## 流程 D：写作偏好与注意力控制（可选）

Writing Profile 解决“怎样写”；Story Plan 解决“当前写什么”。两者可以独立
使用。没有已保存并启用的 Profile 时，原有 Story Plan、角色卡和世界书行为
保持不变。

### 首次设置

1. 打开 **Extensions → Amy Creator Studio → 写作控制**。
2. 选择“内置克制叙事”，或从 Story Plan 的旧 `styleGuide` 准备迁移草稿。
   迁移只生成草稿，不会自动保存或删除旧字段。
3. 在简单界面中填写语言、视角、时态、叙事距离、硬规则、文风偏好、对话
   范围、外貌冷却和短样例。需要 tags、优先级或章节/场景局部选择时使用“高级
   Profile JSON”。
4. 点击“保存已审核配置”并确认。聊天得到独立快照；以后修改可复用模板不会
   静默改变这部作品。
5. 在“规划”页选好当前章和场景，回到“写作控制”点击“编译预览”。
6. 在上下文检查器中确认：
   - 未来章节始终为“否”；
   - 选中与排除规则的原因合理；
   - token 预算没有异常警告；
   - source hash 与当前 Profile、焦点和 Ledger 对应。
7. 点击“启用 / 刷新”并确认。系统会把旧的
   `Amy Active Story Plan v1` 原地迁移为唯一的
   `Amy Active Writing Context v1`，不会保留两个常驻条目。

### 当前场景标签

高级 Story Plan JSON 可以在 Chapter 或 Scene 中使用以下可选字段：

```json
{
  "tags": ["dialogue", "conflict", "first-observation"],
  "styleRuleIds": ["emotion-through-action"],
  "disabledStyleRuleIds": ["lyrical-weather"],
  "targetOverrides": {
    "dialogue_word_share": [0.4, 0.55]
  },
  "portrayalTriggers": ["stable-appearance"]
}
```

- `tags` 选择与场景相关的软规则；
- `styleRuleIds` 显式选择规则，`disabledStyleRuleIds` 显式排除规则；
- `targetOverrides` 只调整当前章或场景的软比例范围；
- `portrayalTriggers` 允许本场表现对应稳定事实；
- 所有 ID 都必须引用已审核 Profile；未知 ID 只产生预览警告。

### 场景结束与 Narrative Ledger

“生成场景收束草稿”会额外生成可编辑的
`narrativeLedgerDelta`。它只统计本场已接受正文，不是正史。保存前应删除
错误的表现次数、意象或比例估算；只有与 Story State 一起确认保存后才会合并
到 `amy_narrative_ledger_v1`。

若历史消息被编辑、删除或切换 swipe，Ledger 会被标记为过期；编译器和 Scene
Close 会忽略其中的比例、冷却和重复统计。普通 Scene Close 增量不会静默清除
过期状态。当前版本不能自动重建全部
历史统计；确认“重置过期账本”后只清除写作统计和近期重复痕迹，不改变正文、
Story State、记忆、Profile 或 Plan。随后应重新编译活动上下文，并从后续已
审核场景重新累计。

### 可选正文审校

“审核最近回复”只把最近一条助手正文与当前已审核写作控制交给 Codex，返回
不必要事实表现、重复意象、规则违反和比例估算。报告只显示在界面中，不自动
保存、不修改正文、不写入正史或长期记忆。用户可以复制报告后自行决定是否
局部修改。

### Agent 不变量

- 稳定外貌和背景默认只用于一致性，不代表本场必须主动描写。
- 硬规则始终保留；软规则每轮最多 6 条，样例最多 2 段。
- 比例是范围与场景预算，不得用无效对白或描写凑数。
- 完整 Profile、完整 Story Plan、`premise` 和未来章节不得进入活动条目。
- Profile、Plan、Story State 与 Ledger 不得互相覆盖职责。
- 停用只删除活动条目；已审核数据继续保留。

## 流程 E：长篇小说的场景循环

### 1. 写场景

- 每个场景应有可识别的目标、冲突或信息变化。
- 不必每条消息都整理状态。默认在场景结束、地点切换、显著时间跳跃、主要
  人物进出场或剧情分歧前进行收束。
- 若最近消息窗口不足以覆盖整个场景，先调大“检查最近多少条消息”；最大值
  是 100。

### 2. 生成场景收束草稿

点击“生成场景收束草稿”。模型返回下面的审核信封：

```json
{
  "source": {
    "chatId": "chapter-1",
    "startMessageId": 14,
    "endMessageId": 31,
    "messageCount": 18
  },
  "memories": [],
  "storyState": {}
}
```

请求发出后如果用户切换聊天，结果会被拒绝，不会落入新聊天。

### 3. 审核原子记忆

每条记忆包含：

- `title`：短标题；
- `content`：不依赖上下文也能理解的第三人称陈述；
- `keys`：检索触发词；
- `kind`：`fact | event | relationship | goal | state`；
- `importance`：1 到 5。

审核时必须：

- 第一条场景总结应是 `event`，重要度为 5；
- 删除寒暄、措辞细节和很快失效的临时状态；
- 把不同事实拆成不同条目；
- 不把计划、梦境、谎言或角色猜测写成已发生事实；
- 保留对后续确有影响的承诺、知识变化、关系变化、物品和未解决线索。

保存时会按规范化后的 `content` 跳过完全重复记忆，但不会做模糊语义合并。

### 4. 审核 Story State

```json
{
  "schema": "amy_story_state_v1",
  "scene": {
    "summary": "Mira and Ivo returned to the eastern port.",
    "time": "Year 12, dusk",
    "location": "Eastern port",
    "presentCharacters": ["Mira", "Ivo"]
  },
  "characters": [
    {
      "name": "Mira",
      "status": "Exhausted but uninjured",
      "goal": "Identify the atlas maker",
      "location": "Eastern port",
      "inventory": ["shifting atlas"],
      "knowledge": ["Ivo kept the harbor promise"]
    }
  ],
  "relationships": [
    {
      "from": "Mira",
      "to": "Ivo",
      "state": "Cautious trust",
      "lastChange": "Ivo kept his promise"
    }
  ],
  "openThreads": [
    {
      "title": "Atlas maker",
      "detail": "The maker's identity remains unknown.",
      "status": "open",
      "keys": ["atlas", "maker"]
    }
  ],
  "canon": [
    {
      "content": "Mira returned to the eastern port with the atlas.",
      "keys": ["Mira", "eastern port", "atlas"]
    }
  ],
  "authorPlans": [
    {
      "content": "Reveal the atlas maker in chapter five.",
      "status": "planned"
    }
  ]
}
```

字段规则：

- `scene`：刚结束的最近场景以及场景后的时间、地点和在场人物。
- `characters`：仍影响下一场的当前状态。不得复制整张角色卡。
- `relationships`：方向性关系；只记录足以影响行为的当前关系和最近变化。
- `openThreads`：未回收线索使用 `open`；确认回收后可标为 `resolved`。
- `canon`：当前仍需强制保持一致的少量正史，不是完整历史档案。
- `authorPlans`：仅供作者协调。普通续写模型看不到它；需要执行某项计划时，
  用户或编排 Agent 必须把相关计划明确放进本次作者指令。

新场景收束会收到上一份已审核 Story State，并应返回完整的新快照。Agent 不得
因为本场没有提及某角色，就删除仍然有效的重要状态或未解决线索。

### 5. 保存

点击“保存已审核草稿”并确认后：

1. 新的原子记忆写入当前聊天世界书并标记为可向量检索；
2. 完全重复记忆被跳过；
3. `Amy Story State v1` 常驻条目被原地更新，而不是重复创建；
4. `authorPlans` 只保存在聊天元数据，不写入常驻提示；
5. 待审核草稿被清空；
6. 已审核状态可在折叠的“当前已审核故事状态”中查看。

如果用户取消确认，不得把取消当成失败重试，也不得绕过确认直接调用写入接口。

## 流程 F：checkpoint 与剧情分支

### 只创建导航节点

1. 先保存当前场景的已审核草稿。
2. 点击“创建分支检查点”（Create checkpoint）。
3. 确认后，SillyTavern 在最后一条消息上创建 checkpoint，但仍停留在当前
   聊天。
4. 可通过消息旁的旗标进入 checkpoint；安装 Timelines 后可查看分支图。

checkpoint 会复制创建时的聊天元数据，因此进入分支时已有 Story State，续写
不会从空状态开始。

### 在分支保存不同正史

checkpoint 也会继承原聊天的世界书绑定。这使主线与新分支最初指向同一个
可变聊天世界书。若分支只是查看或试写且不保存记忆，可以保持不变；若要保存
分支专属状态，必须先隔离：

1. 进入 checkpoint 聊天。
2. 点击聊天世界书按钮，打开当前绑定的 World Info。
3. 使用 World Info 的“复制”操作创建一个新名称，例如
   `原名称 - Branch 2`。
4. 按住 Shift 或 Alt 点击聊天世界书按钮，选择刚复制的世界书并绑定到当前
   checkpoint。
5. 用 `/getchatbook create=false` 核对返回名称是分支副本。
6. 此后才允许在分支点击“保存已审核草稿”。

Agent 不得在共享世界书未隔离时保存互相冲突的主线和分支 Story State，也
不得启用、刷新或停用分支专属 Story Plan 焦点。

## Agent 续写时的证据优先级

当 Agent 能看到这些信息时，按下列顺序处理：

1. 用户当前明确指令；
2. 用户在本次任务中明确提供的作者计划与当前已启用 Story Plan 焦点；
3. 已审核 Story State 中的当前场景、人物状态、关系、线索和 `canon`；
4. 检索到的原子记忆；
5. 当前聊天原文；
6. 角色卡和静态世界书。

这不是允许用户指令任意篡改正史。若高优先级指令与现有正史冲突，Agent 应
指出冲突，并询问这是修订、分支还是角色认知错误，不得静默覆盖。

### 续写 Agent 的最小检查清单

- 当前时间和地点是什么？
- 谁在场，谁不在场？
- 每个在场人物知道什么、不知道什么？
- `A → B` 与 `B → A` 的关系是否不同？
- 哪些承诺、物品、伤势、目标仍然有效？
- 哪些线索仍是 `open`？
- 当前是否启用了正确的 Story Plan 章/场景？它与正史是否冲突？
- 本次作者指令是否明确激活了其他计划？
- 当前聊天是否是主线还是 checkpoint 分支？

## 失败恢复

### 生成结果不是合法 JSON

- 不保存。
- 保留当前已审核状态不变。
- 重试一次；仍失败时缩短聊天窗口，或把异常输出交给 Agent 只修复 JSON
  结构，不改动语义。

### 场景收束没有 `storyState`

- 系统会拒绝该场景收束草稿。
- 不得降级成“先保存记忆、以后再补状态”。重新生成并审核完整信封。

### 草稿属于另一个聊天

- 返回 `source.chatId` 对应的聊天再保存；或在当前聊天重新提取。
- 不得手工改写 `source.chatId` 伪造来源。

### 世界书保存失败

- 不清空待审核草稿。
- 检查当前聊天世界书是否存在、是否正确绑定，再重试。
- 分支中首先确认没有误用主线世界书。

### 状态与聊天原文冲突

- 原文可证明状态错误时，编辑待审核草稿后再保存。
- 无法确定时保留旧状态并向用户提问，不得让模型自行裁决正史。

## 面向维护 Agent 的实现不变量

修改 Creator Studio 时必须保持：

- V2 输入可迁移，规范化输出固定为 Character Card V3.0；
- `extensions` 与已支持的 V3 字段不能在往返校验中丢失；
- 嵌入 `character_book` 与独立 World Info 内容一致；
- 世界书关联通过 `extensions.world` 保存，不能触发创建接口覆盖标准 V3
  `character_book`；
- 所有持久化写入继续要求用户确认；
- 异步模型请求返回后必须再次核对来源聊天；
- Story State 常驻条目按固定 comment 原地更新；
- `authorPlans` 不得进入常驻 lorebook 内容；
- 没有 Story Plan 时，原有角色、记忆、Story State 与 checkpoint 流程保持不变；
- 完整 Story Plan 只能保存在聊天元数据；常驻条目只能包含当前章/场景，且
  不得包含完整 `premise`、后续章节或未来场景；
- Story Plan 启用、刷新和停用都必须要求用户确认并核对来源聊天；
- 分支图继续使用原生 checkpoint / Timelines；
- 英文、简体中文和繁体中文 locale key 集合保持一致；
- 新增行为必须有单元测试，并运行插件完整测试、目标 ESLint、JSON 解析和
  `git diff --check`。

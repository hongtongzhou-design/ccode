# 约定：网关与绑定（配置模型层）

> 状态：**已落地**。改 `profiles.rs` / `launch_plan` / 设为全局 / 模型能力 / 配置页 / 托盘前必读。
> 产品决策来自 2026-08-30 设计梳理；实现前走查补丁（洞 1–7）已并入本文，覆盖代码以括号内路径为准。

Ccode 的配置单位从「一条连接粘住 Agent + 端点 + 密钥 + 模型 + 策略」拆成两层：**网关**（怎么跟端点说话）和 **绑定**（某个 Agent 用这个网关的哪些模型）。控件是否出现按组合求交，不改写 HTTP，不解析 TUI `/model`。

## 1. 产品承诺（已锁定）

| 主题 | 选择 |
|---|---|
| 第三方模型对不上 CLI 原生命令 | 按 **Agent × 启动模型 × 网关槽 × 体检** 求交后只展示真能生效的控件。不走本地代理。 |
| 配置单位 | 网关一等；Agent 只绑定。同一 `(agent, gatewayId)` 只能有一条 api 绑定。 |
| 端点 | 一把密钥 + 协议分槽：`anthropic` / `openai` / `responses` / `gemini` / `cursor`。 |
| 用户策略 | Header 在网关；思考档 / 温度 / 输出上限在网关的**每个模型**上（稀疏）；Agent 绑定只决定能不能注入，以及 `extraEnv`。 |
| 会话里 `/model` | 不改进程 env。状态栏按**启动时选中的模型**决定原生命令。混用时提示「换模要重开才按新模型注入」。不追踪 TUI。 |
| 配置页 | 主列表仍按 Agent 看绑定；网关进同页工具条里的库。 |
| 官方账号 / 本地 | 官方 = 无网关绑定；Ollama 等无密钥本地端点 = 普通网关（`noAuth`）。 |
| 相对 cc-switch | 不做商业中转预设、本地代理、云同步、切走回写。**要做托盘一键「设为全局」**，且托盘只写全局文件、不改启动栏默认绑定。 |
| 内外双轨 | 「默认」（注入预选）和「全局生效」（上次写入 CLI 文件）是两个徽标，不合成「启用」。 |

明确不做：解析 TUI `/model`、热切已开内嵌标签、请求改写。

## 2. 对象模型

```
Gateway
  id            新发 UUID（见 §3：不复用 profile id）
  name
  noAuth
  keyHint       密钥本体在 keys.json，键 = gateway id
  slots         { anthropic, openai, responses, gemini, cursor } 均可空
  headerEnv     Header 名 → 环境变量名（不落密文）
  models[]      GatewayModel（目录 ∪ 手填；策略字段稀疏）
  catalogFetchedAt, catalogFromSlot
  lastProbe[]   见 §8
  slotProbes[]  list 时按槽现算 latest（lastLatencyMs / lastOk / lastProbeAt）；不落盘

GatewayModel
  id            网关认识的模型 id
  source        fetched | user
  temperature / topP / maxOutputTokens / reasoningEffort   用户设了才存

Binding
  id            见 §3
  agent
  kind          api | official
  gatewayId     api 必填；official 为空
  protocol      仅 qwen / kimi 需要（同一 openai 槽可当 kimi 或 openai）
  apiBackend    仅 grok（chat_completions/responses/messages；仅「设为全局」写 [model.*] 消费，启动注入够不到）
  models[]      有序，首个 = 启动默认
  extraEnv      CLI 专用，不自动拆去网关
  lastUsedAt

约束
  同一 (agent, gatewayId) 至多一条 api 绑定
  每个 agent 至多一条 official 绑定
  绑定时该 Agent 所需协议槽必须已填，否则先补槽（缺槽态见 §9）
```

槽对照（与现 `launch_plan` 一致，不是新发明）：

| Agent | 槽 | 现实现 |
|---|---|---|
| Claude Code / CodeBuddy | `anthropic` | `ANTHROPIC_*` / `CODEBUDDY_*` env |
| Codex | `responses` | `-c model_providers.<id>.*`，`wire_api=responses` |
| Gemini | `gemini` | `GOOGLE_GEMINI_BASE_URL` 等 |
| Cursor | `cursor` | `CURSOR_API_ENDPOINT` + `--model` |
| Grok / OpenCode | `openai` | grok：`GROK_MODELS_BASE_URL`；opencode：`OPENCODE_CONFIG_CONTENT` 内联 JSON |
| Qwen / Kimi | 绑定 `protocol` → `openai` 或 `anthropic` | kimi 官方协议仍用 openai 槽 URL + `provider_type=kimi`；kimi 双写 `KIMI_MODEL_BASE_URL` / `KIMI_BASE_URL` |

显示名：绑定无独立名字，列表用网关名（一对一）。官方绑定固定叫「官方账号」。

「复制到其他 agent」改为：**把该网关绑到目标 Agent**。缺槽当场补 URL，不复制密钥。

## 3. 第 0 原则：binding id 复用旧 profile id

磁盘上大量以 profile id 为锚，迁移不得重发 binding id。

**binding id = 旧 profile id**（UUID 原样）。**gateway 另发新 id**。

因此以下全部不断链，适配层只改「读到的对象从 Profile 变成 Binding」：

| 锚点 | 位置 |
|---|---|
| Codex catalog 文件名 | `ccode/catalogs/codex-<id>.json`（`agents.rs` `codex_catalog_path`） |
| 定时任务 | `schedules.json` 的 `profile_id`（`scheduler.rs`） |
| 会话归属 | `app.db` `session_meta.profile_id` |
| 设置五字段 | `ai_profile_id` / `ai_profiles` / `default_profiles` / `hidden_profiles` / `active_global_profiles`（字段名暂不改存储，语义改为 binding id） |
| localStorage | `ccode.terminalTabs.v1`（`profileId`）、`ccode.lastProfile.<agent>`、`ccode.lastLaunch`、`ccode.wsLast.<cwd>`、`ccode.quickChat`（`profileId`） |

**必须重键的只有 `keys.json`**：密钥从 profile id 迁到 gateway id。`get_key` 的入参改为 gateway id；启动路径 = binding → gateway → key。官方绑定不查密钥。

被合并掉的旧 profile（见 §13）id 进合并清单，供「拆开这次自动合并」还原；这些 id 不再出现在绑定表里，指向它们的 schedules / lastProfile 在合并当时改写为保留下来的 binding id。

## 4. Provider 身份不得再叫死常量 `ccode`

启动注入是进程级，多网关不打架。真正冲突在落盘身份和会话元信息：

- Codex 全局：`[model_providers.ccode]` 只有一段，后写覆盖先写（`global_config.rs` `patch_codex_config`）。与「每 agent 一个全局生效徽标」自洽，可接受。
- Codex rollout 只记 `model_provider="ccode"`（`agents.rs` `codex_inline_provider_args` 注释），不含网关。拆层后若仍用常量，旧会话恢复会静默指到当前随便一个带 URL 的绑定。
- OpenCode 内联 / 全局：`provider.ccode`，模型 `ccode/{m}`。
- Kimi 全局：`providers.ccode`，`[models.*].provider = "ccode"`，占位别名也曾叫 `models.ccode`。

**规则**：provider 名从网关派生，注入与全局写入同一函数：

```
provider_id(gateway) = "ccode-" + gateway.id 去掉连字符后的前 8 位十六进制
```

（kimi 别名字符集 `[A-Za-z0-9_-]`、TOML 裸键、OpenCode provider 键都吃得下。）实现固定取 8 位；碰撞极罕见，不做加长。辅助函数单一出处，禁止各 adapter 再写死 `"ccode"`。

新会话 / 新全局写入用派生名。**写派生名时清掉 Ccode 历史上写的无后缀 `ccode` 段**（`model_providers.ccode` / `provider.ccode` / `providers.ccode`），避免两套并存。

**恢复回落**：

| 会话记录的 provider | 行为 |
|---|---|
| `ccode-<短id>` | 按短 id 找网关，注入同名 provider；找不到再走下面的旧口径 |
| `ccode` 或不含网关（迁移前 rollout） | 按 `session_meta.profile_id`（= binding id）恢复；没有则 `pickResumeProfile` 原顺序（期望 id → 该 agent 带槽 URL 的绑定）。注入时 provider 名仍用 **`ccode`**，以便对上旧 rollout。不要把旧会话改写成派生名。 |
| 其它 / 空 | 维持现顺序 |

`src/resume-profile.ts` 的 `provider === "ccode"` 判断改为：`ccode` **或** `ccode-` 前缀。派生名命中网关后，只在该网关的绑定里挑，不再「任意带 baseUrl」。

## 5. 求交器

纯逻辑，**后端单算、前端消费 DTO**（测试锁死）。前端不得自己查能力链——能力链在 `model_registry.rs`，状态栏隐藏 `/effort` 与网关库三态字段都只读 `combo_surface` / `combo_surface_for_gateway`。

```
surface(agent, modelId, gatewayId, slot, launchSelected: bool) → ControlSurface
```

消费：

- 模型能力：`model_registry` 五层链（thinking / context / output / vision）。relay 层按 §6 带网关维度。
- Agent 通道：`request_policy_support`（supported / unsupported / unknown）。
- 用户在该模型上存的策略（稀疏）。
- `lastProbe`（§8）。
- Agent TUI 原生命令：`effort_levels` / `model_switch`。

显示规则（2026-09-01 起通道按入口记账：`inject` 启动注入 / `persist` 仅设为全局 / `tui` 仅会话内命令 / `unsupported` / `unknown`）：

- **可改** = 模型能力允许 ∧ 通道 `inject`（体检未失败）∨ 通道 `persist`（启动不注、设为全局生效）。
- **只读可见** = 模型上已存值，但通道为 `tui`/`unsupported`/`unknown` → 「已保存在网关，当前 CLI 没有通道」（tui 另有专用文案「仅会话内原生命令生效」）。
- **不出现** = 模型不会思考，或托管工具（web search 等）在第三方上。继续如实不声明 hosted tools。
- **状态栏 `/effort`** = 仅启动时选中模型求交为「原生档位可用」。绑定名单能力混杂（思考或已存采样策略不一致）→ 固定一句重开提示。
- **协议维度**：kimi 的 effort 通道仅 kimi 协议读取，绑 anthropic/openai 协议的绑定求交按 unknown 计（`channel_status_for`）。
- **从未体检 ≠ 体检失败**，见 §8。

「未实证一律不注」仍只约束 **Agent 通道表** 为 unknown/unsupported 的字段，与体检无关。

## 6. 能力数据源：唯一破例是 relay 键

查询链其余层不动，键仍是纯模型名前缀（`model_registry.rs` `normalize` / `longest_match`）：用户覆盖、公共库、内置表、关键词兜底都与 URL/网关无关。

**例外**：`model-capabilities-relay.json` 今日以模型名为键，「同一模型在不同网关能力不同时最新一次拉取赢」（`record_relay_models_to`）。多网关下两家中转同卖 `deepseek-v3.1` 会互踩。

- 新写入键：`{gatewayId}|{modelId}`（modelId 用网关返回的原始 id，查询时再 `normalize` 末段）。
- `chain_field` 增加可选 `gateway_id`：relay 表只查带该前缀的键；其它表仍只认模型名。
- 升级后**不读**无 `|` 的旧键（避免继续互踩）。各网关第一次「获取模型」才填新键；在此之前求交跳过 relay，走公共库 / 内置表。
- `record_relay_models` 必须传入 `gateway_id`，禁止再写无前缀键。

## 7. 逐模型策略是新维度，不是搬字段

今日 `RequestPolicy` 是连接级单份（`profiles.rs`）。OpenCode 注入把同一份 `model_opts` 套到 `provider.ccode.models` 的每一个条目（`agents.rs` 约 436–442 行）。Codex 的 `model_reasoning_effort` 也是启动级一条。

拆层后：

- **存储**：`GatewayModel` 上的稀疏字段，四头全新（存储 / 注入按启动模型取值 / 求交 / 模型行展开编辑）。排期不得按「把 request_policy 挪个位置」估。
- **注入**：只取**启动时选中模型**上的值，且求交允许才注。不再把一份策略套到名单里每个模型。
- **全局写入**：CLI 文件格式支持逐模型的（OpenCode `models.*.options`、Kimi `[models.*]`、Codex catalog 的 reasoning 仍是模板全量、effort 仍是一条 `model_reasoning_effort`）按各模型自己的值写；只有一条槽位的 env（`CLAUDE_CODE_EFFORT_LEVEL`、Codex `model_reasoning_effort`）用绑定名单**首个**模型的值。
- **迁移摊派**：旧连接级 `request_policy` 的思考档 / 温度 / 输出上限摊到该连接当时模型名单里的**每一个**模型（唯一合法迁法）。Header 进网关 `headerEnv`。同一模型多条旧连接值冲突：非空合并，全冲突则留 `lastUsedAt` 较新的。

`extraEnv` 全部进绑定，迁移不猜测拆分。

## 8. lastProbe：新状态，必须有失效规则

今日探针结果不落盘，每次重探（`profile_validation.rs`）。方案把 `lastProbe` 存进网关之后：

**存什么**：按槽（及可选 model）存各检查项：`never` | `passed` | `failed`，外加探测时间和所用 URL 指纹。

**作废**：该槽 URL 变更、网关密钥变更（含从有到无 / 轮换）、`noAuth` 翻转。作废 = 回到 `never`，不把旧失败带到新端点。

**求交**：

| 体检 | 控件 |
|---|---|
| `never`（从未体检） | **不否定**。通道 supported 且模型能力允许 → 可改（乐观）。 |
| `passed` | 放行。 |
| `failed` | 否定该项：即使通道 supported 也禁用，并显示体检摘要。 |

**与注入侧的不对称**（必须写进用户手册）：

- 注入「未实证一律不注」= Agent **通道表** unknown/unsupported，跟体检无关。Claude 的 effort 通道是 supported，从未体检也会注。
- 体检失败才会挡住已有通道的注入。
- 手册原句建议：「网关体检不是开关。没跑过体检时，Ccode 只按 CLI 是否真有注入通道决定；体检明确失败才会关掉对应控件。」

官方绑定、无密钥网关：无 API 探针；求交不看 probe。

## 9. 删除网关 / 清槽 / 悬挂绑定

- **有绑定的网关禁止删除**。按钮置灰，提示先解绑。不解绑不级联删绑定（绑定 id 是 schedules / 会话锚）。
- **槽可清空**。依赖该槽的绑定进入 **缺槽态**：配置页行 ⚠「这个网关还没配该协议的端点」；启动栏该项禁选；设为全局 / 托盘该项禁用。绑定记录保留（id 不断）。
- **解绑**：删除绑定行。先走现有 `clear_profile_refs` 同类清理（settings 五字段、schedules 里指向它的 `profile_id` 置空）。catalog 文件可删。不解绑网关、不动密钥。
- **删除无绑定的网关**：删网关行 + `keys.json` 对应键 + 该网关的 relay 前缀键（尽力而为）+ 该网关 lastProbe。

## 10. 配置页信息架构

主列表按 Agent 分组（启动路径不变）。每行一条绑定：网关名、模型摘要、两个徽标：

- **默认**：启动栏预选（`default_profiles`，值 = binding id）。
- **官方账号模型（v3.186）**：启动不得把中转/国产网关模型名（deepseek / qwen / glm…）注入官方通道。Codex 官方只接受 `gpt-` / `o1`/`o3`/`o4` / 含 `codex` 的模型；否则不传 `-m`，避免 ChatGPT 订阅的 `service_tier=priority` 打到 DeepSeek 上。前端 `officialModelAllowed` 与 `agents.rs official_model_allowed` 双端镜像。
- **全局生效**：上次由 Ccode 写入该 CLI 文件的绑定（`active_global_profiles`）。口径仍是「上次写入」不是绝对生效态；托盘见 §12。

行内：编辑绑定（模型名单 / 默认模型 / extraEnv）· 在终端使用 · 设为全局 · 停用 · 解绑。

「添加」= 选用已有网关（缺槽则先补）或新建网关再绑定。选用已有网关时从该网关目录勾选启动模型，禁止把整份目录预填进绑定。

官方账号收进组头芯片（已安装才显示）：未连接是「连接」ghost 钮（终端跑 CLI 登录），已连接是「官方已连接」。不占一整行。启动栏里官方也是一条绑定。

网关库（同页工具条，不是新的一级导航）：密钥、五个协议槽、Header、获取模型、按模型展开策略、按槽体检。连接弹层保持窄；网关编辑可以更宽。保存是唯一主 CTA。

## 11. 启动注入

启动栏：Agent → 绑定（网关名 / 官方账号）→ 模型（绑定名单）。

拉起那一刻按当时选中模型求交后注入。`launch_plan` 入参改为 `Binding + selected_model + Gateway`。预览仍脱敏。

需要「启动时把名单注册进选择器」的 CLI（Claude 最多 5 槽、Codex catalog、OpenCode models、Grok `allowed_models`）：写入绑定的整份名单。Codex catalog 路径仍 `codex-<binding_id>.json`（§3）。

官方绑定：不注 API、`env_remove` 残留密钥变量（现口径）。`extraEnv` 仍最后注入。

**Codex 官方绑定额外注入** `-c model_provider="openai"`：磁盘 `config.toml` 的 `model_provider` 指向自定义网关时会盖过 ChatGPT 登录（选官方账号仍走网关计费）。`-c` 优先级最高，只影响本进程，不改用户文件、不写 `[model_providers.*]`。登录走 `codex login --device-auth`（设备码印在内嵌终端；不在 Ccode 内自建 OAuth）。未选模型时磁盘 `model` 仍会生效。`chatgpt.com` 401 / `token_revoked` 是 ChatGPT 登录态本身失效，不是官方/API 凭证串台。

**Codex 恢复不得串台（v3.223）**：rollout 的 `model_provider` 分三条——`ccode`/`ccode-<短id>` = Ccode 网关；`openai` = ChatGPT 官方；其他名字（磁盘 `custom` 等）= 客户端/全局配置渠道。自动恢复时客户端渠道只挑带 Base URL 的网关，绝不落到官方账号（否则强制 `api.openai.com` 且 `env_remove` 密钥，报 401 Missing bearer，同一会话在客户端却能继续）。官方未登录时 `openai` 会话也改挑网关；启动栏未登录的官方账号不自动预选，硬启动先确认。纯逻辑 `src/resume-profile.ts`。

**无头调用（雷达解读 / 提交信息等）** 的「最近使用」回落跳过官方账号：OAuth 过期会把 CLI stderr 甩到界面。有 API 配置就走 API；只有官方才回落官方。显式 id、功能专属、AI 专用仍尊重官方。失败文案走 `summarize_headless_error`，不回整段日志。终端里手选「官方账号」不受这条约束。

**Codex 网关绑定额外注入** `-c web_search="disabled"` 与 `-c service_tier="auto"`：ChatGPT 登录/磁盘默认会把官方 hosted 网页搜索和订阅优先档带进本进程；catalog 的 `supports_search_tool: false` 挡不住请求。DeepSeek 等中转会拒 `web_search`（有的网关转成 Anthropic `web_search_20250305`）。只盖本进程，官方账号启动不注。

**出网代理**（设置 `outbound_proxy`）：只注入官方启动与组头登录（`HTTPS_PROXY`/`HTTP_PROXY`/`ALL_PROXY`/`NO_PROXY`）。网关 API 启动不走。连接 `extraEnv` 同名键最后覆盖。不建本地反代理，官方失败不回落中转。

## 12. 设为全局与托盘

「设为全局」是绑定上的动作，复用现事务写入 / 备份 / 原始快照 / 复检弹层。成功更新「全局生效」徽标，**不**改「默认」绑定。无密钥网关仍禁止设为全局（`plan_writes` 现拒绝 `noAuth`，保持）。

**官方绑定「设为全局」改语义**（今日 `plan_writes` 对 official 直接报错）：改为 `restore_original_backup`——清掉 Ccode 写入的 API 配置，让 CLI 登录态接手，并 `clear_active_global`。没有原始快照（从未对这个 agent 设过全局）= 无事可恢复，按钮说明「当前全局文件不是 Ccode 写的，无需恢复」。这是切回官方账号的托盘 / 菜单入口，不是新发明（`global_config.rs` `original/` + `restore_original_backup`）。

**托盘**（仓库里目前没有，本批新增）：

```
Ccode            → 打开主窗口
Claude Code      → 各绑定（含官方账号）
Codex            → …
（set_global unsupported 的 Agent 整组置灰，原因与配置页同源）
退出
```

点击 api 绑定 = 同一套 `apply_global`。失败 OS 通知，不弹进度层。不改启动栏默认，不热切已开标签。

**托盘选中态不要把「上次写入」画成收音机承诺**（洞 7）：

`active_global_profiles` 在用户于 Ccode 外手改文件后会失真。配置页徽标可以靠 title 交代；托盘 `●` 会放大成「这就是当前全局」。

菜单弹出时对该 agent 做一次 **dry-run**：`plan_writes` 产物与磁盘现文件比对（忽略无关空白 / JSON 键序若现实现已有归一就用）。

| 比对 | 托盘 |
|---|---|
| 与某绑定计划一致 | 该项 `●`，其余 `○` |
| 谁都比不上（手改 / 他方工具写过） | 全部 `○`，菜单顶一行「全局文件已在 Ccode 外改过」 |
| dry-run 失败（读文件失败、超时） | 回落「上次写入」徽标口径，并在该项 title 标明「未校验磁盘」 |

不在托盘做 cc-switch 式回填保真。比对只影响显示，不自动写回。

## 13. 迁移

升级时一次性，可拆回。合并清单落 `ccode/gateway-merge.json`（或同等），「拆开这次自动合并」按清单把被吞掉的 binding / 单槽网关还原，并把 keys 再拆回去。

步骤：

1. 备份 `profiles.json` + `keys.json`。
2. 官方账号 profile → official 绑定，**id 不变**，`gatewayId` 空。
3. API profile 按 `keys.json` 密钥指纹分组（无密钥的 `noAuth` 按「无密钥 + 规范化 URL」分组，避免把所有本地端点合成一个网关）。
4. 一组一把密钥 → **一份新 id 网关**；每条旧连接按当时 Agent 协议把 URL 填进对应槽。
5. **同槽两个不同 URL → 拆成两份网关**（密钥相同，不盲合）。
6. **同一 `(agent, gateway)` 撞唯一约束**（今日允许同一 agent 两份同密钥同 URL 连接，即「工作 / 省钱」不同名单）：
   - 合并模型名单（保序去重：先 `lastUsedAt` 较新那条的名单，再追加另一条里尚未出现的）。
   - 保留较新那条的其余属性（extraEnv、protocol、停用态等），**保留其 profile id 作为 binding id**。
   - 另一条进合并清单：记下被丢弃的 id、名单、extraEnv，供拆开还原。
   - 指向被丢弃 id 的 settings / schedules / lastProfile / session_meta **改写为保留 id**（否则「接着聊」会指向幽灵 id）。
7. 旧 `request_policy` 按 §7 摊派。
8. `keys.json` 重键到 gateway id；旧 profile id 键删除（官方本无键）。
9. `default_profiles` / `hidden_profiles` / `active_global_profiles` / `ai_*` 已是 binding id，仅当第 6 步发生改写。
10. 旧 `profiles.json` 备份保留；网关库提供「拆开这次自动合并」。

用户侧：曾经复制到 Claude / Codex / Qwen 的同一把 NewAPI → 一份多槽网关 + 三条绑定（各 binding id = 原三条 profile id）。

## 14. 获取模型：分槽保留现状，不要只走 OpenAI

列表缓存键今日已是 `agent|protocol|base_url`（`models.rs`），改造为 **`gatewayId|slot`** 即可。

「优先走 OpenAI 槽」只决定**网关库点一次「获取模型」时先拉哪一个槽**。每个槽的 HTTP 路径必须保留现状，尤其：

- Gemini：`/v1beta/models` 候选（`models.rs` 143–154 行），query `key=`，不是 `{base}/v1/models`。
- Anthropic 槽：现 Claude/CodeBuddy 拉目录的路径与鉴权（Bearer）不得改成 OpenAI 形。
- Cursor：继续拒绝通用 `/models`（现直接报错）。
- OpenAI / Responses：现 `{base}/v1/models` 或 `{base}/models` 候选链。

分槽拉取失败不互相覆盖缓存。目录合并进网关 `models[]` 时打 `catalogFromSlot`；手填 id 始终允许。Relay 写入带 `gatewayId`（§6）。

## 15. 落地时要改口的假设

- 逐模型策略是四头新工作，不是迁字段（§7）。
- 落地第 1 步不是纯前端：状态栏隐藏无效 `/effort` 需要「该模型会不会思考」，能力链在 Rust，要先有 `combo_surface`（或同等）command / DTO。
- Gemini 拉目录路径特殊（§14）。
- 文档清单必须包含 **AGENTS.md 本身**（`profiles.rs` 条目、密钥/注入硬约束措辞随对象改名：密钥键从 profile id 改为 gateway id；`launch_plan` 入参；「复制到其他 agent」）。另改 `docs/user-guide.md` 连接章、本文、`docs/architecture.md` §5/§10、matrix 里 Profile 称谓、`docs/conventions/safety.md` 的 RequestPolicy 条。

## 16. 落地顺序

真正的新硬骨头只有三块：**provider 派生名（§4）**、**relay 缓存键（§6）**、**逐模型策略载体（§7）**。其余是迁移细则。

1. **求交 DTO + 单测**。Rust 出口 `combo_surface`；状态栏按启动模型隐藏无效 `/effort`。存储仍是 Profile。relay 键改造可与此并行，但求交已按可选 gatewayId 查（旧数据无网关则跳过 relay）。
2. **Gateway / Binding 存储 + §3/§13 迁移**（含撞唯一约束的名单合并）。`get_key` 改键。`launch_plan` / `plan_writes` 改读新对象；provider 名改派生 + 旧 rollout 回落。配置页可先用适配层，UI 仍像今天。
3. **配置页拆开**：Agent 绑定列表 + 网关库；缺槽态；解绑 / 禁删。
4. **逐模型策略 UI + 体检挂槽 + 注入按选中模型求交**。OpenCode 不再把一份 options 套所有模型。
5. **托盘**：按 Agent 列绑定；`plan_writes` dry-run 选中态；官方 = 恢复初始快照。
6. **文档**：§15 清单一次齐。

## 17. Key Decisions

1. 诚实呈现，不走本地代理、不解析 TUI `/model`。
2. 网关 / 绑定拆层；`(agent, gateway)` 一对一。
3. **binding id 复用 profile id，gateway 新发 id**——迁移不断锚。
4. Provider 名 `ccode-<网关短id>`；旧 rollout 的 `ccode` 按 binding id 回落并仍以常量名注入。
5. Relay 缓存键带网关；其它能力层不动。
6. 体检从未 ≠ 失败；与通道表「未实证不注」不对称，手册写明。
7. 托盘只写全局、不改注入默认；选中态以 dry-run 文件比对为准，比不了对回落「上次写入」。
8. 有绑定禁删网关；清槽 → 缺槽态保留绑定 id。
9. 官方设为全局 = 恢复初始快照。
10. 预设表仍只收官方 / 公开端点。

## 18. 导出 / 导入 v2

文件形状（`export_gateways_v2` / `import_gateways_v2`）：

```
{
  version: 2,
  gateways: [{ name, noAuth, slots, headerEnv, models, apiKey? }],
  bindings: [{ agent, gatewayRef: { name, slotFp }, protocol, apiBackend?, models, extraEnv }]
}
```

- `slotFp`：已填槽的 `name=规范化URL` 用 `|` 拼接，导入按它（及可选密钥指纹）对上网关。
- 默认不含密钥。含密钥须二次确认，落盘 0600；`extraEnv` 仍按名剔除含 KEY/TOKEN/SECRET/PASSWORD/AUTH 的项，再过 `redact_sensitive_text`，然后才把 `apiKey` 写回。
- 导入：先按密钥指纹匹配，没有或对不上再按槽指纹。同网关槽 URL 冲突、Header / extraEnv / 协议冲突进 `skippedSlots`（界面列出原文）。唯一约束命中则合并模型名单。
- 旧 profiles 数组仍能导入（v1 回落）。

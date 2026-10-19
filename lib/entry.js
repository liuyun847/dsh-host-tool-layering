/**
 * dsh-host-tool-layering · 入口工具（常驻可见的"工具加载器"，**每组一个**）
 *
 * ## 它补的是什么缺口
 * 本插件把各组工具从**模型可见工具表**里摘掉之后，模型手上只剩技能当说明书 ——
 * 说明书告诉它"有哪些工具、按完整名怎么调"，但它**看不见**这些工具的任何痕迹。
 * 真机上因此失败过一次：模型全程一次都没发出 `cua_driver_native__*` 调用（反而跑去
 * `cordis_inspect` 里"查工具"，撞了个不存在的方法就放弃了）。复盘见工作区笔记
 * `.dsh\.project\dsh-工具面按需暴露-20261005.md` §1（325 次工具调用里 CUA 零次）。
 *
 * 本模块补上"看得见的入口"：**每个组**注册一个常驻可见的小工具（缺省名 `get_<组名>`，
 * 默认两组即 `get_cua` / `get_godot`）。模型调用某个入口一次 ⇒ **该会话**从**下一步**起
 * 只放行**那一个组**（v0.3.1 起：进程内粘住 **+ 落盘投影** ⇒ 宿主重启后也会自动恢复，见下）。
 *
 * ## v0.3.0：放行粒度从"会话"收紧到"**(会话, 组)**"
 * v0.2.0 是一个入口放行所有组（调用 `get_cua` 会连 godot 一起放行）。现在每组各管各的：
 *  - 登记表是 `Map<sessionId, Set<组名>>`（值从 `true` 变成"这个会话放行了哪些组"）；
 *  - 装配侧按 `(会话, 组)` 逐组判定（见 `lib/assembly.js` 的 `armedGroups`）；
 *  - 调用仍然是**只加不减**、**幂等**：重复调用不改变任何工具表。
 *
 *
 * ## v0.3.1：登记表**落盘**，跨宿主重启存活
 * 宿主一重启，所有会话回到"全摘"默认态，而工具表是**每步从注册表重新装配**的 ⇒ 恢复后的第一条
 * 请求看到的是"少了那一组工具"的表，**整段前缀缓存作废**。2026-10-16 22:28 实测：某会话恢复请求的
 * 工具数从 98 掉回 42（cua 组 56 个全部回落），该请求 `inputTokens 463,324 / cacheReadTokens 3,200`
 * （前一请求命中 489,472）⇒ 约 46 万 token 按全价重算。
 * 现在这份 `(会话, 组)` 登记会写进**宿主领域存储**（域 `tool_layering_armed` / 表 `armed`，
 * 键 = sessionId，值 = `{ groups: string[] }`），启动时在**第一次装配之前**恢复回来：
 *  - **写侧**：{@link armGroup} 放入一个**新**条目后通知写侧回调（重复放行不写），写的是该会话
 *    **整份**组表（覆盖写 ⇒ 幂等、无需读-改-写）；失败只打一条 warn，绝不影响返回值语义；
 *  - **读侧**：域打开 + 水合落定之前，装配水线会 `await` 它（上限 `ARMED_RESTORE_WAIT_MS`）——
 *    这就是"不留竞态"的实现方式（细节与超时闸门的理由见 `lib/index.js` 的 `waitArmedRestore`）；
 *  - **降级**：存储服务不在场 / 域打开失败 / 记录形状不认 ⇒ 退回纯内存（行为与 v0.3.0 完全一致）
 *    + 一条 warn 明说"本次运行不持久化"，水线与入口工具照旧；
 *  - 登记表**本身**仍是模块作用域的那一张（配置热替换照旧不抹放行），落盘只是它的持久投影。
 *
 * ## 一步时延是设计使然，不是缺陷
 * 装配发生在**每一步开始**（`dsh-agent-loop\lib\index.js:907` 每个 preStep 调
 * `systemPrompt.assemble()`），而工具调用发生在**步中** ⇒ 第 N 步调用、第 N+1 步的工具表
 * 才含这些工具。表变会追写一条 `request/header(reason='change')` + 一条 `developer/message`
 * (tool-addition×N)（`dsh-agent-loop\lib\index.js:1202-1248`）—— 这是**一次即稳**的设计行为：
 * 武装之后每步的工具表就固定了，不会来回抖。
 *
 * ## 工具定义面：**只说"能拿到什么"，机制解释属于 README**
 * 描述是**每步都要付的常驻 token**，所以刻意压到一句话、英文、≤120 字符：
 * `Reveal the <组名> tools (prefix <前缀>) in this session.`（内置两组有更具体的措辞）。
 * "为什么需要它 / 一步时延 / 幂等 / 登记表在哪 / 不是能力边界"这些都属于 README，
 * **不写进工具定义**（`render` 同样只留一行 ≤40 字符的中文）。
 *
 * ## 登记表为什么放在模块作用域
 * `Map<sessionId, Set<组名>>` 放在**模块作用域**（不是 `apply()` 体内）：配置热重载会重新跑
 * `apply()`（`cordis-plugin-loader\lib\index.js:446` 同 name 的行只走 `_patchContext()`），
 * 若把登记表放在 `apply()` 里，一次配置保存就把"已放行"抹掉，模型刚点开的工具又消失。
 * **进程内不清理**：会话结束就没人再查它（每会话几十字节），换来的是"到重启为止一直有效"
 * 这种确定语义。⚠ v0.3.0 时它**不落盘** ⇒ dsh 重启后所有会话回到未放行（默认态就是
 * 省 token）；v0.3.1 起同一张表有了一份**落盘投影**（见上"v0.3.1"一节），重启后自动恢复
 * —— 内存这张始终是权威读源，介质只是它的备份。
 *
 * ## 机制依据（live 树 = `~\.dsh\profiles\node_modules\@deepseek-ai\`，Junction → 安装树）
 * | 事实 | 依据 |
 * |---|---|
 * | 装配水线的 `context.scope` **就是 agent**，`scope.id` = SessionId | `dsh-agent\lib\types\dispatch.js:92`（`assembleContextFor` 返回 `{agent, scope: agent}`） |
 * | Agent 的身份字段 | `dsh-agent\lib\types\types.d.ts:11,13`（`readonly id: SessionId`）；运行面另有 `session`（`runtime-types.d.ts:143`） |
 * | `ctx.tools.register(definition)` 是 public，**无 scope 要求**：经服务自身 ctx 落 **global 层** ⇒ 全 agent 可见 | `dsh-tools\lib\index.js:2878-2887`；可见集合 = global + 作用域链（`:2959-2985 view()`） |
 * | 注册即进模型可见工具表（装配直接取注册表可见集合） | `dsh-system-prompt\lib\index.js:348` → `dsh-tools\lib\index.js:2831 wireSchemas(scope)` |
 * | 工具名**没有前缀约定**（`mcp__` 只是 MCP 客户端的命名约定）⇒ `get_cua` / `get_godot` 不会撞任何组前缀 | `dsh-mcp-client\lib\index.js:120-126`（只有 MCP 工具带前缀）；本插件按配置里的前缀匹配 |
 * | 调用路径只查注册表：`tools/pre-execute` → 守卫 → `resolveExecution` | `dsh-tools\lib\index.js:3011` → `:2995 get(name, scope)` |
 * | 保留名 `run_code` 不能注册（配置层已拒绝这个值） | `dsh-tools\lib\index.js:2885` |
 * | 执行侧 `exec.agent` 由 agent loop 填（`ToolExecutionInput.agent`） | `dsh-tools\lib\types\index.d.ts:229` |
 * | 本机 11 个插件都没有注册 `tools.guard` / `tools/pre-execute`，且本工具不声明 approval ⇒ 不会弹审批 | 2026-10-05 全 profile 扫描（见工作区笔记 §5 的核验记录） |
 *
 * ## 值 schema 是**作者 DSL**，不是裸 JSON Schema
 * `defineTool` 的 `output.schema` 与 `parameters` 走 `dsh-tools` 的 schema 编译器：
 * object 根必须显式写 `additionalProperties`（先例与注释：本机
 * `dsh-host-task-board\lib\index.js:1361-1363`）。本工具的 canonical value 恒为
 * `{ group, armed, alreadyArmed }`（两个布尔 + 组名）⇒ 声明 `additionalProperties: false`
 * 把形状锁死。⚠ 宿主会拿它校验返回体（`dsh-tools\lib\index.js:3542 snapshotToolValue` →
 * `:2554 returned invalid output`），所以返回值必须是**无损 JSON**（绝不放 `undefined` 键）。
 */

import { defineTool } from '@deepseek-ai/dsh-tools'

/**
 * 内置两组的工具描述（比通用推导更具体：点名每组有多少个工具、分别是什么）。
 *
 * 键是 **prefix**（不是组名）：描述讲的是"这批工具"，而 prefix 才是这批工具的身份；
 * 用户改了组名也不该让描述变得不准。命不中就用通用规则（见 {@link describeEntryTool}）。
 *
 * ⚠ 这是一句**每步都要付 token** 的常驻文案：只说"能拿到什么"，不解释机制（见文件头）。
 */
const KNOWN_DESCRIPTIONS = new Map([
  ['cua_driver_native__',
    'Reveal the computer-control tools (cua_driver_native__*: 46 desktop + 10 browser) in this session.'],
  ['mcp__godot_use__',
    'Reveal the Godot MCP tools (mcp__godot_use__*) in this session.'],
])

/**
 * 已放行的组登记表：`Map<sessionId, Set<组名>>`。
 *
 * **模块作用域 + 不清理**，理由见文件头（配置热重载不该抹掉放行状态）。
 * 只加不减（没有"收回"这个产品语义）：某个 `(会话, 组)` 一旦进来就到进程结束。
 *
 * @type {Map<string, Set<string>>}
 */
const armedGroupsBySession = new Map()

/** 取不到会话时回给调用方的空表（**不要**改它：它是共享常量）。 */
const NO_GROUPS = new Set()


// ── 落盘钩子 + 快照/恢复（v0.3.1）：登记表与介质之间的接口 ─────────────────────
// 为什么接口开在这里、而不是让 `lib/index.js` 自己读写这张表：登记表在**模块作用域**，
// 只有本模块能安全地读写它；`index.js` 负责的是"什么时候读介质、什么时候写介质"
// （只有它拿得到 `ctx.storageDomain` 与当前配置）。

/**
 * 写侧回调集合：登记表**新增**一个 `(会话, 组)` 时被通知一次。
 *
 * 契约（三条都是硬的）：
 *  - **同步返回、绝不抛**（它跑在 {@link armGroup} 里，而 `armGroup` 的返回值是给模型看的
 *    `alreadyArmed`）；真要写盘就在内部 fire-and-forget；
 *  - **只在新增时被调用**：重复放行不产生任何写盘动作（幂等靠这一条撑着）；
 *  - 由 `lib/index.js` 在 `apply()` 里登记、卸载时注销（见 {@link addArmedWriter} 的返回值）。
 *
 * @type {Set<(sessionId: string) => void>}
 */
const armedWriters = new Set()

/**
 * 登记一个写侧回调。
 *
 * @param {(sessionId: string) => void} writer - 写侧回调（同步、不抛；返回 Promise 也会被兜住）。
 * @returns {() => void} 注销函数（幂等）。
 */
export function addArmedWriter(writer) {
  if (typeof writer !== 'function') throw new TypeError('addArmedWriter: writer 必须是函数')
  armedWriters.add(writer)
  return () => { armedWriters.delete(writer) }
}

/**
 * 通知全部写侧回调。**绝不抛、绝不 await**：写盘失败只该表现为"这一条没落盘"。
 *
 * @param {string} sessionId - 刚新增登记的会话 id。
 * @returns {void}
 */
function notifyArmedWriters(sessionId) {
  for (const writer of armedWriters) {
    try {
      const result = writer(sessionId)
      // 写侧理论上只同步返回；万一它交回一个 Promise，也在这里把 rejection 吃掉
      //（否则会变成 unhandled rejection，而它跟眼前这次工具调用毫无关系）。
      if (result !== null && typeof result === 'object' && typeof result.then === 'function') {
        result.then(undefined, () => {})
      }
    } catch { /* 写侧自己兜异常；这里再兜一层，保证 armGroup 的返回值不受任何影响 */ }
  }
}

/**
 * 取该会话已放行组名的**快照**：排序 + 去重后的**新数组**。
 *
 * 为什么不让写侧直接读活引用（{@link armedGroupsOf}）：落盘要的是"同一份状态任何时候序列化
 * 都得到同一串字节"——`Set` 的插入顺序随模型点入口的先后变化，直接 JSON 化会让介质内容随
 * 操作顺序抖动（人工比对也费劲）。
 *
 * @param {unknown} sessionId - 会话 id。
 * @returns {string[]} 组名数组（升序）；未登记的会话给空数组。
 */
export function snapshotArmedGroups(sessionId) {
  return [...armedGroupsOf(sessionId)].sort()
}

/**
 * 整表快照：`[会话 id, 组名数组]`，**按会话 id 升序**（落盘与诊断都可读、顺序稳定）。
 *
 * @returns {[string, string[]][]} 快照（新数组、新子数组，调用方随便改）。
 */
export function snapshotArmedSessions() {
  return [...armedGroupsBySession.keys()]
    .sort()
    .map((sessionId) => [sessionId, snapshotArmedGroups(sessionId)])
}

/**
 * 把介质里读出来的条目并回登记表 —— "跨宿主重启恢复"的落点。
 *
 * 语义（四条都是硬的）：
 *  - **只并集、只加不减**：内存里已有的放行绝不被介质覆盖（配置热替换时内存才是最新的；
 *    介质可能落后一步，比如上一次写盘失败）；
 *  - **幂等**：同一份介质读两次，第二次一个都不新增（`addedGroups === 0`）；
 *  - **不校验"这个组现在还在不在配置里"**：组的 `name` 是配置面可改的，旧记录里的陌生组名
 *    一律**保留但忽略**（装配侧按 `(会话, 组)` 逐组比对当前配置，陌生名字自然永远不命中；
 *    "点名一次"由调用方做）；
 *  - 坏条目（不是 `[非空字符串, 组名数组]`）一律跳过并计数，**绝不抛**。
 *
 * ⚠ 本函数**不通知写侧**：恢复不是"新放行"，不该反过来触发写盘。
 *
 * @param {Iterable<unknown>} entries - 形如 `[[sessionId, ['cua']], ...]` 的条目集合。
 * @returns {{sessions: number, groups: number, addedGroups: number, skipped: number, groupNames: Set<string>}}
 *   `sessions` / `groups` = 介质里读到的会话数 / `(会话, 组)` 条目数；`addedGroups` = 其中
 *   **本次新并入内存**的条目数；`skipped` = 坏条目数；`groupNames` = 介质里出现过的全部组名
 *   （给"陌生组名点名"用）。
 */
export function restoreArmedSessions(entries) {
  const groupNames = new Set()
  const seenSessions = new Set()
  let groups = 0
  let addedGroups = 0
  let skipped = 0
  let rows
  try {
    rows = entries === null || entries === undefined ? [] : [...entries]
  } catch {
    // 连迭代都做不到（调用方给了个非可迭代对象）⇒ 当"介质里什么都没有"，绝不抛到装配路径上。
    rows = []
    skipped += 1
  }
  for (const row of rows) {
    if (!Array.isArray(row) || row.length < 2) { skipped += 1; continue }
    const [sessionId, rawGroups] = row
    if (typeof sessionId !== 'string' || sessionId.length === 0) { skipped += 1; continue }
    if (!Array.isArray(rawGroups)) { skipped += 1; continue }
    const names = []
    for (const name of rawGroups) {
      if (typeof name !== 'string' || name.length === 0) continue
      names.push(name)
      groupNames.add(name)
    }
    if (names.length === 0) continue
    seenSessions.add(sessionId)
    let live = armedGroupsBySession.get(sessionId)
    for (const name of names) {
      groups += 1
      if (live !== undefined && live.has(name)) continue
      if (live === undefined) {
        live = new Set()
        armedGroupsBySession.set(sessionId, live)
      }
      live.add(name)
      addedGroups += 1
    }
  }
  return { sessions: seenSessions.size, groups, addedGroups, skipped, groupNames }
}

/**
 * 该 `(会话, 组)` 是否已放行。
 *
 * @param {unknown} sessionId - 会话 id（SessionId 在运行期就是字符串）。
 * @param {unknown} groupName - 组名（配置里该组的 `name`）。
 * @returns {boolean} 已放行返回 true；`sessionId` 非字符串/空串、`groupName` 非字符串一律 false。
 */
export function isGroupArmed(sessionId, groupName) {
  if (typeof sessionId !== 'string' || sessionId.length === 0) return false
  if (typeof groupName !== 'string') return false
  const groups = armedGroupsBySession.get(sessionId)
  return groups !== undefined && groups.has(groupName)
}

/**
 * 该会话是否放行过**任何**一组。
 *
 * ⚠ 这只是"并集查询"，给诊断/日志用；**装配侧的判定必须用 `(会话, 组)` 粒度**
 * （{@link isGroupArmed}），否则会退回 v0.2.0 的"一次放行全部组"。
 *
 * @param {unknown} sessionId - 会话 id。
 * @returns {boolean} 放行过至少一组返回 true。
 */
export function isArmed(sessionId) {
  return typeof sessionId === 'string' && sessionId.length > 0
    && (armedGroupsBySession.get(sessionId)?.size ?? 0) > 0
}

/**
 * 取该会话已放行的组名集合。
 *
 * 返回的是**活引用**（装配每步都会问一次，不值得为此拷贝）—— 调用方**只读**它。
 * 会话不存在时返回共享的空表。
 *
 * @param {unknown} sessionId - 会话 id。
 * @returns {ReadonlySet<string>} 组名集合（可能为空）。
 */
export function armedGroupsOf(sessionId) {
  if (typeof sessionId !== 'string' || sessionId.length === 0) return NO_GROUPS
  return armedGroupsBySession.get(sessionId) ?? NO_GROUPS
}

/**
 * 放行一个 `(会话, 组)`。**幂等**：重复放行只是再写一次同一个元素，不触发任何工具表变化。
 *
 * @param {string} sessionId - 会话 id。
 * @param {string} groupName - 组名（非空字符串；空串是编程错误，直接抛）。
 * @returns {boolean} 此前**已经**放行过（true = 这次调用没有改变任何东西）。
 */
export function armGroup(sessionId, groupName) {
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    throw new Error('armGroup: sessionId 必须是非空字符串（调用方应先经 sessionIdOf 取身份）')
  }
  if (typeof groupName !== 'string' || groupName.length === 0) {
    throw new Error(`armGroup: groupName 必须是非空字符串（当前是 ${JSON.stringify(groupName)}）`)
  }
  let groups = armedGroupsBySession.get(sessionId)
  if (groups === undefined) {
    groups = new Set()
    armedGroupsBySession.set(sessionId, groups)
  }
  const alreadyArmed = groups.has(groupName)
  groups.add(groupName)
  // v0.3.1：只有**新增**才通知写侧（重复放行不产生任何写盘动作）。
  // ⚠ 写侧回调**不参与返回值**：`alreadyArmed` 完全由上面的 `groups.has` 决定，
  //   与改动前逐字节一致（它是给模型看的字段）。
  if (!alreadyArmed) notifyArmedWriters(sessionId)
  return alreadyArmed
}

/**
 * 登记表里的会话数（诊断用；测试也用它断言"谁被放行过"）。
 *
 * @returns {number} 至少放行过一组的会话数。
 */
export function armedSessionCount() {
  return armedGroupsBySession.size
}

/**
 * 登记表里的 `(会话, 组)` 条目总数（诊断用）。
 *
 * @returns {number} 全部已放行的 `(会话, 组)` 数。
 */
export function armedGroupCount() {
  let total = 0
  for (const groups of armedGroupsBySession.values()) total += groups.size
  return total
}

/**
 * 清空登记表。**只给测试用**：单测在同一进程里跑多个用例，需要把上一例的放行状态抹掉。
 * 生产路径**不要**调用它（没有"取消放行"这个产品语义：放行到进程结束为止）。
 *
 * @returns {number} 被清掉的会话数。
 */
export function resetArmedSessions() {
  const size = armedGroupsBySession.size
  armedGroupsBySession.clear()
  return size
}

/**
 * 从"会话身份载体"里取 SessionId。
 *
 * 两个调用点拿到的是**同一个对象**：
 *  - 装配水线：`context.scope`（`assembleContextFor` 里 `scope: agent`）；
 *  - 工具执行：`exec.agent`（agent loop 填的 `ToolExecutionInput.agent`）。
 * 优先读声明面的 `id`（`Agent.id: SessionId`），读不到再退回运行面的 `session.id`
 * （同一个 SessionId，多一条兜底路径而已）。
 *
 * @param {unknown} subject - agent（或任何带 `id` / `session.id` 的对象）。
 * @returns {string|undefined} 会话 id；取不到返回 undefined（调用方自己决定怎么处理）。
 */
export function sessionIdOf(subject) {
  const direct = subject?.id
  if (typeof direct === 'string' && direct.length > 0) return direct
  const nested = subject?.session?.id
  if (typeof nested === 'string' && nested.length > 0) return nested
  return undefined
}

/**
 * 造该组入口工具的 `description`：**只说"能拿到什么"**，一句话、英文、≤120 字符。
 *
 *  - 内置两组：具体措辞（见 {@link KNOWN_DESCRIPTIONS}）；
 *  - 其它组：`Reveal the <组名> tools (prefix <前缀>) in this session.`
 *
 * @param {{name?: string, prefix: string}} group - 组配置（读 `name` / `prefix`）。
 * @returns {string} 该组入口工具的一句话描述。
 */
export function describeEntryTool(group) {
  const known = KNOWN_DESCRIPTIONS.get(group?.prefix)
  if (known !== undefined) return known
  return `Reveal the ${group?.name ?? '?'} tools (prefix ${group?.prefix ?? '?'}) in this session.`
}

/**
 * 造**某一组**的入口工具定义（`defineTool` 的产物，可直接交给 `ctx.tools.register()`）。
 *
 * 名字与描述都来自该组自己的配置（`entryName` / `name` / `prefix`）；调用它只放行这一组
 * （`(会话, 组)` 粒度），放行判定在 `lib/assembly.js`。
 *
 * @param {object} options - 构造参数。
 * @param {{name: string, prefix: string, entryName: string}} options.group - 该组配置
 *   （`lib/config.js` 的 `ResolvedGroup`；这里只读这三个字段）。
 * @param {(fn: 'info'|'warn'|'error', message: string) => void} [options.log] - 日志出口（可选；省略则不打日志）。
 * @returns {object} `ToolDefinition`：`{ name, description, parameters, output: { schema, render }, execute }`。
 */
export function makeEntryTool({ group, log }) {
  const { name: groupName, prefix, entryName } = group
  const description = describeEntryTool(group)

  return defineTool({
    name: entryName,
    description,
    // 无参数：空 property map ⇒ 编译成 `{ type: 'object', properties: {} }`
    //（先例 `dsh-tool-goal\lib\index.js:264-268` 的 get_goal 也是 `parameters: {}`）。
    parameters: {},
    output: {
      // 值 schema（作者 DSL）：object 根必须显式写 additionalProperties，见文件头。
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          group: { type: 'string', required: true },
          armed: { type: 'boolean', required: true },
          alreadyArmed: { type: 'boolean', required: true },
        },
      },
      // ⚠ 只有这里返回的 content 会落会话历史 ⇒ 一行中文，≤40 字符，不 dump JSON、不讲机制。
      render: (_args, value) => [{
        type: 'text',
        text: value?.alreadyArmed === true
          ? '该组此前已放回，无需重复调用。'
          : `已放回 ${value?.group ?? groupName} 组工具（下一步起可见）。`,
      }],
    },
    // 不声明 isConcurrencySafe ⇒ 默认 exclusive（本工具改的是一张进程内共享、且带落盘投影的
    // 登记表；并发写同一会话的组表没有任何收益，独占最稳）。
    async execute(_args, exec) {
      const sessionId = sessionIdOf(exec?.agent)
      if (sessionId === undefined) {
        // 取不到会话身份就**什么都不做**：绝不能退化成"放行所有会话"这种静默扩大。
        throw new Error(`${entryName} 取不到调用方会话身份（exec.agent?.id 与 exec.agent?.session?.id 都读不到）`
          + '⇒ 未放行任何组。本工具只能由会话内的模型调用（宿主会填 exec.agent）')
      }
      const alreadyArmed = armGroup(sessionId, groupName)
      if (!alreadyArmed) {
        log?.('info', `会话 ${sessionId} 已放回 ${groupName} 组工具（前缀 ${prefix}）：`
          + '从下一步起本插件不再摘除该组（其它组不受影响）')
      }
      return { group: groupName, armed: true, alreadyArmed }
    },
  })
}

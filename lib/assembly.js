/**
 * dsh-host-tool-layering · 装配体工具表筛选（纯函数）
 *
 * 语义一条：**按各组前缀识别属于该组的工具，装配时全部摘除，并逐组计数**。
 * 不做任何工作区/会话检测（继承 `dsh-host-godot-tool-layering` v0.2.0 的形态）。
 *
 * ## 机制依据（为什么"只从 assembly.tools 里删"是安全且充分的）
 *
 * ```
 * dsh-agent-loop\lib\index.js:890     每个模型步之前：systemPrompt.assemble(assembleContextFor(this, signal))
 *         ↓
 * dsh-system-prompt\lib\index.js:322-326
 *         每个工具被重建成【全新的三键对象】 { name, description, parameters }
 *         （parameters 走 structuredClone）；【不含 execute】
 *         ↓
 * dsh-system-prompt\lib\index.js:348   tools: orderTools(collected, this.toolOrder, knownNames)
 *         ↑ 注意：顺序规范化发生在【水线之前】，所以水线里删元素不会触发
 *           `:83-86` 的保留名/未注册名校验（那条路已经跑完了）
 *         ↓
 * dsh-system-prompt\lib\index.js:351   ctx.waterfall(scopeTarget(this, scope), "system-prompt/assemble", assembly, context, …)
 *         ↓                           文档串 `:302`："The returned waterfall value is authoritative"
 *         ↓  本插件在这里【删元素】
 * 模型请求里看到的工具表
 * ```
 *
 * - **删宣布面碰不到可执行面**：能拿到的对象只有 `name/description/parameters`；
 *   真正可执行的 `ToolDefinition`（含 `execute`）留在 `dsh-tools` 注册表里。
 *   模型按名调用时走 `dsh-tools\lib\index.js:3176 dispatchToolBody`
 *   → `:3189 resolveExecution` → `:2906 resolveExecution` → `:2890 get`，
 *   这条链只查**注册表视图**，从不读装配体 —— 摘掉宣布面后**按名调用仍然会成功执行**
 *   （旧插件已实跑证实）。所以本模块产出的不是"能力边界"，而是"模型看不看得见"的宣布面。
 *   需要真正的能力边界时，官方闸门是 `dsh-tools\lib\index.js:2790 tools.restrict({deny})`：
 *   scoped、对未知名会抛错、且**同时掐掉执行**；本插件**故意不用**它（见 README「能力边界」）。
 * - **工具名形态**：`mcp__<serverName>__<rawName>`（`dsh-mcp-client\lib\index.js:120-126`，
 *   越界字符会被替换并追加 12 位哈希，见同文件 `:109-115`）。
 *   本机两组分别是：CUA 的 `cua_driver_native__*`（56 个）与 godot 的 `mcp__godot_use__*`（39 个）。
 *
 * ## 前缀重叠：**长的先匹配**（本模块唯一的判定规则）
 * 组表是按前缀匹配的，前缀天然可能嵌套（`mcp__x__` 与 `mcp__x__y__` 都命中 `mcp__x__y__z`）。
 * 本模块把每个工具**恰好算给一组**：取命中里**最长**的那个前缀；
 * 长度相同（即两个组写了同一个 prefix）时取**组表里靠前**的那组。
 * ⇒ 逐组计数不会重复计，`sum(perGroup.removed) === totalRemoved` 恒成立。
 *
 * ## 已知分叉（PTC / both 模式）
 * 走 PTC（`run_code`）的会话里，程序内可用的 SDK 由 `dsh-tools\lib\index.js:2922 sdkSchemas(scope)`
 * 从**注册表**（`view(scope).visible`）生成，且 `:2993 collapses()` 对"嵌套子派发"
 * （`nested === true`，即 run_code 内 SDK 发起的调用）一律放行 ⇒
 * 本插件摘除宣布面**不影响** run_code 内的子派发：**这类会话保有全部能力（含写操作）**，
 * 只是顶层工具表里不再显示。`sdkSchemas` 的生成源是注册表视图、与本模块的筛选无关，
 * 所以这条分叉是**结构性的**，不是配置能关掉的开关。
 * 触发条件：宿主以 `DSH_TOOLS_MODE=ptc`（`dsh-web-app\cordis.patch.yml:31-38`）启动，
 * 或会话 preset 走 `presentAs('ptc'|'both')`（`dsh-agent-tool-presentation\lib\index.js:47`）。
 *
 * ⚠ 把上面两条合起来读：**本插件在任何模式下都不提供安全边界**。
 *
 * ## 两条硬约束
 *  1. **纯函数 + 幂等**：同样输入必然同样输出；删过一次的项不存在，第二次跑不可能再删。
 *     这不是洁癖：`dsh-agent-loop\lib\index.js:909-917` 的 `toolsChanged()` 会把本轮工具表
 *     与 session 的 `request/header` 基线比对，**一变就追加一条 header 记录** ⇒
 *     结果不确定就会每轮污染会话存档（并从首个变更 token 起让 prompt 缓存失效）。
 *  2. **只做删除**：不重排、不重建对象、不深拷贝。保留下来的工具对象必须是**同一个引用**，
 *     顺序必须与入参一致 —— 这样"没东西可删"时能返回同一个数组引用，彻底 no-op。
 */

import { deriveGroupName } from './config.js'

/**
 * 从 prefix 推出 fail-loud 宽松启发式的**关键词**。
 *
 * 为什么需要它：fail-loud 要抓的正是"上游改了命名形态"这一情形，那时前缀必然不再命中。
 * 若只看前缀，`strict === 0` 会让本插件**静默退化成白装**（`mcp__godot__*`、
 * `mcp__godot-use__*` 都属于这类）。启发式只在"该组前缀零命中"时启用，
 * 因此正常路径上不可能误报。
 *
 * 规则与 `deriveGroupName` 共用：去掉 `mcp__` 包装，取第一个 `_` 之前的分段。
 * 例 `mcp__godot_use__` → `godot`（与原插件 v0.2.0 的关键词完全一致）；
 * `cua_driver_native__` → `cua`。
 *
 * @param {string} prefix - 组前缀。
 * @returns {string|null} 小写关键词；推不出（空前缀等）时返回 null ⇒ 该组关闭宽松通道。
 */
export function looseKeywordOf(prefix) {
  const keyword = deriveGroupName(prefix).toLowerCase()
  return keyword.length > 0 ? keyword : null
}

/**
 * 预编译匹配表：按**前缀长度降序**排（长的先匹配 ⇒ 前缀重叠时归属最具体的组）。
 *
 * `index` 是组在入参 `groups` 里的下标 —— 计数结果按它回填，所以排序不会打乱对外顺序。
 *
 * @param {ReadonlyArray<{name?: string, prefix: string}>} groups - 组表。
 * @returns {{index: number, name: string, prefix: string}[]} 匹配表。
 */
export function buildMatchers(groups) {
  return groups
    .map((group, index) => ({ index, name: group.name ?? deriveGroupName(group.prefix), prefix: group.prefix }))
    .sort((a, b) => b.prefix.length - a.prefix.length || a.index - b.index)
}

/**
 * 造一份"全零"的逐组计数（形状固定，方便调用方无条件读字段）。
 *
 * @param {ReadonlyArray<{name?: string, prefix: string}>} groups - 组表。
 * @returns {{name: string, prefix: string, present: number, removed: number, removedNames: string[]}[]} 计数表。
 */
export function zeroCounts(groups) {
  return groups.map((group) => ({
    name: group.name ?? deriveGroupName(group.prefix),
    prefix: group.prefix,
    present: 0,
    removed: 0,
    removedNames: [],
  }))
}

/**
 * 从工具表里摘掉全部属于各组前缀的工具，**逐组计数**。
 *
 * **纯函数**；不修改入参数组，不重建任何工具对象。没有任何项被摘掉时，
 * 连数组都返回**同一个引用**。每个命中项恰好算给一组（最长的匹配前缀，见模块文档串）。
 *
 * @param {ReadonlyArray<{name?: unknown}>} tools - 装配体里的工具表。
 * @param {ReadonlyArray<{name?: string, prefix: string}>} groups - 组表（顺序即对外计数顺序）。
 * @returns {{
 *   tools: ReadonlyArray<object>,
 *   changed: boolean,
 *   perGroup: {name: string, prefix: string, present: number, removed: number, removedNames: string[]}[],
 *   removedNames: string[],
 *   totalPresent: number,
 *   totalRemoved: number,
 * }} 筛选结果；`changed === false` 时 `tools` 与入参同引用，逐组计数仍如实为 0。
 */
export function removeToolsByGroups(tools, groups) {
  const perGroup = zeroCounts(groups)
  const empty = { tools, changed: false, perGroup, removedNames: [], totalPresent: 0, totalRemoved: 0 }
  if (!Array.isArray(tools) || tools.length === 0 || groups.length === 0) return empty

  // 判定谓词只写一次：'该工具属于哪一组'。扫描与过滤共用它 ⇒
  // 不可能出现"统计说没删、实际删了"这类自相矛盾。
  const matchers = buildMatchers(groups)

  /** @type {number[]} 命中项在入参里的下标（升序，供后面保序过滤） */
  const hitIndices = []
  /** @type {string[]} */
  const removedNames = []
  for (let i = 0; i < tools.length; i++) {
    const tool = tools[i]
    const toolName = tool !== null && typeof tool === 'object' ? tool.name : undefined
    if (typeof toolName !== 'string') continue
    const hit = matchers.find((matcher) => toolName.startsWith(matcher.prefix))
    if (hit === undefined) continue
    hitIndices.push(i)
    removedNames.push(toolName)
    const part = perGroup[hit.index]
    part.present++
    part.removed++
    part.removedNames.push(toolName)
  }

  if (hitIndices.length === 0) return empty

  // 保序过滤：留下的每个都是入参里的同一个引用，顺序 = 入参顺序的子序列。
  /** @type {object[]} */
  const kept = []
  let cursor = 0
  for (let i = 0; i < tools.length; i++) {
    if (cursor < hitIndices.length && hitIndices[cursor] === i) {
      cursor++
      continue
    }
    kept.push(tools[i])
  }

  return {
    tools: kept,
    changed: true,
    perGroup,
    removedNames,
    totalPresent: hitIndices.length,
    totalRemoved: hitIndices.length,
  }
}

/**
 * 完整的一步处理：把筛选结果应用到装配体上。
 *
 * **纯函数**。返回值里带 `assembly`：`changed === false` 时它就是**入参那个对象**，
 * 调用方可以直接原样 return，零对象身份变化（幂等硬约束，见模块文档串）。
 *
 * @param {{tools?: unknown}} assembly - 上游装配体。
 * @param {object} options - 处理参数。
 * @param {ReadonlyArray<{name?: string, prefix: string}>} options.groups - 组表。
 * @returns {{
 *   assembly: object,
 *   changed: boolean,
 *   perGroup: {name: string, prefix: string, present: number, removed: number, removedNames: string[]}[],
 *   totalPresent: number,
 *   totalRemoved: number,
 *   removedNames: string[],
 * }} 处理结果。
 */
export function processAssembly(assembly, options) {
  const { groups } = options
  const base = {
    assembly,
    changed: false,
    perGroup: zeroCounts(groups),
    totalPresent: 0,
    totalRemoved: 0,
    removedNames: [],
  }

  // 形状防御：任何意外都原样放过 —— 本插件的职责是省 token，绝不能影响装配本身
  if (assembly === null || typeof assembly !== 'object' || !Array.isArray(assembly.tools)) return base

  const result = removeToolsByGroups(assembly.tools, groups)
  if (!result.changed) return base

  // 返回新对象、不改入参：水线契约是"返回值权威"，同型先例 `dsh-agent\lib\index.js:134-143`
  return {
    assembly: { ...assembly, tools: result.tools },
    changed: true,
    perGroup: result.perGroup,
    totalPresent: result.totalPresent,
    totalRemoved: result.totalRemoved,
    removedNames: result.removedNames,
  }
}

/**
 * 数一数装配体里"看起来像本组工具"的条目 —— 正常路径按前缀精确匹配；
 * 前缀一个都不匹配时退回**宽松启发式**（名字里含该组关键词，不区分大小写）。
 *
 * 返回 `strict` 与 `loose` 两个计数：`strict` 是前缀精确命中数（正常路径），
 * `loose` 还额外把"名字含关键词但不带前缀"的算进来（只在 strict === 0 时有意义）。
 * 关键词推不出时（空前缀）宽松通道整体关闭，`loose === strict` —— 不允许 `includes('')` 恒真。
 *
 * @param {ReadonlyArray<{name?: unknown}>} tools - 装配体里的工具表。
 * @param {string} prefix - 组前缀。
 * @returns {{strict: number, loose: number}} 前缀精确命中数与宽松命中数。
 */
export function countLikeTools(tools, prefix) {
  if (!Array.isArray(tools)) return { strict: 0, loose: 0 }
  // 空前缀/非字符串前缀不是有效的匹配依据：`''.startsWith('')` 恒真，照直算会得到
  // "所有工具都像本组工具"这种荒谬结论。配置层已拒绝空前缀，这里再兜一层。
  if (typeof prefix !== 'string' || prefix.length === 0) return { strict: 0, loose: 0 }
  const keyword = looseKeywordOf(prefix)
  let strict = 0
  let loose = 0
  for (const tool of tools) {
    const toolName = tool?.name
    if (typeof toolName !== 'string') continue
    if (toolName.startsWith(prefix)) {
      strict++
      loose++
    } else if (keyword !== null && toolName.toLowerCase().includes(keyword)) {
      loose++
    }
  }
  return { strict, loose }
}

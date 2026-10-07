/**
 * dsh-host-tool-layering · 配置解析（v0.3.0：配置面 = `diag` + `groups`，入口名在**组内**）
 *
 * 本文件是 `dsh-host-godot-tool-layering` v0.2.0 的**泛化**：把"写死一个 godot 前缀"
 * 变成"一张组表，每组 = 一批工具（前缀）+ 一个说明技能"。原插件的每一条失败语义
 * 都原样继承，逐条对照见 README §5。
 *
 * ## v0.3.0：入口工具**按组独立**（配置面的改动只有一处）
 * v0.2.0 的顶层 `entryName`（一个入口放行**所有**组）改成**组内** `entryName`：
 * 每组一个入口工具、各放各的组（`(会话, 组)` 粒度，见 `lib/entry.js` / `lib/assembly.js`）。
 *  - 缺省规则：**`get_<组名>`**（默认两组 ⇒ `get_cua` / `get_godot`）；组名本身没写时
 *    先由 prefix 推出（`deriveGroupName`），所以"缺省链路"是 `prefix → 组名 → 入口名`。
 *  - 校验四条（任一不满足 ⇒ 整个配置非法，见下"非法配置的失败语义"）：
 *    ① 形态 1–64 位 ASCII（只允许字母/数字/下划线/连字符）；
 *    ② 不得是保留名 `run_code`；
 *    ③ **不得以任何一组的 `prefix` 开头**（否则本插件会把自己的入口工具也摘掉）；
 *    ④ **入口名之间不得重名**（含与另一组"缺省推导出来的名字"撞车）。
 *  - 顶层再写 `entryName` 现在是**不认得的键** ⇒ 只 warn、忽略（不判非法，理由见下）。
 *
 * ## 为什么不写 `export const Config = z.object({...})`
 * 与本机插件群的既有取舍一致（同 `dsh-host-godot-tool-layering`）：本 profile 里只有
 * `dsh-web-search-uapi` 用 `zod`，而它在 `~\.dsh\profiles\desktop\node_modules\` 里**没有**
 * 可解析的裸依赖（只靠 pnpm 严格布局从 `@deepseek-ai/dsh-*` 内部解析）。加一个
 * `import 'zod'` 就等于引入"来源不明的裸依赖"，而收益只是配置校验 —— 手写更划算，
 * 且零依赖让 `node --test` 可以直接跑源目录、不需要 `node_modules`。
 * （⚠ v0.2.0 起这条**只剩一半**：`lib/entry.js` 要 import `@deepseek-ai/dsh-tools`
 *  拿 `defineTool`，那个包由 profile 级 `node_modules` 的 junction 解析 —— 环境说明见 README §10。）
 *
 * ## 非法配置的失败语义：**报告，但不把异常抛到宿主启动路径**
 * `resolveConfig` 只**判定并说明原因**（返回 `{ok:false, reason}`，从不抛错），
 * 由 `lib/index.js` 的 `apply()` 决定：打一条 `error` 日志（点名具体哪个字段非法）
 * 并**完全不注册水线**（插件不生效），宿主与其它插件照常。
 * 为什么不能直接 `throw`：
 *  - **冷启动**：`cordis.patch.yml` 的补丁由 loader 应用，
 *    `dsh-app-boot\lib\index.js:240` 是 `await this.root.update(data)`；本插件的
 *    `apply()` 在 `Service.init()` 里跑，抛错 ⇒ 整个宿主进程非零退出。
 *  - **热加载**：旧版 loader（≤1.0.3，0.1.6 及更早）会整层回滚 ⇒ 同一个 patch 文件里
 *    其它 insert 行也一起不生效；⚠ 0.1.7-rc.1 起 loader 1.0.5 取消事务回滚，
 *    抛错只让本行挂载失败 —— "不 throw"的动机因此减弱，但冷启动退出这条依然成立。
 * ⚠ **故意不静默回落默认值** —— 那会让"配置写错"表现成"插件生效了但行为怪"，
 * 排查成本比一次明确的 error 日志高得多。
 *
 * ## 未知键：**忽略 + 打一条 warn，不算非法**（继承原插件的有意取舍）
 * 顶层未知键与组内未知键都只 warn。理由同原插件：本插件的作用是"把工具从模型可见工具表
 * 摘掉"，拒绝配置 ⇒ 插件不注册 ⇒ **工具重新出现在表里**（与目标相反）；容忍 ⇒ 行为正确，
 * 代价只是一行提示。这条容忍还顺带填上一个真实的热加载缝隙（见 README §9）：
 * 宿主对**模块代码**按 URL 缓存，改 `lib/*.js` 后不重启就仍是旧代码，
 * 于是会出现"配置文件已是新形态、读它的却是旧代码"的瞬间 —— v0.3.0 升级路上
 * 必然出现一次"顶层 `entryName` 已被新代码当成未知键"的中间态，容忍它比拒绝它安全。
 *
 * ⚠ 本插件**不是能力边界**：没有 `tools.restrict()` 那种闸门，见 README「能力边界」。
 */

/**
 * 默认组表（与 README 的配置表一一对应）：
 *  - `cua`   —— CUA 电脑控制工具（56 个 / 24,832 wire token），说明书技能 `computer-control`；
 *  - `godot` —— godot MCP 工具（39 个 / 9,599 wire token），说明书技能 `godot-use`。
 *
 * 语义与 `dsh-host-godot-tool-layering` v0.2.0 完全一致（不做任何检测、任何会话默认全摘），
 * 只是"前缀 + 技能"从代码里搬到了配置面。
 *
 * ⚠ 这里**刻意不写 `entryName`**：入口名走缺省规则 `get_<组名>`（⇒ `get_cua` / `get_godot`），
 * 让"缺省链路"只有一条路径可走（也省得两处默认值将来对不上）。
 */
export const DEFAULT_GROUPS = Object.freeze([
  Object.freeze({ name: 'cua', prefix: 'cua_driver_native__', skill: 'computer-control' }),
  Object.freeze({ name: 'godot', prefix: 'mcp__godot_use__', skill: 'godot-use' }),
])

/** 配置项的默认值（README 的配置表与此一一对应）。 */
export const CONFIG_DEFAULTS = Object.freeze({
  diag: false,
  groups: DEFAULT_GROUPS,
})

/**
 * 本插件**认得**的顶层配置键（只有这两个）。
 *
 * 出现别的键时：不判非法、按未知键忽略，由 `apply()` 打一条 warn 点名。
 * ⚠ v0.2.0 的顶层 `entryName` 已移除（改成组内键），旧配置里的它落到这一条上 ⇒ 只 warn。
 */
export const CONFIG_KEYS = Object.freeze(['diag', 'groups'])

/** 本插件认得的**组内**键；别的键只 warn、不判非法。 */
export const GROUP_KEYS = Object.freeze(['name', 'prefix', 'skill', 'entryName'])

/**
 * 入口工具名的合法形态：`^[A-Za-z0-9_-]{1,64}$`。
 *
 * 为什么要卡：工具名会进**模型请求的 tools 数组**，而各 provider（尤其 OpenAI 兼容线）
 * 普遍只接受这一形态（长度上限 64）；同时它还要能安全地交给 `ctx.tools.register()`
 * —— 那里唯一会抛的名字是保留名 `run_code`（`dsh-tools\lib\index.js:2885`），
 * 而 `apply()` 绝不抛错（见文件头），所以这类值必须在**配置层**就挡掉。
 */
export const ENTRY_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

/** 入口工具**不能**用的保留名（`dsh-tools` 的 PTC 呈现通道）。 */
export const RESERVED_ENTRY_NAMES = Object.freeze(['run_code'])

/**
 * 判断一个入口工具名是否合法（形态 + 保留名）。
 *
 * ⚠ 只是"名字本身能不能用"这一半；"这个名字会不会被某组前缀摘掉 / 会不会和别组的入口
 * 撞名"是**组表级**的交叉校验，在 {@link resolveConfig} 里做。
 *
 * @param {unknown} entryName - 候选名字。
 * @returns {boolean} 合法返回 true。
 */
export function isSafeEntryName(entryName) {
  return typeof entryName === 'string'
    && ENTRY_NAME_PATTERN.test(entryName)
    && !RESERVED_ENTRY_NAMES.includes(entryName)
}

/**
 * 某组入口工具名的**缺省值**：`get_<组名>`（默认两组 ⇒ `get_cua` / `get_godot`）。
 *
 * 组名是"缺省链路"的中间站：没写 `name` 时先由 prefix 推出（{@link deriveGroupName}），
 * 再套这条规则 ⇒ 两组名都给全了才可能推不出名字。
 *
 * @param {string} groupName - 已解析的组名（见 {@link ResolvedGroup} 的 `name`）。
 * @returns {string} 该组的缺省入口工具名。
 */
export function defaultEntryNameOf(groupName) {
  return `get_${groupName}`
}

/**
 * 从 `prefix` 推出组的"短名"（仅在某组没写 `name` 时用）。
 *
 * 规则：去掉 `mcp__` 包装，取第一个 `_` 之前的分段。
 * 例：`mcp__godot_use__` → `godot`；`cua_driver_native__` → `cua`。
 *
 * ⚠ 这个短名有三个用途，全部共用同一条规则（谁都不能单独改）：
 *  ① 缺省组名（日志里 `(cua)` 那一段）；
 *  ② **缺省入口名**的输入（`get_<组名>`）；
 *  ③ fail-loud 宽松启发式的关键词（见 `lib/assembly.js` 的 `looseKeywordOf`）。
 *
 * @param {string} prefix - 工具名前缀。
 * @returns {string} 短名；推不出时回落为空串。
 */
export function deriveGroupName(prefix) {
  if (typeof prefix !== 'string') return ''
  const core = prefix.startsWith('mcp__') ? prefix.slice(5) : prefix
  const trimmed = core.replace(/^_+/, '').replace(/_+$/, '')
  return trimmed.split('_')[0] ?? ''
}

/**
 * @typedef {object} ResolvedGroup
 * @property {string} name - 组名（日志里 `(cua)` 那一段；缺省由 prefix 推出）。
 * @property {string} prefix - 该组工具名的公共前缀（**唯一**的识别依据）。
 * @property {string|null} skill - 说明技能名（`~\.dsh\skills\<skill>\SKILL.md`）；未配置时 null。
 * @property {string} entryName - 该组**自己的**常驻入口工具名（缺省 `get_<组名>`）；
 *   模型调用它 ⇒ 本会话从下一步起只放行**这一组**。
 */

/**
 * @typedef {object} ResolvedConfig
 * @property {boolean} diag - 是否打印每次装配的逐组诊断。
 * @property {ResolvedGroup[]} groups - 组表（空数组 = 合法但什么都不摘，静默 no-op）；
 *   顺序即"注册入口工具的顺序"与"逐组计数的对外顺序"。
 * @property {string[]} unknownKeys - 顶层不认得的键（原样保留键名，供日志点名）。
 * @property {{index: number, name: string, key: string}[]} unknownGroupKeys - 组内不认得的键。
 * @property {string[]} duplicatePrefixes - 被两组以上共用的 prefix（只 warn，不判非法）。
 */

/**
 * @typedef {{ok: true, config: ResolvedConfig} | {ok: false, reason: string}} ConfigResult
 */

/**
 * 校验并规范化配置。**不抛错**：非法配置返回 `{ ok: false, reason }`，
 * 由调用方（`lib/index.js` 的 `apply()`）打 `error` 日志并放弃注册水线。
 *
 * `undefined` / `null` / `{}` 都视为"全默认"（patch 行不写 config 是合法形态）。
 *
 * ## `groups` 的三个边界（都是有意为之）
 *  - **空数组** ⇒ 合法，插件不注册水线（静默 no-op，不摘任何工具，也**不注册任何入口工具**）；
 *  - **缺省 / null** ⇒ 用 `DEFAULT_GROUPS`（与 `diag` 的 `??` 语义一致：YAML 里写空值
 *    `groups:` 得到 `null`，按"未设置"处理）。⚠ 想真的全关请显式写 `groups: []`；
 *  - **非数组 / 组项缺 prefix / prefix 非字符串 / prefix 为空串** ⇒ 非法（打 error、不挂水线）。
 *    空前缀必须拒绝：`''.startsWith('')` 恒真 ⇒ 会把**所有**工具都摘掉，这是灾难级误配。
 *
 * ## 组内 `entryName` 的边界（v0.3.0）
 *  - **缺省 / null** ⇒ `get_<组名>`（与 `diag` 的 `??` 语义一致）；
 *  - **非字符串 / 形态不合法 / 保留名 `run_code` / 落在任何组 `prefix` 之下 / 与别组的入口名重名**
 *    ⇒ 非法。非法值必须在配置层挡住：`ctx.tools.register()` 对保留名会抛，而 `apply()` 绝不抛错
 *    （冷启动路径），不能把一个会抛的名字放进去。
 *
 * ## 交叉校验为什么要逐组逐名判定（v0.3.0 的 R2）
 * 摘除的判定是"名字以**某组**前缀开头"，而放行是 `(会话, 组)` 粒度的 ⇒ 只要**甲组的入口名**
 * 以**乙组的前缀**开头，就会出现"调用甲组入口 ⇒ 甲组放行、乙组未放行 ⇒ 甲组的入口工具被
 * 当成乙组工具摘掉" ⇒ 那个入口静默消失（fail-loud 不会报：它是命中了前缀的）。
 * 所以校验必须对**每一组的入口名 × 每一组的前缀**全组合判定，而不是两个位置参数比一次。
 *
 * @param {object} [config] - 宿主从 `cordis.patch.yml` 传入的 `config` 字段。
 * @returns {ConfigResult} `ok: true` 时 `config` 是规范化结果；`ok: false` 时 `reason` 点名非法字段。
 */
export function resolveConfig(config) {
  const raw = config ?? {}
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, reason: `config 必须是一个对象（当前是 ${describeType(raw)}）` }
  }

  const diag = raw.diag ?? CONFIG_DEFAULTS.diag
  if (typeof diag !== 'boolean') {
    return { ok: false, reason: `diag 必须是布尔值 true/false（当前是 ${describeType(diag)}；YAML 里不要加引号）` }
  }

  const rawGroups = raw.groups ?? CONFIG_DEFAULTS.groups
  if (!Array.isArray(rawGroups)) {
    return {
      ok: false,
      reason: `groups 必须是数组，每项形如 { name, prefix, skill, entryName }（当前是 ${describeType(rawGroups)}）。`
        + '若想一个组都不摘，请显式写 `groups: []`（合法）；不写这个键则用内置默认两组',
    }
  }

  /** @type {ResolvedGroup[]} */
  const groups = []
  /** @type {{index: number, name: string, key: string}[]} */
  const unknownGroupKeys = []
  for (let index = 0; index < rawGroups.length; index++) {
    const item = normalizeGroup(rawGroups[index], index)
    if (!item.ok) return { ok: false, reason: item.reason }
    groups.push(item.group)
    for (const key of item.unknownKeys) unknownGroupKeys.push({ index, name: item.group.name, key })
  }

  // R2：**每一组**的入口名都不得落在**任何一组**的 prefix 之下（全组合判定）。
  // 为什么必须拒：入口工具是本插件**自己**注册的工具，而摘除的判定就是"名字以组前缀开头" ——
  // 一旦某个入口名以某组前缀开头，那个组的入口工具就会在该组未被放行时被摘掉
  // （`(会话, 组)` 粒度下完全可能发生）⇒ 模型侧既看不见那个入口，也得不到任何告警
  // （fail-loud 只在"工具在场却零命中前缀"时触发，而这里恰恰是命中了）⇒ "按需放回"这条链断掉。
  // 大小写与 lib/assembly.js 的匹配语义保持一致（**大小写敏感**）。
  for (const group of groups) {
    const collided = groups.find((other) => group.entryName.startsWith(other.prefix))
    if (collided === undefined) continue
    return {
      ok: false,
      reason: `${JSON.stringify(group.name)} 组的 entryName ${JSON.stringify(group.entryName)} 以 `
        + `${JSON.stringify(collided.name)} 组的 prefix ${JSON.stringify(collided.prefix)} 开头 —— `
        + `那样本插件会把自己的入口工具也当成该组工具摘掉（且不在"放行该组"的会话里就一定发生），`
        + `按需放回的入口会静默消失（连 warn 都不会有：fail-loud 只在零命中前缀时才触发）。`
        + `请把它改成不以任何组 prefix 开头的名字，例如缺省的 ${JSON.stringify(defaultEntryNameOf(group.name))}`,
    }
  }

  // R3：入口名之间不得重名（含"某组显式写的名字"与"另一组缺省推出的名字"撞车）。
  // 重名的后果不是"报错"而是**静默失效**：`ctx.tools.register()` 第二次注册同名工具时
  // 注册表里只剩一个，两个组的入口变成一个 ⇒ 另一组永远没机会被放行。
  /** @type {Map<string, number>} 入口名 → 第一次出现的组下标 */
  const entryNameOwner = new Map()
  for (let index = 0; index < groups.length; index++) {
    const group = groups[index]
    const first = entryNameOwner.get(group.entryName)
    if (first !== undefined) {
      const firstGroup = groups[first]
      return {
        ok: false,
        reason: `入口工具名重名：groups[${first}]（${JSON.stringify(firstGroup.name)} 组）与 groups[${index}]`
          + `（${JSON.stringify(group.name)} 组）都叫 ${JSON.stringify(group.entryName)}。`
          + '两个组共用一个入口工具 ⇒ 另一个组永远放不出来（`tools.register()` 里同名只剩一个）。'
          + `请显式写其中一个组的 entryName（缺省规则是 get_<组名>：本组缺省为 `
          + `${JSON.stringify(defaultEntryNameOf(group.name))}）`,
      }
    }
    entryNameOwner.set(group.entryName, index)
  }

  // 同 prefix 出现两次：不判非法（摘除结果与单组一致，行为无害），但要 warn ——
  // 因为"后出现的那一组永远 present=0"是个静默的配置错误。
  // ⚠ 缺省入口名会因此撞车（两组推出同一个 `get_<组名>`）⇒ 那种写法会在上面的 R3 被拒；
  //    想保留"同前缀两组"，必须显式给其中一组写一个不同的 entryName。
  const seen = new Set()
  /** @type {string[]} */
  const duplicatePrefixes = []
  for (const group of groups) {
    if (seen.has(group.prefix)) duplicatePrefixes.push(group.prefix)
    else seen.add(group.prefix)
  }

  const unknownKeys = Object.keys(raw).filter((key) => !CONFIG_KEYS.includes(key))

  return { ok: true, config: { diag, groups, unknownKeys, unknownGroupKeys, duplicatePrefixes } }
}

/**
 * 规范化单个组项。**不抛错**：非法返回 `{ ok: false, reason }`。
 *
 * 校验"能不能安全地当匹配依据用"（`prefix` 必须在、是字符串、非空）与"入口名能不能安全地
 * 注册进注册表"（形态 + 保留名）；`name` / `skill` / `entryName` 缺省都是合法的
 * （分别回落到 prefix 推出的短名 / null / `get_<组名>`）。组表级的交叉校验在 `resolveConfig`。
 *
 * @param {unknown} raw - 组项原始值。
 * @param {number} index - 在 `groups` 里的下标（错误文案用它定位）。
 * @returns {{ok: true, group: ResolvedGroup, unknownKeys: string[]} | {ok: false, reason: string}}
 */
function normalizeGroup(raw, index) {
  const at = `groups[${index}]`
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, reason: `${at} 必须是对象，形如 { name, prefix, skill, entryName }（当前是 ${describeType(raw)}）` }
  }

  const prefix = raw.prefix
  if (prefix === undefined || prefix === null) {
    return { ok: false, reason: `${at} 缺少 prefix —— 每组必须给一个工具名前缀（如 'cua_driver_native__'）` }
  }
  if (typeof prefix !== 'string') {
    return { ok: false, reason: `${at}.prefix 必须是字符串（当前是 ${describeType(prefix)}；YAML 里不要加多余引号以外的装饰）` }
  }
  if (prefix.length === 0) {
    return { ok: false, reason: `${at}.prefix 不能是空字符串 —— 空前缀会匹配【所有】工具并把它们全部摘掉` }
  }

  const rawName = raw.name
  if (rawName !== undefined && rawName !== null && (typeof rawName !== 'string' || rawName.length === 0)) {
    return { ok: false, reason: `${at}.name 必须是非空字符串（当前是 ${describeType(rawName)}）；不写则由 prefix 推出` }
  }
  const name = rawName ?? deriveGroupName(prefix)

  const rawSkill = raw.skill
  if (rawSkill !== undefined && rawSkill !== null && (typeof rawSkill !== 'string' || rawSkill.length === 0)) {
    return {
      ok: false,
      reason: `${at}.skill 必须是非空字符串（当前是 ${describeType(rawSkill)}）；`
        + '它是要校验的说明技能名（~/.dsh/skills/<skill>/SKILL.md），不想要就整条删掉这个键',
    }
  }
  const skill = rawSkill ?? null

  const defaultEntryName = defaultEntryNameOf(name)
  const rawEntryName = raw.entryName
  if (rawEntryName !== undefined && rawEntryName !== null && typeof rawEntryName !== 'string') {
    return {
      ok: false,
      reason: `${at}.entryName 必须是字符串（当前是 ${describeType(rawEntryName)}）；`
        + `不写这个键则用缺省名 ${JSON.stringify(defaultEntryName)}`,
    }
  }
  const entryName = rawEntryName ?? defaultEntryName
  if (RESERVED_ENTRY_NAMES.includes(entryName)) {
    return {
      ok: false,
      reason: `${at}.entryName 不能用保留名 ${JSON.stringify(entryName)} —— 它是 PTC 模式的呈现通道，`
        + '`tools.register()` 会直接抛（`dsh-tools` 已锁死），请换一个名字；'
        + `不写这个键则用缺省名 ${JSON.stringify(defaultEntryName)}`,
    }
  }
  if (!ENTRY_NAME_PATTERN.test(entryName)) {
    return {
      ok: false,
      reason: `${at}.entryName 必须是 1–64 位的 ASCII 工具名（只允许字母、数字、下划线、连字符；`
        + `当前是 ${JSON.stringify(entryName)}）。`
        + (rawEntryName === undefined || rawEntryName === null
          ? `这个值是从组名 ${JSON.stringify(name)} 推出的缺省名（规则 get_<组名>）`
          : `本组的缺省名是 ${JSON.stringify(defaultEntryName)}`)
        + '；工具名会进模型请求的 tools 数组，所以形态受 provider 约束',
    }
  }

  const unknownKeys = Object.keys(raw).filter((key) => !GROUP_KEYS.includes(key))

  return { ok: true, group: Object.freeze({ name, prefix, skill, entryName }), unknownKeys }
}

/**
 * 给日志用的类型描述（错误文案点名"当前是什么"，方便一步定位）。
 *
 * @param {unknown} value - 任意值。
 * @returns {string} 人类可读的类型描述。
 */
function describeType(value) {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

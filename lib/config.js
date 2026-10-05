/**
 * dsh-host-tool-layering · 配置解析（v0.1.0：配置面 = `diag` + `groups`）
 *
 * 本文件是 `dsh-host-godot-tool-layering` v0.2.0 的**泛化**：把"写死一个 godot 前缀"
 * 变成"一张组表，每组 = 一批工具（前缀）+ 一个说明技能"。原插件的每一条失败语义
 * 都原样继承，逐条对照见 README §5。
 *
 * ## 为什么不写 `export const Config = z.object({...})`
 * 与本机插件群的既有取舍一致（同 `dsh-host-godot-tool-layering`）：本 profile 里只有
 * `dsh-web-search-uapi` 用 `zod`，而它在 `~\.dsh\profiles\desktop\node_modules\` 里**没有**
 * 可解析的裸依赖（只靠 pnpm 严格布局从 `@deepseek-ai/dsh-*` 内部解析）。加一个
 * `import 'zod'` 就等于引入"来源不明的裸依赖"，而收益只是配置校验 —— 手写更划算，
 * 且零依赖让 `node --test` 可以直接跑源目录、不需要 `node_modules`。
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
 * 于是会出现"配置文件已是新形态、读它的却是旧代码"的瞬间。
 *
 * ⚠ 本插件**不是能力边界**：没有 `tools.restrict()` 那种闸门，见 README「能力边界」。
 */

/**
 * 默认组表（与 README 的配置表一一对应）：
 *  - `cua`   —— CUA 电脑控制工具（56 个 / 24,832 wire token），说明书技能 `computer-control`；
 *  - `godot` —— godot MCP 工具（39 个 / 9,599 wire token），说明书技能 `godot-use`。
 *
 * 语义与 `dsh-host-godot-tool-layering` v0.2.0 完全一致（不做任何检测、任何会话一律全摘），
 * 只是"前缀 + 技能"从代码里搬到了配置面。
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
 */
export const CONFIG_KEYS = Object.freeze(['diag', 'groups'])

/** 本插件认得的**组内**键；别的键只 warn、不判非法。 */
export const GROUP_KEYS = Object.freeze(['name', 'prefix', 'skill'])

/**
 * 从 `prefix` 推出组的"短名"（仅在某组没写 `name` 时用）。
 *
 * 规则：去掉 `mcp__` 包装，取第一个 `_` 之前的分段。
 * 例：`mcp__godot_use__` → `godot`；`cua_driver_native__` → `cua`。
 *
 * ⚠ 这个短名同时是 fail-loud 宽松启发式的关键词（见 `lib/assembly.js` 的
 * `looseKeywordOf`）—— 两者共用一条规则，日志里点名的词与判定用的词永远一致。
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
 */

/**
 * @typedef {object} ResolvedConfig
 * @property {boolean} diag - 是否打印每次装配的逐组诊断。
 * @property {ResolvedGroup[]} groups - 组表（空数组 = 合法但什么都不摘，静默 no-op）。
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
 *  - **空数组** ⇒ 合法，插件不注册水线（静默 no-op，不摘任何工具）；
 *  - **缺省 / null** ⇒ 用 `DEFAULT_GROUPS`（与 `diag` 的 `??` 语义一致：YAML 里写空值
 *    `groups:` 得到 `null`，按"未设置"处理）。⚠ 想真的全关请显式写 `groups: []`；
 *  - **非数组 / 组项缺 prefix / prefix 非字符串 / prefix 为空串** ⇒ 非法（打 error、不挂水线）。
 *    空前缀必须拒绝：`''.startsWith('')` 恒真 ⇒ 会把**所有**工具都摘掉，这是灾难级误配。
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
      reason: `groups 必须是数组，每项形如 { name, prefix, skill }（当前是 ${describeType(rawGroups)}）。`
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

  // 同 prefix 出现两次：不判非法（摘除结果与单组一致，行为无害），但要 warn ——
  // 因为"后出现的那一组永远 present=0"是个静默的配置错误。
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
 * 只校验"能不能安全地当匹配依据用"这三件事：`prefix` 必须在、是字符串、非空。
 * `name` / `skill` 缺省都是合法的（分别回落到 prefix 推出的短名 / null）。
 *
 * @param {unknown} raw - 组项原始值。
 * @param {number} index - 在 `groups` 里的下标（错误文案用它定位）。
 * @returns {{ok: true, group: ResolvedGroup, unknownKeys: string[]} | {ok: false, reason: string}}
 */
function normalizeGroup(raw, index) {
  const at = `groups[${index}]`
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, reason: `${at} 必须是对象，形如 { name, prefix, skill }（当前是 ${describeType(raw)}）` }
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

  const unknownKeys = Object.keys(raw).filter((key) => !GROUP_KEYS.includes(key))

  return { ok: true, group: Object.freeze({ name, prefix, skill }), unknownKeys }
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

/**
 * dsh-host-tool-layering v0.3.0
 *
 * 宿主插件：在 system prompt 组装的水线上，**不做任何工作区检测，默认任何会话一律摘除各组前缀下的
 * 全部工具**（本机默认两组：CUA `cua_driver_native__` 56 个 + godot `mcp__godot_use__` 39 个）。
 * v0.2.0 起有**常驻可见的入口工具**；v0.3.0 起入口工具**每组一个、各管各的**：模型调用
 * `get_cua` ⇒ 该会话从下一步起只放回 cua 组（godot 照旧被摘），调用 `get_godot` 则反之
 * （登记表与工具定义见 `lib/entry.js`，装配侧判定见 `lib/assembly.js`）。
 *
 * ```
 * 所有会话（不分 cwd、不分目录、不看文件系统） →  各组工具全部从"模型可见工具表"摘掉
 * 摘掉之后模型侧只剩技能当说明书（每组一个技能，见 lib/skills.js）
 *        ↓ 模型调用某组的常驻入口工具（缺省 get_<组名>）
 * 该会话从下一步起 → **那一组**的工具回到可见工具表（进程内粘住，直到宿主重启；其它组不受影响）
 * ```
 *
 * ## 为什么需要入口工具（v0.2.0 的新增理由）
 * 摘掉宣布面之后，模型**看不见**这组工具的任何痕迹，只能靠技能里的说明"凭记忆按完整名硬发"
 * —— 真机上因此失败过一次：会话 `session-aaaa1111…` 里 325 次工具调用中 `cua_driver_native__*`
 * **零次**（模型改去 `cordis_inspect` 里"查工具"，撞了个不存在的方法就放弃了）。
 * 复盘见工作区笔记 `.dsh\.project\dsh-工具面按需暴露-20261005.md` §1。
 * 入口工具把"能力可见性"交回模型自己：它看得见 `get_cua`，就能自己决定要不要把那组工具要回来。
 * 一步时延（第 N 步调用、第 N+1 步表才变）是**设计使然**：装配在每步开始
 * （`dsh-agent-loop\lib\index.js:907`），调用发生在步中。
 *
 * ## v0.3.0：入口**按组独立**、工具描述只说"能拿到什么"
 *  - 配置面：顶层 `entryName` 删除，改成**组内** `entryName`（缺省 `get_<组名>`）；
 *  - 登记表：`Map<sessionId, Set<组名>>`，判定粒度 `(会话, 组)`，只加不减、幂等、进程内、不落盘；
 *  - 工具定义：每组一个入口工具，`description` 一句话英文（≤120 字符）只讲"能拿到什么"，
 *    `render` 一行中文（≤40 字符）；机制解释一律留在 README，不占常驻 token；
 *  - fail-loud 的 `ignoreNames` 排除**全部**入口工具名（v0.2.0 只有一个 `get_cua`）。
 *
 * ## 与 `dsh-host-godot-tool-layering` v0.2.0 的关系：**泛化，不是替换实现**
 * 那份插件把"一组工具（前缀写死 `mcp__godot_use__`）+ 一个技能（写死 `godot-use`）"
 * 编在代码里。本插件把它抽成配置面的一张**组表**：每组 = 一个前缀 + 一个说明技能。
 * 边界语义逐条继承（README §5 有逐条对照表）：
 *
 * | 语义 | 本插件的做法 |
 * |---|---|
 * | 纯函数 + 幂等，无改动返回同一个 assembly 引用 | `lib/assembly.js` 只删不重建；无命中时返回入参引用 |
 * | 无对象时静默 no-op | 形状异常 / 该组工具不在场 ⇒ 不打任何日志 |
 * | **有对象却零命中前缀时打一条 warn** | 逐组 fail-loud（每组的宽松启发式关键词由前缀推出），每组只打一次 |
 * | 配置非法 ⇒ 只打 error、不注册水线、不抛错 | `lib/config.js` 返回 `{ok:false,reason}`，`apply()` 打 error 后 return |
 * | 只筛宣布面，不是能力边界 | 不碰注册表、不用 `tools.restrict()`，只删装配体元素 |
 * | 不碰任何第三方文件 ⇒ 不需要 patch-guard | 本插件只读自己的配置与技能文件的存在性 |
 *
 * 新增的两条：**逐组计数 + 技能存在性校验**（`present=56 removed=56 (cua)` 这种日志形态，
 * 以及"工具摘了但说明书不存在"的 fail-loud warn），以及 **v0.2.0/v0.3.0 的按组放行入口工具**。
 *
 * ## 为什么值得做（本机实测，2026-10-04）
 * 模型可见工具表 88 个定义 / 32,024 token，占常驻上下文 78%；其中
 * CUA 56 个 = 24,832 token、godot 39 个 = 9,599 token。两组都只在少数会话里真正被用到，
 * 摘掉后由技能按需提供说明书（技能目录本身只在会话里以"标题 + 一句话"的形式出现）；
 * 真要用的会话，点一次对应组的入口工具就能把那组要回来（只多付常驻入口工具的钱）。
 *
 * ## 机制与边界（行号以 live 树为准）
 * live 树 = `%USERPROFILE%\.dsh\profiles\node_modules\@deepseek-ai\`
 * （Junction → `%APPDATA%\npm\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\`）。
 * ⚠ 本机有**三棵** dsh 树，行号不可混用；顶层 `%USERPROFILE%\node_modules\@deepseek-ai\`
 * 是陈旧的 0.1.2-alpha.3。完整的证据链见 `lib/assembly.js`、`lib/entry.js` 的模块文档串与 README §2。
 *
 * ## 为什么必须 `{ global: true, prepend: true }`
 *  - `global: true`：分发过滤是 `hook.global || !filter || filter.call(...)`
 *    （`@deepseek-ai/cordis\lib\index.js:263`），而 `dsh-scope` 用水线的 `args[1].scope`
 *    做作用域过滤（`dsh-scope\lib\invariant.js:31`）。**省掉 `global` 会导致子代理的装配体
 *    不被筛选**（协调者省了、子代理没省）。同水线的官方实现正是这么挂的
 *    （`dsh-system-prompt\lib\invariant.js:33`）。
 *  - `prepend: true`：取最外层，`await next()` 拿到的是**最终**装配结果，
 *    在它之上删元素才不会被下游覆盖。
 *
 * ## 为什么要 `inject = ['tools']`（v0.2.0）
 * 入口工具必须经 `ctx.tools.register()` 真注册（只往 `assembly.tools` 塞 schema 是不够的：
 * 执行解析走注册表，`dsh-tools\lib\index.js:3011 resolveExecution → :2995 get`）。
 * **不进 inject、改用 `ctx.get('tools')` 半注册是不行的**：服务后到时插件已经跑完，
 * 结果就是"工具被摘掉了、入口却没有"——正是要避免的那个死角。`inject` 让 apply 等服务就绪再跑。
 * 先例：本机 `dsh-host-task-board\lib\index.js:124`、官方 `dsh-tool-goal` 等都是这么声明的。
 *
 * ## 行为契约
 * | 情形 | 行为 |
 * |---|---|
 * | 装配体里有某组工具、**该 `(会话, 组)` 未放行** | 该组全部摘掉（逐组计数）；该组首次打一条 info 点名"摘了几个、说明书是哪本技能" |
 * | **该 `(会话, 组)` 已放行**（模型调用过该组的入口工具） | **该组**一个工具都不摘（计数 `present=0 removed=0` + `armed=true`）；不打"已生效"、不打 fail-loud、不做技能校验；**其它组照旧全摘** |
 * | 某会话所有组都被放行 | 整表原样返回**入参同一个引用**（宿主因此看不到工具表变化） |
 * | 某组工具不在场（未装 MCP / serverName 变了 / 已被别的插件摘掉） | **静默 no-op**，原样返回同一个引用，该组不打日志 |
 * | **装配体形状异常**（非对象、无 `tools`、`tools` 非数组） | 原样放过，不抛错，不打日志 |
 * | **某组工具在场但该组前缀一条都不匹配**（且该组未放行） | 打 **`warn`**（fail-loud）—— 防上游改名后静默白装；判定用该组的宽松关键词（见 `lib/assembly.js`），每组只报一次 |
 * | **某组真的摘了工具、但它配的 `SKILL.md` 不存在** | 打 **`warn`**（fail-loud）点名缺失路径 —— 工具摘了却没有说明书，模型不知道用法 |
 * | 入口工具本身 | **常驻可见**（不匹配任何组前缀 ⇒ 永远不被摘；配置层已交叉校验）；重复调用幂等，只多写一次同一个登记值 |
 * | `diag: true` | **每次装配**打一行 info：`diag: present=56 removed=56 (cua) \| present=0 removed=0 (godot, armed) \| total_removed=… remaining=… changed=…`（被放行的组带 `, armed`） |
 * | `groups: []`（空数组，合法） | 不注册水线、不摘任何工具、也**不注册任何入口工具**（没东西可摘就没有"放回"入口这回事）；挂载时留一行 info 说明"本插件当前 no-op" |
 * | 配置非法（config 非对象 / `diag` 非布尔 / `groups` 非数组 / 组项缺 `prefix` / `prefix` 非字符串或空串 / 组内 `entryName` 形态非法、用保留名 `run_code`、以任一组 `prefix` 开头、或与别组入口名重名） | 只打一条 `error`，**不注册水线**（插件不生效）、**不注册入口工具**，**不抛错** |
 * | 配置里出现不认得的键（顶层或组内） | 不判非法；打一条 `warn` 点名后忽略（拒绝会让工具重新可见，与目标相反） |
 *
 * ## 能力语义（别把本插件当安全边界）
 * 摘宣布面只决定"模型看不看得见"，**不是能力边界**：执行解析走注册表视图、从不读装配体 ⇒
 * 任何会话里模型**按名调用被摘掉的工具仍然会成功执行**；
 * PTC / `both` 模式下 `run_code` 内的 SDK 由注册表生成（`dsh-tools\lib\index.js:2922 sdkSchemas`）
 * ⇒ 那些会话**保有全部能力（含写操作）**，只是顶层工具表里不显示。
 * 需要真正的边界请另用官方 `tools.restrict({ deny })`；本插件**故意不用**它。
 * 入口工具同样**不是**权限开关：它只是"把宣布面放回来"，不放宽任何执行限制。
 *
 * ## 生效方式（两条分开）
 * 1. **`cordis.patch.yml` 的 insert 行（patch 层改动）走 live 热加载，不需要重启**，
 *    但包内 patch **不自己触发重组合**：dsh-hmr 只监视 profile 的 `cordis.patch.yml`、
 *    home 层 `cordis.patch.yml`、profile 的 `package.json`（`dsh-hmr/lib/index.js:353-376`）。
 *    改完包内 patch 要有一次触发（点一下插件页开关，或保存 profile patch 任意一处）。
 * 2. **改本插件自己的模块代码（`lib/*.js`）必须重启 dsh**才会重载。依据
 *    （`@deepseek-ai/cordis-plugin-loader\lib\index.js`）：
 *      - `:466` 更新一条 loader 行时，只有当 `name`（还有 `inject`/`group`）变了才重新
 *        `import()`，否则直接复用 `previous.runtime.callback`；
 *      - `:275-282` 的 `import()` **不带任何 cache-busting 查询串** ⇒ 同一个文件 URL 命中
 *        Node 的 ESM 模块缓存，进程内永远返回首次加载的那份模块实例；
 *      - `:446` 连 `name` 都没变的行只走 `_patchContext()`（配置热替换）。
 *    ⇒ 热加载能换掉**配置**、换不掉**代码**；但 `lib/entry.js` 的"已放行"登记表在**模块作用域**,
 *    所以配置热替换不会把已经放行的会话打回原形（理由见 `lib/entry.js` 的模块文档串）。
 */

import { processAssembly, countLikeTools, looseKeywordOf } from './assembly.js'
import { resolveConfig } from './config.js'
import { armedGroupsOf, makeEntryTool, sessionIdOf } from './entry.js'
import { createSkillProbe, resolveSkillRoots } from './skills.js'

/** 插件名（宿主日志与 loader 行里的标识）。 */
export const name = 'tool-layering'

/**
 * 必需注入的服务：**只有 tools**。
 *
 * 入口工具要真注册进注册表（见文件头"为什么要 inject"）；`ctx.logger` 是 cordis 自带、
 * 不需要注入。**不要**在这里加可选服务（比如 agents/sessions）：进了 inject 而服务缺失
 * 会让 apply 直接抛 ⇒ 整行加载失败，与本插件"绝不抛回 loader"的纪律冲突。
 */
export const inject = ['tools']

/** 版本号，只用于日志溯源（与 package.json 手工对齐）。 */
const VERSION = '0.3.0'

/**
 * 把一条逐组计数格式化成日志片段：`present=56 removed=56 (cua)`；
 * 该组本次被放行时多一段 `, armed`（`present=0 removed=0 (cua, armed)`）——
 * 否则"计数怎么全是 0"要靠人去猜。
 *
 * 单独导出是为了可单测：这是日志契约里唯一被外部（排障时的 grep）依赖的形态。
 *
 * @param {{name: string, present: number, removed: number, armed?: boolean}} part - 一组计数。
 * @returns {string} 形如 `present=56 removed=56 (cua)` 或 `present=0 removed=0 (godot, armed)`。
 */
export function formatGroupCount(part) {
  return `present=${part.present} removed=${part.removed} (${part.name}${part.armed === true ? ', armed' : ''})`
}

/**
 * 造水线处理器。**导出是为了可单测**：测试传一个假 `next()` 就能验证
 * "返回值权威"/"原样放过"/"零改动"/"逐组 fail-loud"/"技能校验"/"diag"/"按 `(会话, 组)` 放行"
 * 这些契约，不需要启动 dsh。
 *
 * @param {object} options - 依赖注入。
 * @param {object} options.config - {@link resolveConfig} 的产物（`ok: true` 时的 `config`）。
 * @param {(fn: 'info'|'warn'|'error', message: string) => void} options.log - 日志出口。
 * @param {ReturnType<typeof createSkillProbe>} [options.skillProbe] - 技能探针（测试可注入假探针）。
 * @returns {(assembly: object, context: object, next: () => Promise<object>) => Promise<object>} 水线处理器。
 */
export function createAssembleHandler({ config, log, skillProbe }) {
  const probe = skillProbe ?? createSkillProbe({ roots: resolveSkillRoots() })

  /**
   * 逐组记账标志，各自只打一次：
   *  - `effectiveReported`：该组首次"真的摘掉了东西"的装配（info）；
   *  - `failLoudReported`：该组首次"工具在场却一条都没匹配上前缀"（warn）。
   *
   * 为什么不能共用一个：第一轮装配若某组一个工具都没有（MCP 还没起来），
   * 共用的标志会被置位，之后真正该报的 fail-loud 就**永远报不出来**了 ——
   * 而那个场景（上游改 serverName）恰恰是最需要被发现的问题。
   * 为什么按组分开：两组的上线时间互不相干（CUA 常驻、godot 随 MCP 起停）。
   * ⚠ 这两个标志都**不因"已放行"而置位**：放行只是不摘，不是"这个组已经处理完了"。
   */
  const state = config.groups.map(() => ({ effectiveReported: false, failLoudReported: false }))

  /** "技能根目录一个都取不到"这件事只提示一次，否则每轮装配都要说一遍。 */
  let rootUnavailableReported = false

  /**
   * 本插件自己注册的**全部**入口工具名（v0.3.0：每组一个）。
   * fail-loud 的宽松启发式必须把它们排除：缺省名 `get_cua` / `get_godot` 里分别含关键词
   * `cua` / `godot`（两组前缀推出的那两个），不排除就会在"本会话没有该组工具在场"时
   * 打出一条假 warn。详见 `lib/assembly.js` 的 `countLikeTools` 文档串。
   */
  const ownToolNames = new Set(
    config.groups
      .map((group) => group.entryName)
      .filter((entryName) => typeof entryName === 'string' && entryName.length > 0),
  )

  return async function onAssemble(_assembly, context, next) {
    // 水线契约：`next()` 的返回值才是权威装配体（`dsh-system-prompt\lib\index.js:302`）
    const assembly = await next()
    if (assembly === null || typeof assembly !== 'object' || !Array.isArray(assembly.tools)) {
      return assembly
    }

    // 会话身份：装配水线的 `context.scope` **就是 agent**
    //（`dsh-agent\lib\types\dispatch.js:92` 的 `assembleContextFor` 返回 `{ agent, scope: agent }`），
    // 而 `agent.id` 就是 SessionId（`dsh-agent\lib\types\types.d.ts:11,13`）。
    // 取不到身份（无 scope 的全局装配、测试里的裸 context）一律按**未放行**处理 ⇒ 照旧全摘。
    const sessionId = sessionIdOf(context?.scope)
    // 判定粒度是 `(会话, 组)`：把该会话已放行的**组名**集合交给纯函数，逐组比对。
    const armedGroups = new Set(sessionId === undefined ? [] : armedGroupsOf(sessionId))

    const result = processAssembly(assembly, { groups: config.groups, armedGroups })

    for (let index = 0; index < config.groups.length; index++) {
      const group = config.groups[index]
      const part = result.perGroup[index]
      const flags = state[index]

      // ⓪ 该 `(会话, 组)` 已放行 ⇒ 这一组被跳过（没摘、也没计数）。**必须在这里短路**：
      //    fail-loud 的判据是 `present === 0`，而放行时它必然成立 ——
      //    不短路就会每步打一条假的"上游命名形态可能已变"（工具其实好端端在表里）；
      //    "首次生效"日志的判据 `removed === 0` 与技能校验同样不该在放行时触发
      //    （工具没摘 ⇒ 模型没有失明风险，不需要说明书兜底）。
      //    ⚠ 这里只看**这一组**：别的组该摘照摘（v0.3.0 的按组独立就体现在这一行）。
      if (part.armed) continue

      // ① fail-loud：该组前缀一条都没匹配上，但装配体里明显有"像本组"的工具 ⇒
      //    上游命名形态可能已变。宽松启发式只在严格通道零命中时才启用，正常路径上不可能误报，
      //    也省掉"每次装配都多扫一遍名字"的开销。
      //    ⚠ `ownToolNames` 必须传：否则本插件自己的 `get_cua` / `get_godot` 会被算成
      //      "像 cua/godot 组"的工具（见上）。
      if (part.present === 0 && !flags.failLoudReported) {
        const loose = countLikeTools(assembly.tools, group.prefix, { ignoreNames: ownToolNames }).loose
        if (loose > 0) {
          flags.failLoudReported = true
          const keyword = looseKeywordOf(group.prefix)
          log('warn', `装配体里有 ${loose} 个名字含 "${keyword}" 的工具，但 ${group.name} 组一条都没匹配上前缀 `
            + `"${group.prefix}" —— 上游命名形态可能已变（serverName 改名？前缀写错？），`
            + `本组当前退化为 no-op：这些工具的 token 仍在白付。功能不受影响，请重新核对配置里的 prefix`)
        }
      }

      if (part.removed === 0) continue

      // ② 首次生效：只说一次，且点名"说明书在哪本技能"（或明说没配技能）
      if (!flags.effectiveReported) {
        flags.effectiveReported = true
        log('info', `首次装配已生效：摘除 ${group.name} 组全部 ${part.removed} 个工具（${formatGroupCount(part)}）`
          + (group.skill !== null
            ? `；模型侧改为按**完整名** ${group.prefix}<原始名> 调用（说明书见技能 ${group.skill}）`
            : '；⚠ 本组没有配置说明技能（skill），工具摘掉后模型手上没有任何说明书'))
      }

      // ③ 技能校验：只有"真的摘了工具"才校验 —— 没摘就没有失明风险，不必打扰用户。
      //    结果缓存（每个技能名进程内只 stat 一次）；warn 每个技能只打一次。
      if (group.skill === null) continue
      if (probe.roots.length === 0) {
        if (!rootUnavailableReported) {
          rootUnavailableReported = true
          log('warn', '取不到技能根目录（USERPROFILE / DSH_HOME / HOME 都为空）⇒ 本次跳过技能存在性校验；'
            + `请自行确认 ${group.name} 组的技能 "${group.skill}" 里的 SKILL.md 真实存在`)
        }
        continue
      }
      if (probe.exists(group.skill)) continue
      if (probe.warned(group.skill)) continue
      probe.markWarned(group.skill)
      // filePathOf 对"非法技能名"（含路径分隔符等）返回 null —— 那种名字磁盘上不可能存在，
      // 直接点名它本身，别拼出一个越出技能根目录的路径来误导排查。
      const skillPath = probe.filePathOf(group.skill)
      log('warn', `${group.name} 组摘掉了 ${part.removed} 个工具，但它的说明技能不存在：`
        + `${skillPath ?? `技能名 ${JSON.stringify(group.skill)} 不是合法的目录名，磁盘上不可能存在`} —— 工具已从模型可见工具表摘除，模型手上没有说明书`
        + '（不知道有哪些工具、怎么调）。请创建该技能文件，或把本组 config 的 skill 改成一个真实存在的技能名')
    }

    if (config.diag) {
      const parts = result.perGroup.map(formatGroupCount).join(' | ')
      log('info', `diag: ${parts} | total_removed=${result.totalRemoved} `
        + `remaining=${assembly.tools.length - result.totalRemoved} changed=${result.changed}`)
    }

    return result.assembly
  }
}

/**
 * 插件入口（Cordis `apply`）。
 *
 * 需要注入 `tools` 服务（`export const inject = ['tools']`）：入口工具要经
 * `ctx.tools.register()` 真注册（见文件头"为什么要 inject"）。
 *
 * ## 注册顺序：**每配置一组就注册一个入口工具**，且都在一切提前 return 之前
 * 本函数有两处提前 return（配置非法 / `groups` 为空数组 ⇒ 不挂水线），但它们**都不摘任何工具**，
 * 所以"工具被摘、模型侧却没有放回入口"这种死角在结构上不可能出现：
 *  - 有合法组表 ⇒ 每组都有自己的入口（注册顺序 = `config.groups` 顺序）；
 *  - `groups: []` / 配置非法 ⇒ 一个工具都不摘 ⇒ 也就不需要入口工具（本版**不注册**任何入口）。
 * 每组各自 try/catch：某个入口注册失败（重名等）只降级该组，其它组与摘除路径不受影响。
 *
 * ## 失败语义：本函数**绝不抛错**
 * `apply()` 跑在宿主启动路径上：`cordis.patch.yml` 的补丁经 loader 应用时是
 * `dsh-app-boot\lib\index.js:240` 的 `await this.root.update(data)`。
 * 抛错 ⇒ 冷启动时整个宿主进程非零退出（旧版 loader ≤1.0.3 还会整层回滚同文件其它 insert 行；
 * 0.1.7-rc.1 起 loader 1.0.5 取消事务回滚，故障面收窄到本行，但仍会打断冷启动）。
 * 现在改为：打一条 `error` 日志点名非法字段，**完全不注册水线**（插件不生效），
 * 宿主与其它插件照常启动。**不静默回落默认值** —— 那会让"配置写错"表现成
 * "插件生效了但行为怪"。
 *
 * @param {object} ctx - Cordis 上下文。
 * @param {object} [config] - `cordis.patch.yml` 里该行的 `config` 字段。
 * @returns {void} 无论配置是否合法都正常返回。
 */
export function apply(ctx, config) {
  // 日志出口：**双写**。
  // `@deepseek-ai/cordis\lib\index.js:1687` 在 Context 构造里 `this.logger = new LoggerService(self)`，
  // 同文件 `:639-648` 把 `info/warn/error/debug` 挂上 LoggerService.prototype，
  // 官方 `dsh-mcp-client\lib\index.js:174,583,634` 正是这么用的（`ctx.logger.warn(...)`）。
  // 两路各有各的可见性，所以**两路都写、都不删**：
  //  - `ctx.logger.*` ⇒ 进 cordis 的 logger 通路（内存 buffer / exporter，取决于本机配置）；
  //  - `console.*`   ⇒ 宿主 stdout，被看门狗收进 `<工具目录>\dsh-watchdog-dsh.log`
  //    —— 这是本机**实际唯一能事后翻到**的地方，故保留。
  // 任何一路不可用都不影响另一路（各自 try/catch；本插件绝不能让日志把装配搞崩）。
  const log = (fn, message) => {
    const line = `[${name}] ${message}`
    try { ctx.logger?.[fn]?.(line) } catch { /* logger 服务异常时忽略，仍有 console 那一路 */ }
    try {
      if (fn === 'error') console.error(line)
      else if (fn === 'warn') console.warn(line)
      else console.log(line)
    } catch { /* stdout 不可用时静默，仍有 logger 那一路 */ }
  }

  // 配置非法 ⇒ **只报告、不抛错、不挂水线**（详见本函数文档串的"失败语义"）。
  // 包一层 try/catch 是额外保险：`resolveConfig` 现在返回结果对象而不抛错，
  // 但"启动路径上的任何异常都会毁掉宿主"这个后果太贵，不值得赌第二遍。
  let resolved
  try {
    resolved = resolveConfig(config)
  } catch (error) {
    resolved = { ok: false, reason: `配置校验本身抛出异常：${error?.message ?? String(error)}` }
  }

  // ── 入口工具：**每组一个**，注册在一切提前 return 之前（顺序理由见本函数文档串）─────
  // 配置非法时 `entryGroups` 为空 ⇒ 什么都不注册：那种形态下插件不生效、一个工具都不摘，
  // 不会有"摘了却没有入口"的死角（v0.2.0 曾退回默认名注册一个，v0.3.0 起按组注册，故取消）。
  const entryGroups = resolved.ok ? resolved.config.groups : []
  /** @type {{entryName: string, group: string, ok: boolean}[]} 每个入口工具的注册结果（供挂载日志如实汇报） */
  const entryTools = []
  // disposer 不用手动存：`ctx.tools.register()` 把注销挂在**当前 fiber** 上，配置热重载 /
  // 插件卸载时由 cordis 自动执行（`dsh-tools\lib\index.js:2878-2887`）。
  if (entryGroups.length > 0 && typeof ctx.tools?.register !== 'function') {
    log('error', `tools 服务不可用 ⇒ ${entryGroups.length} 个入口工具`
      + `（${entryGroups.map((group) => group.entryName).join('、')}）都未注册。`
      + '本插件照常摘除各组工具，但模型侧不会出现"放回"入口（工具仍可按完整名调用）')
  } else {
    for (const group of entryGroups) {
      try {
        ctx.tools.register(makeEntryTool({ group, log }))
        entryTools.push({ entryName: group.entryName, group: group.name, ok: true })
      } catch (error) {
        entryTools.push({ entryName: group.entryName, group: group.name, ok: false })
        log('error', `${group.name} 组的入口工具 ${group.entryName} 注册失败：${error?.message ?? String(error)}`
          + '。该组工具照常摘除，但模型侧没有该组的"放回"入口 —— 请检查 entryName 是否与已有工具重名')
      }
    }
  }
  const entryRegistered = entryTools.filter((item) => item.ok).length

  if (!resolved.ok) {
    log('error', `配置非法 ⇒ 插件不生效（未注册 system-prompt/assemble 水线）：${resolved.reason}`
      + '。请修正 cordis.patch.yml 里本行的 config 后保存 —— 热加载由 dsh-hmr 驱动，保存即再次热加载重试；'
      + '⚠ 本插件的【模块代码】不随热加载重载，改 lib/*.js 后需要重启 dsh 才生效；'
      + '本次不影响宿主启动，也不影响其它插件'
      + '（一个工具都不会摘 ⇒ 也不注册任何入口工具，没有"摘了却没有入口"的死角）')
    return
  }

  const effective = resolved.config

  // 未知键只 warn、不拒绝。为什么不拒绝：拒绝 ⇒ 插件不注册 ⇒ 工具重新出现在模型可见
  // 工具表里，与目标相反；容忍 ⇒ 行为完全正确（照常全摘），代价只是这一行提示。
  // ⚠ v0.2.0 的顶层 `entryName` 现在会落到这里（改成组内键了）：只 warn，不判非法。
  if (effective.unknownKeys.length > 0) {
    log('warn', '配置里出现本插件不认得的顶层键，已忽略（配置面只有 diag / groups；'
      + '入口工具名是**组内**的 entryName）：'
      + effective.unknownKeys.map((key) => JSON.stringify(key)).join(', '))
  }
  if (effective.unknownGroupKeys.length > 0) {
    log('warn', 'groups 里出现本插件不认得的键，已忽略（每个组只有 name / prefix / skill / entryName）：'
      + effective.unknownGroupKeys
        .map((item) => `groups[${item.index}]( ${item.name} ) 里的 ${JSON.stringify(item.key)}`)
        .join(', '))
  }
  if (effective.duplicatePrefixes.length > 0) {
    log('warn', '有多个组写了同一个 prefix，已忽略后出现的那组（同前缀时只有组表里靠前的组会命中，'
      + `后面的组永远 present=0）：${effective.duplicatePrefixes.map((p) => JSON.stringify(p)).join(', ')}`
      + '。若这是想拆成两组不同技能，请把 prefix 写得更具体'
      + '（⚠ 同前缀的两组必须显式写不同的 entryName，否则缺省名会撞车 ⇒ 配置非法）')
  }

  // `groups: []` 是**合法**配置：什么都没得摘 ⇒ 不注册水线（连每步一次的空调用都省掉），
  // 也不注册入口工具（没有组就没有"放回"这回事）。留一行 info 说明当前是 no-op，
  // 否则"配置成空 ⇒ 静默白装"会毫无线索。
  if (effective.groups.length === 0) {
    log('info', `v${VERSION} groups 为空数组 ⇒ 不注册 system-prompt/assemble 水线（本插件当前是 no-op，`
      + '一个工具都不会摘，也不注册任何入口工具）。这是合法配置；想让工具重新可见就保持这样，'
      + '想启用请把组表写回去')
    return
  }

  const skillProbe = createSkillProbe({ roots: resolveSkillRoots() })
  // 没配 skill 的组在挂载时就点一次名：装配期的技能校验只覆盖"配了但文件不存在"这一种。
  for (const group of effective.groups) {
    if (group.skill === null) {
      log('warn', `${group.name} 组没有配置说明技能（skill）⇒ 该组工具被摘掉后模型手上没有任何说明书`
        + '（不知道有哪些工具、怎么调）。请给该组补一个真实存在的技能名，或确认这是有意的')
    }
  }

  ctx.on('system-prompt/assemble', createAssembleHandler({ config: effective, log, skillProbe }), {
    global: true,
    prepend: true,
  })

  const entryText = effective.groups
    .map((group) => `${group.name} → ${group.entryName}`)
    .join('、')

  log('info', `v${VERSION} 已挂载 system-prompt/assemble 水线：不做任何工作区检测，任何会话默认直接摘除各组前缀下的全部工具 —— `
    + effective.groups
      .map((group) => `${group.name}(${group.prefix}${group.skill !== null ? ` → 技能 ${group.skill}` : ' → ⚠未配技能'})`)
      .join('、')
    + '；某组工具不在场时该组静默 no-op'
    + `；每组一个常驻入口工具（${entryText}）`
    + (entryRegistered === effective.groups.length
      ? '已注册 —— 模型调用某个入口一次，该会话从下一步起只放回那一组（一步时延是设计使然）'
      : `⚠ 只注册成功 ${entryRegistered}/${effective.groups.length} 个 ⇒ 有组缺少"放回"入口（详见上面的 error）`)
    + `${effective.diag ? '；diag 已开启（每次装配打一行逐组诊断）' : ''}`
    + '（注意：本插件只筛宣布面，不构成能力边界 —— 摘除后按完整名调用仍会成功执行，'
    + 'PTC/both 模式下 run_code 内也仍可调用全部工具）')
  if (skillProbe.roots.length === 0) {
    log('warn', '取不到技能根目录（USERPROFILE / DSH_HOME / HOME 都为空）⇒ 无法校验各组的说明技能是否存在')
  }
}

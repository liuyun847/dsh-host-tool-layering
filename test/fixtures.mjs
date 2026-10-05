/**
 * 测试夹具：真实工具名快照 + 装配体构造器。
 *
 * 名字来源（都是**实测快照**，不是编的）：
 *  - CUA 的 56 个短名取自 `working\dsh-prompt-audit\data\DRIFT\measure\24-tools-name-all.txt`
 *    （该快照里 `cua_driver_native__` 前缀的条目正好 56 个，与任务口径一致）；
 *  - godot 的 39 个短名取自 `working\dsh-prompt-audit\03-tools.md`（2026-09-12 实测快照，
 *    与旧插件 `dsh-host-godot-tool-layering` 的 fixtures 完全一致）；
 *  - 其余为同快照里的内置/其它 MCP 工具（**必须一个不动**的那批）。
 *
 * 参数表刻意写成"每个工具一个不同的小 schema"：这样"只删不重建"的断言才有区分度 ——
 * 如果实现对 objects 做了浅拷贝/深拷贝，引用比较就会失败。
 */

/** CUA 工具短名（raw name），56 个。 */
export const CUA_RAW_NAMES = Object.freeze([
  'bring_to_front',
  'browser_click',
  'browser_dialog',
  'browser_download',
  'browser_navigate',
  'browser_pointer',
  'browser_prepare',
  'browser_set_input_files',
  'browser_type',
  'check_permissions',
  'click',
  'clipboard_read',
  'clipboard_write',
  'debug_window_info',
  'double_click',
  'drag',
  'end_session',
  'escalate_session',
  'get_accessibility_tree',
  'get_agent_cursor_state',
  'get_browser_state',
  'get_config',
  'get_cursor_position',
  'get_desktop_state',
  'get_recording_state',
  'get_screen_size',
  'get_session',
  'get_session_state',
  'get_window_state',
  'health_report',
  'hotkey',
  'install_ffmpeg',
  'invoke_menu',
  'kill_app',
  'launch_app',
  'list_apps',
  'list_sessions',
  'list_windows',
  'move_cursor',
  'page',
  'press_key',
  'replay_trajectory',
  'right_click',
  'scroll',
  'set_agent_cursor_enabled',
  'set_agent_cursor_motion',
  'set_agent_cursor_theme',
  'set_config',
  'set_value',
  'set_window_frame',
  'start_recording',
  'start_session',
  'stop_recording',
  'type_text',
  'verify_state',
  'zoom',
])

/** godot MCP 工具短名（raw name），39 个。 */
export const GODOT_RAW_NAMES = Object.freeze([
  'add_autoload',
  'add_node',
  'attach_project',
  'attach_script',
  'batch_scene_operations',
  'connect_signal',
  'create_scene',
  'delete_nodes',
  'detach_project',
  'disconnect_signal',
  'duplicate_node',
  'export_mesh_library',
  'get_debug_output',
  'get_node_properties',
  'get_node_signals',
  'get_project_files',
  'get_project_info',
  'get_project_settings',
  'get_scene_dependencies',
  'get_scene_tree',
  'get_ui_elements',
  'launch_editor',
  'list_autoloads',
  'list_projects',
  'load_sprite',
  'profile_project',
  'remove_autoload',
  'run_project',
  'run_script',
  'save_scene',
  'search_project',
  'set_node_properties',
  'simulate_input',
  'start_profiler',
  'stop_profiler',
  'stop_project',
  'take_screenshot',
  'update_autoload',
  'validate',
])

/** 默认两组的完整公共名（形态依据 `dsh-mcp-client\lib\index.js:120-126`）。 */
export const CUA_FULL_NAMES = Object.freeze(CUA_RAW_NAMES.map((raw) => `cua_driver_native__${raw}`))
export const GODOT_FULL_NAMES = Object.freeze(GODOT_RAW_NAMES.map((raw) => `mcp__godot_use__${raw}`))

/** 不属于任何组、必须一个不动的工具（内置 / 其它 MCP server / 计划任务等）。 */
export const NON_LAYERED_NAMES = Object.freeze([
  'ask_user_question',
  'create_goal',
  'edit',
  'exit_plan_mode',
  'get_goal',
  'glob',
  'grep',
  'interrupt_agent',
  'job_kill',
  'job_list',
  'job_output',
  'list_agents',
  'list_mcp_resource_templates',
  'list_mcp_resources',
  'mcp__context7__query-docs',
  'mcp__context7__resolve-library-id',
  'present',
  'pwsh',
  'read',
  'read_image',
  'read_mcp_resource',
  'restart_dsh',
  'schedule_create',
  'schedule_delete',
  'schedule_list',
  'schedule_update',
  'send_message',
  'skill',
  'subagent',
  'subagent_fork',
  'task_board',
  'todo_write',
  'update_goal',
  'web_fetch',
  'web_search',
  'write',
])

/**
 * 造一个工具对象（装配体里的形态：只有三键，没有 execute）。
 *
 * @param {string} toolName - 完整公共名。
 * @returns {{name: string, description: string, parameters: object}} 工具对象。
 */
export function makeTool(toolName) {
  return {
    name: toolName,
    description: `description for ${toolName}`,
    parameters: { type: 'object', properties: { [toolName]: { type: 'string' } }, required: [toolName] },
  }
}

/** CUA 工具对象（每次调用新建，避免测试间相互污染）。 */
export function cuaTools() {
  return CUA_FULL_NAMES.map(makeTool)
}

/** godot 工具对象。 */
export function godotTools() {
  return GODOT_FULL_NAMES.map(makeTool)
}

/** 非分层工具对象。 */
export function nonLayeredTools() {
  return NON_LAYERED_NAMES.map(makeTool)
}

/**
 * 构造一个"三组交错"的装配体。
 *
 * 顺序刻意交错（内置 / CUA / godot 轮流），这样"只删不重排"的断言才能抓到重排实现。
 *
 * @param {object} [options] - 可选项。
 * @param {boolean} [options.includeCua] - 是否含 CUA 工具，默认 true。
 * @param {boolean} [options.includeGodot] - 是否含 godot 工具，默认 true。
 * @returns {{sections: object[], contexts: object[], tools: object[], variables: object}} 装配体。
 */
export function makeAssembly(options = {}) {
  const buckets = [
    nonLayeredTools(),
    options.includeCua === false ? [] : cuaTools(),
    options.includeGodot === false ? [] : godotTools(),
  ]
  const tools = []
  const max = Math.max(...buckets.map((bucket) => bucket.length))
  for (let i = 0; i < max; i++) {
    for (const bucket of buckets) {
      if (i < bucket.length) tools.push(bucket[i])
    }
  }
  return {
    sections: [{ name: 'persona', text: 'you are a test fixture' }],
    contexts: [{ name: 'runtime', text: 'runtime context' }],
    tools,
    variables: { provider: 'test', model: 'test-model', cwd: 'C:\\fixture' },
  }
}

/**
 * 造一个只记日志、不做磁盘校验的假技能探针（默认"技能都存在"）。
 *
 * 为什么假探针也要有真形状：处理器会读 `probe.roots` / `filePathOf` / `exists` /
 * `warned` / `markWarned` 这五处，形状不全的桩会让测试测不到真实分支。
 *
 * @param {object} [options] - 可选项。
 * @param {string[]} [options.roots] - 技能根目录表，默认 `['C:\\skills']`。
 * @param {string[]} [options.missing] - 视为"不存在"的技能名。
 * @param {(filePath: string) => boolean} [options.existsSync] - 可选：直接注入判定函数（用于数 stat 次数）。
 * @returns {object} 探针 + `stats` 计数器，形如 `{ probe, stats }`。
 */
export function makeProbe(options = {}) {
  const roots = options.roots ?? ['C:\\skills']
  const missing = new Set(options.missing ?? [])
  const stats = { checks: 0, paths: [] }
  /** @type {Map<string, boolean>} */
  const cache = new Map()
  /** @type {Set<string>} */
  const warnedSet = new Set()
  const existsSync = options.existsSync
  const skillPath = (skillName) => `${roots[0]}\\${skillName}\\SKILL.md`
  const probe = {
    roots,
    filePathOf: (skillName) => (roots.length === 0 ? null : skillPath(skillName)),
    exists: (skillName) => {
      if (typeof skillName !== 'string' || skillName.length === 0) return false
      const cached = cache.get(skillName)
      if (cached !== undefined) return cached
      let found
      if (typeof existsSync === 'function') {
        stats.checks++
        stats.paths.push(skillPath(skillName))
        found = existsSync(skillPath(skillName)) === true
      } else {
        found = !missing.has(skillName)
      }
      cache.set(skillName, found)
      return found
    },
    warned: (skillName) => warnedSet.has(skillName),
    markWarned: (skillName) => { warnedSet.add(skillName) },
  }
  return { probe, stats }
}

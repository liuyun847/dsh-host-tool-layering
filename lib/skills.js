/**
 * dsh-host-tool-layering · 说明技能存在性校验
 *
 * ## 为什么这件事是**硬要求**，不是锦上添花
 * 本插件把一组工具从"模型可见工具表"里摘掉之后，模型就再也看不到那些工具的
 * 名称/描述/参数表（装配体里本来也只有 `{name, description, parameters}`，见
 * `lib/assembly.js` 的机制说明）。此时模型要知道"有哪些工具、怎么调"，**唯一**的依据
 * 就是那本配套技能 `~\.dsh\skills\<skill>\SKILL.md`。
 * 工具摘了、说明书却不存在 ⇒ 模型对该能力**彻底失明**（知道有这回事、不知道任何细节）。
 * 这与"省 token"的目标不冲突但优先级更高，所以必须 **fail-loud**：打一条 warn 点名。
 *
 * ## 校验范围（有意为之的窄）
 * 只看 `SKILL.md` 这一个文件存在与否：
 *  - 不解析 frontmatter、不校验技能名与工具名前缀是否真的对得上（那是技能自己的事）；
 *  - 不看 profile 的 `preset-skills\` —— 本机技能目录的权威位置是 `~\.dsh\skills\`
 *    （`dsh-skill-toggle` 等既有实现同样以它为"会话技能目录"）。
 *
 * ## 缓存
 * 装配**每轮**触发一次（`dsh-agent-loop\lib\index.js:890`），每轮都对每个组 stat 一次磁盘
 * 是没必要的 I/O。这里按技能名缓存"存在与否"的判定结果，进程内只 stat 一次；
 * 代价是"会话中途新建技能文件"要等宿主重启才被认到 —— 可以接受：
 * warn 本来也只在首次缺失时打一条，之后不再刷屏。
 * 缓存与"已 warn 过"两个状态分开记：前者决定要不要 stat，后者决定要不要打日志。
 *
 * ## 纯函数边界
 * 本模块把 `existsSync` 与根目录表都做成了入参（默认取真实实现），
 * 所以 `test/skills.test.mjs` 不需要真磁盘、也不需要 mock 模块。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** 技能说明文件的固定文件名。 */
export const SKILL_FILE_NAME = 'SKILL.md'

/**
 * 算出"技能根目录"的候选表（按优先级去重）。
 *
 * 为什么是候选表而不是单个路径：技能目录的权威定义是 `<DSH_HOME>\skills`，
 * 而用户可见的写法是 `~\.dsh\skills`（`~` = `USERPROFILE`）。本机两者指向同一处
 * （`DSH_HOME=%USERPROFILE%\.dsh`），但任一环境变量都可能缺失或被改，
 * 所以**任一候选下存在即算存在**，避免把"其实装好了的技能"误报成缺失。
 *
 * @param {object} [env] - 环境变量表（默认 `process.env`）。
 * @param {() => string} [homedir] - 兜底的家目录取法（默认 `os.homedir`）。
 * @returns {string[]} 候选根目录（已去重；至少一项，除非连家目录都取不到）。
 */
export function resolveSkillRoots(env = process.env, homedir = os.homedir) {
  /** @type {string[]} */
  const candidates = []
  const push = (value) => {
    if (typeof value === 'string' && value.trim().length > 0) candidates.push(path.resolve(value.trim()))
  }

  // ① 任务口径：~\.dsh\skills（~ = USERPROFILE）
  const userProfile = env?.USERPROFILE
  if (typeof userProfile === 'string' && userProfile.trim().length > 0) {
    push(path.join(userProfile.trim(), '.dsh', 'skills'))
  }
  // ② 宿主口径：<DSH_HOME>\skills
  const dshHome = env?.DSH_HOME
  if (typeof dshHome === 'string' && dshHome.trim().length > 0) {
    push(path.join(dshHome.trim(), 'skills'))
  }
  // ③ POSIX 口径（非 Windows 或 USERPROFILE 缺失时）
  const home = env?.HOME
  if (typeof home === 'string' && home.trim().length > 0) {
    push(path.join(home.trim(), '.dsh', 'skills'))
  }
  // ④ 最后兜底
  if (candidates.length === 0) {
    try {
      const fallback = typeof homedir === 'function' ? homedir() : ''
      if (typeof fallback === 'string' && fallback.length > 0) push(path.join(fallback, '.dsh', 'skills'))
    } catch { /* 取不到家目录就返回空表，由调用方按"无法校验"处理 */ }
  }

  // 去重（Windows 路径大小写不敏感 ⇒ 用小写做键）
  const seen = new Set()
  /** @type {string[]} */
  const roots = []
  for (const candidate of candidates) {
    const key = candidate.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    roots.push(candidate)
  }
  return roots
}

/**
 * 技能名是否可以安全地当**目录名**拼进路径。
 *
 * 不收任何路径分隔符与 Windows 非法字符，也拒绝 `.` / `..`：
 * 技能名来自配置，不该有能力把 stat 指到技能根目录之外（只读校验也照样挡住）。
 * 非 ASCII 名（中文技能名）是允许的 —— 只挡分隔符与控制字符。
 *
 * @param {unknown} skillName - 技能名。
 * @returns {boolean} 是否可安全拼接。
 */
export function isSafeSkillName(skillName) {
  if (typeof skillName !== 'string' || skillName.length === 0) return false
  if (skillName === '.' || skillName === '..') return false
  // eslint-disable-next-line no-control-regex -- 控制字符一并挡掉
  return !/[\u0000-\u001f\u007f\\/:*?"<>|]/.test(skillName)
}

/**
 * 造一个技能探针：按技能名判定 `SKILL.md` 是否存在（结果缓存），并记"已 warn 过"。
 *
 * @param {object} [options] - 依赖注入。
 * @param {string[]} [options.roots] - 技能根目录候选表（默认由 {@link resolveSkillRoots} 算出）。
 * @param {(filePath: string) => boolean} [options.existsSync] - 存在性判定（默认 `fs.existsSync`），测试可注入。
 * @returns {{
 *   roots: string[],
 *   filePathOf: (skillName: unknown) => string|null,
 *   exists: (skillName: unknown) => boolean,
 *   warned: (skillName: unknown) => boolean,
 *   markWarned: (skillName: unknown) => void,
 * }} 探针；`roots` 为空表时 `exists` 恒为 false（调用方应先看 `roots.length` 决定是否校验）。
 */
export function createSkillProbe(options = {}) {
  const roots = Array.isArray(options.roots) ? options.roots : resolveSkillRoots()
  const existsSync = typeof options.existsSync === 'function' ? options.existsSync : fs.existsSync
  /** @type {Map<string, boolean>} 技能名 → 是否存在（进程内只判定一次） */
  const cache = new Map()
  /** @type {Set<string>} 已经为它打过 warn 的技能名 */
  const warnedSet = new Set()

  const filePathOf = (skillName) => {
    if (roots.length === 0 || !isSafeSkillName(skillName)) return null
    return path.join(roots[0], skillName, SKILL_FILE_NAME)
  }

  return {
    roots,
    filePathOf,
    exists(skillName) {
      if (!isSafeSkillName(skillName)) return false
      const cached = cache.get(skillName)
      if (cached !== undefined) return cached
      let found = false
      for (const root of roots) {
        let hit = false
        try {
          hit = existsSync(path.join(root, skillName, SKILL_FILE_NAME)) === true
        } catch { hit = false /* 磁盘异常一律按"不存在"处理，绝不把异常抛到装配路径上 */ }
        if (hit) { found = true; break }
      }
      cache.set(skillName, found)
      return found
    },
    warned(skillName) {
      return typeof skillName === 'string' && warnedSet.has(skillName)
    },
    markWarned(skillName) {
      if (typeof skillName === 'string') warnedSet.add(skillName)
    },
  }
}

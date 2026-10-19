/**
 * v0.3.1 的契约测试：**放行登记表落盘**（跨宿主重启存活）。
 *
 * 覆盖五件事（任务口径 ①—⑤）：
 *  - **恢复**：介质里有记录 ⇒ 打开即恢复（`isGroupArmed` 立即为真）；落盘 → 清空内存 → 按落盘恢复
 *    结果一致且幂等；
 *  - **竞态**：装配会等"恢复落定"（不等就会在重启后的头几步把已放行的组又摘掉），
 *    卡死时有超时闸门 + 一条 warn，绝不把会话卡住；
 *  - **写**：新增放行触发一次整份覆盖写（排序去重、幂等）；写盘失败只 warn，**不改** `armGroup`
 *    的返回值语义；打开期内的放行在落定后补写；
 *  - **降级**：服务不在场 / 域打开失败 / 记录坏 ⇒ 纯内存 + 一条"本次运行不持久化"的 warn，
 *    水线、入口工具、放行判定照常，绝不抛；
 *  - **陌生组名**：旧记录里已不在当前配置里的组名 ⇒ 保留但忽略 + 点名一次。
 *
 * ⚠ 这里**不连真实宿主服务**、**不碰 `~\.dsh\storages\`**：存储服务、域句柄、介质全是本文件的假实现
 * （唯一用到真依赖的是"域声明形状"那条用例：它 `import('@deepseek-ai/dsh-storage-domain')`，
 * 与本包其它测试用真 `@deepseek-ai/dsh-tools` 是同一个口径，见 README §10）。
 */

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { armedDomainSpec, apply, ARMED_DOMAIN, ARMED_RESTORE_WAIT_MS, ARMED_TABLE, createAssembleHandler, normalizeArmedGroups, startArmedStore } from '../lib/index.js'
import { resolveConfig } from '../lib/config.js'
import {
  armGroup,
  armedGroupCount,
  armedGroupsOf,
  armedSessionCount,
  isGroupArmed,
  resetArmedSessions,
  restoreArmedSessions,
  snapshotArmedGroups,
  snapshotArmedSessions,
} from '../lib/entry.js'
import {
  CUA_ENTRY_TOOL_NAME,
  GODOT_ENTRY_TOOL_NAME,
  NON_LAYERED_NAMES,
  makeAssembly,
  makeMockCtx,
  makeProbe,
} from './fixtures.mjs'

/** 默认两组的组名（`cordis.patch.yml` 的配置口径）。 */
const KNOWN_GROUPS = new Set(['cua', 'godot'])

/** 假域声明（行为用例用它，避开对域包的直接依赖）；形状用例另行校验真实 spec。 */
const FAKE_SPEC = { name: ARMED_DOMAIN, version: 1, tables: { [ARMED_TABLE]: {} } }

/** 等一个条件成立（fire-and-forget 的写盘要用它收口，不用固定 sleep 猜时序；返回值即条件值）。 */
async function until(predicate, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = predicate()
    if (value) return value
    if (Date.now() > deadline) throw new Error('等待条件超时')
    await new Promise((resolve) => { setTimeout(resolve, 2) })
  }
}

/** 让出若干轮事件循环（异步落定用）。 */
async function tick(rounds = 4) {
  for (let index = 0; index < rounds; index += 1) {
    await new Promise((resolve) => { setImmediate(resolve) })
  }
}

/** 等到定时器那一路也跑过（`startArmedStore` 的"注入回调始终没激活"兜底是 `setTimeout(0)`）。 */
async function afterTimer() {
  await new Promise((resolve) => { setTimeout(resolve, 5) })
}

/** 日志收集器（形态与 `makeMockCtx` 的 logger 一致）。 */
function makeLogs() {
  const logs = []
  return { logs, log: (fn, message) => logs.push({ fn, message }) }
}

/**
 * 假领域存储服务：`open(spec)` 交回一个假域（`table(name)` ⇒ 假表）。
 *
 * @param {object} [options] - 可选项。
 * @param {Iterable<[string, unknown]>} [options.records] - 介质里初始就有的记录。
 * @param {boolean} [options.failWrite] - 每次 `put` 都抛（模拟介质写失败）。
 * @param {(attempt: number) => Error|null} [options.onOpen] - 决定第 N 次 open 抛不抛。
 * @param {Promise<void>} [options.openGate] - open 之前先等它（模拟"打开很慢"）。
 * @returns {{facility: object, state: object, records: Map<string, unknown>}} 假服务 + 可观测状态。
 */
function makeFakeFacility(options = {}) {
  const records = new Map(options.records ?? [])
  const state = { opens: 0, closes: 0, specs: [], writes: [], failWrite: options.failWrite === true }
  const facility = {
    async open(spec) {
      state.opens += 1
      state.specs.push(spec)
      if (options.openGate !== undefined) await options.openGate
      if (typeof options.onOpen === 'function') {
        const error = options.onOpen(state.opens)
        if (error !== null && error !== undefined) throw error
      }
      return {
        table(name) {
          if (name !== ARMED_TABLE) throw new Error(`假域里没有表 ${name}`)
          return {
            entries: () => [...records.entries()],
            get: (key) => records.get(key),
            put: async (key, record) => {
              if (state.failWrite) throw new Error('介质写失败（模拟）')
              records.set(key, record)
              state.writes.push({ key, record })
            },
            delete: async (key) => { records.delete(key) },
          }
        },
        async close() { state.closes += 1 },
      }
    },
  }
  return { facility, state, records }
}

/**
 * 给假 ctx 装上 cordis 的 `get` / `inject` / `effect` 三件套（`lib/index.js` 只用到这三个）。
 *
 * @param {object} ctx - `makeMockCtx()` 的产物。
 * @param {object} options - 可选项。
 * @param {object} [options.facility] - `storageDomain` 服务实现。
 * @param {'ready'|'absent'|'never'} [options.mode] - `ready`：服务在场；`absent`：注入回调会跑但服务为空；
 *   `never`：回调从不激活（服务始终没来）。
 * @returns {{ctx: object, disposers: Function[]}} 同一个 ctx + 收集到的 disposer（测试里手动触发＝卸载）。
 */
function attachStorage(ctx, { facility, mode = 'ready' } = {}) {
  const disposers = []
  const pick = () => (mode === 'absent' ? undefined : facility)
  ctx.get = (serviceName) => (serviceName === 'storageDomain' ? pick() : undefined)
  ctx.effect = (factory) => { disposers.push(factory()); return () => {} }
  ctx.inject = (names, callback) => {
    assert.deepEqual(names, ['storageDomain'], '可选依赖只有 storageDomain 这一项')
    if (mode === 'never') return
    callback({
      get: (serviceName) => (serviceName === 'storageDomain' ? pick() : undefined),
      effect: (factory) => { disposers.push(factory()); return () => {} },
    })
  }
  return { ctx, disposers }
}

/** 造一个 store（行为用例统一入口）。 */
function makeStore({ facility, knownGroupNames = KNOWN_GROUPS, mode = 'ready', buildSpec, logs }) {
  const ctx = makeMockCtx()
  const { disposers } = attachStorage(ctx, { facility, mode })
  const collector = logs ?? makeLogs()
  const store = startArmedStore({
    ctx,
    log: collector.log,
    knownGroupNames,
    buildSpec: buildSpec ?? (async () => FAKE_SPEC),
  })
  return { store, logs: collector.logs, disposers }
}

/** 装配处理器用的处理器夹具（照 `plugin.test.mjs` 的 mount 口径）。 */
function mountHandler(configInput = {}, extra = {}) {
  const { logs, log } = makeLogs()
  const resolved = resolveConfig(configInput)
  assert.equal(resolved.ok, true, `只接受合法配置：${resolved.reason}`)
  const { probe } = makeProbe()
  return {
    handler: createAssembleHandler({ config: resolved.config, log, skillProbe: probe, ...extra }),
    logs,
  }
}

/** 水线契约里的"带 scope 的装配 context"。 */
const contextOf = (sessionId) => ({ agent: { id: sessionId }, scope: { id: sessionId } })

/** 假 `next()`：返回值即权威装配体。 */
const nextOf = (assembly) => async () => assembly

// ── ① 恢复 ──────────────────────────────────────────────────────────────────

test('恢复①：介质里已有放行 ⇒ 打开即恢复（isGroupArmed 立即为真），恢复本身不产生任何写盘', async (t) => {
  resetArmedSessions()
  const { facility, state } = makeFakeFacility({
    records: [['session-A', { groups: ['cua'] }], ['session-B', { groups: ['godot', 'cua'] }]],
  })
  const { store, logs } = makeStore({ facility })
  t.after(() => store.stop())

  // ⚠ 关键：`apply()` 当场返回、装配随时可能发生 ⇒ 这里刻意"先 await ready 再断言"，
  //   真实宿主里装配看到的也正是这个时点（waterline 会 await 同一个 promise）。
  await store.ready

  assert.equal(store.status, 'ready')
  assert.equal(isGroupArmed('session-A', 'cua'), true, '恢复后立即为真（这是本次改动的主目标）')
  assert.equal(isGroupArmed('session-B', 'godot'), true)
  assert.equal(isGroupArmed('session-B', 'cua'), true)
  assert.equal(isGroupArmed('session-A', 'godot'), false, '介质里没有的不该凭空出现')
  assert.deepEqual(snapshotArmedGroups('session-B'), ['cua', 'godot'], '组名快照排序稳定')
  assert.equal(armedSessionCount(), 2)
  assert.equal(armedGroupCount(), 3)
  assert.equal(state.writes.length, 0, '恢复不是"新放行" ⇒ 一次写盘都不该有')

  const info = logs.filter((line) => line.fn === 'info')
  assert.equal(info.length, 1)
  assert.match(info[0].message, /放行登记表已就绪/)
  assert.match(info[0].message, new RegExp(ARMED_DOMAIN))
  assert.match(info[0].message, /2 个会话 \/ 3 个 \(会话, 组\) 条目/)
  assert.match(info[0].message, /3 个新并入内存/)
  assert.equal(logs.some((line) => line.fn === 'warn'), false)
})

test('恢复②：落盘 → 清空内存 → 按落盘恢复 ⇒ 结果逐条一致；重复恢复幂等（内存优先、只并集）', async (t) => {
  resetArmedSessions()
  const { facility, records, state } = makeFakeFacility()
  const first = makeStore({ facility })
  t.after(() => first.store.stop())
  await first.store.ready

  armGroup('session-A', 'godot')
  armGroup('session-A', 'cua')
  armGroup('session-B', 'cua')
  await until(() => state.writes.length >= 3)
  assert.deepEqual(records.get('session-A'), { groups: ['cua', 'godot'] }, '键 = sessionId，组名排序后写')
  assert.deepEqual(records.get('session-B'), { groups: ['cua'] })
  const before = snapshotArmedSessions()

  // 模拟宿主重启：内存清空（模块作用域那张表）+ 旧 store 关掉；介质留着。
  resetArmedSessions()
  await first.store.stop()
  assert.equal(armedSessionCount(), 0)

  const second = makeStore({ facility })
  t.after(() => second.store.stop())
  await second.store.ready
  assert.deepEqual(snapshotArmedSessions(), before, '恢复结果与重启前逐条一致')

  // 幂等：同一份介质再恢复一次，什么都不新增
  const again = restoreArmedSessions([...records.entries()].map(([key, record]) => [key, record.groups]))
  assert.equal(again.addedGroups, 0, '第二次恢复一个都不新增')
  assert.equal(again.sessions, 2, '但统计照旧如实（介质里有 2 个会话）')

  // 内存优先：内存里已有的放行不被介质抹掉（只并集）
  armGroup('session-C', 'cua')
  restoreArmedSessions([['session-C', ['godot']], ['session-D', ['cua']]])
  assert.deepEqual(snapshotArmedGroups('session-C'), ['cua', 'godot'], '并集，不是覆盖')
  assert.equal(isGroupArmed('session-D', 'cua'), true)
})

// ── 竞态：装配必须等"恢复落定" ───────────────────────────────────────────────

test('竞态①：恢复没落定时装配**不会**先判定；落定后第一步就用上恢复出来的放行', async () => {
  resetArmedSessions()
  let release = () => {}
  const armedReady = new Promise((resolve) => { release = resolve })
  const { handler, logs } = mountHandler({}, { armedReady })

  const assembly = makeAssembly()
  const pending = handler(assembly, contextOf('session-A'), nextOf(assembly))
  const raced = await Promise.race([
    pending.then(() => 'done'),
    new Promise((resolve) => { setTimeout(() => resolve('waiting'), 30) }),
  ])
  assert.equal(raced, 'waiting', '恢复没落定 ⇒ 装配必须先等着（这就是"不留竞态"）')

  // "落盘恢复"这一刻把放行灌进内存（等价于 hydrate 完成），然后兑现 ready
  armGroup('session-A', 'cua')
  release()
  const out = await pending

  assert.equal(out.tools.filter((tool) => tool.name.startsWith('cua_driver_native__')).length, 56,
    '重启后第一步就按恢复出来的放行放行 —— 整段前缀缓存因此得以命中')
  assert.equal(out.tools.some((tool) => tool.name.startsWith('mcp__godot_use__')), false, '未放行的组照旧全摘')
  assert.equal(logs.some((line) => line.fn === 'warn'), false, '正常落定不该有 warn')
})

test('竞态②：恢复在超时内没落定 ⇒ 打一条 warn 后照常装配（绝不把会话卡住）', async () => {
  resetArmedSessions()
  const never = new Promise(() => {})
  const { handler, logs } = mountHandler({}, { armedReady: never, armedRestoreWaitMs: 20 })
  armGroup('session-A', 'cua')

  const assembly = makeAssembly()
  const out = await handler(assembly, contextOf('session-A'), nextOf(assembly))

  assert.equal(out.tools.filter((tool) => tool.name.startsWith('cua_driver_native__')).length, 56,
    '超时后按当前内存里的登记表判定（这里内存里已有，所以照常放行）')
  const warns = logs.filter((line) => line.fn === 'warn')
  assert.equal(warns.length, 1)
  assert.match(warns[0].message, /20ms 内没有落定/)
  assert.match(warns[0].message, /重算一次前缀缓存/, 'warn 要说清代价')

  // 只点名一次（后续每一步不该刷屏）
  const second = makeAssembly()
  await handler(second, contextOf('session-A'), nextOf(second))
  assert.equal(logs.filter((line) => line.fn === 'warn').length, 1)
})

test('竞态③：没给 armedReady（裸处理器）时照旧立即判定 —— 既有测试与无存储形态不受影响', async () => {
  resetArmedSessions()
  const { handler } = mountHandler({})
  armGroup('session-A', 'cua')
  const assembly = makeAssembly()
  const out = await handler(assembly, contextOf('session-A'), nextOf(assembly))
  assert.equal(out.tools.filter((tool) => tool.name.startsWith('cua_driver_native__')).length, 56)
})

// ── 写盘点 ──────────────────────────────────────────────────────────────────

test('写入①：新增放行即整份覆盖写（键 = sessionId、值 = 排序去重的组表）；重复放行不写', async (t) => {
  resetArmedSessions()
  const { facility, state, records } = makeFakeFacility()
  const { store } = makeStore({ facility })
  t.after(() => store.stop())
  await store.ready

  assert.equal(armGroup('session-B', 'godot'), false, '首次放行')
  assert.equal(armGroup('session-B', 'cua'), false, '另一个组也是新增')
  await until(() => state.writes.length >= 2)
  assert.deepEqual(records.get('session-B'), { groups: ['cua', 'godot'] }, '排序后写、无重复项')
  assert.deepEqual(state.writes.map((item) => item.key), ['session-B', 'session-B'], '写的是整个会话的组表')

  const written = state.writes.length
  assert.equal(armGroup('session-B', 'cua'), true, '重复放行：alreadyArmed = true（语义与改动前一致）')
  assert.equal(armGroup('session-B', 'godot'), true)
  await tick()
  assert.equal(state.writes.length, written, '重复放行不触发任何写盘')
  assert.deepEqual(armedGroupsOf('session-B').size, 2)
})

test('写入②：写盘失败只打一条 warn，绝不抛到调用方、绝不改 armGroup 的返回值', async (t) => {
  resetArmedSessions()
  const { facility } = makeFakeFacility({ failWrite: true })
  const { store, logs } = makeStore({ facility })
  t.after(() => store.stop())
  await store.ready

  assert.doesNotThrow(() => armGroup('session-A', 'cua'))
  await until(() => logs.some((line) => line.fn === 'warn'))
  const warns = logs.filter((line) => line.fn === 'warn')
  assert.equal(warns.length, 1)
  assert.match(warns[0].message, /写盘失败/)
  assert.match(warns[0].message, /内存里的放行照常生效/)
  assert.equal(isGroupArmed('session-A', 'cua'), true, '内存态照常')
  assert.equal(armGroup('session-A', 'cua'), true, '返回值语义不变（第二次调用仍是"此前已放行"）')
})

test('写入③：打开期内（ready 之前）的放行会在落定后补写，不靠时序侥幸', async (t) => {
  resetArmedSessions()
  let releaseOpen = () => {}
  const openGate = new Promise((resolve) => { releaseOpen = resolve })
  const { facility, state, records } = makeFakeFacility({ openGate })
  const { store } = makeStore({ facility })
  t.after(() => store.stop())

  assert.equal(store.status, 'opening')
  assert.equal(armGroup('session-A', 'cua'), false, '打开还没落定时模型就点了入口')
  await tick()
  assert.equal(state.writes.length, 0, '域还没开，写不进去')

  releaseOpen()
  await store.ready
  await until(() => state.writes.length === 1)
  assert.deepEqual(records.get('session-A'), { groups: ['cua'] }, '落定后补写，放行不丢')
})

test('写入④：重试 already-open 一次即可开成功（热替换时上一个实例还在异步收尾）', async (t) => {
  resetArmedSessions()
  const { facility, state } = makeFakeFacility({
    onOpen: (attempt) => (attempt === 1
      ? Object.assign(new Error("domain 'tool_layering_armed' is already open"), { code: 'already-open' })
      : null),
  })
  const { store } = makeStore({ facility })
  t.after(() => store.stop())
  await store.ready
  assert.equal(store.status, 'ready')
  assert.equal(state.opens, 2, '第一次 already-open、第二次成功')
})

// ── 降级（必须照旧工作 + 明确告警） ──────────────────────────────────────────

test('降级①：storageDomain 不在场 ⇒ 纯内存 + 一条"本次运行不持久化"的 warn，水线照挂、放行照常', async (t) => {
  resetArmedSessions()
  const ctx = makeMockCtx()
  const { disposers } = attachStorage(ctx, { mode: 'absent' })
  t.after(() => disposers.forEach((dispose) => dispose()))

  assert.doesNotThrow(() => apply(ctx, {}))
  assert.equal(ctx.entries.length, 1, '摘除水线照挂（本地存储不该影响装配）')
  assert.deepEqual(ctx.registered.map((tool) => tool.name), [CUA_ENTRY_TOOL_NAME, GODOT_ENTRY_TOOL_NAME])
  await tick()

  const warns = ctx.logs.filter((line) => line.fn === 'warn')
  assert.equal(warns.length, 1)
  assert.match(warns[0].message, /^\[tool-layering\] /, '新增日志行同样带插件前缀')
  assert.match(warns[0].message, /本次运行不持久化/)
  assert.match(warns[0].message, /storageDomain 服务不在场/)
  assert.match(warns[0].message, /回到"全摘"默认态/, 'warn 要说清后果')

  // 放行照常（纯内存，行为与 v0.3.0 一致）
  const value = await ctx.registered[0].execute({}, { agent: { id: 'session-A' } })
  assert.deepEqual(value, { group: 'cua', armed: true, alreadyArmed: false })
  assert.equal(isGroupArmed('session-A', 'cua'), true)
  // 装配也照常按放行判定
  const assembly = makeAssembly()
  const out = await ctx.entries[0].handler(assembly, contextOf('session-A'), nextOf(assembly))
  assert.equal(out.tools.filter((tool) => tool.name.startsWith('cua_driver_native__')).length, 56)
})

test('降级②：注入回调从不激活（服务始终没来）⇒ 一条 warn，插件照常工作', async (t) => {
  resetArmedSessions()
  const ctx = makeMockCtx()
  const { disposers } = attachStorage(ctx, { mode: 'never' })
  t.after(() => disposers.forEach((dispose) => dispose()))

  assert.doesNotThrow(() => apply(ctx, {}))
  await afterTimer()
  const warns = ctx.logs.filter((line) => line.fn === 'warn')
  assert.equal(warns.length, 1)
  assert.match(warns[0].message, /注入回调始终未激活/)
  assert.match(warns[0].message, /本次运行不持久化/)
})

test('降级③：域打开失败（介质坏 / backend 缺）⇒ 纯内存 + 一条 warn，之后一次盘都不写', async (t) => {
  resetArmedSessions()
  const { facility, state } = makeFakeFacility({
    onOpen: () => Object.assign(new Error('unit 文件不是合法 JSON'), { code: 'malformed-medium' }),
  })
  const { store, logs } = makeStore({ facility })
  t.after(() => store.stop())
  await store.ready

  assert.equal(store.status, 'memory-only')
  const warns = logs.filter((line) => line.fn === 'warn')
  assert.equal(warns.length, 1)
  assert.match(warns[0].message, /打开放行登记表失败/)
  assert.match(warns[0].message, /malformed-medium/)
  assert.match(warns[0].message, /本次运行不持久化/)

  assert.equal(armGroup('session-A', 'cua'), false)
  await tick()
  assert.equal(state.writes.length, 0, '降级后不写盘（也没有表句柄可写）')
  assert.equal(isGroupArmed('session-A', 'cua'), true, '内存态照常')
})

test('降级④：没有 ctx.inject 的 ctx（测试桩 / 极简宿主）⇒ 静默纯内存（不误报"不持久化"）', async () => {
  resetArmedSessions()
  const ctx = makeMockCtx()
  const { logs, log } = makeLogs()
  const store = startArmedStore({ ctx, log, knownGroupNames: KNOWN_GROUPS })
  await store.ready
  assert.equal(store.status, 'memory-only')
  assert.deepEqual(logs, [], '这种 ctx 连"宿主有没有挂存储"都判不了 ⇒ 不打假告警')
  store.stop()
})

// ── 数据文件损坏 ────────────────────────────────────────────────────────────

test('损坏①：介质里某条记录形状不认 ⇒ 当空处理（跳过 + 一条 warn），其余会话照常恢复，不崩', async (t) => {
  resetArmedSessions()
  const { facility } = makeFakeFacility({
    records: [
      ['session-A', { groups: ['cua'] }],
      ['session-B', { groups: 'cua' }],      // groups 不是数组
      ['session-C', null],                   // 整条是 null
      ['session-D', { groups: [] }],          // 空组表（合法但什么也不贡献）
      ['', { groups: ['cua'] }],              // 键是空串
    ],
  })
  const { store, logs } = makeStore({ facility })
  t.after(() => store.stop())
  await store.ready

  assert.equal(store.status, 'ready', '坏记录不该把整张表拖成降级')
  assert.equal(isGroupArmed('session-A', 'cua'), true, '好记录照常恢复')
  assert.equal(isGroupArmed('session-B', 'cua'), false, '坏记录按"没放过"处理（绝不当合法状态用）')
  assert.equal(isGroupArmed('session-C', 'cua'), false)
  assert.equal(armedGroupCount(), 1)
  const warns = logs.filter((line) => line.fn === 'warn')
  assert.equal(warns.length, 1)
  assert.match(warns[0].message, /3 条放行记录的形状不认/)
  assert.match(warns[0].message, /没有放行过任何组/)
})

test('损坏②：normalizeArmedGroups —— 只认 { groups: string[] }，去重排序、坏输入给 null', () => {
  assert.deepEqual(normalizeArmedGroups({ groups: ['godot', 'cua', 'cua', ''] }), ['cua', 'godot'])
  assert.deepEqual(normalizeArmedGroups({ groups: [42, null, {}, 'cua'] }), ['cua'], '非字符串项丢掉')
  assert.deepEqual(normalizeArmedGroups({ groups: [] }), [], '空组表是合法形状')
  for (const bad of [null, undefined, 'cua', 42, true, ['cua'], {}, { groups: 'cua' }, { groups: {} }]) {
    assert.equal(normalizeArmedGroups(bad), null, `形状不认应给 null：${JSON.stringify(bad)}`)
  }
  // restoreArmedSessions 对"完全不可迭代"的介质也不崩
  resetArmedSessions()
  const broken = restoreArmedSessions({ nope: true })
  assert.equal(broken.sessions, 0)
  assert.equal(broken.skipped, 1)
})

test('域声明：真实 armedDomainSpec ⇒ 域 tool_layering_armed v1 / 表 armed；坏记录抛错（交给宿主挪走归档）', async () => {
  const spec = await armedDomainSpec()
  assert.equal(spec.name, ARMED_DOMAIN)
  assert.equal(spec.version, 1)
  assert.deepEqual(Object.keys(spec.tables), [ARMED_TABLE])
  assert.equal(spec.invalidRecords, 'backup-and-skip', '坏记录由宿主挪到备份文件、当"没写过"继续加载')
  const schema = spec.tables[ARMED_TABLE].valueSchema
  assert.deepEqual(schema.parse({ groups: ['godot', 'cua', 'cua'] }), { groups: ['cua', 'godot'] })
  assert.throws(() => schema.parse('nope'), /形状不认/)
  assert.throws(() => schema.parse({ groups: 'cua' }), /形状不认/)
  // 域/表名必须匹配宿主的 UNIT_NAME_RE（不收连字符，写错会在打开域那一步抛错）
  for (const unitName of [ARMED_DOMAIN, ARMED_TABLE]) {
    assert.match(unitName, /^[a-z][a-z0-9_]*$/)
  }
  assert.ok(ARMED_RESTORE_WAIT_MS > 0)
})

// ── 陌生组名：保留但忽略 ────────────────────────────────────────────────────

test('陌生组名①：介质里有当前配置不存在的组名 ⇒ 保留但忽略 + 点名一次（不判非法、不崩）', async (t) => {
  resetArmedSessions()
  const { facility } = makeFakeFacility({
    records: [['session-A', { groups: ['cua', 'cua_旧名'] }], ['session-B', { groups: ['已删掉的组'] }]],
  })
  const { store, logs } = makeStore({ facility })
  t.after(() => store.stop())
  await store.ready

  assert.equal(store.status, 'ready', '陌生组名不构成错误（组的 name 是配置面可改的）')
  assert.equal(isGroupArmed('session-A', 'cua_旧名'), true, '保留（介质原样并进内存）')
  assert.equal(isGroupArmed('session-B', '已删掉的组'), true)
  assert.deepEqual(store.unknownGroups, ['cua_旧名', '已删掉的组'])
  const warns = logs.filter((line) => line.fn === 'warn')
  assert.equal(warns.length, 1, '只点名一次')
  assert.match(warns[0].message, /2 个当前配置里不存在的组名/)
  assert.match(warns[0].message, /cua_旧名/)
  assert.match(warns[0].message, /已保留但忽略/)
})

test('陌生组名②：端到端 —— 陌生组名不影响装配（判定只看当前配置里的组名），也不触发写盘', async (t) => {
  resetArmedSessions()
  const { facility, state } = makeFakeFacility({
    records: [['session-A', { groups: ['cua', 'cua_旧名'] }]],
  })
  const ctx = makeMockCtx()
  const { disposers } = attachStorage(ctx, { facility })
  t.after(() => disposers.forEach((dispose) => dispose()))
  apply(ctx, {})

  const assembly = makeAssembly()
  const out = await ctx.entries[0].handler(assembly, contextOf('session-A'), nextOf(assembly))
  assert.notEqual(out, assembly, 'godot 仍被摘 ⇒ 有改动')
  assert.equal(out.tools.filter((tool) => tool.name.startsWith('cua_driver_native__')).length, 56, 'cua 放行生效')
  assert.equal(out.tools.filter((tool) => tool.name.startsWith('mcp__godot_use__')).length, 0)
  assert.equal(state.writes.length, 0, '恢复不是新放行 ⇒ 不写盘')
})

// ── 真实介质：临时目录 + 真实的域层与 JSON 后端 ──────────────────────────────
// 上面那些用例用假域句柄（快、可控），这一组走**真链路**：`defineDomain`（真的模块加载期校验）
// + `DomainFacility.open`（真的逐条记录 schema 校验）+ json 后端（真的 tmp+rename 原子写）。
// 它挡的是本版最大的一个实现风险：**手工写的 `{ parse }` schema 能不能被真域层接受**。
// ⚠ 介质根目录是 `os.tmpdir()` 下的临时目录，**不碰**宿主服务、`~\.dsh\storages\` 一个字节都不动。

/** 在一处临时目录上搭一个真实的 storageDomain（`DomainFacility` + `JsonStorageBackend`）。 */
async function makeRealFacility(root) {
  const [domainModule, jsonModule] = await Promise.all([
    import('@deepseek-ai/dsh-storage-domain'),
    import('@deepseek-ai/dsh-storage-json'),
  ])
  const backend = new jsonModule.JsonStorageBackend(root)
  const facilityCtx = {
    storage: { backend: { get: (name) => (name === 'json' ? backend : undefined) } },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    emit() {},
  }
  return { facility: new domainModule.DomainFacility(facilityCtx, { backend: 'json', routes: {} }), backend }
}

test('真实介质①：落盘 → 关域 → 重新打开 ⇒ 整条链路走通（含原子写出来的可读 JSON）', async (t) => {
  resetArmedSessions()
  const root = mkdtempSync(join(tmpdir(), 'tl-armed-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))

  const { facility, backend } = await makeRealFacility(root)
  t.after(() => backend.close())
  // ⚠ 这里用**真实的**域声明构建器（`armedDomainSpec`），不是假 spec
  const first = makeStore({ facility, buildSpec: armedDomainSpec })
  t.after(() => first.store.stop())
  await first.store.ready
  assert.equal(first.store.status, 'ready', `真实域层应当接受本插件的域声明：${first.store.reason}`)

  armGroup('session-A', 'cua')
  armGroup('session-A', 'godot')
  armGroup('session-B', 'cua')
  const file = join(root, `${ARMED_DOMAIN}.json`)
  await until(() => {
    try { return readFileSync(file, 'utf8').includes('session-B') } catch { return false }
  })
  const document = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(document.unit.name, ARMED_DOMAIN)
  assert.equal(document.unit.version, 1)
  assert.deepEqual(document.tables[ARMED_TABLE]['session-A'], { groups: ['cua', 'godot'] },
    '落盘形态：键 = sessionId、值 = 排序后的组名数组（人可读、顺序稳定）')
  assert.deepEqual(document.tables[ARMED_TABLE]['session-B'], { groups: ['cua'] })

  // 重启：清内存 + 关域（释放域名）→ 同一处介质重新打开
  resetArmedSessions()
  await first.store.stop()
  const second = await makeRealFacility(root)
  t.after(() => second.backend.close())
  const reopened = makeStore({ facility: second.facility, buildSpec: armedDomainSpec })
  t.after(() => reopened.store.stop())
  await reopened.store.ready

  assert.equal(reopened.store.status, 'ready')
  assert.deepEqual(snapshotArmedSessions(), [['session-A', ['cua', 'godot']], ['session-B', ['cua']]],
    '重启后按介质恢复，逐条一致')
})

test('真实介质②：介质坏（不是 JSON / 记录形状不认）⇒ 纯内存 + 一条 warn 点名 code，不崩', async (t) => {
  resetArmedSessions()
  const root = mkdtempSync(join(tmpdir(), 'tl-armed-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const file = join(root, `${ARMED_DOMAIN}.json`)

  // ① 整份不是合法 JSON ⇒ code=malformed-medium
  writeFileSync(file, '{ 这不是 JSON', 'utf8')
  const broken = await makeRealFacility(root)
  t.after(() => broken.backend.close())
  const first = makeStore({ facility: broken.facility, buildSpec: armedDomainSpec })
  t.after(() => first.store.stop())
  await first.store.ready
  assert.equal(first.store.status, 'memory-only')
  const firstWarns = first.logs.filter((line) => line.fn === 'warn')
  assert.equal(firstWarns.length, 1)
  assert.match(firstWarns[0].message, /malformed-medium/)
  assert.match(firstWarns[0].message, /本次运行不持久化/)

  // ② 合法 JSON、但某条记录形状不认 ⇒ 打开失败（默认 single 布局没有 backupRecord）⇒ 同样降级，
  //    且**绝不**把坏记录当合法状态用（登记表保持空）
  writeFileSync(file, JSON.stringify({
    unit: { name: ARMED_DOMAIN, version: 1 },
    global: null,
    tables: { [ARMED_TABLE]: { 'session-A': { groups: ['cua'] }, 'session-B': { groups: 'cua' } } },
  }, null, 2), 'utf8')
  const second = await makeRealFacility(root)
  t.after(() => second.backend.close())
  const reopened = makeStore({ facility: second.facility, buildSpec: armedDomainSpec })
  t.after(() => reopened.store.stop())
  await reopened.store.ready
  assert.equal(reopened.store.status, 'memory-only')
  assert.match(reopened.logs.find((line) => line.fn === 'warn').message, /invalid-record/)
  assert.equal(armedSessionCount(), 0, '坏介质里一条都不能当合法状态用')
  assert.equal(isGroupArmed('session-A', 'cua'), false)
})

// ── 端到端：apply 接上存储 ──────────────────────────────────────────────────

test('端到端：apply 接上真实形状的存储 ⇒ 恢复出来的放行在第一次装配就生效，新放行立刻写穿介质', async (t) => {
  resetArmedSessions()
  const { facility, records, state } = makeFakeFacility({
    records: [['session-A', { groups: ['cua'] }]],
  })
  const ctx = makeMockCtx()
  const { disposers } = attachStorage(ctx, { facility })
  t.after(() => disposers.forEach((dispose) => dispose()))
  apply(ctx, {})

  // 打开域是异步的（apply 不当场等）⇒ 先等它落定，再断言"第一次装配"这条路径。
  assert.equal(state.specs.length, 0, 'apply 不当场等存储落定（装配侧自己 await ready）')
  await until(() => state.specs.length === 1, 500)
  assert.equal(state.specs[0].name, ARMED_DOMAIN, '打开域用的就是本插件的域声明')

  const restoreInfo = await until(() => ctx.logs.find((line) => line.message.includes('放行登记表已就绪')), 500)
  assert.ok(restoreInfo, '恢复单独占一行（原来那行 diag: 保持原样）')
  assert.equal(restoreInfo.fn, 'info')
  assert.match(restoreInfo.message, /^\[tool-layering\] /)

  // 第一次装配：恢复出来的 cua 放行立刻生效（这就是"整段前缀缓存不再被击穿"的机制）
  const assembly = makeAssembly()
  const out = await ctx.entries[0].handler(assembly, contextOf('session-A'), nextOf(assembly))
  assert.equal(out.tools.filter((tool) => tool.name.startsWith('cua_driver_native__')).length, 56)
  assert.equal(out.tools.filter((tool) => tool.name.startsWith('mcp__godot_use__')).length, 0)

  // 步中点开 godot ⇒ 立刻写穿介质（下次重启也记得）
  const value = await ctx.registered[1].execute({}, { agent: { id: 'session-A' } })
  assert.deepEqual(value, { group: 'godot', armed: true, alreadyArmed: false })
  await until(() => records.get('session-A').groups.length === 2)
  assert.deepEqual(records.get('session-A'), { groups: ['cua', 'godot'] })

  // 卸载（热替换/停用）⇒ 关域、注销写侧；数据留在介质里
  disposers.forEach((dispose) => dispose())
  await until(() => state.closes === 1, 500)
  const count = state.writes.length
  armGroup('session-Z', 'cua')
  await tick()
  assert.equal(state.writes.length, count, '卸载后不再写盘（写侧已注销）')
  assert.ok(NON_LAYERED_NAMES.length > 0)
})

/**
 * 插件入口与水线处理器的契约测试。
 *
 * 这里**不启动 dsh**：只用一个假 ctx 记下水线注册参数，再用假 `next()` 驱动处理器，
 * 技能探针一律注入假实现（默认"技能都存在"），验证"返回值权威""逐组计数""原样放过"
 * "幂等""逐组 fail-loud""技能校验 + 缓存""diag""按 `(会话, 组)` 放行"这些行为。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'

import { apply, createAssembleHandler, formatGroupCount, inject, name } from '../lib/index.js'
import { resolveConfig } from '../lib/config.js'
import { armGroup, armedGroupCount, isGroupArmed, resetArmedSessions } from '../lib/entry.js'
import {
  CUA_ENTRY_TOOL_NAME,
  GODOT_ENTRY_TOOL_NAME,
  NON_LAYERED_NAMES,
  makeAssembly,
  makeMockCtx,
  makeProbe,
  makeTool,
} from './fixtures.mjs'

/** 非组内工具（内置 + 其它 MCP + 本插件两个入口工具）的个数。 */
const NON_LAYERED_COUNT = NON_LAYERED_NAMES.length

/** 造一个假 `next()`：每次调用都把同一个装配体交回去（水线契约：返回值权威）。 */
function nextOf(assembly) {
  return async () => assembly
}

/** 组装 { handler, logs, probe }：走真实的 resolveConfig，只替换日志出口与技能探针。 */
function mount(configInput, probeOptions) {
  const logs = []
  const log = (fn, message) => logs.push({ fn, message })
  const resolved = resolveConfig(configInput)
  assert.equal(resolved.ok, true, `mount() 只接受合法配置：${resolved.reason}`)
  const { probe, stats } = makeProbe(probeOptions)
  return { handler: createAssembleHandler({ config: resolved.config, log, skillProbe: probe }), logs, probe, stats }
}

/** 只含 CUA 一组的配置（回归测试用，日志更干净）。 */
const CUA_ONLY = { groups: [{ name: 'cua', prefix: 'cua_driver_native__', skill: 'computer-control' }] }

/** 造一个"带 scope 的装配 context"（水线契约：`context.scope` 就是 agent）。 */
function contextOf(sessionId) {
  return { agent: { id: sessionId }, scope: { id: sessionId } }
}

test('formatGroupCount：日志契约的唯一定义处（被放行的组带 ", armed"）', () => {
  assert.equal(formatGroupCount({ name: 'cua', present: 56, removed: 56 }), 'present=56 removed=56 (cua)')
  assert.equal(formatGroupCount({ name: 'godot', present: 0, removed: 0 }), 'present=0 removed=0 (godot)')
  // v0.3.0：计数全零时能一眼看出"是因为被放行了"
  assert.equal(formatGroupCount({ name: 'cua', present: 0, removed: 0, armed: true }), 'present=0 removed=0 (cua, armed)')
  assert.equal(formatGroupCount({ name: 'cua', present: 0, removed: 0, armed: false }), 'present=0 removed=0 (cua)')
})

test('apply：挂 system-prompt/assemble 水线，注册参数必须是 { global: true, prepend: true }', () => {
  const ctx = makeMockCtx()
  apply(ctx, {})

  assert.equal(name, 'tool-layering', '插件名与 patch 行 id 一致')
  assert.equal(ctx.entries.length, 1)
  const [entry] = ctx.entries
  assert.equal(entry.event, 'system-prompt/assemble')
  assert.deepEqual(entry.options, { global: true, prepend: true }, '省掉 global 会导致子代理装配体不被筛选')
  assert.equal(typeof entry.handler, 'function')

  const info = ctx.logs.filter((l) => l.fn === 'info')
  assert.equal(info.length, 1)
  const [line] = info
  assert.match(line.message, /已挂载 system-prompt\/assemble 水线/)
  assert.match(line.message, /不做任何工作区检测/, '措辞要点明"不读工作区"（运行时唯一的输入是会话放行了哪些组）')
  assert.match(line.message, /cua_driver_native__/, '挂载日志要点名每一组的前缀')
  assert.match(line.message, /mcp__godot_use__/)
  assert.match(line.message, /技能 computer-control/, '挂载日志要点名每组配的说明技能')
  assert.match(line.message, /技能 godot-use/)
  assert.match(line.message, /不构成能力边界/, '挂载日志应提示能力语义，避免被误当安全边界')
  assert.match(line.message, /cua → get_cua/, '挂载日志要点名"每组一个入口工具"的对应关系')
  assert.match(line.message, /godot → get_godot/)
  assert.match(line.message, /只放回那一组/, '要说清入口是**按组**的（v0.3.0 的核心口径）')
  assert.match(line.message, /v0\.3\.0/, '挂载日志应带版本号')
  assert.equal(ctx.logs.some((l) => l.fn === 'warn'), false)
})

test('apply：注册常驻入口工具（**每组一个**），且 inject 必须含 tools', () => {
  resetArmedSessions()
  const ctx = makeMockCtx()
  apply(ctx, {})

  assert.deepEqual(inject, ['tools'],
    '入口工具要真进注册表；用 ctx.get("tools") 半注册会出现"工具被摘、入口却没有"的死角')
  assert.deepEqual(ctx.registered.map((tool) => tool.name), [CUA_ENTRY_TOOL_NAME, GODOT_ENTRY_TOOL_NAME],
    '注册顺序 = config.groups 顺序')
  for (const tool of ctx.registered) {
    assert.equal(typeof tool.execute, 'function')
    assert.equal(typeof tool.output.render, 'function')
    assert.deepEqual(tool.parameters, { type: 'object', properties: {} }, '入口工具无参数')
    assert.equal(tool.output.schema.additionalProperties, false, 'canonical value 的形状锁死')
    // 工具描述只说"能拿到什么"：一句话、英文、≤120 字符（每步都要付的常驻 token）
    assert.ok(tool.description.length <= 120, `${tool.name} 描述过长：${tool.description.length}`)
    assert.equal(/[\u4e00-\u9fff]/.test(tool.description), false, `${tool.name} 描述应为英文`)
    for (const banned of ['幂等', '下一步', '会话级', '能力边界']) {
      assert.equal(tool.description.includes(banned), false, `${tool.name} 描述里不该有机制解释："${banned}"`)
    }
  }
  assert.match(ctx.registered[0].description, /cua_driver_native__/, 'cua 那句点名自己的前缀')
  assert.match(ctx.registered[1].description, /mcp__godot_use__/, 'godot 那句点名自己的前缀')

  // 入口工具本身不在任何组前缀下 ⇒ 处理器永远不会摘它
  const assembly = makeAssembly()
  assert.ok(assembly.tools.some((t) => t.name === CUA_ENTRY_TOOL_NAME), '夹具里就该有它')
  assert.ok(assembly.tools.some((t) => t.name === GODOT_ENTRY_TOOL_NAME))
})

test('apply：组内 entryName 可覆盖（工具名与挂载日志同时跟着变）', () => {
  const ctx = makeMockCtx()
  apply(ctx, { groups: [{ prefix: 'cua_driver_native__', entryName: 'unlock_cua' }, { prefix: 'mcp__godot_use__' }] })
  assert.deepEqual(ctx.registered.map((tool) => tool.name), ['unlock_cua', 'get_godot'])
  const mount = ctx.logs.find((l) => l.fn === 'info' && l.message.includes('已挂载')).message
  assert.match(mount, /unlock_cua/)
  assert.match(mount, /get_godot/, '没覆盖的那组仍用缺省名')
})

test('apply：组内 entryName 非法 ⇒ 打 error、不挂水线，且**不注册任何入口工具**', () => {
  // 与 v0.2.0 的差别：那时会退回默认名注册一个入口；v0.3.0 按组注册 ⇒ 没有合法组表就一个都不注册。
  // 这不是死角：配置非法 ⇒ 一个工具都不会摘 ⇒ 也就不需要"放回"入口。
  const ctx = makeMockCtx()
  assert.doesNotThrow(() => apply(ctx, { groups: [{ prefix: 'cua_driver_native__', entryName: 'run_code' }] }))
  assert.equal(ctx.entries.length, 0, '配置非法 ⇒ 不注册水线')
  assert.equal(ctx.registered.length, 0, '配置非法 ⇒ 不注册任何入口工具')
  const errors = ctx.logs.filter((l) => l.fn === 'error')
  assert.equal(errors.length, 1)
  assert.match(errors[0].message, /entryName|保留名/)
  assert.match(errors[0].message, /没有"摘了却没有入口"的死角/, 'error 要说清为什么"不注册入口"是安全的')
})

test('apply：非法配置 ⇒ 打 error、不挂水线、**不抛错**（宿主启动路径不能被配置错误打断）', () => {
  const ctx = makeMockCtx()
  // 旧行为是 throw TypeError ⇒ 冷启动时 dsh-app-boot 的 root.update() 抛 ⇒ 宿主非零退出；
  // 热加载在旧版 loader（≤1.0.3）下还会整层 patch 回滚（连带同文件其它 insert 行）——
  // 0.1.7-rc.1 起 loader 1.0.5 取消事务回滚，该顾虑消失，但"绝不抛"仍锁死（冷启动退出）。
  assert.doesNotThrow(() => apply(ctx, { groups: 'cua' }))
  assert.equal(ctx.entries.length, 0, '配置非法时不该挂水线（插件完全不生效）')
  assert.equal(ctx.registered.length, 0, '也不注册入口工具')

  const errors = ctx.logs.filter((l) => l.fn === 'error')
  assert.equal(errors.length, 1, '应恰好打一条 error')
  assert.match(errors[0].message, /配置非法/, 'error 要点明"配置非法"')
  assert.match(errors[0].message, /groups/, 'error 要点名具体哪个字段非法')
  assert.match(errors[0].message, /不生效|未注册/, 'error 要说清后果（插件不生效）')
  assert.match(errors[0].message, /保存即再次热加载重试/, 'error 要说明 live 下改完保存即重试')
  assert.match(errors[0].message, /重启 dsh/, 'error 要给出下一步动作（模块代码要重启才重载）')
  assert.equal(
    ctx.logs.some((l) => l.fn === 'info' && l.message.includes('已挂载')),
    false,
    '不该同时出现"已挂载"',
  )
})

test('apply：各种非法配置都不会抛错，且都不挂水线、不注册入口工具', () => {
  const bad = [
    { diag: 'yes' },
    { diag: 1 },
    { groups: 'cua' },
    { groups: 42 },
    { groups: {} },
    { groups: [{}] },
    { groups: [{ prefix: 42 }] },
    { groups: [{ prefix: '' }] },
    // v0.3.0 新增的四条：形态 / 保留名 / 撞前缀 / 重名
    { groups: [{ prefix: 'x__', entryName: 'bad name' }] },
    { groups: [{ prefix: 'x__', entryName: 'run_code' }] },
    { groups: [{ prefix: 'x__', entryName: 'x__entry' }] },
    { groups: [{ prefix: 'x__' }, { prefix: 'x__' }] },
    [],
    'x',
    42,
    true,
  ]
  for (const config of bad) {
    const ctx = makeMockCtx()
    assert.doesNotThrow(() => apply(ctx, config), `不该抛：${JSON.stringify(config)}`)
    assert.equal(ctx.entries.length, 0, `不该挂水线：${JSON.stringify(config)}`)
    assert.equal(ctx.registered.length, 0, `不该注册入口工具：${JSON.stringify(config)}`)
    assert.equal(ctx.logs.filter((l) => l.fn === 'error').length, 1, `应打一条 error：${JSON.stringify(config)}`)
  }
})

test('apply：groups 为空数组（合法）⇒ 不挂水线、不打 error/warn、不注册入口，只留一条 info 说明当前 no-op', () => {
  const ctx = makeMockCtx()
  assert.doesNotThrow(() => apply(ctx, { groups: [] }))
  assert.equal(ctx.entries.length, 0, '没东西可摘就不注册水线（连每步一次的空调用都省掉）')
  assert.equal(ctx.registered.length, 0, '没有组就没有"放回"这回事 ⇒ 一个入口工具都不注册')
  assert.equal(ctx.logs.some((l) => l.fn === 'error'), false)
  assert.equal(ctx.logs.some((l) => l.fn === 'warn'), false)
  const info = ctx.logs.filter((l) => l.fn === 'info')
  assert.equal(info.length, 1)
  assert.match(info[0].message, /groups 为空数组/)
  assert.match(info[0].message, /no-op/)
  assert.match(info[0].message, /合法配置/, '要说清"这不是配置错误"')
  assert.match(info[0].message, /不注册任何入口工具/)
})

test('apply：tools 服务不可用 ⇒ 一条 error，但摘除路径照挂（水线不受影响）', () => {
  const ctx = makeMockCtx()
  delete ctx.tools
  assert.doesNotThrow(() => apply(ctx, {}))
  assert.equal(ctx.entries.length, 1, 'tools 不可用只影响入口工具，不影响摘除')
  assert.equal(ctx.registered.length, 0)
  const errors = ctx.logs.filter((l) => l.fn === 'error')
  assert.equal(errors.length, 1)
  assert.match(errors[0].message, /tools 服务不可用/)
  assert.match(errors[0].message, /get_cua/)
  assert.match(errors[0].message, /get_godot/)
  assert.match(ctx.logs.find((l) => l.fn === 'info' && l.message.includes('已挂载')).message, /只注册成功 0\/2/)
})

test('apply：某个入口工具注册失败 ⇒ 只降级那一组，其它组与水线不受影响', () => {
  const ctx = makeMockCtx()
  const original = ctx.tools.register
  ctx.tools.register = (definition) => {
    if (definition.name === CUA_ENTRY_TOOL_NAME) throw new Error('已存在同名工具')
    return original(definition)
  }
  assert.doesNotThrow(() => apply(ctx, {}))

  assert.equal(ctx.entries.length, 1, '入口注册失败不该影响水线')
  assert.deepEqual(ctx.registered.map((tool) => tool.name), [GODOT_ENTRY_TOOL_NAME], 'godot 那组照常注册')
  const errors = ctx.logs.filter((l) => l.fn === 'error')
  assert.equal(errors.length, 1)
  assert.match(errors[0].message, /get_cua 注册失败/)
  assert.match(errors[0].message, /cua 组/, '要点名是哪一组的入口')
  assert.match(errors[0].message, /已存在同名工具/, '要带上底层原因')
  assert.match(ctx.logs.find((l) => l.fn === 'info' && l.message.includes('已挂载')).message, /只注册成功 1\/2/)
})

test('apply：顶层未知键 ⇒ 不判非法，挂水线 + 一条 warn 点名', () => {
  const ctx = makeMockCtx()
  assert.doesNotThrow(() => apply(ctx, { diag: true, allowlist: [], requiredMarker: '__x__' }))
  assert.equal(ctx.entries.length, 1, '未知键不构成非法配置 ⇒ 照常挂水线')
  assert.deepEqual(ctx.registered.map((tool) => tool.name), [CUA_ENTRY_TOOL_NAME, GODOT_ENTRY_TOOL_NAME])
  assert.equal(ctx.logs.some((l) => l.fn === 'error'), false, '不该报 error')

  const warns = ctx.logs.filter((l) => l.fn === 'warn')
  assert.equal(warns.length, 1)
  assert.match(warns[0].message, /不认得的顶层键/)
  assert.match(warns[0].message, /"allowlist"/, 'warn 要点名具体是哪些键')
  assert.match(warns[0].message, /"requiredMarker"/)
  assert.match(warns[0].message, /组内/, 'warn 要提示入口名现在是组内键')
  assert.ok(ctx.logs.some((l) => l.fn === 'info' && l.message.includes('diag 已开启')))
})

test('apply：v0.2.0 的顶层 entryName（旧配置）只 warn、不判非法，组内缺省照常推导', () => {
  // 升级路上一定会有"旧配置 + 新代码"的中间态：容忍它（照常全摘、入口用缺省名），
  // 拒绝它则会让工具全部重新可见 —— 与目标相反。
  const ctx = makeMockCtx()
  assert.doesNotThrow(() => apply(ctx, { diag: false, entryName: 'unlock_all' }))
  assert.equal(ctx.entries.length, 1, '旧键不构成非法配置')
  assert.deepEqual(ctx.registered.map((tool) => tool.name), [CUA_ENTRY_TOOL_NAME, GODOT_ENTRY_TOOL_NAME],
    '旧值不影响组内缺省名（各组仍叫 get_cua / get_godot）')
  const warns = ctx.logs.filter((l) => l.fn === 'warn')
  assert.equal(warns.length, 1)
  assert.match(warns[0].message, /不认得的顶层键/)
  assert.match(warns[0].message, /"entryName"/)
})

test('apply：组内未知键 ⇒ 一条 warn，点名"第几组 + 组名 + 键名"', () => {
  const ctx = makeMockCtx()
  // 注意：这里给组配了 skill，否则会额外多出一条"没配说明技能"的挂载期 warn，干扰本用例
  apply(ctx, { groups: [{ prefix: 'a__', name: 'A', keep: true, skill: 'x' }] })
  const warns = ctx.logs.filter((l) => l.fn === 'warn')
  assert.equal(warns.length, 1)
  assert.match(warns[0].message, /groups 里出现本插件不认得的键/)
  assert.match(warns[0].message, /groups\[0\]/)
  assert.match(warns[0].message, /A/)
  assert.match(warns[0].message, /"keep"/)
  assert.match(warns[0].message, /entryName/, 'warn 要列出组内真正认得的键')
  assert.equal(ctx.entries.length, 1)
})

test('apply：多个组写同一个 prefix ⇒ 一条 warn 说明"后面那组永远 present=0"', () => {
  const ctx = makeMockCtx()
  apply(ctx, {
    groups: [
      { prefix: 'x__', name: 'a', skill: 'x' },          // 缺省入口名 get_a
      { prefix: 'x__', name: 'b', skill: 'y' },          // 缺省入口名 get_b（与 get_a 不撞）
    ],
  })
  assert.equal(ctx.entries.length, 1, '重复 prefix 不判非法（入口名不撞车时）')
  const warns = ctx.logs.filter((l) => l.fn === 'warn')
  assert.equal(warns.length, 1)
  assert.match(warns[0].message, /同一个 prefix/)
  assert.match(warns[0].message, /"x__"/)
  assert.match(warns[0].message, /present=0/)
  assert.match(warns[0].message, /entryName/, 'warn 要顺带点明"同前缀两组必须写不同 entryName"')
})

test('apply：某组没配 skill ⇒ 挂载时就 warn 一次点名该组', () => {
  const ctx = makeMockCtx()
  apply(ctx, { groups: [{ name: 'cua', prefix: 'cua_driver_native__' }, { prefix: 'b__', skill: 'x' }] })
  const warns = ctx.logs.filter((l) => l.fn === 'warn')
  assert.equal(warns.length, 1, '配了 skill 的那组不该被点名')
  assert.match(warns[0].message, /cua 组没有配置说明技能/)
  assert.match(warns[0].message, /没有任何说明书/)
  assert.match(ctx.logs.find((l) => l.fn === 'info').message, /cua\(cua_driver_native__ → ⚠未配技能\)/)
})

test('处理器：两组全摘 ⇒ 逐组计数、非组内工具引用不变、每组各一条 info', async () => {
  resetArmedSessions()
  const assembly = makeAssembly()
  const { handler, logs } = mount({})
  const out = await handler(assembly, {}, nextOf(assembly))

  assert.notEqual(out, assembly, '有删除时应返回新 assembly')
  assert.equal(out.tools.length, NON_LAYERED_COUNT)
  assert.deepEqual(out.tools.map((t) => t.name), NON_LAYERED_NAMES, '其余工具顺序不变')
  for (const item of out.tools) {
    assert.ok(assembly.tools.includes(item), `工具对象引用被重建：${item.name}`)
  }
  assert.equal(out.sections, assembly.sections)
  assert.equal(out.contexts, assembly.contexts)
  assert.equal(out.variables, assembly.variables)

  const info = logs.filter((l) => l.fn === 'info')
  assert.equal(info.length, 2, '两组各一条"首次装配已生效"')
  assert.ok(info[0].message.includes('present=56 removed=56 (cua)'), info[0].message)
  assert.match(info[0].message, /技能 computer-control/)
  assert.match(info[0].message, /完整名\*\* cua_driver_native__<原始名>/)
  assert.ok(info[1].message.includes('present=39 removed=39 (godot)'), info[1].message)
  assert.match(info[1].message, /技能 godot-use/)
  assert.equal(logs.some((l) => l.fn === 'warn'), false, '正常生效不该有 warn')
})

test('处理器：只有一组在场 ⇒ 那组一条 info，另一组完全静默（不打"已生效"也不打 warn）', async () => {
  resetArmedSessions()
  const assembly = makeAssembly({ includeCua: false })
  const { handler, logs } = mount({})
  const out = await handler(assembly, {}, nextOf(assembly))

  assert.equal(out.tools.length, NON_LAYERED_COUNT, 'godot 那 39 个被摘掉，只剩内置那批')
  assert.equal(logs.length, 1, '只该有 godot 组那一条 info')
  assert.equal(logs[0].fn, 'info')
  assert.match(logs[0].message, /godot 组/)
})

test('处理器：与 cwd / 工作区无关；**未放行**的任何会话（含无 scope 的装配）一律全摘', async () => {
  resetArmedSessions()
  const { handler } = mount({})
  const contexts = [
    {},
    undefined,
    { agent: { session: { header: { cwd: 'C:\\Users\\tester\\Desktop\\code\\working' } } } },
    { agent: { session: { header: { cwd: 'C:\\Users\\tester\\Desktop\\code\\godot-game-demo' } } } },
    { agent: null, scope: null },
    // v0.2.0 起水线 context 带 `scope`（= agent）——没被放行的会话照样全摘
    { scope: { id: 'session-not-armed' } },
    { agent: { id: 'session-not-armed' }, scope: { id: 'session-not-armed' } },
  ]
  for (const context of contexts) {
    const assembly = makeAssembly()
    const out = await handler(assembly, context, nextOf(assembly))
    assert.equal(out.tools.some((t) => t.name.startsWith('cua_driver_native__')), false,
      `未放行的上下文必须全摘：${JSON.stringify(context)}`)
    assert.equal(out.tools.some((t) => t.name.startsWith('mcp__godot_use__')), false)
    assert.ok(out.tools.some((t) => t.name === CUA_ENTRY_TOOL_NAME), '入口工具任何时候都不该被摘')
    assert.ok(out.tools.some((t) => t.name === GODOT_ENTRY_TOOL_NAME))
  }
})

test('处理器：两组都不在场 ⇒ 静默 no-op（一条日志都不打、形状不变）', async () => {
  resetArmedSessions()
  const assembly = makeAssembly({ includeCua: false, includeGodot: false })
  const { handler, logs } = mount({})
  const out = await handler(assembly, {}, nextOf(assembly))

  assert.equal(out, assembly)
  assert.equal(out.tools, assembly.tools)
  assert.deepEqual(logs, [], '无相应工具时一条日志都不该打')
})

test('处理器：工具在场却零命中 ⇒ **逐组**打 warn（fail-loud），每组只打一次', async () => {
  resetArmedSessions()
  // 模拟"上游把 serverName / 前缀改掉"：工具在场，但一条都不匹配各组的 prefix
  const assembly = {
    tools: [
      makeTool('mcp__cua_pre__click'),
      makeTool('mcp__godot__run_project'),
      makeTool('mcp__godot-use__validate'),
      makeTool('read'),
    ],
  }
  const { handler, logs } = mount({})
  const out = await handler(assembly, {}, nextOf(assembly))

  assert.equal(out, assembly, '零命中时不该改装配体')
  const warns = logs.filter((l) => l.fn === 'warn')
  assert.equal(warns.length, 2, '两组各一条')
  assert.ok(warns[0].message.includes('1 个名字含 "cua" 的工具'), warns[0].message)
  assert.ok(warns[0].message.includes('cua_driver_native__'), '应回显期望的前缀')
  assert.ok(warns[1].message.includes('2 个名字含 "godot" 的工具'), warns[1].message)
  assert.ok(warns[1].message.includes('mcp__godot_use__'))
  assert.ok(warns[0].message.includes('serverName'), '应提示 serverName 改名这一最常见原因')
  assert.ok(logs.every((l) => l.fn !== 'info' || !l.message.includes('已生效')), 'fail-loud 时不该同时报"已生效"')

  // 后续轮次不重复刷屏
  await handler(assembly, {}, nextOf(assembly))
  assert.equal(logs.filter((l) => l.fn === 'warn').length, 2, 'fail-loud 每组只报一次')
})

test('处理器：形状异常 ⇒ 原样放过，且连记账都不做', async () => {
  resetArmedSessions()
  const { handler, logs } = mount({})
  for (const bad of [null, 42, 'x', {}, { tools: null }, { tools: 'read' }, { tools: {} }]) {
    const out = await handler(bad, {}, nextOf(bad))
    assert.equal(out, bad)
  }
  assert.deepEqual(logs, [])
})

test('处理器：幂等 —— 同一输入连调两次，第二次原样返回同一个引用', async () => {
  resetArmedSessions()
  const assembly = makeAssembly()
  const { handler, logs } = mount({})
  const first = await handler(assembly, {}, nextOf(assembly))
  const second = await handler(first, {}, nextOf(first))

  assert.equal(second, first, '第二次必须原样返回同一个引用')
  assert.deepEqual(second.tools, first.tools)
  assert.equal(logs.length, 2, '第二次不该再多出任何日志（含 diag 之外的 info/warn）')

  // 从原始输入再跑一次（另一个处理器实例）也必须逐名一致
  const { handler: handler2 } = mount({})
  const third = await handler2(assembly, {}, nextOf(assembly))
  assert.deepEqual(third.tools.map((t) => t.name), first.tools.map((t) => t.name))
})

test('处理器：技能缺失 ⇒ warn 点名缺失路径，且每个技能只打一次 + 判定结果缓存', async () => {
  resetArmedSessions()
  let statCount = 0
  const { handler, logs } = mount({}, { roots: ['C:\\skills'], existsSync: () => { statCount++; return false } })
  const assembly = makeAssembly()

  await handler(assembly, {}, nextOf(assembly))
  assert.equal(statCount, 2, '两个技能各 stat 一次')

  const warns = logs.filter((l) => l.fn === 'warn')
  assert.equal(warns.length, 2)
  assert.match(warns[0].message, /cua 组摘掉了 56 个工具，但它的说明技能不存在/)
  assert.ok(warns[0].message.includes('C:\\skills\\computer-control\\SKILL.md'), warns[0].message)
  assert.match(warns[0].message, /模型手上没有说明书/)
  assert.ok(warns[1].message.includes('C:\\skills\\godot-use\\SKILL.md'), warns[1].message)

  // 第二轮：不再刷 warn，也不再 stat 磁盘
  await handler(makeAssembly(), {}, nextOf(assembly))
  assert.equal(statCount, 2, '第二轮必须命中缓存')
  assert.equal(logs.filter((l) => l.fn === 'warn').length, 2)
})

test('处理器：技能存在 ⇒ 不校验也不告警（只统计不误报）', async () => {
  resetArmedSessions()
  const { handler, logs } = mount({}, { roots: ['C:\\skills'] })
  const assembly = makeAssembly()
  await handler(assembly, {}, nextOf(assembly))
  assert.equal(logs.some((l) => l.fn === 'warn'), false)
})

test('处理器：技能缺失但该组没摘任何工具 ⇒ 不校验、不 warn（连 stat 都不做）', async () => {
  resetArmedSessions()
  let statCount = 0
  const { handler, logs } = mount({}, { roots: ['C:\\skills'], existsSync: () => { statCount++; return false } })
  const assembly = makeAssembly({ includeCua: false, includeGodot: false })
  await handler(assembly, {}, nextOf(assembly))
  assert.equal(statCount, 0, '没摘东西就没有失明风险，不必打扰用户')
  assert.deepEqual(logs, [])
})

test('处理器：取不到技能根目录 ⇒ 一条 warn 说明"本次跳过技能校验"，只打一次', async () => {
  resetArmedSessions()
  const { handler, logs } = mount({}, { roots: [] })
  const assembly = makeAssembly()
  await handler(assembly, {}, nextOf(assembly))
  await handler(makeAssembly(), {}, nextOf(assembly))

  const warns = logs.filter((l) => l.fn === 'warn')
  assert.equal(warns.length, 1)
  assert.match(warns[0].message, /取不到技能根目录/)
  assert.match(warns[0].message, /跳过技能存在性校验/)
})

test('处理器：没配 skill 的组不会打出"技能缺失"warn（挂载时已提示过，不重复打扰）', async () => {
  resetArmedSessions()
  const { handler, logs } = mount({ groups: [{ name: 'cua', prefix: 'cua_driver_native__' }] })
  const assembly = makeAssembly({ includeGodot: false })
  await handler(assembly, {}, nextOf(assembly))
  assert.equal(logs.some((l) => l.fn === 'warn'), false)
  assert.match(logs[0].message, /没有配置说明技能/)
})

test('处理器：diag 开启 ⇒ 每次装配一行逐组诊断（含 present=/removed= (组名)）', async () => {
  resetArmedSessions()
  const { handler, logs } = mount({ diag: true })
  const context = {}
  for (let i = 0; i < 3; i++) {
    const assembly = makeAssembly()
    await handler(assembly, context, nextOf(assembly))
  }
  const diag = logs.filter((l) => l.message.includes('diag: '))
  assert.equal(diag.length, 3, 'diag 是"每次装配一行"，不做去重')
  // mount() 用的是裸日志出口（前缀由 apply() 里的 log 加），所以这里比对不带前缀的正文
  assert.equal(
    diag[0].message,
    `diag: present=56 removed=56 (cua) | present=39 removed=39 (godot) | total_removed=95 remaining=${NON_LAYERED_COUNT} changed=true`,
  )
  for (const line of diag) {
    assert.doesNotMatch(line.message, /cwd=/)
    assert.doesNotMatch(line.message, /allowlist/)
    assert.doesNotMatch(line.message, /白名单/)
  }
})

test('处理器：diag 关闭时一条 diag 都不打；开启且无可摘项时也如实报 0', async () => {
  resetArmedSessions()
  const quiet = mount({})
  const full = makeAssembly()
  await quiet.handler(full, {}, nextOf(full))
  assert.equal(quiet.logs.some((l) => l.message.includes('diag: ')), false)

  const bare = makeAssembly({ includeCua: false, includeGodot: false })
  const { handler, logs } = mount({ diag: true })
  const out = await handler(bare, {}, nextOf(bare))
  assert.equal(out, bare)
  const diag = logs.filter((l) => l.message.includes('diag: '))
  assert.equal(diag.length, 1)
  assert.equal(
    diag[0].message,
    `diag: present=0 removed=0 (cua) | present=0 removed=0 (godot) | total_removed=0 remaining=${NON_LAYERED_COUNT} changed=false`,
  )
})

test('记账各自只打一次：连续多轮正常装配后不再刷 info', async () => {
  resetArmedSessions()
  const { handler, logs } = mount({})
  for (let i = 0; i < 5; i++) {
    const assembly = makeAssembly()
    await handler(assembly, {}, nextOf(assembly))
  }
  assert.equal(logs.length, 2, '只该有两组各自的"首次装配已生效"')
  assert.deepEqual(logs.map((l) => l.fn), ['info', 'info'])
})

test('回归：首轮该组没有工具（未挂 MCP），后续出现改名后的形态也要报 fail-loud', async () => {
  resetArmedSessions()
  const { handler, logs } = mount(CUA_ONLY)
  const bare = { tools: [makeTool('read')] }
  await handler(bare, {}, nextOf(bare))
  assert.deepEqual(logs, [], '首轮无 cua 工具 ⇒ 静默')

  const renamed = { tools: [makeTool('mcp__cua_pre__click')] }
  await handler(renamed, {}, nextOf(renamed))
  assert.equal(logs.filter((l) => l.fn === 'warn').length, 1, '改名必须在后续轮次照样报出来')
})

test('回归：首轮全部摘完（无 warn），后续出现改名形态也要报 fail-loud', async () => {
  resetArmedSessions()
  const { handler, logs } = mount(CUA_ONLY)
  const normal = makeAssembly({ includeGodot: false })
  await handler(normal, {}, nextOf(normal))
  assert.equal(logs.filter((l) => l.fn === 'warn').length, 0)

  const renamed = { tools: [makeTool('mcp__cua_pre__click'), makeTool('read')] }
  await handler(renamed, {}, nextOf(renamed))
  const warns = logs.filter((l) => l.fn === 'warn')
  assert.equal(warns.length, 1, '两个记账标志分开，首个装配体不会把 fail-loud 吞掉')
  assert.match(warns[0].message, /一条都没匹配上前缀/)
})

test('处理器：日志双写（ctx.logger 与 console 两路都走），且统一带 [tool-layering] 前缀', async () => {
  const ctx = makeMockCtx()
  const original = { log: console.log, warn: console.warn, error: console.error }
  const stdout = []
  console.log = (m) => stdout.push(m)
  console.warn = (m) => stdout.push(m)
  console.error = (m) => stdout.push(m)
  try {
    apply(ctx, { diag: true })
    const handler = ctx.entries[0].handler
    const assembly = makeAssembly()
    await handler(assembly, {}, nextOf(assembly))
  } finally {
    console.log = original.log
    console.warn = original.warn
    console.error = original.error
  }
  assert.ok(stdout.some((m) => m.includes('已挂载')), 'console 那一路要有挂载日志')
  assert.ok(stdout.some((m) => m.includes('diag: present=56 removed=56 (cua)')), 'console 那一路要有逐组 diag 日志')
  assert.ok(ctx.logs.some((l) => l.message.includes('已挂载')), 'ctx.logger 那一路也要有')
  for (const line of stdout) assert.ok(line.startsWith('[tool-layering] '), '日志前缀统一')
})

test('回归：两个入口工具都在场但两组工具都不在场 ⇒ **不打** fail-loud（get_cua 含 cua、get_godot 含 godot）', async () => {
  resetArmedSessions()
  // 这条是 v0.2.0 实测踩到的假阳性（v0.3.0 变成两个名字）：入口工具缺省名里含本组宽松关键词，
  // 若宽松启发式不排除本插件自己的工具，就会在"本会话没有该组工具"时打出
  // "上游命名形态可能已变"的假 warn（每次装配两条）。排除后必须彻底静默。
  const { handler, logs } = mount({})
  const assembly = makeAssembly({ includeCua: false, includeGodot: false })
  assert.ok(assembly.tools.some((t) => t.name === CUA_ENTRY_TOOL_NAME), '夹具里必须有入口工具，否则这条测不到东西')
  assert.ok(assembly.tools.some((t) => t.name === GODOT_ENTRY_TOOL_NAME))

  const out = await handler(assembly, {}, nextOf(assembly))
  assert.equal(out, assembly)
  assert.deepEqual(logs, [], '入口工具不该被算成"像 cua/godot 组"的工具')

  // 对照：真正改名的工具（名字含 cua / godot 但不带前缀、又不是本插件注册的）照样要报
  const renamedCua = { tools: [makeTool(CUA_ENTRY_TOOL_NAME), makeTool(GODOT_ENTRY_TOOL_NAME), makeTool('mcp__cua_pre__click')] }
  await handler(renamedCua, {}, nextOf(renamedCua))
  let warns = logs.filter((l) => l.fn === 'warn')
  assert.equal(warns.length, 1, 'fail-loud 不能被这条排除策略一起关掉')
  assert.ok(warns[0].message.includes('1 个名字含 "cua" 的工具'), warns[0].message)

  const renamedGodot = { tools: [makeTool(CUA_ENTRY_TOOL_NAME), makeTool(GODOT_ENTRY_TOOL_NAME), makeTool('mcp__godot__x')] }
  await handler(renamedGodot, {}, nextOf(renamedGodot))
  warns = logs.filter((l) => l.fn === 'warn' && l.message.includes('godot'))
  assert.equal(warns.length, 1, 'godot 那组的排除同样不能把 fail-loud 关掉')
  assert.ok(warns[0].message.includes('1 个名字含 "godot" 的工具'), warns[0].message)
})

// ── v0.2.0/v0.3.0：入口工具 ⇒ 按 `(会话, 组)` 放行（装配期只认"这个会话放行了哪些组"）────
//
// 这一节的要求：①未放行照旧全摘；②放行某组只影响那一组；③两组都放行才整表放行；
// ④重复调用幂等（不改变表、不额外追加变更记录）；⑤会话隔离（A 放行不影响 B）。

test('放行①：未放行的会话照旧全摘，且摘除路径与 v0.1.0 逐字一致（含首次生效 info）', async () => {
  resetArmedSessions()
  const assembly = makeAssembly()
  const { handler, logs } = mount({})
  const out = await handler(assembly, contextOf('session-A'), nextOf(assembly))

  assert.equal(out.tools.length, NON_LAYERED_COUNT)
  assert.deepEqual(out.tools.map((t) => t.name), NON_LAYERED_NAMES)
  assert.ok(out.tools.some((t) => t.name === CUA_ENTRY_TOOL_NAME), '入口工具必须留下')
  assert.equal(logs.length, 2, '两组各自的"首次装配已生效"')
  assert.ok(logs[0].message.includes('present=56 removed=56 (cua)'))
  assert.equal(logs.some((l) => l.fn === 'warn'), false)
})

test('放行②：调 get_cua ⇒ **只**放行 cua（56 个留下），godot 那 39 个仍被摘', async () => {
  resetArmedSessions()
  const { handler, logs } = mount({})
  const session = contextOf('session-A')

  // 步中：模型调用 cua 组的入口工具（等价于 armGroup('session-A', 'cua')）
  armGroup('session-A', 'cua')

  const assembly = makeAssembly()
  const out = await handler(assembly, session, nextOf(assembly))

  assert.notEqual(out, assembly, 'godot 那组还在摘 ⇒ 装配体确实变了')
  assert.equal(out.tools.filter((t) => t.name.startsWith('cua_driver_native__')).length, 56,
    '56 个 CUA 工具从下一步起回到模型可见工具表')
  assert.equal(out.tools.some((t) => t.name.startsWith('mcp__godot_use__')), false,
    'v0.3.0 的核心：点开 cua 的入口不会把 godot 也一起放出来')
  assert.equal(out.tools.length, NON_LAYERED_COUNT + 56)

  // 被放行的那组不报"首次装配已生效"（否则就是误报），未放行的那组照旧报一条
  const info = logs.filter((l) => l.fn === 'info')
  assert.equal(info.length, 1)
  assert.ok(info[0].message.includes('present=39 removed=39 (godot)'), info[0].message)
  assert.equal(logs.some((l) => l.fn === 'warn'), false)

  // 留下的 56 个 CUA 工具都是入参里的同一个引用（没被重建、也没被移动）
  for (const item of out.tools) {
    assert.ok(assembly.tools.includes(item), `工具对象引用被重建：${item.name}`)
  }
})

test('放行③：调 get_godot ⇒ 反向成立（godot 39 个留下，cua 56 个仍被摘）', async () => {
  resetArmedSessions()
  const { handler, logs } = mount({})
  armGroup('session-A', 'godot')
  const assembly = makeAssembly()
  const out = await handler(assembly, contextOf('session-A'), nextOf(assembly))

  assert.equal(out.tools.filter((t) => t.name.startsWith('mcp__godot_use__')).length, 39)
  assert.equal(out.tools.some((t) => t.name.startsWith('cua_driver_native__')), false)
  assert.equal(out.tools.length, NON_LAYERED_COUNT + 39)
  const info = logs.filter((l) => l.fn === 'info')
  assert.equal(info.length, 1)
  assert.ok(info[0].message.includes('present=56 removed=56 (cua)'), info[0].message)
})

test('放行④：两个入口都调过 ⇒ 两组都放行，整表原样返回同一个引用', async () => {
  resetArmedSessions()
  const { handler, logs } = mount({})
  armGroup('session-A', 'cua')
  armGroup('session-A', 'godot')
  const assembly = makeAssembly()
  const out = await handler(assembly, contextOf('session-A'), nextOf(assembly))

  assert.equal(out, assembly, '全部组放行时必须原样返回入参装配体（同引用 ⇒ 宿主看不到工具表变化）')
  assert.equal(out.tools.length, 56 + 39 + NON_LAYERED_COUNT)
  assert.ok(out.tools.some((t) => t.name.startsWith('cua_driver_native__')))
  assert.ok(out.tools.some((t) => t.name.startsWith('mcp__godot_use__')))
  assert.deepEqual(logs, [], '放行的组不该多出"首次装配已生效"，也不该有 fail-loud')
})

test('放行⑤：重复调用入口工具 ⇒ 幂等：表不变、返回同一引用、不追加任何日志/变更', async () => {
  resetArmedSessions()
  const ctx = makeMockCtx()
  apply(ctx, {})
  const handler = ctx.entries[0].handler
  const [cuaTool, godotTool] = ctx.registered
  const session = contextOf('session-A')

  await cuaTool.execute({}, { agent: { id: 'session-A' } })
  await godotTool.execute({}, { agent: { id: 'session-A' } })
  const first = makeAssembly()
  const out1 = await handler(first, session, nextOf(first))
  assert.equal(out1, first)
  const logsAfterFirst = ctx.logs.length

  const again = await cuaTool.execute({}, { agent: { id: 'session-A' } })
  assert.equal(again.alreadyArmed, true, '第二次调用必须自报"此前已放行"')
  const second = makeAssembly()
  const out2 = await handler(second, session, nextOf(second))

  assert.equal(isGroupArmed('session-A', 'cua'), true)
  assert.equal(armedGroupCount(), 2, '重复调用不长出新的登记项')
  assert.equal(out2, second, '第二次装配同样原样返回（不产生新的工具表变化）')
  assert.deepEqual(out2.tools.map((t) => t.name), out1.tools.map((t) => t.name))
  assert.equal(ctx.logs.length, logsAfterFirst, '重复调用不追加任何日志（含"已放行"那条 info）')
})

test('放行⑥：会话隔离 —— A 放行 cua 不影响 B（B 照旧全摘，且 B 的 cua 也没被放行）', async () => {
  resetArmedSessions()
  const { handler } = mount({})
  armGroup('session-A', 'cua')

  const a = makeAssembly()
  const b = makeAssembly()
  const outA = await handler(a, contextOf('session-A'), nextOf(a))
  const outB = await handler(b, contextOf('session-B'), nextOf(b))

  assert.equal(outA.tools.filter((t) => t.name.startsWith('cua_driver_native__')).length, 56, 'A 的 cua 放行')
  assert.equal(outB.tools.length, NON_LAYERED_COUNT, 'B 未放行 ⇒ 照旧全摘（一个都不留）')
  assert.equal(isGroupArmed('session-B', 'cua'), false)
  // 反过来再确认一次：B 的装配不会把 A 的状态抹掉
  assert.equal(isGroupArmed('session-A', 'cua'), true)
})

test('放行⑦：被放行的组短路掉 fail-loud，**未放行的另一组照旧报**（两者互不干扰）', async () => {
  resetArmedSessions()
  // 两组的前缀一条都匹配不上（模拟"上游改名"）；放行 cua ⇒ 只有 godot 该报
  const { handler, logs } = mount({})
  armGroup('session-A', 'cua')
  const assembly = { tools: [makeTool('mcp__cua_pre__click'), makeTool('mcp__godot__run_project')] }
  const out = await handler(assembly, contextOf('session-A'), nextOf(assembly))

  assert.equal(out, assembly)
  const warns = logs.filter((l) => l.fn === 'warn')
  assert.equal(warns.length, 1, '被放行的组不打 fail-loud，未放行的组照打')
  assert.match(warns[0].message, /godot/)
  assert.equal(logs.some((l) => l.message.includes('cua')), false, '被放行的组连它那条都不该出现')
})

test('放行⑧：diag 行如实标出"哪一组被放行"（`, armed` 逐组标注）', async () => {
  resetArmedSessions()
  const { handler, logs } = mount({ diag: true })
  armGroup('session-A', 'cua')
  const assembly = makeAssembly()
  await handler(assembly, contextOf('session-A'), nextOf(assembly))

  const diag = logs.filter((l) => l.message.includes('diag: '))
  assert.equal(diag.length, 1)
  assert.equal(
    diag[0].message,
    `diag: present=0 removed=0 (cua, armed) | present=39 removed=39 (godot) |`
    + ` total_removed=39 remaining=${56 + NON_LAYERED_COUNT} changed=true`,
  )
})

test('放行⑨：端到端（不启动 dsh）—— apply 注册的两个入口工具各管各的，同一 handler 的装配行为随之改变', async () => {
  resetArmedSessions()
  const ctx = makeMockCtx()
  apply(ctx, {})
  const handler = ctx.entries[0].handler
  const [cuaTool, godotTool] = ctx.registered
  const session = contextOf('session-aaaa1111-2222-3333-4444-555555555555')

  const before = makeAssembly()
  const outBefore = await handler(before, session, nextOf(before))
  assert.equal(outBefore.tools.some((t) => t.name.startsWith('cua_driver_native__')), false,
    '调用入口工具之前：模型看不见 CUA 工具（这就是当初那次失败的条件）')
  assert.equal(outBefore.tools.some((t) => t.name.startsWith('mcp__godot_use__')), false)

  const cuaValue = await cuaTool.execute({}, { agent: { id: 'session-aaaa1111-2222-3333-4444-555555555555' } })
  assert.deepEqual(cuaValue, { group: 'cua', armed: true, alreadyArmed: false })
  // 宿主会拿 output.schema 校验返回体（dsh-tools 的 snapshotToolValue → INVALID_TOOL_OUTPUT），
  // 这里用同一个校验器把关，避免"返回体不合 schema"这种只在真机上炸的坑。
  assert.deepEqual(validateJsonSchemaValue(cuaTool.output.schema, cuaValue, ''), [])

  // 只放 cua 后：cua 回来、godot 仍不可见
  const step2 = makeAssembly()
  const outStep2 = await handler(step2, session, nextOf(step2))
  assert.equal(outStep2.tools.filter((t) => t.name.startsWith('cua_driver_native__')).length, 56,
    '56 个 CUA 工具从下一步起回到模型可见工具表')
  assert.equal(outStep2.tools.some((t) => t.name.startsWith('mcp__godot_use__')), false,
    'godot 没被点开 ⇒ 仍被摘（v0.3.0 的按组独立）')

  // 再放 godot：整表原样回来
  const godotValue = await godotTool.execute({}, { agent: { id: 'session-aaaa1111-2222-3333-4444-555555555555' } })
  assert.deepEqual(godotValue, { group: 'godot', armed: true, alreadyArmed: false })
  const step3 = makeAssembly()
  const outStep3 = await handler(step3, session, nextOf(step3))
  assert.equal(outStep3, step3, '两组都放行 ⇒ 原样放过')

  // 另一个会话仍然是摘掉的（隔离），且它的装配体没有被改动过
  const other = makeAssembly()
  const outOther = await handler(other, contextOf('session-other'), nextOf(other))
  assert.equal(outOther.tools.some((t) => t.name.startsWith('cua_driver_native__')), false)
  assert.equal(outOther.tools.some((t) => t.name.startsWith('mcp__godot_use__')), false)
})

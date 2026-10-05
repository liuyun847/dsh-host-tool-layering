/**
 * 插件入口与水线处理器的契约测试。
 *
 * 这里**不启动 dsh**：只用一个假 ctx 记下水线注册参数，再用假 `next()` 驱动处理器，
 * 技能探针一律注入假实现（默认"技能都存在"），验证"返回值权威""逐组计数""原样放过"
 * "幂等""逐组 fail-loud""技能校验 + 缓存""diag"这些行为。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { apply, createAssembleHandler, formatGroupCount, name } from '../lib/index.js'
import { resolveConfig } from '../lib/config.js'
import { NON_LAYERED_NAMES, makeAssembly, makeProbe, makeTool } from './fixtures.mjs'

/** 造一个只实现 `on` 的假 ctx，记下注册参数与日志。 */
function mockCtx() {
  const entries = []
  const logs = []
  const push = (fn) => (message) => logs.push({ fn, message })
  return {
    entries,
    logs,
    logger: { info: push('info'), warn: push('warn'), error: push('error') },
    on(event, handler, options) { entries.push({ event, handler, options }) },
  }
}

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

test('formatGroupCount：日志契约的唯一定义处', () => {
  assert.equal(formatGroupCount({ name: 'cua', present: 56, removed: 56 }), 'present=56 removed=56 (cua)')
  assert.equal(formatGroupCount({ name: 'godot', present: 0, removed: 0 }), 'present=0 removed=0 (godot)')
})

test('apply：挂 system-prompt/assemble 水线，注册参数必须是 { global: true, prepend: true }', () => {
  const ctx = mockCtx()
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
  assert.match(line.message, /不做任何检测/)
  assert.match(line.message, /cua_driver_native__/, '挂载日志要点名每一组的前缀')
  assert.match(line.message, /mcp__godot_use__/)
  assert.match(line.message, /技能 computer-control/, '挂载日志要点名每组配的说明技能')
  assert.match(line.message, /技能 godot-use/)
  assert.match(line.message, /不构成能力边界/, '挂载日志应提示能力语义，避免被误当安全边界')
  assert.match(line.message, /v0\.1\.0/, '挂载日志应带版本号')
  assert.equal(ctx.logs.some((l) => l.fn === 'warn'), false)
})

test('apply：非法配置 ⇒ 打 error、不挂水线、**不抛错**（宿主启动路径不能被配置错误打断）', () => {
  const ctx = mockCtx()
  // 旧行为是 throw TypeError ⇒ 冷启动时 dsh-app-boot 的 root.update() 抛 ⇒ 宿主非零退出；
  // 热加载在旧版 loader（≤1.0.3）下还会整层 patch 回滚（连带同文件其它 insert 行）——
  // 0.1.7-rc.1 起 loader 1.0.5 取消事务回滚，该顾虑消失，但"绝不抛"仍锁死（冷启动退出）。
  assert.doesNotThrow(() => apply(ctx, { groups: 'cua' }))
  assert.equal(ctx.entries.length, 0, '配置非法时不该挂水线（插件完全不生效）')

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

test('apply：各种非法配置都不会抛错，且都不挂水线', () => {
  const bad = [
    { diag: 'yes' },
    { diag: 1 },
    { groups: 'cua' },
    { groups: 42 },
    { groups: {} },
    { groups: [{}] },
    { groups: [{ prefix: 42 }] },
    { groups: [{ prefix: '' }] },
    [],
    'x',
    42,
    true,
  ]
  for (const config of bad) {
    const ctx = mockCtx()
    assert.doesNotThrow(() => apply(ctx, config), `不该抛：${JSON.stringify(config)}`)
    assert.equal(ctx.entries.length, 0, `不该挂水线：${JSON.stringify(config)}`)
    assert.equal(ctx.logs.filter((l) => l.fn === 'error').length, 1, `应打一条 error：${JSON.stringify(config)}`)
  }
})

test('apply：groups 为空数组（合法）⇒ 不挂水线、不打 error/warn，只留一条 info 说明当前 no-op', () => {
  const ctx = mockCtx()
  assert.doesNotThrow(() => apply(ctx, { groups: [] }))
  assert.equal(ctx.entries.length, 0, '没东西可摘就不注册水线（连每步一次的空调用都省掉）')
  assert.equal(ctx.logs.some((l) => l.fn === 'error'), false)
  assert.equal(ctx.logs.some((l) => l.fn === 'warn'), false)
  const info = ctx.logs.filter((l) => l.fn === 'info')
  assert.equal(info.length, 1)
  assert.match(info[0].message, /groups 为空数组/)
  assert.match(info[0].message, /no-op/)
  assert.match(info[0].message, /合法配置/, '要说清"这不是配置错误"')
})

test('apply：顶层未知键 ⇒ 不判非法，挂水线 + 一条 warn 点名', () => {
  const ctx = mockCtx()
  assert.doesNotThrow(() => apply(ctx, { diag: true, allowlist: [], requiredMarker: '__x__' }))
  assert.equal(ctx.entries.length, 1, '未知键不构成非法配置 ⇒ 照常挂水线')
  assert.equal(ctx.logs.some((l) => l.fn === 'error'), false, '不该报 error')

  const warns = ctx.logs.filter((l) => l.fn === 'warn')
  assert.equal(warns.length, 1)
  assert.match(warns[0].message, /不认得的顶层键/)
  assert.match(warns[0].message, /"allowlist"/, 'warn 要点名具体是哪些键')
  assert.match(warns[0].message, /"requiredMarker"/)
  assert.ok(ctx.logs.some((l) => l.fn === 'info' && l.message.includes('diag 已开启')))
})

test('apply：组内未知键 ⇒ 一条 warn，点名"第几组 + 组名 + 键名"', () => {
  const ctx = mockCtx()
  // 注意：这里给组配了 skill，否则会额外多出一条"没配说明技能"的挂载期 warn，干扰本用例
  apply(ctx, { groups: [{ prefix: 'a__', name: 'A', keep: true, skill: 'x' }] })
  const warns = ctx.logs.filter((l) => l.fn === 'warn')
  assert.equal(warns.length, 1)
  assert.match(warns[0].message, /groups 里出现本插件不认得的键/)
  assert.match(warns[0].message, /groups\[0\]/)
  assert.match(warns[0].message, /A/)
  assert.match(warns[0].message, /"keep"/)
  assert.equal(ctx.entries.length, 1)
})

test('apply：多个组写同一个 prefix ⇒ 一条 warn 说明"后面那组永远 present=0"', () => {
  const ctx = mockCtx()
  apply(ctx, {
    groups: [
      { prefix: 'x__', name: 'a', skill: 'x' },
      { prefix: 'x__', name: 'b', skill: 'y' },
    ],
  })
  assert.equal(ctx.entries.length, 1, '重复 prefix 不判非法')
  const warns = ctx.logs.filter((l) => l.fn === 'warn')
  assert.equal(warns.length, 1)
  assert.match(warns[0].message, /同一个 prefix/)
  assert.match(warns[0].message, /"x__"/)
  assert.match(warns[0].message, /present=0/)
})

test('apply：某组没配 skill ⇒ 挂载时就 warn 一次点名该组', () => {
  const ctx = mockCtx()
  apply(ctx, { groups: [{ name: 'cua', prefix: 'cua_driver_native__' }, { prefix: 'b__', skill: 'x' }] })
  const warns = ctx.logs.filter((l) => l.fn === 'warn')
  assert.equal(warns.length, 1, '配了 skill 的那组不该被点名')
  assert.match(warns[0].message, /cua 组没有配置说明技能/)
  assert.match(warns[0].message, /没有任何说明书/)
  assert.match(ctx.logs.find((l) => l.fn === 'info').message, /cua\(cua_driver_native__ → ⚠未配技能\)/)
})

test('处理器：两组全摘 ⇒ 逐组计数、非组内工具引用不变、每组各一条 info', async () => {
  const assembly = makeAssembly()
  const { handler, logs } = mount({})
  const out = await handler(assembly, {}, nextOf(assembly))

  assert.notEqual(out, assembly, '有删除时应返回新 assembly')
  assert.equal(out.tools.length, NON_LAYERED_NAMES.length)
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
  const assembly = makeAssembly({ includeCua: false })
  const { handler, logs } = mount({})
  const out = await handler(assembly, {}, nextOf(assembly))

  assert.equal(out.tools.length, NON_LAYERED_NAMES.length, 'godot 那 39 个被摘掉，只剩内置那批')
  assert.equal(logs.length, 1, '只该有 godot 组那一条 info')
  assert.equal(logs[0].fn, 'info')
  assert.match(logs[0].message, /godot 组/)
})

test('处理器：与 cwd / 会话上下文完全无关（任何 context 结果都一样）', async () => {
  const { handler } = mount({})
  const contexts = [
    {},
    undefined,
    { agent: { session: { header: { cwd: '<工作区>' } } } },
    { agent: { session: { header: { cwd: '%USERPROFILE%\\Desktop\\code\\godot-game-demo' } } } },
    { agent: null, scope: null },
  ]
  for (const context of contexts) {
    const assembly = makeAssembly()
    const out = await handler(assembly, context, nextOf(assembly))
    assert.equal(out.tools.some((t) => t.name.startsWith('cua_driver_native__')), false,
      `任何上下文都必须全摘：${JSON.stringify(context)}`)
    assert.equal(out.tools.some((t) => t.name.startsWith('mcp__godot_use__')), false)
  }
})

test('处理器：两组都不在场 ⇒ 静默 no-op（一条日志都不打、形状不变）', async () => {
  const assembly = makeAssembly({ includeCua: false, includeGodot: false })
  const { handler, logs } = mount({})
  const out = await handler(assembly, {}, nextOf(assembly))

  assert.equal(out, assembly)
  assert.equal(out.tools, assembly.tools)
  assert.deepEqual(logs, [], '无相应工具时一条日志都不该打')
})

test('处理器：工具在场却零命中 ⇒ **逐组**打 warn（fail-loud），每组只打一次', async () => {
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
  const { handler, logs } = mount({})
  for (const bad of [null, 42, 'x', {}, { tools: null }, { tools: 'read' }, { tools: {} }]) {
    const out = await handler(bad, {}, nextOf(bad))
    assert.equal(out, bad)
  }
  assert.deepEqual(logs, [])
})

test('处理器：幂等 —— 同一输入连调两次，第二次原样返回同一个引用', async () => {
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
  const { handler, logs } = mount({}, { roots: ['C:\\skills'] })
  const assembly = makeAssembly()
  await handler(assembly, {}, nextOf(assembly))
  assert.equal(logs.some((l) => l.fn === 'warn'), false)
})

test('处理器：技能缺失但该组没摘任何工具 ⇒ 不校验、不 warn（连 stat 都不做）', async () => {
  let statCount = 0
  const { handler, logs } = mount({}, { roots: ['C:\\skills'], existsSync: () => { statCount++; return false } })
  const assembly = makeAssembly({ includeCua: false, includeGodot: false })
  await handler(assembly, {}, nextOf(assembly))
  assert.equal(statCount, 0, '没摘东西就没有失明风险，不必打扰用户')
  assert.deepEqual(logs, [])
})

test('处理器：取不到技能根目录 ⇒ 一条 warn 说明"本次跳过技能校验"，只打一次', async () => {
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
  const { handler, logs } = mount({ groups: [{ name: 'cua', prefix: 'cua_driver_native__' }] })
  const assembly = makeAssembly({ includeGodot: false })
  await handler(assembly, {}, nextOf(assembly))
  assert.equal(logs.some((l) => l.fn === 'warn'), false)
  assert.match(logs[0].message, /没有配置说明技能/)
})

test('处理器：diag 开启 ⇒ 每次装配一行逐组诊断（含 present=/removed= (组名)）', async () => {
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
    'diag: present=56 removed=56 (cua) | present=39 removed=39 (godot) | total_removed=95 remaining=36 changed=true',
  )
  for (const line of diag) {
    assert.doesNotMatch(line.message, /cwd=/)
    assert.doesNotMatch(line.message, /allowlist/)
    assert.doesNotMatch(line.message, /白名单/)
  }
})

test('处理器：diag 关闭时一条 diag 都不打；开启且无可摘项时也如实报 0', async () => {
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
    'diag: present=0 removed=0 (cua) | present=0 removed=0 (godot) | total_removed=0 remaining=36 changed=false',
  )
})

test('记账各自只打一次：连续多轮正常装配后不再刷 info', async () => {
  const { handler, logs } = mount({})
  for (let i = 0; i < 5; i++) {
    const assembly = makeAssembly()
    await handler(assembly, {}, nextOf(assembly))
  }
  assert.equal(logs.length, 2, '只该有两组各自的"首次装配已生效"')
  assert.deepEqual(logs.map((l) => l.fn), ['info', 'info'])
})

test('回归：首轮该组没有工具（未挂 MCP），后续出现改名后的形态也要报 fail-loud', async () => {
  const { handler, logs } = mount(CUA_ONLY)
  const bare = { tools: [makeTool('read')] }
  await handler(bare, {}, nextOf(bare))
  assert.deepEqual(logs, [], '首轮无 cua 工具 ⇒ 静默')

  const renamed = { tools: [makeTool('mcp__cua_pre__click')] }
  await handler(renamed, {}, nextOf(renamed))
  assert.equal(logs.filter((l) => l.fn === 'warn').length, 1, '改名必须在后续轮次照样报出来')
})

test('回归：首轮全部摘完（无 warn），后续出现改名形态也要报 fail-loud', async () => {
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
  const ctx = mockCtx()
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

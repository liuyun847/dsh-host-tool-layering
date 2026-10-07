/**
 * `lib/assembly.js` 的契约测试：多组同时命中 / 只有一组命中 / 前缀重叠（长的先匹配）/
 * 空组表 / 幂等 / 只删不重建 / 形状防御 / 宽松启发式计数 / **按 `(会话, 组)` 放行**。
 *
 * v0.3.0 的签名变化：`sessionArmed: boolean` → `armedGroups: Set<组名>`（放行粒度从"整个会话"
 * 收紧到"某一组"）。所有既有断言逐条保留，只把入参换成集合；新增的都是"只放行其中一组"。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { buildMatchers, countLikeTools, looseKeywordOf, processAssembly, removeToolsByGroups, zeroCounts } from '../lib/assembly.js'
import { DEFAULT_GROUPS } from '../lib/config.js'
import {
  CUA_FULL_NAMES,
  GODOT_FULL_NAMES,
  NON_LAYERED_NAMES,
  cuaTools,
  godotTools,
  makeAssembly,
} from './fixtures.mjs'

/** 标准两组（就是插件默认的那两组，去掉用不到的字段）。 */
const GROUPS = DEFAULT_GROUPS.map(({ name, prefix }) => ({ name, prefix }))

/** 标准处理参数（一个组都没放行）。 */
const OPTIONS = { groups: GROUPS }

/** "两组都已放行"的集合。 */
const BOTH_ARMED = new Set(['cua', 'godot'])

/** 小工具：按完整名造一个工具对象。 */
function tool(toolName) {
  return { name: toolName, description: `d ${toolName}`, parameters: { type: 'object', properties: {} } }
}

test('夹具自检：CUA 56 个、godot 39 个，名字不重复、都带各自前缀', () => {
  assert.equal(CUA_FULL_NAMES.length, 56, 'CUA 工具应为 56 个')
  assert.equal(GODOT_FULL_NAMES.length, 39, 'godot 工具应为 39 个')
  const all = [...CUA_FULL_NAMES, ...GODOT_FULL_NAMES, ...NON_LAYERED_NAMES]
  assert.equal(new Set(all).size, all.length, '全部工具名不应重复')
  for (const full of CUA_FULL_NAMES) assert.ok(full.startsWith('cua_driver_native__'), `${full} 缺少前缀`)
  for (const full of GODOT_FULL_NAMES) assert.ok(full.startsWith('mcp__godot_use__'), `${full} 缺少前缀`)
  for (const name of NON_LAYERED_NAMES) {
    assert.equal(name.startsWith('cua_driver_native__'), false, `${name} 不该落在 CUA 组`)
    assert.equal(name.startsWith('mcp__godot_use__'), false, `${name} 不该落在 godot 组`)
  }
})

test('① 两组同时命中：全部摘掉、逐组计数各自正确、非组内工具一个不动', () => {
  const assembly = makeAssembly()
  const beforeKept = assembly.tools.filter((t) => NON_LAYERED_NAMES.includes(t.name))
  assert.equal(assembly.tools.length, 56 + 39 + NON_LAYERED_NAMES.length, '夹具应是三组交错')

  const result = processAssembly(assembly, OPTIONS)

  assert.equal(result.changed, true)
  assert.equal(result.totalPresent, 95)
  assert.equal(result.totalRemoved, 95)
  assert.equal(result.removedNames.length, 95)
  assert.deepEqual(result.perGroup.map((p) => p.name), ['cua', 'godot'], '逐组计数顺序 = 组表顺序')
  assert.equal(result.perGroup[0].present, 56)
  assert.equal(result.perGroup[0].removed, 56)
  assert.equal(result.perGroup[0].removedNames.length, 56)
  assert.equal(result.perGroup[1].present, 39)
  assert.equal(result.perGroup[1].removed, 39)
  assert.deepEqual(result.perGroup[0].removedNames.slice().sort(), CUA_FULL_NAMES.slice().sort())
  assert.deepEqual(result.perGroup[1].removedNames.slice().sort(), GODOT_FULL_NAMES.slice().sort())

  // 逐组计数不可能重复计：两份名单互不重叠，且加总等于 totalRemoved
  const overlap = result.perGroup[0].removedNames.filter((n) => result.perGroup[1].removedNames.includes(n))
  assert.deepEqual(overlap, [], '同一个工具不该被算进两组')
  const sum = result.perGroup.reduce((acc, part) => acc + part.removed, 0)
  assert.equal(sum, result.totalRemoved, 'sum(perGroup.removed) 必须等于 totalRemoved')

  // 留下来的正好是非组内那一批：数量、顺序、对象引用都不变
  assert.equal(result.assembly.tools.length, NON_LAYERED_NAMES.length)
  assert.deepEqual(result.assembly.tools.map((t) => t.name), NON_LAYERED_NAMES)
  for (const item of beforeKept) {
    assert.ok(result.assembly.tools.includes(item), `工具对象引用被重建了：${item.name}`)
  }

  // 装配体其余字段原样保留、引用不变；有删除时返回新对象（不改入参）
  assert.equal(result.assembly.sections, assembly.sections)
  assert.equal(result.assembly.contexts, assembly.contexts)
  assert.equal(result.assembly.variables, assembly.variables)
  assert.notEqual(result.assembly, assembly)
})

test('② 只有一组命中（CUA 不在场）：该组全零，另一组照常摘', () => {
  const assembly = makeAssembly({ includeCua: false })
  const result = processAssembly(assembly, OPTIONS)

  assert.equal(result.changed, true)
  assert.equal(result.perGroup[0].name, 'cua')
  assert.equal(result.perGroup[0].present, 0, '不在场的组必须如实报 0（日志形如 present=0 removed=0 (cua)）')
  assert.equal(result.perGroup[0].removed, 0)
  assert.deepEqual(result.perGroup[0].removedNames, [])
  assert.equal(result.perGroup[1].present, 39)
  assert.equal(result.perGroup[1].removed, 39)
  assert.equal(result.totalRemoved, 39)
  assert.equal(result.assembly.tools.length, NON_LAYERED_NAMES.length)
})

test('③ 只有另一组命中（godot 不在场）：逐组计数各自独立', () => {
  const assembly = makeAssembly({ includeGodot: false })
  const result = processAssembly(assembly, OPTIONS)
  assert.deepEqual(result.perGroup.map((p) => [p.name, p.present, p.removed]), [
    ['cua', 56, 56],
    ['godot', 0, 0],
  ])
  assert.equal(result.assembly.tools.length, NON_LAYERED_NAMES.length)
})

test('④ 前缀重叠：长的先匹配，每个工具恰好算给一组', () => {
  const groups = [
    { name: 'outer', prefix: 'mcp__x__' },
    { name: 'inner', prefix: 'mcp__x__y__' },
  ]
  const tools = [tool('mcp__x__y__z'), tool('mcp__x__a'), tool('read'), tool('mcp__x__y__')]

  const result = removeToolsByGroups(tools, groups)
  const byName = Object.fromEntries(result.perGroup.map((p) => [p.name, p]))
  assert.equal(byName.inner.present, 2, 'mcp__x__y__z 与 mcp__x__y__ 归最长的前缀')
  assert.equal(byName.outer.present, 1, 'mcp__x__a 只带外层前缀')
  assert.equal(result.totalRemoved, 3)
  assert.equal(result.perGroup.reduce((acc, p) => acc + p.removed, 0), result.totalRemoved)
  assert.deepEqual(result.tools.map((t) => t.name), ['read'])

  // 组表顺序反过来，归属不变（长度优先，与数组位置无关）
  const reversed = removeToolsByGroups(tools, [...groups].reverse())
  assert.deepEqual(
    Object.fromEntries(reversed.perGroup.map((p) => [p.name, p.present])),
    { inner: 2, outer: 1 },
  )
  assert.deepEqual(reversed.tools.map((t) => t.name), ['read'])
})

test('④b 两组写同一个 prefix：先出现的组赢，后面的组恒为 0（不重复计）', () => {
  const groups = [{ name: 'first', prefix: 'p__' }, { name: 'second', prefix: 'p__' }]
  const result = removeToolsByGroups([tool('p__t'), tool('read')], groups)
  assert.deepEqual(result.perGroup.map((p) => [p.name, p.present]), [['first', 1], ['second', 0]])
  assert.equal(result.totalRemoved, 1)
})

test('⑤ 组表为空：完全 no-op（同引用、零计数）', () => {
  const assembly = makeAssembly()
  const snapshot = JSON.stringify(assembly)
  const result = processAssembly(assembly, { groups: [] })

  assert.equal(result.changed, false)
  assert.equal(result.assembly, assembly, '空组表必须原样返回同一个 assembly 引用')
  assert.equal(result.assembly.tools, assembly.tools)
  assert.equal(result.totalRemoved, 0)
  assert.deepEqual(result.perGroup, [])
  assert.equal(JSON.stringify(assembly), snapshot, 'no-op 不得改动入参')
})

test('⑥ 两组都不在场：静默 no-op，形状完全不变（同引用）', () => {
  const assembly = makeAssembly({ includeCua: false, includeGodot: false })
  const result = processAssembly(assembly, OPTIONS)
  assert.equal(result.changed, false)
  assert.equal(result.assembly, assembly)
  assert.equal(result.assembly.tools, assembly.tools)
  assert.equal(result.totalPresent, 0)
  assert.deepEqual(result.perGroup.map((p) => p.present), [0, 0], 'no-op 时逐组计数仍如实为 0')
})

test('⑦ 形状异常：非对象 / 无 tools / tools 非数组一律原样放过', () => {
  for (const bad of [null, undefined, 42, 'x', {}, { tools: null }, { tools: {} }, { tools: 'read' }]) {
    const result = processAssembly(bad, OPTIONS)
    assert.equal(result.assembly, bad, `形状异常应原样返回：${JSON.stringify(bad)}`)
    assert.equal(result.changed, false)
    assert.equal(result.totalRemoved, 0)
    assert.deepEqual(result.perGroup.map((p) => p.present), [0, 0])
  }
})

test('⑦b 空工具表 / 工具表里有 null 也能过；非字符串名字不算命中', () => {
  const empty = { tools: [] }
  assert.equal(processAssembly(empty, OPTIONS).assembly, empty)

  const withNulls = {
    tools: [null, tool('read'), undefined, { name: 42 }, tool('cua_driver_native__click'), { name: null }],
  }
  const result = processAssembly(withNulls, OPTIONS)
  assert.equal(result.changed, true)
  assert.equal(result.totalRemoved, 1)
  assert.deepEqual(result.assembly.tools.map((t) => (t === null || t === undefined ? t : t.name)),
    [null, 'read', undefined, 42, null])
})

test('⑧ 幂等：同一输入连续调用两次，第二次零改动且返回同一引用', () => {
  const assembly = makeAssembly()
  const first = processAssembly(assembly, OPTIONS)
  const second = processAssembly(first.assembly, OPTIONS)

  assert.equal(second.changed, false, '第二次必须无可删项')
  assert.equal(second.assembly, first.assembly, '第二次必须返回第一次的结果引用')
  assert.equal(second.totalRemoved, 0)
  assert.deepEqual(second.perGroup.map((p) => [p.name, p.present]), [['cua', 0], ['godot', 0]],
    '第二次逐组计数也必须是 0（否则日志会每轮说"又删了 56 个"）')

  // 同一输入跑两遍（互不干扰）也必须完全一致
  const a = processAssembly(makeAssembly(), OPTIONS).assembly.tools.map((t) => t.name)
  const b = processAssembly(makeAssembly(), OPTIONS).assembly.tools.map((t) => t.name)
  assert.deepEqual(a, b)
})

test('⑨ 只删不重排、不重建对象：留下的每个工具都是入参里的同一个引用', () => {
  const assembly = makeAssembly()
  const inputTools = assembly.tools
  const result = processAssembly(assembly, OPTIONS)

  assert.notEqual(result.assembly.tools, inputTools, '有删除时应是新数组')
  for (const item of result.assembly.tools) {
    assert.ok(inputTools.includes(item), `工具对象引用被重建：${item.name}`)
  }

  // 顺序 = 入参顺序的子序列
  const inputOrder = inputTools.map((t) => t.name)
  const outputOrder = result.assembly.tools.map((t) => t.name)
  let cursor = -1
  for (const item of outputOrder) {
    const idx = inputOrder.indexOf(item)
    assert.ok(idx > cursor, `输出顺序不是入参顺序的子序列（${item}）`)
    cursor = idx
  }
})

test('⑩ 其它 MCP server 与内置工具不受影响；前缀匹配大小写敏感', () => {
  const result = processAssembly(makeAssembly(), OPTIONS)
  const otherMcp = result.assembly.tools.filter((t) => t.name.startsWith('mcp__') && !t.name.startsWith('mcp__godot_use__'))
  assert.deepEqual(otherMcp.map((t) => t.name), [
    'mcp__context7__query-docs',
    'mcp__context7__resolve-library-id',
  ])

  const cased = { tools: [tool('CUA_DRIVER_NATIVE__click'), tool('MCP__GODOT_USE__validate')] }
  assert.equal(processAssembly(cased, OPTIONS).assembly, cased, '大小写不符不算命中（也不该被误删）')
})

test('⑪ 逐组不变式：全摘形态下 present 恒等于 removed，且每项只被数一次', () => {
  const result = removeToolsByGroups(makeAssembly().tools, GROUPS)
  for (const part of result.perGroup) {
    assert.equal(part.present, part.removed, `${part.name}：全摘形态下 present 应恒等于 removed`)
    assert.equal(part.removed, part.removedNames.length)
  }
  assert.equal(result.totalPresent, result.totalRemoved)
  assert.equal(new Set(result.removedNames).size, result.removedNames.length, 'removedNames 不该有重复项')
})

test('buildMatchers：按前缀长度降序排，且带回组表下标（对外顺序不受排序影响）', () => {
  const groups = [
    { name: 'short', prefix: 'a__' },
    { name: 'long', prefix: 'a__bb__' },
    { name: 'mid', prefix: 'a__b__' },
  ]
  const matchers = buildMatchers(groups)
  assert.deepEqual(matchers.map((m) => m.name), ['long', 'mid', 'short'])
  assert.deepEqual(matchers.map((m) => m.index), [1, 2, 0], 'index 必须指回原组表位置')

  // 没给 name 时用 prefix 推出的短名
  assert.deepEqual(buildMatchers([{ prefix: 'mcp__godot_use__' }]).map((m) => m.name), ['godot'])
})

test('zeroCounts：形状固定（name/prefix/armed/present/removed/removedNames 都在），armed 逐组判定', () => {
  assert.deepEqual(zeroCounts(GROUPS), [
    { name: 'cua', prefix: 'cua_driver_native__', armed: false, present: 0, removed: 0, removedNames: [] },
    { name: 'godot', prefix: 'mcp__godot_use__', armed: false, present: 0, removed: 0, removedNames: [] },
  ])
  // v0.3.0：已放行是一个**组名集合**，不是布尔 ⇒ 只放行 cua 时 godot 必须仍是 false
  //（这是 lib/index.js 用来跳过"已生效"/fail-loud 的判据）
  assert.deepEqual(zeroCounts(GROUPS, new Set(['cua'])).map((part) => part.armed), [true, false])
  assert.deepEqual(zeroCounts(GROUPS, BOTH_ARMED).map((part) => part.armed), [true, true])
  assert.deepEqual(zeroCounts(GROUPS, new Set()).map((part) => part.armed), [false, false])
})

test('countLikeTools：宽松关键词由前缀推出，只在严格通道零命中时才有意义', () => {
  const godotCounts = countLikeTools([
    { name: 'mcp__godot_use__run_project' },
    { name: 'mcp__godot__run_project' },
    { name: 'mcp__godot-use__validate' },
    { name: 'GODOT_editor_open' },
    { name: 'read' },
    { name: null },
    null,
  ], 'mcp__godot_use__')
  assert.equal(godotCounts.strict, 1, '只有标准前缀算精确命中')
  assert.equal(godotCounts.loose, 4, '宽松通道应把 4 个带 godot 的都数上（不改大小写）')
  assert.equal(looseKeywordOf('mcp__godot_use__'), 'godot', '与旧插件 v0.2.0 的关键词一致')

  const cuaCounts = countLikeTools([
    { name: 'cua_driver_native__click' },
    { name: 'mcp__cua_pre__click' },
    { name: 'CUA_editor_open' },
    { name: 'read' },
  ], 'cua_driver_native__')
  assert.equal(cuaCounts.strict, 1)
  assert.equal(cuaCounts.loose, 3)
  assert.equal(looseKeywordOf('cua_driver_native__'), 'cua')

  assert.deepEqual(countLikeTools(undefined, 'x__'), { strict: 0, loose: 0 })
})

test('countLikeTools：关键词推不出时（空前缀）宽松通道整体关闭，不允许 includes(\'\') 恒真', () => {
  assert.equal(looseKeywordOf(''), null)
  assert.equal(looseKeywordOf('mcp__'), null)
  const counts = countLikeTools([{ name: 'read' }, { name: 'write' }], '')
  assert.equal(counts.strict, 0)
  assert.equal(counts.loose, 0, '空前缀不该把所有工具都算成"像本组工具"')
})

test('countLikeTools：ignoreNames 必须排除本插件**全部**入口工具（get_cua 含 cua、get_godot 含 godot）', () => {
  // 回归（v0.2.0 实测踩到、v0.3.0 变成两个名字）：入口工具缺省名里含本组宽松关键词
  // ⇒ 不排除就会在"本会话没有该组工具在场"时打出假 fail-loud。
  const tools = [{ name: 'get_cua' }, { name: 'get_godot' }, { name: 'read' }]
  assert.equal(countLikeTools(tools, 'cua_driver_native__').loose, 1, '不排除时 get_cua 确实会被误算')
  assert.equal(countLikeTools(tools, 'mcp__godot_use__').loose, 1, '不排除时 get_godot 确实会被误算')
  const ignoreNames = new Set(['get_cua', 'get_godot'])
  assert.equal(countLikeTools(tools, 'cua_driver_native__', { ignoreNames }).loose, 0)
  assert.equal(countLikeTools(tools, 'mcp__godot_use__', { ignoreNames }).loose, 0)

  // 排除只针对点名的那几个：真正"像本组"的改名工具照样算得出来
  const renamed = [
    { name: 'get_cua' }, { name: 'get_godot' },
    { name: 'mcp__cua_pre__click' }, { name: 'mcp__godot__x' }, { name: 'read' },
  ]
  assert.equal(countLikeTools(renamed, 'cua_driver_native__', { ignoreNames }).loose, 1,
    'exclude 不能把 fail-loud 一起关掉')
  assert.equal(countLikeTools(renamed, 'mcp__godot_use__', { ignoreNames }).loose, 1,
    '两组各自的改名工具都要能被数出来')
  // 非 Set / 未传时行为与旧签名完全一致
  assert.equal(countLikeTools(tools, 'cua_driver_native__', {}).loose, 1)
  assert.equal(countLikeTools(tools, 'cua_driver_native__', { ignoreNames: ['get_cua'] }).loose, 1, '只认 Set')
})

test('多组时逐组计数与单组单独跑的结果一致（互不干扰）', () => {
  const assembly = makeAssembly()
  const both = removeToolsByGroups(assembly.tools, GROUPS)
  const cuaOnly = removeToolsByGroups(cuaTools(), [GROUPS[0]])
  const godotOnly = removeToolsByGroups(godotTools(), [GROUPS[1]])
  assert.equal(both.perGroup[0].removed, cuaOnly.perGroup[0].removed)
  assert.equal(both.perGroup[1].removed, godotOnly.perGroup[0].removed)
})

test('⑫ 两组全部放行：一个工具都不摘、同引用、逐组计数全零且 armed=true', () => {
  const assembly = makeAssembly()
  const inputTools = assembly.tools
  const snapshot = JSON.stringify(assembly)

  const result = processAssembly(assembly, { groups: GROUPS, armedGroups: BOTH_ARMED })

  assert.equal(result.changed, false)
  assert.equal(result.assembly, assembly, '放行时必须返回入参同一个 assembly 引用（否则每步都会追写 request/header）')
  assert.equal(result.assembly.tools, inputTools, '工具数组也必须是同一个引用')
  assert.equal(result.totalPresent, 0)
  assert.equal(result.totalRemoved, 0)
  assert.deepEqual(result.removedNames, [])
  assert.deepEqual(result.perGroup, [
    { name: 'cua', prefix: 'cua_driver_native__', armed: true, present: 0, removed: 0, removedNames: [] },
    { name: 'godot', prefix: 'mcp__godot_use__', armed: true, present: 0, removed: 0, removedNames: [] },
  ], '计数必须全零：present=56 会让 lib/index.js 打出假的 fail-loud warn')
  assert.equal(JSON.stringify(assembly), snapshot, '放行不得改动入参')
  assert.equal(assembly.tools.length, 56 + 39 + NON_LAYERED_NAMES.length, '95 个组内工具一个都没少')
})

test('⑬ 对照：同一个装配体，未放行全摘 / 两组都放行全留，差别只在 armedGroups 这一个集合', () => {
  const unarmed = processAssembly(makeAssembly(), { groups: GROUPS })
  const armed = processAssembly(makeAssembly(), { groups: GROUPS, armedGroups: BOTH_ARMED })

  assert.equal(unarmed.changed, true)
  assert.deepEqual(unarmed.perGroup.map((p) => [p.armed, p.present, p.removed]), [[false, 56, 56], [false, 39, 39]])
  assert.equal(unarmed.assembly.tools.length, NON_LAYERED_NAMES.length)

  assert.equal(armed.changed, false)
  assert.deepEqual(armed.perGroup.map((p) => [p.armed, p.present, p.removed]), [[true, 0, 0], [true, 0, 0]])
  assert.equal(armed.assembly.tools.length, 56 + 39 + NON_LAYERED_NAMES.length)

  // 未放行那一侧照旧只删不重建：留下的每个都是入参里的同一个引用
  const source = makeAssembly()
  const kept = processAssembly(source, { groups: GROUPS }).assembly.tools
  for (const item of kept) assert.ok(source.tools.includes(item), `工具对象引用被重建：${item.name}`)
})

test('⑭ 按组放行：只放行 cua ⇒ cua 的工具一个不动、godot 照旧全摘（v0.3.0 的核心语义）', () => {
  const assembly = makeAssembly()
  const inputTools = assembly.tools
  const result = processAssembly(assembly, { groups: GROUPS, armedGroups: new Set(['cua']) })

  assert.equal(result.changed, true, 'godot 那组还在摘，所以装配体确实变了')
  assert.notEqual(result.assembly, assembly)
  assert.equal(result.perGroup[0].armed, true, 'cua 被标 armed')
  assert.equal(result.perGroup[0].present, 0, '被放行的组不计数（否则会打出假的 fail-loud）')
  assert.equal(result.perGroup[0].removed, 0)
  assert.deepEqual(result.perGroup[0].removedNames, [])
  assert.deepEqual(result.perGroup[1].armed, false)
  assert.equal(result.perGroup[1].present, 39)
  assert.equal(result.perGroup[1].removed, 39)

  // 留下来的 = 非组内那批 + 全部 56 个 CUA 工具（顺序仍是入参顺序的子序列）
  assert.equal(result.assembly.tools.length, NON_LAYERED_NAMES.length + 56)
  assert.deepEqual(
    result.assembly.tools.filter((t) => t.name.startsWith('cua_driver_native__')).length,
    56,
  )
  assert.equal(result.assembly.tools.some((t) => t.name.startsWith('mcp__godot_use__')), false)

  // 组表顺序与下标对齐：perGroup[0] 永远是 cua，perGroup[1] 永远是 godot
  assert.deepEqual(result.perGroup.map((p) => p.name), ['cua', 'godot'])
  // 放行的那组不进 totalRemoved / removedNames
  assert.equal(result.totalRemoved, 39)
  assert.equal(result.removedNames.some((n) => n.startsWith('cua_driver_native__')), false)
  assert.equal(new Set(result.removedNames).size, result.removedNames.length)
  // 被放行的工具对象仍是入参那批引用（没被重建、没被移动）
  for (const item of result.assembly.tools) {
    assert.ok(inputTools.includes(item), `工具对象引用被重建：${item.name}`)
  }

  // 反向：只放行 godot ⇒ 镜像结论
  const mirror = processAssembly(makeAssembly(), { groups: GROUPS, armedGroups: new Set(['godot']) })
  assert.deepEqual(mirror.perGroup.map((p) => [p.name, p.armed, p.present, p.removed]),
    [['cua', false, 56, 56], ['godot', true, 0, 0]])
  assert.equal(mirror.assembly.tools.filter((t) => t.name.startsWith('mcp__godot_use__')).length, 39)
  assert.equal(mirror.assembly.tools.some((t) => t.name.startsWith('cua_driver_native__')), false)
})

test('⑮ 放行集合的取值纪律：非 Set 一律按"一个组都没放行"处理（宁可照旧全摘）', () => {
  const tools = makeAssembly().tools

  const all = removeToolsByGroups(tools, GROUPS, { armedGroups: BOTH_ARMED })
  assert.equal(all.tools, tools)
  assert.equal(all.changed, false)
  assert.deepEqual(all.perGroup.map((p) => p.armed), [true, true])

  // 短路发生在形状校验之前：非数组输入在"两组都放行"这条路上一律原样返回
  for (const bad of [undefined, null, 'read', {}]) {
    const result = removeToolsByGroups(bad, GROUPS, { armedGroups: BOTH_ARMED })
    assert.equal(result.tools, bad)
    assert.equal(result.changed, false)
  }

  // 明确传空集合时行为与不传完全一致
  const explicitEmpty = removeToolsByGroups(tools, GROUPS, { armedGroups: new Set() })
  assert.equal(explicitEmpty.changed, true)
  assert.equal(explicitEmpty.totalRemoved, 95)

  // 空组表 + 两组放行：仍然 no-op，perGroup 为空
  const emptyGroups = processAssembly(makeAssembly(), { groups: [], armedGroups: BOTH_ARMED })
  assert.deepEqual(emptyGroups.perGroup, [])
  assert.equal(emptyGroups.changed, false)

  // 非 Set 值一律按"没放行"处理（登记表/配置出错时宁可照旧摘，也不静默全放行）
  for (const weird of [true, 1, 'cua', ['cua'], { cua: true }]) {
    const result = processAssembly(makeAssembly(), { groups: GROUPS, armedGroups: weird })
    assert.equal(result.changed, true, `只有 Set 才算放行：${JSON.stringify(weird)}`)
    assert.deepEqual(result.perGroup.map((p) => p.armed), [false, false])
  }
})

test('⑯ 放行与归属解耦：即使被放行的组不是"最长前缀"的那组，归属判定也不变', () => {
  const groups = [
    { name: 'outer', prefix: 'mcp__x__' },
    { name: 'inner', prefix: 'mcp__x__y__' },
  ]
  const tools = [tool('mcp__x__y__z'), tool('mcp__x__a'), tool('read')]

  // 放行 outer：inner 的工具仍归 inner（最长前缀），照旧被摘
  const result = removeToolsByGroups(tools, groups, { armedGroups: new Set(['outer']) })
  assert.deepEqual(result.perGroup.map((p) => [p.name, p.armed, p.present]), [['outer', true, 0], ['inner', false, 1]])
  assert.deepEqual(result.tools.map((t) => t.name), ['mcp__x__a', 'read'])

  // 反向：放行 inner ⇒ outer 照摘，inner 的同名工具留下
  const mirror = removeToolsByGroups(tools, groups, { armedGroups: new Set(['inner']) })
  assert.deepEqual(mirror.perGroup.map((p) => [p.name, p.armed, p.present]), [['outer', false, 1], ['inner', true, 0]])
  assert.deepEqual(mirror.tools.map((t) => t.name), ['mcp__x__y__z', 'read'])
})

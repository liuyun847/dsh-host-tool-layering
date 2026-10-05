/**
 * `lib/config.js` 的契约测试：默认两组、`diag` / `groups` 的校验、**失败语义**、
 * 未知键（顶层与组内）只忽略不判非法，以及空前缀这类"灾难级误配"必须被拒。
 *
 * 非法配置**不抛错**，而是返回 `{ ok: false, reason }`（`reason` 必须点名非法字段），
 * 由 `lib/index.js` 的 `apply()` 打 error 日志并放弃注册水线。
 * 这里同时锁住"不抛"这条（宿主启动路径不能被配置错误打断）。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  CONFIG_DEFAULTS,
  CONFIG_KEYS,
  DEFAULT_GROUPS,
  GROUP_KEYS,
  deriveGroupName,
  resolveConfig,
} from '../lib/config.js'

/** 取 `ok: true` 的配置，取不到就直接失败（让断言消息明确）。 */
function ok(input) {
  const result = resolveConfig(input)
  assert.equal(result.ok, true, `本应合法：${JSON.stringify(input)}（reason=${result.reason}）`)
  return result.config
}

/** 取 `ok: false` 的 reason。 */
function reasonOf(input) {
  const result = resolveConfig(input)
  assert.equal(result.ok, false, `本应非法：${JSON.stringify(input)}`)
  return result.reason
}

test('缺省配置 = 文档里写的那套默认值（diag false + 默认两组）', () => {
  for (const input of [undefined, null, {}]) {
    const cfg = ok(input)
    assert.equal(cfg.diag, false)
    assert.deepEqual(cfg.groups, [
      { name: 'cua', prefix: 'cua_driver_native__', skill: 'computer-control' },
      { name: 'godot', prefix: 'mcp__godot_use__', skill: 'godot-use' },
    ])
    assert.deepEqual(cfg.unknownKeys, [])
    assert.deepEqual(cfg.unknownGroupKeys, [])
    assert.deepEqual(cfg.duplicatePrefixes, [])
    assert.deepEqual(Object.keys(cfg).sort(), [
      'diag', 'duplicatePrefixes', 'groups', 'unknownGroupKeys', 'unknownKeys',
    ])
  }
  assert.deepEqual(CONFIG_DEFAULTS.diag, false)
  assert.equal(CONFIG_DEFAULTS.groups, DEFAULT_GROUPS, '缺省时直接复用同一份默认组表')
  assert.deepEqual(CONFIG_KEYS, ['diag', 'groups'], '配置面只有这两个顶层键')
  assert.deepEqual(GROUP_KEYS, ['name', 'prefix', 'skill'], '组内只有这三个键')
})

test('diag 覆盖生效，且只认布尔值', () => {
  assert.equal(ok({ diag: true }).diag, true)
  assert.equal(ok({ diag: false }).diag, false)
  // YAML 里写 `diag:`（空值）会得到 null —— 按"未设置"处理，与缺省同义（`??` 语义）
  assert.equal(ok({ diag: null }).diag, false)
  for (const bad of ['yes', 'true', 1, 0, [], {}]) {
    const result = resolveConfig({ diag: bad })
    assert.equal(result.ok, false, `应拒绝：${JSON.stringify(bad)}`)
    assert.match(result.reason, /diag/)
    assert.match(result.reason, /布尔值/)
  }
})

test('非法配置返回 ok:false（不抛错，宿主启动路径不能被配置错误打断）', () => {
  for (const config of [[], 'x', 42, true, { diag: 'yes' }, { diag: 1 }]) {
    assert.doesNotThrow(() => resolveConfig(config), `不该抛：${JSON.stringify(config)}`)
    const result = resolveConfig(config)
    assert.equal(result.ok, false, `应拒绝：${JSON.stringify(config)}`)
    assert.equal(typeof result.reason, 'string')
    assert.ok(result.reason.length > 0, 'reason 必须说明原因')
    assert.equal('config' in result, false, '非法时不该给出半成品 config')
  }
  assert.match(reasonOf([]), /config/, '非对象 config 的 reason 要点名 config')
})

test('groups 非数组 ⇒ 非法（is not array 这类写错必须一步定位）', () => {
  for (const bad of ['cua', 42, true, {}, { cua: 'cua_driver_native__' }]) {
    const reason = reasonOf({ groups: bad })
    assert.match(reason, /groups/)
    assert.match(reason, /数组/)
    assert.match(reason, /groups: \[\]/, 'reason 要告诉用户"想全关就写空数组"这条出路')
  }
  // ⚠ 空值走的是另一条路：YAML 里 `groups:` 得到 null，按"未设置"处理 ⇒ 默认两组
  //（与 diag 的 `??` 语义一致）。想真的一个都不摘，必须显式写 `groups: []`。
  assert.deepEqual(ok({ groups: null }).groups, DEFAULT_GROUPS)
})

test('groups 为空数组合法 ⇒ 什么都不摘（静默 no-op 的配置侧）', () => {
  const cfg = ok({ groups: [] })
  assert.deepEqual(cfg.groups, [])
  assert.equal(cfg.diag, false)
  assert.deepEqual(cfg.duplicatePrefixes, [])
})

test('组项缺 prefix / prefix 非字符串 / 空前缀 ⇒ 非法，且 reason 点名是第几组', () => {
  assert.match(reasonOf({ groups: [{ skill: 'x' }] }), /groups\[0\].*prefix/s)
  assert.match(reasonOf({ groups: [{ prefix: 42 }] }), /prefix.*字符串/s)
  assert.match(reasonOf({ groups: [{ prefix: null }] }), /groups\[0\] 缺少 prefix/)
  // 空前缀是灾难级误配：`''.startsWith('')` 恒真 ⇒ 会把所有工具都摘掉，必须拒绝
  assert.match(reasonOf({ groups: [{ prefix: '' }] }), /空字符串/)
  // 定位信息要能指到第 2 组
  const reason = reasonOf({ groups: [{ prefix: 'a__' }, { prefix: 7 }] })
  assert.match(reason, /groups\[1\]/)
})

test('组项本身不是对象 ⇒ 非法（不抛错）', () => {
  for (const bad of [null, 'cua', 42, true, []]) {
    assert.doesNotThrow(() => resolveConfig({ groups: [bad] }))
    const reason = reasonOf({ groups: [bad] })
    assert.match(reason, /groups\[0\]/)
    assert.match(reason, /对象/)
  }
})

test('组项的 name / skill 可省：name 由 prefix 推出，skill 回落 null', () => {
  const cfg = ok({ groups: [{ prefix: 'mcp__godot_use__' }, { prefix: 'cua_driver_native__', name: 'my-cua' }] })
  assert.deepEqual(cfg.groups, [
    { name: 'godot', prefix: 'mcp__godot_use__', skill: null },
    { name: 'my-cua', prefix: 'cua_driver_native__', skill: null },
  ])
  // 空值（YAML 里 `name:`）同样按"未设置"处理
  const nulled = ok({ groups: [{ prefix: 'x__', name: null, skill: null }] })
  assert.deepEqual(nulled.groups, [{ name: 'x', prefix: 'x__', skill: null }])

  // 但"给了但不是非空字符串"要拒绝
  assert.match(reasonOf({ groups: [{ prefix: 'x__', name: 42 }] }), /name.*非空字符串/s)
  assert.match(reasonOf({ groups: [{ prefix: 'x__', name: '' }] }), /name.*非空字符串/s)
  assert.match(reasonOf({ groups: [{ prefix: 'x__', skill: '' }] }), /skill.*非空字符串/s)
  assert.match(reasonOf({ groups: [{ prefix: 'x__', skill: [] }] }), /skill.*非空字符串/s)
})

test('deriveGroupName：去掉 mcp__ 包装、取第一个 _ 之前的分段', () => {
  assert.equal(deriveGroupName('mcp__godot_use__'), 'godot', '与旧插件的 fail-loud 关键词一致')
  assert.equal(deriveGroupName('cua_driver_native__'), 'cua')
  assert.equal(deriveGroupName('mcp__cua_pre__'), 'cua')
  assert.equal(deriveGroupName('solo'), 'solo')
  assert.equal(deriveGroupName('__weird__'), 'weird')
  assert.equal(deriveGroupName(''), '')
  assert.equal(deriveGroupName(42), '')
})

test('顶层未知键：忽略 + 点名，但**不判非法**（旧插件的取舍原样继承）', () => {
  // 为什么不判非法：拒绝 ⇒ 插件不注册 ⇒ 工具重新出现在可见工具表里（与目标相反）；
  // 容忍 ⇒ 行为完全正确（照常全摘）。详见 lib/config.js 的模块文档串。
  const cfg = ok({ diag: true, allowlist: [], requiredMarker: '__x__' })
  assert.equal(cfg.diag, true)
  assert.deepEqual(cfg.unknownKeys, ['allowlist', 'requiredMarker'])
  assert.deepEqual(ok({ zzz: 1, diag: true, aaa: 2 }).unknownKeys, ['zzz', 'aaa'], '按出现顺序列出')
  assert.deepEqual(ok({ somethingElse: 1 }).unknownKeys, ['somethingElse'])
})

test('组内未知键：忽略 + 点名（带组下标与组名），不判非法', () => {
  const cfg = ok({
    groups: [{ prefix: 'a__', name: 'A', keep: true }, { prefix: 'b__', whitelist: [] }],
  })
  assert.deepEqual(cfg.unknownGroupKeys, [
    { index: 0, name: 'A', key: 'keep' },
    { index: 1, name: 'b', key: 'whitelist' },
  ])
  assert.deepEqual(cfg.groups.map((g) => g.name), ['A', 'b'])
})

test('多个组写同一个 prefix：不判非法，但列进 duplicatePrefixes（后出现的组永远 present=0）', () => {
  const cfg = ok({ groups: [{ prefix: 'x__' }, { prefix: 'y__' }, { prefix: 'x__' }] })
  assert.deepEqual(cfg.duplicatePrefixes, ['x__'])
  assert.equal(cfg.groups.length, 3, '重复 prefix 的组仍然保留在组表里')
  assert.deepEqual(ok({ groups: [{ prefix: 'x__' }, { prefix: 'y__' }] }).duplicatePrefixes, [])
})

test('resolveConfig 对任何输入都不抛错', () => {
  const inputs = [
    undefined, null, {}, [], 'x', 42, true, { diag: [] }, { groups: 'x' },
    { groups: [null] }, { groups: [{ prefix: {} }] }, { groups: [[], {}] },
  ]
  for (const input of inputs) {
    assert.doesNotThrow(() => resolveConfig(input), `不该抛：${JSON.stringify(input)}`)
  }
})

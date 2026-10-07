/**
 * `lib/config.js` 的契约测试：默认两组（含**组内** entryName 的缺省推导）、`diag` / `groups` 的校验、
 * **失败语义**、未知键（顶层与组内）只忽略不判非法，以及空前缀这类"灾难级误配"必须被拒。
 *
 * 非法配置**不抛错**，而是返回 `{ ok: false, reason }`（`reason` 必须点名非法字段），
 * 由 `lib/index.js` 的 `apply()` 打 error 日志并放弃注册水线。
 * 这里同时锁住"不抛"这条（宿主启动路径不能被配置错误打断）。
 *
 * v0.3.0 的签名变化：顶层 `entryName` 删除，入口名改成**组内**键（缺省 `get_<组名>`）；
 * 校验从"一个名字"变成"每组一个名字 + 两组之间的交叉校验（前缀 / 重名）"。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  CONFIG_DEFAULTS,
  CONFIG_KEYS,
  DEFAULT_GROUPS,
  GROUP_KEYS,
  RESERVED_ENTRY_NAMES,
  defaultEntryNameOf,
  deriveGroupName,
  isSafeEntryName,
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

/** 默认两组的**解析后**形态（含缺省推出的 entryName）。 */
const DEFAULT_RESOLVED_GROUPS = [
  { name: 'cua', prefix: 'cua_driver_native__', skill: 'computer-control', entryName: 'get_cua' },
  { name: 'godot', prefix: 'mcp__godot_use__', skill: 'godot-use', entryName: 'get_godot' },
]

test('缺省配置 = 文档里写的那套默认值（diag false + 默认两组，入口名缺省 get_cua / get_godot）', () => {
  for (const input of [undefined, null, {}]) {
    const cfg = ok(input)
    assert.equal(cfg.diag, false)
    assert.deepEqual(cfg.groups, DEFAULT_RESOLVED_GROUPS, '每组一个入口工具，缺省名 = get_<组名>')
    assert.deepEqual(cfg.unknownKeys, [])
    assert.deepEqual(cfg.unknownGroupKeys, [])
    assert.deepEqual(cfg.duplicatePrefixes, [])
    // v0.3.0：解析结果里**没有**顶层 entryName 了（它是组内键）
    assert.deepEqual(Object.keys(cfg).sort(), [
      'diag', 'duplicatePrefixes', 'groups', 'unknownGroupKeys', 'unknownKeys',
    ])
  }
  assert.deepEqual(CONFIG_DEFAULTS.diag, false)
  assert.equal(CONFIG_DEFAULTS.groups, DEFAULT_GROUPS, '缺省时直接复用同一份默认组表')
  assert.equal('entryName' in CONFIG_DEFAULTS, false, '顶层 entryName 已被删除（改成组内键）')
  assert.deepEqual(CONFIG_KEYS, ['diag', 'groups'], '配置面只有这两个顶层键')
  assert.deepEqual(GROUP_KEYS, ['name', 'prefix', 'skill', 'entryName'], '组内是这四个键')
  // 默认组表刻意不写 entryName（让"缺省链路"只有一条路径：prefix → 组名 → get_<组名>）
  assert.deepEqual(DEFAULT_GROUPS.map((group) => Object.keys(group).sort()), [
    ['name', 'prefix', 'skill'], ['name', 'prefix', 'skill'],
  ])
})

test('组内 entryName：覆盖生效；空值（YAML 空值 null）按"未设置"回落缺省名', () => {
  const one = (group) => ok({ groups: [group] }).groups[0]

  assert.equal(one({ prefix: 'cua_driver_native__', entryName: 'get_cua' }).entryName, 'get_cua')
  assert.equal(one({ prefix: 'cua_driver_native__', entryName: 'unlock-cua_tools' }).entryName, 'unlock-cua_tools')
  assert.equal(one({ prefix: 'cua_driver_native__', entryName: null }).entryName, 'get_cua', '空值 = 未设置')
  assert.equal(one({ prefix: 'cua_driver_native__', entryName: undefined }).entryName, 'get_cua')
  assert.equal(one({ prefix: 'cua_driver_native__' }).entryName, 'get_cua', '缺省 = get_<组名>')

  // 缺省推导：组名显式给了就用它；没给就先由 prefix 推出
  assert.equal(one({ name: 'mytools', prefix: 'x__' }).entryName, 'get_mytools')
  assert.equal(one({ prefix: 'mcp__godot_use__' }).entryName, 'get_godot')
  assert.equal(one({ prefix: 'solo' }).entryName, 'get_solo')

  // 每组各写各的：互不影响
  const two = ok({
    groups: [
      { prefix: 'a__', entryName: 'get_a' },
      { prefix: 'b__' },
    ],
  })
  assert.deepEqual(two.groups.map((group) => group.entryName), ['get_a', 'get_b'])
})

test('defaultEntryNameOf：缺省规则只有这一处定义（get_<组名>）', () => {
  assert.equal(defaultEntryNameOf('cua'), 'get_cua')
  assert.equal(defaultEntryNameOf('godot'), 'get_godot')
  assert.equal(defaultEntryNameOf('my-tools'), 'get_my-tools')
  assert.equal(defaultEntryNameOf(''), 'get_')
})

test('组内 entryName：非法值一律拒绝（形态 + 保留名），reason 必须点名第几组、出路与缺省名', () => {
  const bad = ['', ' ', 'get cua', 'get.cua', 'get:cua', 'a'.repeat(65), 42, true, [], {}, '中文名', 'run_code']
  for (const value of bad) {
    const result = resolveConfig({ groups: [{ prefix: 'cua_driver_native__', entryName: value }] })
    assert.equal(result.ok, false, `应拒绝：${JSON.stringify(value)}`)
    assert.match(result.reason, /entryName/)
    assert.match(result.reason, /groups\[0\]/, '要点名是第几组')
    assert.equal('config' in result, false, '非法时不该给出半成品 config')
    assert.match(result.reason, /get_cua/, 'reason 要告诉用户这一组的缺省名是什么')
  }
  // 保留名单独给一条更准确的原因（它形态合法，但注册会抛）
  assert.match(reasonOf({ groups: [{ prefix: 'x__', entryName: 'run_code' }] }), /保留名/)
  assert.match(reasonOf({ groups: [{ prefix: 'x__', entryName: 'run_code' }] }), /get_x/, '保留名那条也要给出缺省名')
  assert.deepEqual(RESERVED_ENTRY_NAMES, ['run_code'])

  // 非字符串（含数字/布尔/数组/对象）走"必须是字符串"那条，而不是形态那条
  assert.match(reasonOf({ groups: [{ prefix: 'x__', entryName: 7 }] }), /必须是字符串/)
  assert.match(reasonOf({ groups: [{ prefix: 'x__', entryName: 7 }] }), /get_x/)
  // 定位信息要能指到第 2 组
  assert.match(reasonOf({ groups: [{ prefix: 'a__' }, { prefix: 'b__', entryName: 'bad name' }] }), /groups\[1\]/)
})

test('组名推出非法入口名（非 ASCII）时也要拒绝，并说清"这是缺省推导出来的"', () => {
  // 组名本身不校验 ASCII（它只进日志），但缺省入口名要进 tools 数组 ⇒ 必须在配置层挡住。
  const reason = reasonOf({ groups: [{ name: '中文组', prefix: 'x__' }] })
  assert.match(reason, /entryName/)
  assert.match(reason, /中文组/, '要点名是哪个组名推出的')
  assert.match(reason, /get_<组名>/, '要说清缺省规则')
})

test('isSafeEntryName：形态判定与保留名判定合在一处', () => {
  for (const good of ['get_cua', 'get-godot', 'a', 'A1_-', 'x'.repeat(64)]) {
    assert.equal(isSafeEntryName(good), true, `应接受：${good}`)
  }
  for (const badOf of ['', 'x'.repeat(65), 'a b', 'a.b', 'a/b', 'a\\b', '中文', 'run_code', 42, null, undefined, {}]) {
    assert.equal(isSafeEntryName(badOf), false, `应拒绝：${String(badOf)}`)
  }
})

test('任意一组的 entryName 落在**任意一组**的 prefix 之下 ⇒ 配置非法（v0.3.0 的逐组逐名 R2）', () => {
  // 为什么必须拒：入口工具是本插件**自己**注册的工具，而摘除的判定就是"名字以组前缀开头" ——
  // 一旦某个入口名以某组前缀开头，那个入口在该组未放行的会话里就会被摘掉（`(会话, 组)` 粒度
  // 下完全可能发生）⇒ 模型侧既看不见入口、又不会得到任何告警（fail-loud 只在"工具在场却
  // 零命中前缀"时触发，这里恰恰是命中了）。
  const own = reasonOf({ groups: [{ prefix: 'cua_driver_native__', entryName: 'cua_driver_native__get' }] })
  assert.match(own, /entryName/)
  assert.match(own, /cua_driver_native__get/, 'reason 要点名 offending 的名字')
  assert.match(own, /cua_driver_native__/, 'reason 要点名命中的 prefix')
  assert.match(own, /cua/, 'reason 要点名是哪个组')
  assert.match(own, /get_cua/, 'reason 要给出路（缺省名）')

  // 跨组：第 1 组的入口名落在第 2 组的前缀下（旧版"两个位置参数比一次"会漏掉这种）
  const cross = reasonOf({
    groups: [
      { prefix: 'mcp__godot_use__x', entryName: 'get_a' },
      { prefix: 'mcp__godot_use__', entryName: 'mcp__godot_use__get' },
    ],
  })
  assert.match(cross, /mcp__godot_use__get/)
  assert.match(cross, /godot/, '要点名被撞的那一组')
  // 反向：第 1 组的入口名落在第 2 组前缀下（顺序无关）
  assert.equal(resolveConfig({
    groups: [
      { prefix: 'zz__', entryName: 'zz__entry' },
      { prefix: 'yy__' },
    ],
  }).ok, false)

  // 默认两组时按默认组表判定
  const godot = reasonOf({ groups: [{ prefix: 'a__' }, { prefix: 'mcp__godot_use__', entryName: 'mcp__godot_use__x' }] })
  assert.match(godot, /mcp__godot_use__/)
  assert.match(godot, /godot/)

  // 边界：正好等于前缀本身（startsWith 恒真）也算命中
  assert.equal(resolveConfig({ groups: [{ prefix: 'cua_driver_native__', entryName: 'cua_driver_native__' }] }).ok, false)
  // 自定义组前缀同样受管
  assert.match(reasonOf({ groups: [{ prefix: 'x__', entryName: 'x__tool' }] }), /x__/)
})

test('入口名与 prefix 的关系：只"含"前缀不算命中，缺省与常规名字一律放行（防误杀）', () => {
  // 合法：缺省名、只含 cua 但不以前缀开头、前缀出现在中间、大小写不同（与 assembly 的大小写敏感语义一致）
  const legal = [
    undefined,
    'get_cua',
    'my_get_cua',
    'get_cua_2',
    'cua',
    'not_cua_driver_native__x',
    'CUA_DRIVER_NATIVE__get',
    'mcp__godot_use', // 少一个下划线 ⇒ 不是前缀
  ]
  for (const entryName of legal) {
    const input = { groups: [{ prefix: 'cua_driver_native__', ...(entryName === undefined ? {} : { entryName }) }] }
    const result = resolveConfig(input)
    assert.equal(result.ok, true, `不该误杀：${String(entryName)}（reason=${result.reason}）`)
    assert.equal(result.config.groups[0].entryName, entryName ?? 'get_cua')
  }

  // `groups: []`（什么都不摘）时不可能撞前缀 ⇒ 任何合法名字都放行
  assert.equal(resolveConfig({ groups: [] }).ok, true)
})

test('交叉校验与既有非法值互不影响：各报各的原因', () => {
  // 保留名：仍走它自己那条更准确的原因（在交叉校验之前判定）
  assert.match(reasonOf({ groups: [{ prefix: 'x__', entryName: 'run_code' }] }), /保留名/)
  // 形态非法：即使它同时"落在前缀下"，也只报形态问题（先判形态）
  assert.match(reasonOf({ groups: [{ prefix: 'cua_driver_native__', entryName: 'cua_driver_native__ get' }] }), /ASCII 工具名/)
  assert.match(reasonOf({ groups: [{ prefix: 'x__', entryName: '中文前缀中文' }] }), /ASCII 工具名/)
  assert.match(reasonOf({ groups: [{ prefix: 'x__', entryName: 'x'.repeat(65) }] }), /ASCII 工具名/)
  // 组表本身非法时，仍优先报组表的问题（交叉校验在组表规范化之后，走不到）
  assert.match(reasonOf({ entryName: 'a__x', groups: 'cua' }), /groups/)
  assert.match(reasonOf({ groups: [{ prefix: '' }] }), /空字符串/)
  // 一次只报一条、且不抛错
  assert.doesNotThrow(() => resolveConfig({ groups: [{ prefix: 'cua_driver_native__', entryName: 'cua_driver_native__x' }] }))
})

test('入口名之间不得重名（显式×显式 / 显式×另一组的缺省推导名）⇒ 配置非法', () => {
  // 两组都显式写同一个名字
  const bothExplicit = reasonOf({
    groups: [
      { name: 'a', prefix: 'a__', entryName: 'get_same' },
      { name: 'b', prefix: 'b__', entryName: 'get_same' },
    ],
  })
  assert.match(bothExplicit, /entryName/)
  assert.match(bothExplicit, /重名/)
  assert.match(bothExplicit, /"get_same"/)
  assert.match(bothExplicit, /groups\[0\]/)
  assert.match(bothExplicit, /groups\[1\]/)
  assert.match(bothExplicit, /"a"/, '要点名两组各自叫什么')
  assert.match(bothExplicit, /"b"/)

  // 显式写的名字撞上另一组**缺省推导**出来的名字（这是最容易漏的一种）
  const withDefault = reasonOf({
    groups: [
      { name: 'cua', prefix: 'cua_driver_native__' },            // 缺省 get_cua
      { name: 'x', prefix: 'x__', entryName: 'get_cua' },
    ],
  })
  assert.match(withDefault, /"get_cua"/)
  assert.match(withDefault, /缺省/)

  // 同 prefix 的两组各自缺省推导 ⇒ 组名相同 ⇒ 入口名撞车（v0.3.0 起这条判非法，
  // 想保留"同前缀两组"必须显式给其中一组写一个不同的 entryName）
  assert.equal(resolveConfig({ groups: [{ prefix: 'x__' }, { prefix: 'x__' }] }).ok, false)
  assert.match(reasonOf({ groups: [{ prefix: 'x__' }, { prefix: 'x__' }] }), /重名/)
  // 给了不同的显式名就合法（重复 prefix 本身仍只 warn，见后面的用例）
  assert.equal(resolveConfig({
    groups: [{ prefix: 'x__', entryName: 'get_x1' }, { prefix: 'x__', entryName: 'get_x2' }],
  }).ok, true)
})

test('顶层 entryName（v0.2.0 的旧键）现在只是"不认得的键"：不判非法、原样列进 unknownKeys', () => {
  // 升级路上必然出现"旧配置 + 新代码"的中间态：这时候**宁可忽略也不要拒绝** ——
  // 拒绝 ⇒ 插件不注册 ⇒ 工具全部重新可见（与目标相反）。旧的顶层值也不会影响组内缺省。
  const cfg = ok({ entryName: 'get_cua' })
  assert.deepEqual(cfg.unknownKeys, ['entryName'])
  assert.deepEqual(cfg.groups, DEFAULT_RESOLVED_GROUPS)
  // 就算旧值是保留名，也照样只是"不认得的键"（它已经不参与注册了）
  assert.deepEqual(ok({ entryName: 'run_code' }).unknownKeys, ['entryName'])
  assert.equal(resolveConfig({ entryName: 'run_code' }).ok, true)
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
  assert.deepEqual(ok({ groups: null }).groups, DEFAULT_RESOLVED_GROUPS)
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

test('组项的 name / skill 可省：name 由 prefix 推出，skill 回落 null（entryName 相应缺省推导）', () => {
  const cfg = ok({ groups: [{ prefix: 'mcp__godot_use__' }, { prefix: 'cua_driver_native__', name: 'my-cua' }] })
  assert.deepEqual(cfg.groups, [
    { name: 'godot', prefix: 'mcp__godot_use__', skill: null, entryName: 'get_godot' },
    { name: 'my-cua', prefix: 'cua_driver_native__', skill: null, entryName: 'get_my-cua' },
  ])
  // 空值（YAML 里 `name:`）同样按"未设置"处理
  const nulled = ok({ groups: [{ prefix: 'x__', name: null, skill: null, entryName: null }] })
  assert.deepEqual(nulled.groups, [{ name: 'x', prefix: 'x__', skill: null, entryName: 'get_x' }])

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

test('多个组写同一个 prefix：给了不同 entryName 时仍不判非法，列进 duplicatePrefixes', () => {
  const cfg = ok({
    groups: [
      { prefix: 'x__', entryName: 'get_x1' },
      { prefix: 'y__' },
      { prefix: 'x__', entryName: 'get_x2' },
    ],
  })
  assert.deepEqual(cfg.duplicatePrefixes, ['x__'])
  assert.equal(cfg.groups.length, 3, '重复 prefix 的组仍然保留在组表里')
  assert.deepEqual(ok({ groups: [{ prefix: 'x__' }, { prefix: 'y__' }] }).duplicatePrefixes, [])
})

test('resolveConfig 对任何输入都不抛错', () => {
  const inputs = [
    undefined, null, {}, [], 'x', 42, true, { diag: [] }, { groups: 'x' },
    { groups: [null] }, { groups: [{ prefix: {} }] }, { groups: [[], {}] },
    { groups: [{ prefix: 'x__', entryName: {} }] },
    { groups: [{ prefix: 'x__' }, { prefix: 'x__' }] },
  ]
  for (const input of inputs) {
    assert.doesNotThrow(() => resolveConfig(input), `不该抛：${JSON.stringify(input)}`)
  }
})

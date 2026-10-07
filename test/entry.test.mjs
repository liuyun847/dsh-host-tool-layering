/**
 * `lib/entry.js` 的契约测试：入口工具的**定义面**（走**真实的** `defineTool`）、
 * 按 `(会话, 组)` 放行与幂等、会话隔离、组隔离、取不到会话身份时的失败语义、
 * 以及"只说能拿到什么"的短描述 / 短 render。
 *
 * ⚠ 本文件 import 了真实的 `@deepseek-ai/dsh-tools`（`lib/entry.js` 用它拿 `defineTool`）
 * ⇒ 跑测试的机器上必须能解析到 dsh 安装树（profile 级 `node_modules` 的 junction），
 * 见 README §10。这样测的才是宿主真正会拿到的那份定义，而不是一个自造的桩。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'

import {
  armGroup,
  armedGroupCount,
  armedGroupsOf,
  armedSessionCount,
  describeEntryTool,
  isArmed,
  isGroupArmed,
  makeEntryTool,
  resetArmedSessions,
  sessionIdOf,
} from '../lib/entry.js'

/** 默认两组的组配置（`lib/config.js` 解析后的形态）。 */
const CUA_GROUP = { name: 'cua', prefix: 'cua_driver_native__', entryName: 'get_cua' }
const GODOT_GROUP = { name: 'godot', prefix: 'mcp__godot_use__', entryName: 'get_godot' }

/** 文档口径的两句描述（英文、一句话、"只说能拿到什么"）。 */
const CUA_DESCRIPTION = 'Reveal the computer-control tools (cua_driver_native__*: 46 desktop + 10 browser) in this session.'
const GODOT_DESCRIPTION = 'Reveal the Godot MCP tools (mcp__godot_use__*) in this session.'

/** 造某个组的入口工具 + 日志收集器。 */
function entry(group = CUA_GROUP) {
  const logs = []
  const tool = makeEntryTool({ group, log: (fn, message) => logs.push({ fn, message }) })
  return { tool, logs }
}

test('定义面（cua）：走真实 defineTool，name/parameters/output 的形状与宿主期望一致', () => {
  const { tool } = entry()

  assert.equal(tool.name, 'get_cua', '名字来自该组配置的 entryName')
  // 无参数：空 property map 编译成 object 根 + 空 properties
  assert.deepEqual(tool.parameters, { type: 'object', properties: {} })
  // 值 schema：作者 DSL 的 `additionalProperties` 必须显式写，required 由嵌套的 required:true 提升上来
  assert.deepEqual(tool.output.schema, {
    type: 'object',
    additionalProperties: false,
    properties: {
      group: { type: 'string' },
      armed: { type: 'boolean' },
      alreadyArmed: { type: 'boolean' },
    },
    required: ['group', 'armed', 'alreadyArmed'],
  })
  assert.equal(typeof tool.execute, 'function')
  assert.equal(typeof tool.output.render, 'function')
})

test('定义面：description 只说"能拿到什么"—— 一句话、英文、≤120 字符、不含机制解释', () => {
  const { tool } = entry()
  assert.equal(tool.description, CUA_DESCRIPTION)
  assert.ok(tool.description.length <= 120, `描述必须 ≤120 字符，当前 ${tool.description.length}`)
  assert.equal(/[\u4e00-\u9fff]/.test(tool.description), false, '描述用英文（省 token）')
  // 机制解释（一步时延 / 为什么需要它 / 幂等 / 会话级 / 不是能力边界）属于 README，不属于工具定义
  for (const banned of ['幂等', '下一步', '会话级', '能力边界', '工具加载入口', 'idempotent', 'next step', 'session-level']) {
    assert.equal(tool.description.includes(banned), false, `描述里不该出现机制解释："${banned}"`)
  }
  assert.equal(tool.description.split('.').filter((part) => part.trim().length > 0).length, 1, '就一句话')
})

test('定义面（godot）：description 同样一句话、≤120 字符，且与 cua 那句不同', () => {
  const godot = entry(GODOT_GROUP).tool
  assert.equal(godot.name, 'get_godot')
  assert.equal(godot.description, GODOT_DESCRIPTION)
  assert.ok(godot.description.length <= 120, `描述必须 ≤120 字符，当前 ${godot.description.length}`)
  assert.notEqual(godot.description, CUA_DESCRIPTION, '两组各说各的（不是一句通用文案）')
  assert.equal(/[\u4e00-\u9fff]/.test(godot.description), false)
})

test('describeEntryTool：自定义组走缺省推导 `Reveal the <组名> tools (prefix <前缀>) in this session.`', () => {
  assert.equal(
    describeEntryTool({ name: 'mytools', prefix: 'x__' }),
    'Reveal the mytools tools (prefix x__) in this session.',
  )
  // 内置两组按 **prefix** 认（改组名不影响描述：描述讲的是这批工具，prefix 才是它的身份）
  assert.equal(describeEntryTool({ name: '被改过的名字', prefix: 'cua_driver_native__' }), CUA_DESCRIPTION)
  assert.equal(describeEntryTool({ name: '被改过的名字', prefix: 'mcp__godot_use__' }), GODOT_DESCRIPTION)
  // 缺字段时也不抛（描述不该成为失败点）
  assert.equal(describeEntryTool({}), 'Reveal the ? tools (prefix ?) in this session.')
})

test('首次调用：放行该 (会话, 组) + 返回 canonical value，且返回值过宿主的输出校验', async () => {
  resetArmedSessions()
  const { tool, logs } = entry()

  const value = await tool.execute({}, { agent: { id: 'session-A' } })

  assert.deepEqual(value, { group: 'cua', armed: true, alreadyArmed: false })
  assert.equal(isGroupArmed('session-A', 'cua'), true)
  assert.equal(isArmed('session-A'), true)
  assert.equal(armedSessionCount(), 1)
  assert.equal(armedGroupCount(), 1)
  // 宿主会拿 output.schema 校验返回体（dsh-tools 的 snapshotToolValue → INVALID_TOOL_OUTPUT），
  // 这里用同一个校验器把关，避免"返回体不合 schema"这种只在真机上炸的坑。
  assert.deepEqual(validateJsonSchemaValue(tool.output.schema, value, ''), [])
  assert.deepEqual(logs.map((l) => l.fn), ['info'], '首次放行打一条 info')
  assert.match(logs[0].message, /session-A/)
  assert.match(logs[0].message, /已放回/)
  assert.match(logs[0].message, /cua/)
})

test('重复调用：幂等 —— 登记表不变、不再打日志、返回 alreadyArmed: true', async () => {
  resetArmedSessions()
  const { tool, logs } = entry()

  const first = await tool.execute({}, { agent: { id: 'session-A' } })
  const second = await tool.execute({}, { agent: { id: 'session-A' } })
  const third = await tool.execute({}, { agent: { id: 'session-A' } })

  assert.deepEqual(first, { group: 'cua', armed: true, alreadyArmed: false })
  assert.deepEqual(second, { group: 'cua', armed: true, alreadyArmed: true })
  assert.deepEqual(third, { group: 'cua', armed: true, alreadyArmed: true })
  assert.equal(armedGroupCount(), 1, '重复调用不该多长出登记项')
  assert.equal(armedSessionCount(), 1)
  assert.equal(logs.length, 1, '只有首次放行打日志（重复调用不刷屏）')
  assert.deepEqual(validateJsonSchemaValue(tool.output.schema, second, ''), [])
})

test('组隔离：放行 cua 不影响 godot（同一个会话里两组互不牵连）', async () => {
  resetArmedSessions()
  const cua = entry(CUA_GROUP).tool
  const godot = entry(GODOT_GROUP).tool

  await cua.execute({}, { agent: { id: 'session-A' } })
  assert.equal(isGroupArmed('session-A', 'cua'), true)
  assert.equal(isGroupArmed('session-A', 'godot'), false, 'v0.3.0 的核心：点一个入口只放行那一组')
  assert.deepEqual([...armedGroupsOf('session-A')], ['cua'])
  assert.equal(armedGroupCount(), 1)

  await godot.execute({}, { agent: { id: 'session-A' } })
  assert.equal(isGroupArmed('session-A', 'godot'), true)
  assert.deepEqual([...armedGroupsOf('session-A')].sort(), ['cua', 'godot'], '两组各记各的')
  assert.equal(armedSessionCount(), 1, '还是同一个会话')
  assert.equal(armedGroupCount(), 2)
})

test('会话隔离：A 被放行不影响 B，也不影响未放行的 C', async () => {
  resetArmedSessions()
  const { tool } = entry()

  await tool.execute({}, { agent: { id: 'session-A' } })

  assert.equal(isGroupArmed('session-A', 'cua'), true)
  assert.equal(isGroupArmed('session-B', 'cua'), false)
  assert.equal(isArmed('session-B'), false)
  assert.equal(isArmed('session-C'), false)
  assert.equal(armedSessionCount(), 1)

  await tool.execute({}, { agent: { id: 'session-B' } })
  assert.equal(armedSessionCount(), 2)
  assert.equal(isArmed('session-C'), false)
})

test('取不到会话身份 ⇒ 抛清晰错误，且**不登记任何东西**（绝不退化成"全体放行"）', async () => {
  resetArmedSessions()
  const { tool, logs } = entry()

  for (const exec of [{}, { agent: undefined }, { agent: null }, { agent: {} }, { agent: { id: '' } }]) {
    await assert.rejects(() => tool.execute({}, exec), /取不到调用方会话身份/)
  }
  assert.equal(armedSessionCount(), 0, '取不到身份时登记表必须保持为空')
  assert.equal(armedGroupCount(), 0)
  assert.deepEqual(logs, [], '失败路径不打"已放行"日志')
})

test('armGroup：只加不减、幂等、返回"此前是否已放行"；非法入参抛清晰错误', () => {
  resetArmedSessions()
  assert.equal(armGroup('session-A', 'cua'), false, '首次')
  assert.equal(armGroup('session-A', 'cua'), true, '重复')
  assert.equal(armGroup('session-A', 'godot'), false, '另一个组是新的登记项')
  assert.deepEqual([...armedGroupsOf('session-A')].sort(), ['cua', 'godot'])
  assert.equal(armedSessionCount(), 1)
  assert.equal(armedGroupCount(), 2)

  assert.throws(() => armGroup('session-A', ''), /groupName/)
  assert.throws(() => armGroup('session-A', 42), /groupName/)
  assert.throws(() => armGroup('', 'cua'), /sessionId/)
  assert.throws(() => armGroup(undefined, 'cua'), /sessionId/)
  // 前面的失败调用没有污染登记表
  assert.equal(armedGroupCount(), 2)
})

test('isGroupArmed / isArmed / armedGroupsOf：非字符串、空串、未登记的会话一律 false / 空表', async () => {
  resetArmedSessions()
  const { tool } = entry()
  await tool.execute({}, { agent: { id: 'session-A' } })

  assert.equal(isGroupArmed('session-A', 'cua'), true)
  assert.equal(isGroupArmed('session-A', 'godot'), false)
  for (const bad of ['session-B', '', undefined, null, 42, {}, ['session-A']]) {
    assert.equal(isGroupArmed(bad, 'cua'), false, `不该算已放行：${String(bad)}`)
    assert.equal(isArmed(bad), false, `不该算已放行：${String(bad)}`)
    assert.equal(armedGroupsOf(bad).size, 0, `空表：${String(bad)}`)
  }
  // 组名不是字符串 ⇒ false（不抛）
  for (const badGroup of [undefined, null, 42, {}]) {
    assert.equal(isGroupArmed('session-A', badGroup), false)
  }
})

test('sessionIdOf：优先声明面的 id，退回运行面的 session.id，都取不到返回 undefined', () => {
  assert.equal(sessionIdOf({ id: 'session-A' }), 'session-A')
  assert.equal(sessionIdOf({ session: { id: 'session-A' } }), 'session-A')
  assert.equal(sessionIdOf({ id: 'session-A', session: { id: 'session-B' } }), 'session-A', '两者都在时以 id 为准')
  assert.equal(sessionIdOf({ id: '' }), undefined, '空串不算身份')
  assert.equal(sessionIdOf({}), undefined)
  assert.equal(sessionIdOf(undefined), undefined)
  assert.equal(sessionIdOf('session-A'), undefined, '字符串本身不是身份载体')
})

test('render：两态都是**一行短中文**（≤40 字符），且各自点名是哪一组', async () => {
  resetArmedSessions()
  const { tool } = entry()

  const first = await tool.execute({}, { agent: { id: 'session-A' } })
  const again = await tool.execute({}, { agent: { id: 'session-A' } })

  const firstText = tool.output.render({}, first).map((block) => block.text).join('\n')
  const againText = tool.output.render({}, again).map((block) => block.text).join('\n')

  assert.equal(firstText, '已放回 cua 组工具（下一步起可见）。')
  assert.equal(againText, '该组此前已放回，无需重复调用。')
  for (const text of [firstText, againText]) {
    assert.ok(text.length <= 40, `render 必须 ≤40 字符，当前 ${text.length}：${text}`)
    assert.equal(text.includes('\n'), false, 'render 就一行')
    assert.equal(text.includes('{'), false, '不要把 canonical value dump 到会话历史里')
  }
  assert.notEqual(firstText, againText)

  // 另一组：文案里点名的是它自己
  const godotText = entry(GODOT_GROUP).tool.output.render({}, { group: 'godot', armed: true, alreadyArmed: false })[0].text
  assert.equal(godotText, '已放回 godot 组工具（下一步起可见）。')
})

test('工具名由该组配置给定（entryName），缺 group 字段时也能构造', async () => {
  resetArmedSessions()
  const tool = makeEntryTool({ group: { name: 'x', prefix: 'x__', entryName: 'unlock_tools' } })
  assert.equal(tool.name, 'unlock_tools')
  const value = await tool.execute({}, { agent: { id: 'session-Z' } })
  assert.deepEqual(value, { group: 'x', armed: true, alreadyArmed: false })
  assert.equal(isGroupArmed('session-Z', 'x'), true)
})

test('resetArmedSessions：只给测试用的清空口，返回清掉的会话数（组也随之清空）', async () => {
  resetArmedSessions()
  const cua = entry(CUA_GROUP).tool
  const godot = entry(GODOT_GROUP).tool
  await cua.execute({}, { agent: { id: 'session-A' } })
  await godot.execute({}, { agent: { id: 'session-A' } })
  await cua.execute({}, { agent: { id: 'session-B' } })
  assert.equal(armedGroupCount(), 3)

  assert.equal(resetArmedSessions(), 2)
  assert.equal(armedSessionCount(), 0)
  assert.equal(armedGroupCount(), 0)
  assert.equal(isGroupArmed('session-A', 'cua'), false)
  assert.equal(isArmed('session-A'), false)
  assert.equal(resetArmedSessions(), 0, '空表再清一次也不出错')
})

/**
 * `lib/skills.js` 的契约测试：技能根目录候选表的取法、技能名安全校验、
 * 存在性判定的**缓存**与"绝不抛错"，以及默认 `fs.existsSync` 这条真实磁盘路径。
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { SKILL_FILE_NAME, createSkillProbe, isSafeSkillName, resolveSkillRoots } from '../lib/skills.js'

test('resolveSkillRoots：USERPROFILE 优先，DSH_HOME 次之，等价路径去重', () => {
  assert.deepEqual(resolveSkillRoots({ USERPROFILE: 'C:\\Users\\X' }), [path.join('C:\\Users\\X', '.dsh', 'skills')])
  assert.deepEqual(resolveSkillRoots({ DSH_HOME: 'D:\\dsh' }), [path.join('D:\\dsh', 'skills')])

  // 本机形态：DSH_HOME 与 USERPROFILE\.dsh 指同一处 ⇒ 去重成一项
  const same = resolveSkillRoots({ USERPROFILE: 'C:\\Users\\X', DSH_HOME: 'C:\\Users\\X\\.dsh' })
  assert.equal(same.length, 1, '同一处技能目录不该出现两次')
  assert.equal(same[0], path.join('C:\\Users\\X', '.dsh', 'skills'))

  // 指不同处 ⇒ 两个候选都留着（任一命中即算存在，避免把装好的技能误报成缺失）
  const both = resolveSkillRoots({ USERPROFILE: 'C:\\Users\\X', DSH_HOME: 'D:\\dsh', HOME: 'C:\\Users\\Y' })
  assert.equal(both.length, 3)
  assert.equal(both[0], path.join('C:\\Users\\X', '.dsh', 'skills'), '任务口径排第一')
})

test('resolveSkillRoots：环境变量都为空时回落 homedir；连 homedir 都取不到则空表', () => {
  assert.deepEqual(resolveSkillRoots({}, () => 'C:\\Users\\Z'), [path.join('C:\\Users\\Z', '.dsh', 'skills')])
  assert.deepEqual(resolveSkillRoots({ USERPROFILE: '  ' }, () => 'C:\\Users\\Z'), [path.join('C:\\Users\\Z', '.dsh', 'skills')])
  assert.deepEqual(resolveSkillRoots({}, () => ''), [], '取不到任何根目录时报空表，由调用方按"无法校验"处理')
  assert.deepEqual(resolveSkillRoots({}, () => { throw new Error('no home') }), [], '取家目录抛错也不该把异常放出去')
})

test('isSafeSkillName：非 ASCII 名可以，路径分隔符与 Windows 非法字符一律拒绝', () => {
  for (const good of ['godot-use', 'computer-control', 'godot_use', '技能名', 'a.b', 'a b']) {
    assert.equal(isSafeSkillName(good), true, `应接受：${good}`)
  }
  for (const bad of ['', '.', '..', 'a/b', 'a\\b', 'a:b', 'a*b', 'a?b', 'a"b', 'a<b', 'a>b', 'a|b', 'a\u0000b', 42, null, undefined, {}]) {
    assert.equal(isSafeSkillName(bad), false, `应拒绝：${String(bad)}`)
  }
})

test('filePathOf：拼 <root>\\<skill>\\SKILL.md；非法名或空根表返回 null', () => {
  const probe = createSkillProbe({ roots: ['C:\\skills'] })
  assert.equal(SKILL_FILE_NAME, 'SKILL.md')
  assert.equal(probe.filePathOf('godot-use'), path.join('C:\\skills', 'godot-use', 'SKILL.md'))
  assert.equal(probe.filePathOf('../evil'), null, '非法技能名不拼路径（不让 stat 越出技能根目录）')
  assert.equal(createSkillProbe({ roots: [] }).filePathOf('godot-use'), null)
})

test('exists：命中即停、结果按技能名缓存（每个技能只碰一次磁盘）', () => {
  const calls = []
  const probe = createSkillProbe({
    roots: ['C:\\skills'],
    existsSync: (filePath) => { calls.push(filePath); return filePath.includes('godot-use') },
  })

  assert.equal(probe.exists('godot-use'), true)
  assert.equal(probe.exists('godot-use'), true)
  assert.equal(calls.length, 1, '第二次必须命中缓存，不再 stat')

  assert.equal(probe.exists('missing-skill'), false)
  assert.equal(probe.exists('missing-skill'), false)
  assert.equal(calls.length, 2, '不存在的结论同样缓存')

  // 非法技能名连磁盘都不碰
  assert.equal(probe.exists('../evil'), false)
  assert.equal(probe.exists(''), false)
  assert.equal(probe.exists(null), false)
  assert.equal(calls.length, 2, '非法技能名不该触发 stat')
})

test('exists：多个候选根目录任一命中即算存在（按优先级短路）', () => {
  const seen = []
  const probe = createSkillProbe({
    roots: ['C:\\first', 'D:\\second'],
    existsSync: (filePath) => { seen.push(filePath); return filePath.startsWith('D:\\second') },
  })
  assert.equal(probe.exists('godot-use'), true)
  assert.deepEqual(seen, [
    path.join('C:\\first', 'godot-use', 'SKILL.md'),
    path.join('D:\\second', 'godot-use', 'SKILL.md'),
  ], '第一个根目录未命中才看第二个')
})

test('exists：existsSync 抛错按"不存在"处理，绝不把异常抛到装配路径上', () => {
  const probe = createSkillProbe({ roots: ['C:\\skills'], existsSync: () => { throw new Error('EACCES') } })
  assert.doesNotThrow(() => probe.exists('godot-use'))
  assert.equal(probe.exists('godot-use'), false)
})

test('warned / markWarned：按技能名记"已经点名过"', () => {
  const probe = createSkillProbe({ roots: ['C:\\skills'] })
  assert.equal(probe.warned('godot-use'), false)
  probe.markWarned('godot-use')
  assert.equal(probe.warned('godot-use'), true)
  assert.equal(probe.warned('computer-control'), false, '两个技能互不影响')
  probe.markWarned(null)
  assert.equal(probe.warned(null), false, '非法名不记账')
})

test('默认 fs.existsSync 这条真实路径可用（临时目录里真的建一个 SKILL.md）', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-skill-probe-'))
  try {
    const skillDir = path.join(root, 'godot-use')
    fs.mkdirSync(skillDir)
    fs.writeFileSync(path.join(skillDir, SKILL_FILE_NAME), '# 说明书\n', 'utf8')

    const probe = createSkillProbe({ roots: [root] })
    assert.equal(probe.exists('godot-use'), true)
    assert.equal(probe.exists('godot-use'), true, '第二次走缓存')
    assert.equal(probe.exists('computer-control'), false, '同根目录下的另一个技能确实不存在')
    assert.equal(fs.existsSync(probe.filePathOf('godot-use')), true)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

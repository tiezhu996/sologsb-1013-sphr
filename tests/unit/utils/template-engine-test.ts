import { module, test } from 'qunit';
import type { CueTemplate, WorkspaceState } from 'stage-cue-editor/models/show';
import {
  ApplyTemplateError,
  addTemplateCue,
  buildSceneFromTemplate,
  checksum,
  clone,
  effectiveVersion,
  emptyTemplate,
  emptyTemplateCue,
  findTemplate,
  initialWorkspace,
  latestReleasedVersion,
  migrateLegacyShow,
  migrateScene,
  moveResolvedCue,
  nextCueId,
  releaseTemplate,
  resolveScene,
  setOverrideField,
  uid,
  validateTemplate,
} from 'stage-cue-editor/utils/template-engine';

function cue(
  cueId: string,
  title: string,
  duration: number,
  owner: string,
  extra = {},
) {
  return { ...emptyTemplateCue(cueId), title, duration, owner, ...extra };
}

function templateWith(cues: ReturnType<typeof cue>[]): CueTemplate {
  const template = emptyTemplate('测试模板');
  cues.forEach((item) => addTemplateCue(template, item));
  return template;
}

module('Unit | 模板与场次所有权', function () {
  test('模板工作版字段改动后，未覆盖场次立即按新值解析', function (assert) {
    const template = templateWith([cue('c1', '灯光起', 60, '李岚')]);
    const scene = buildSceneFromTemplate(template, template.current, {
      act: '第一幕',
      name: 'S1',
      title: '测试场',
      startTime: '19:30',
    });
    const state: WorkspaceState = {
      show: { ...initialWorkspace().show, scenes: [scene] },
      templates: [template],
    };

    assert.strictEqual(resolveScene(scene, template)[0]!.duration, 60);

    // 另一场对同一条提示做了本场覆盖
    const other = buildSceneFromTemplate(template, template.current, {
      act: '第一幕',
      name: 'S2',
      title: '另一场',
      startTime: '20:00',
    });
    setOverrideField(other, template, 'c1', 'duration', 90);
    state.show.scenes.push(other);

    // 模板一改
    template.current.cues[0]!.duration = 120;
    template.current.cues[0]!.owner = '周启';

    // 未覆盖场次立即取新值
    const resolvedFirst = resolveScene(
      scene,
      findTemplate(state, scene.templateId),
    );
    assert.strictEqual(resolvedFirst[0]!.duration, 120, '未覆盖时长立即重算');
    assert.strictEqual(
      resolvedFirst[0]!.owner,
      '周启',
      '未覆盖负责人立即取新值',
    );
    assert.deepEqual(resolvedFirst[0]!.overridden, [], '没有产生覆盖记录');

    // 做过覆盖的场次保留自己的值
    const resolvedOther = resolveScene(other, template);
    assert.strictEqual(
      resolvedOther[0]!.duration,
      90,
      '本场覆盖优先于模板新值',
    );
    assert.strictEqual(
      resolvedOther[0]!.owner,
      '周启',
      '未覆盖的负责人仍跟随新值',
    );
  });

  test('覆盖值改回与模板一致时自动清除，不残留覆盖', function (assert) {
    const template = templateWith([cue('c1', '灯光起', 60, '李岚')]);
    const scene = buildSceneFromTemplate(template, template.current, {
      act: '第一幕',
      name: 'S1',
      title: '测试场',
      startTime: '19:30',
    });

    setOverrideField(scene, template, 'c1', 'duration', 120);
    assert.strictEqual(scene.overrides.length, 1);
    setOverrideField(scene, template, 'c1', 'duration', 60);
    assert.strictEqual(scene.overrides.length, 0, '恢复模板值后覆盖被清除');
  });

  test('本场顺序覆盖不影响模板，也不影响其他场次', function (assert) {
    const template = templateWith([
      cue('c1', '第一条', 10, '李岚'),
      cue('c2', '第二条', 10, '周启'),
    ]);
    const sceneA = buildSceneFromTemplate(template, template.current, {
      act: '第一幕',
      name: 'S1',
      title: 'A',
      startTime: '19:30',
    });
    const sceneB = buildSceneFromTemplate(template, template.current, {
      act: '第一幕',
      name: 'S2',
      title: 'B',
      startTime: '20:00',
    });

    moveResolvedCue(sceneA, template, 't:x:c1', 't:x:c2');
    assert.deepEqual(sceneA.order, ['c2', 'c1'], '本场记录顺序覆盖');
    assert.deepEqual(
      template.current.cues.map((item) => item.cueId),
      ['c1', 'c2'],
      '模板顺序未变',
    );

    const orderA = resolveScene(sceneA, template).map((item) => item.cueId);
    const orderB = resolveScene(sceneB, template).map((item) => item.cueId);
    assert.deepEqual(orderA, ['c2', 'c1'], 'A 场按本场顺序');
    assert.deepEqual(orderB, ['c1', 'c2'], 'B 场仍按模板顺序');
  });
});

module('Unit | 模板发布、钉版与迁移', function () {
  test('发布新版本后钉版场次停留旧版，跟随场次取新版', function (assert) {
    const template = templateWith([cue('c1', '旧标题', 60, '李岚')]);
    const pinned = buildSceneFromTemplate(template, template.current, {
      act: '第一幕',
      name: 'S1',
      title: '钉版场',
      startTime: '19:30',
    });
    // buildSceneFromTemplate 直接钉住 v1（此时尚未 release，模拟已发布状态）
    template.current.version = 2;
    template.releases = [
      {
        version: 1,
        updatedAt: new Date().toISOString(),
        cues: [cue('c1', '旧标题', 60, '李岚')],
      },
    ];
    pinned.templateVersion = 1;
    const following = buildSceneFromTemplate(template, template.current, {
      act: '第一幕',
      name: 'S2',
      title: '跟随场',
      startTime: '20:00',
    });
    following.templateVersion = null;

    template.current.cues[0]!.title = '新标题';
    template.current.cues[0]!.duration = 120;

    assert.strictEqual(
      resolveScene(pinned, template)[0]!.title,
      '旧标题',
      '钉版场保留旧值',
    );
    assert.true(resolveScene(pinned, template)[0]!.pinned, '标记为钉版解析');
    assert.strictEqual(
      resolveScene(following, template)[0]!.title,
      '新标题',
      '跟随场取工作版新值',
    );
  });

  test('迁移到新版本：匹配 cueId 的覆盖保留，失配覆盖转入 detached，新增提示出现', function (assert) {
    const template = templateWith([
      cue('keep', '保留项', 60, '李岚'),
      cue('gone', '将被删除', 30, '周启'),
    ]);
    releaseTemplate(template, 'v1');

    const scene = buildSceneFromTemplate(
      template,
      latestReleasedVersion(template)!,
      { act: '第一幕', name: 'S1', title: '旧场', startTime: '19:30' },
    );
    setOverrideField(scene, template, 'keep', 'duration', 200);
    setOverrideField(scene, template, 'gone', 'owner', '陈默');
    assert.strictEqual(scene.overrides.length, 2);

    // 模板升级：删 gone，加 fresh
    template.current.cues = template.current.cues.filter(
      (item) => item.cueId !== 'gone',
    );
    addTemplateCue(template, cue('fresh', '新增项', 45, '孙禾'));
    releaseTemplate(template, 'v2');

    const result = migrateScene(scene, template, 2);
    assert.strictEqual(result.retained, 1, '保留 1 条匹配覆盖');
    assert.strictEqual(result.detached, 1, '1 条失配');
    assert.strictEqual(result.added, 1, '新增 1 条模板提示');
    assert.deepEqual(
      scene.overrides.map((item) => item.cueId),
      ['keep'],
    );
    assert.deepEqual(
      scene.detachedOverrides.map((item) => item.cueId),
      ['gone'],
    );

    const resolved = resolveScene(scene, template);
    assert.strictEqual(
      resolved.find((item) => item.cueId === 'keep')!.duration,
      200,
      '覆盖随迁移保留',
    );
    assert.strictEqual(
      resolved.find((item) => item.cueId === 'fresh')!.duration,
      45,
      '新提示出现在合并视图',
    );
    assert.notOk(
      resolved.some((item) => item.cueId === 'gone'),
      '旧提示已不在视图',
    );
  });

  test('迁移幂等：重复迁移不重复产生 detached', function (assert) {
    const template = templateWith([
      cue('a', '甲', 10, '李岚'),
      cue('b', '乙', 10, '周启'),
    ]);
    releaseTemplate(template, 'v1');
    const scene = buildSceneFromTemplate(
      template,
      latestReleasedVersion(template)!,
      {
        act: '第一幕',
        name: 'S1',
        title: '场',
        startTime: '19:30',
      },
    );
    setOverrideField(scene, template, 'b', 'duration', 50);

    template.current.cues = [template.current.cues[0]!];
    releaseTemplate(template, 'v2');

    migrateScene(scene, template, 2);
    const detachedAfterFirst = scene.detachedOverrides.length;
    migrateScene(scene, template, 2);
    assert.strictEqual(
      scene.detachedOverrides.length,
      detachedAfterFirst,
      '重复迁移不累积',
    );
    assert.strictEqual(scene.lastMigration?.to, 2);
  });
});

module('Unit | 复制新场次（套用模板）事务', function () {
  test('模板缺负责人/空标题/空提示时校验失败并给出原因', function (assert) {
    const valid = templateWith([cue('c1', '正常', 60, '李岚')]);
    assert.deepEqual(validateTemplate(valid, valid.current), []);

    const noOwner = templateWith([cue('c1', '无负责人', 60, '')]);
    assert.ok(
      validateTemplate(noOwner, noOwner.current).some((r) =>
        r.includes('负责人'),
      ),
    );

    const empty = emptyTemplate('空模板');
    assert.ok(
      validateTemplate(empty, empty.current).some((r) =>
        r.includes('没有任何提示'),
      ),
    );

    const badDuration = templateWith([cue('c1', '坏时长', 0, '李岚')]);
    assert.ok(
      validateTemplate(badDuration, badDuration.current).some((r) =>
        r.includes('时长'),
      ),
    );
  });

  test('套用流程：成功时新场钉住所套版本，模板与场次各自独立', function (assert) {
    const template = templateWith([cue('c1', '流程', 60, '李岚')]);
    releaseTemplate(template, '首版');
    const state: WorkspaceState = {
      show: { ...initialWorkspace().show, scenes: [] },
      templates: [template],
    };

    const version = latestReleasedVersion(template)!;
    assert.deepEqual(validateTemplate(template, version), []);

    const scene = buildSceneFromTemplate(template, version, {
      act: '第二幕',
      name: 'S9',
      title: '新剧场',
      startTime: '21:00',
    });
    state.show.scenes.push(scene);

    assert.strictEqual(scene.templateId, template.id);
    assert.strictEqual(scene.templateVersion, 1);
    assert.deepEqual(scene.overrides, [], '新场次不复制流程，只保留引用');
    assert.strictEqual(resolveScene(scene, template)[0]!.title, '流程');

    // 模板再升级，新场仍解析 v1
    template.current.cues[0]!.title = '改了';
    releaseTemplate(template, '二版');
    assert.strictEqual(
      resolveScene(scene, template)[0]!.title,
      '流程',
      '钉版不被模板升级影响',
    );
  });

  test('失败后检查点与原数据一致（模拟事务回滚）', function (assert) {
    const template = templateWith([cue('c1', '流程', 60, '李岚')]);
    releaseTemplate(template, '首版');
    const state: WorkspaceState = {
      show: { ...initialWorkspace().show, scenes: [] },
      templates: [template],
    };
    const checkpoint = clone(state);
    const checksumBefore = checksum(checkpoint);

    // 模拟一次失败：在 working 上做了部分写入后抛错
    try {
      const working = clone(state);
      const picked = working.templates.find((item) => item === template)!;
      const version = latestReleasedVersion(picked);
      const reasons = validateTemplate(picked, version!);
      if (reasons.length) throw new ApplyTemplateError(reasons);
      working.show.scenes.push(
        buildSceneFromTemplate(picked, version!, {
          act: 'X',
          name: 'SX',
          title: '半途',
          startTime: '21:00',
        }),
      );
      throw new ApplyTemplateError(['模拟写入中断']);
    } catch (error) {
      assert.ok(error instanceof ApplyTemplateError);
    }

    // 回滚 = 恢复检查点；原场次与模板都不少数据
    assert.strictEqual(checksum(checkpoint), checksumBefore, '检查点未被污染');
    assert.strictEqual(checkpoint.show.scenes.length, 0);
    assert.strictEqual(checkpoint.templates[0]!.current.cues.length, 1);
    assert.strictEqual(
      checkpoint.templates[0]!.releases.length,
      1,
      '模板发布版本仍在',
    );
    assert.strictEqual(state.show.scenes.length, 0, '工作区未残留半途场次');
  });
});

module('Unit | v1 数据迁移', function () {
  test('旧版内嵌场次自动转为一场一模板，场次不再持有流程', function (assert) {
    const legacy = {
      title: '旧演出',
      venue: '老剧场',
      date: '2025-01-01',
      updatedAt: '2025-01-01T00:00:00.000Z',
      scenes: [
        {
          id: 'old-scene-1',
          act: '第一幕',
          name: 'S1',
          title: '旧场',
          startTime: '19:30',
          locked: false,
          cues: [
            {
              id: 'old-cue-1',
              kind: '灯光' as const,
              title: '老提示',
              duration: 55,
              owner: '李岚',
              lighting: '面光',
              sound: '',
              props: ['灯'],
              cast: [],
              notes: '',
              dependsOn: [],
            },
          ],
        },
      ],
    };

    const migrated = migrateLegacyShow(legacy);
    assert.strictEqual(migrated.show.schemaVersion, 2);
    assert.strictEqual(migrated.templates.length, 1);
    const scene = migrated.show.scenes[0]!;
    assert.strictEqual(scene.templateId, 'tpl-legacy-old-scene-1');
    assert.deepEqual(scene.overrides, [], '迁移后场次无覆盖');
    assert.deepEqual(scene.localCues, []);

    const template = migrated.templates[0]!;
    assert.strictEqual(template.current.cues[0]!.cueId, 'old-cue-1');
    assert.strictEqual(template.current.cues[0]!.title, '老提示');

    const resolved = resolveScene(scene, template);
    assert.strictEqual(resolved.length, 1, '旧提示通过模板完整解析');
    assert.strictEqual(resolved[0]!.lighting, '面光');
  });
});

module('Unit | 工具函数', function () {
  test('nextCueId 不与现有 cueId 冲突', function (assert) {
    const template = templateWith([
      cue('cue-1', '甲', 10, '李岚'),
      cue('cue-3', '乙', 10, '周启'),
    ]);
    const first = nextCueId(template);
    addTemplateCue(template, {
      ...emptyTemplateCue(first),
      title: '丙',
      owner: '陈默',
    });
    const second = nextCueId(template);
    assert.notStrictEqual(first, second);
    assert.notOk(
      template.current.cues.some((item) => item.cueId === second),
      '新 cueId 不冲突',
    );
  });

  test('effectiveVersion 在版本缺失时回退到当前工作版', function (assert) {
    const template = templateWith([cue('c1', '甲', 10, '李岚')]);
    const scene = buildSceneFromTemplate(template, template.current, {
      act: '第一幕',
      name: 'S1',
      title: '场',
      startTime: '19:30',
    });
    scene.templateVersion = 99; // 版本丢失
    const version = effectiveVersion(scene, template);
    assert.strictEqual(
      version,
      template.current,
      '回退到工作版，保证旧场次可解析',
    );
    void uid;
  });
});

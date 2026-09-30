import { module, test } from 'qunit';
import type {
  ApplyJob,
  CueBook,
  SceneCueOverride,
  ShowTemplate,
  TemplateCue,
} from 'stage-cue-editor/models/cue-book';
import {
  SCHEMA_VERSION,
  parsePersisted,
} from 'stage-cue-editor/lib/cue-book/migration';
import {
  effectiveScene,
  effectiveScenes,
} from 'stage-cue-editor/lib/cue-book/resolve';
import {
  migrateOverrides,
  publishTemplateVersion,
} from 'stage-cue-editor/lib/cue-book/template';
import {
  applyJob,
  createSceneJob,
  failJob,
  preflight,
  resumeJob,
  upgradeSceneJob,
} from 'stage-cue-editor/lib/cue-book/apply';
import {
  buildOverride,
  valuesOf,
} from 'stage-cue-editor/lib/cue-book/override';
import {
  LEGACY_STORAGE_KEY,
  STORAGE_KEY,
  loadState,
  saveState,
} from 'stage-cue-editor/lib/cue-book/repository';

function cue(key: string, patch: Partial<TemplateCue> = {}): TemplateCue {
  return {
    key,
    kind: '灯光',
    title: key,
    duration: 60,
    owner: '李岚',
    lighting: '',
    sound: '',
    props: [],
    cast: [],
    notes: '',
    dependsOnKeys: [],
    ...patch,
  };
}

function template(
  id: string,
  cues: TemplateCue[],
  currentVersion = 1,
): ShowTemplate {
  const stamp = new Date().toISOString();
  return {
    id,
    name: `模板 ${id}`,
    description: '',
    currentVersion,
    versions: [{ version: 1, createdAt: stamp, note: 'v1', cues }],
    createdAt: stamp,
    updatedAt: stamp,
  };
}

function makeBook(
  templates: ShowTemplate[],
  scenes: Array<{
    id: string;
    templateId: string;
    templateVersion?: number;
    overrides?: SceneCueOverride[];
  }>,
): CueBook {
  return {
    schemaVersion: SCHEMA_VERSION,
    title: '测试演出',
    venue: '测试剧场',
    date: '2026-10-01',
    templates,
    scenes: scenes.map((scene, index) => ({
      id: scene.id,
      templateId: scene.templateId,
      templateVersion: scene.templateVersion ?? 1,
      act: '第一幕',
      name: `S${index + 1}`,
      title: scene.id,
      startTime: '19:30',
      locked: false,
      cueOverrides: scene.overrides ?? [],
      migrationWarnings: [],
    })),
    updatedAt: new Date().toISOString(),
  };
}

module('Unit | cue-book | 模板与场次覆盖', function () {
  test('未覆盖字段始终继承模板当前版本', function (assert) {
    const book = makeBook(
      [template('t1', [cue('c1', { duration: 60 })])],
      [{ id: 's1', templateId: 't1' }],
    );
    const c1 = effectiveScene(book, book.scenes[0]!).cues[0]!;
    assert.strictEqual(c1.duration, 60, '继承模板时长');
    assert.deepEqual(c1.overriddenFields, [], '没有任何本场覆盖');
  });

  test('模板一改，未覆盖场次立即按新值重算', function (assert) {
    let t1 = template('t1', [cue('c1', { duration: 60 })]);
    t1 = publishTemplateVersion(t1, [cue('c1', { duration: 120 })], '加时长');
    // 场次仍停留在 v1（尚未点「升级迁移」）。
    const book = makeBook(
      [t1],
      [{ id: 's1', templateId: 't1', templateVersion: 1 }],
    );
    const view = effectiveScene(book, book.scenes[0]!);
    assert.strictEqual(view.cues[0]!.duration, 120, '取值立即跟随模板当前版本');
    assert.false(view.upToDate, '版本标记仍提示需要迁移');
  });

  test('场次覆盖相互隔离，复制新场次不带上一站调整', function (assert) {
    const book = makeBook(
      [template('t1', [cue('c1', { duration: 60, owner: '李岚' })])],
      [
        {
          id: 'sA',
          templateId: 't1',
          overrides: [{ key: 'c1', duration: 30 }],
        },
        { id: 'sB', templateId: 't1' },
      ],
    );
    const [a, b] = effectiveScenes(book);
    assert.strictEqual(a!.cues[0]!.duration, 30, 'A 站用本场覆盖');
    assert.strictEqual(
      b!.cues[0]!.duration,
      60,
      'B 站仍继承模板，不被 A 站影响',
    );

    // 「复制新场次」选择模板，只带本场显式给出的覆盖。
    const job = createSceneJob('t1', 1, {
      act: '第一幕',
      name: 'C 站',
      title: 'c',
      startTime: '20:00',
      cueOverrides: [{ key: 'c1', owner: '周启' }],
    });
    const result = applyJob(book, job);
    const created = result.book.scenes.find(
      (scene) => scene.id === job.sceneId,
    )!;
    assert.strictEqual(
      created.cueOverrides.length,
      1,
      '新场次只有自己的一条覆盖',
    );
    assert.strictEqual(created.cueOverrides[0]!.owner, '周启');
  });

  test('显式清空负责人（空字符串）也算覆盖', function (assert) {
    const book = makeBook(
      [template('t1', [cue('c1', { owner: '李岚' })])],
      [{ id: 's1', templateId: 't1', overrides: [{ key: 'c1', owner: '' }] }],
    );
    const c1 = effectiveScene(book, book.scenes[0]!).cues[0]!;
    assert.strictEqual(c1.owner, '', '空串覆盖被保留，而非回退为模板值');
    assert.ok(c1.overriddenFields.includes('owner'));
  });
});

module('Unit | cue-book | 模板升级与迁移', function () {
  test('升级迁移按稳定 key 匹配，删除提示的覆盖作为孤立项保留', function (assert) {
    const v2Cues = [
      cue('c1', { title: '改名后的 c1', duration: 90 }),
      cue('c3'),
    ];
    const migration = migrateOverrides(
      [
        { key: 'c1', duration: 30 },
        { key: 'c2', owner: '陈默' },
      ],
      v2Cues,
    );
    assert.deepEqual(
      migration.orphans,
      ['c2'],
      'c2 已从模板删除 -> 孤立但不丢弃',
    );
    assert.strictEqual(migration.overrides.length, 2, '两条覆盖都保留');
    assert.deepEqual(
      migration.redundantKeys,
      [],
      'c1 的时长覆盖仍与新默认不同',
    );
  });

  test('升级作业更新版本号并写入迁移提示，原覆盖不丢', function (assert) {
    let t1 = template('t1', [cue('c1'), cue('c2')]);
    t1 = publishTemplateVersion(t1, [cue('c1', { duration: 200 })], '删 c2');
    const book = makeBook(
      [t1],
      [
        {
          id: 's1',
          templateId: 't1',
          templateVersion: 1,
          overrides: [{ key: 'c2', owner: '陈默' }],
        },
      ],
    );
    const job = upgradeSceneJob('s1', 't1', 2);
    const result = applyJob(book, job);
    const scene = result.book.scenes[0]!;
    assert.strictEqual(scene.templateVersion, 2);
    assert.strictEqual(scene.cueOverrides.length, 1, '孤立覆盖保留在场次上');
    assert.strictEqual(scene.migrationWarnings.length, 1, '生成迁移提示');
    assert.strictEqual(result.job.status, 'succeeded');
  });
});

module('Unit | cue-book | 套用事务、回滚与续处理', function () {
  test('预检失败时原 book 与模板数据不变（回滚）', function (assert) {
    const book = makeBook(
      [template('t1', [cue('c1')])],
      [{ id: 's1', templateId: 't1' }],
    );
    const before = JSON.stringify(book);
    const job = upgradeSceneJob('s1', 't-missing', 1);
    assert.throws(() => preflight(book, job), /不存在/);
    assert.throws(() => applyJob(book, job), /不存在/);
    assert.strictEqual(
      JSON.stringify(book),
      before,
      '失败后业务数据逐字节不变',
    );
    assert.strictEqual(book.scenes.length, 1);
  });

  test('作业失败后恢复，修复条件再继续处理可成功', function (assert) {
    // 作业引用了尚不存在的模板 -> 第一次失败。
    const job0 = createSceneJob('t-late', 1, {
      act: '第一幕',
      name: 'S2',
      title: 'late',
      startTime: '19:40',
      cueOverrides: [],
    });
    const book0 = makeBook([], []);
    let job: ApplyJob;
    try {
      applyJob(book0, job0);
      job = job0;
    } catch (error) {
      job = failJob(job0, error);
    }
    assert.strictEqual(job!.status, 'failed', '首次套用失败并记录原因');
    assert.ok(job!.error.length > 0);

    // 「重开后继续处理」：补上模板，作业回到 pending 后重试成功。
    const book1 = makeBook([template('t-late', [cue('c1')])], []);
    const resumed = resumeJob(job!);
    assert.strictEqual(resumed.status, 'pending');
    const result = applyJob(book1, resumed);
    assert.strictEqual(result.job.status, 'succeeded');
    assert.strictEqual(result.book.scenes.length, 1, '场次最终创建成功');
  });

  test('卡在 applying 的作业重新打开后回到 pending，可继续', function (assert) {
    const t = template('t1', [cue('c1')]);
    const legacy = {
      book: {
        schemaVersion: SCHEMA_VERSION,
        title: 'x',
        venue: '',
        date: '',
        templates: [t],
        scenes: [],
        updatedAt: '',
      },
      versions: [],
      jobs: [
        {
          ...createSceneJob('t1', 1, {
            act: '',
            name: 'S1',
            title: 'x',
            startTime: '19:30',
            cueOverrides: [],
          }),
          status: 'applying',
        },
      ],
    };
    const parsed = parsePersisted(legacy)!;
    assert.strictEqual(
      parsed.jobs[0]!.status,
      'pending',
      '中断作业恢复为待处理',
    );
  });
});

module('Unit | cue-book | 旧版数据迁移', function () {
  test('v1 整份深拷贝无损升级：提示/依赖/备注不丢，场次不再携带提示副本', function (assert) {
    const v1 = {
      show: {
        title: '旧演出',
        venue: '旧剧场',
        date: '2026-09-01',
        scenes: [
          {
            id: 'old-scene-1',
            act: '第一幕',
            name: 'S1',
            title: '旧场',
            startTime: '19:30',
            locked: true,
            cues: [
              {
                id: 'old-cue-1',
                kind: '音响',
                title: '旧提示',
                duration: 88,
                owner: '陈默',
                lighting: 'L',
                sound: 'S',
                props: ['月牙灯'],
                cast: ['甲'],
                notes: 'N',
                dependsOn: ['old-cue-gone'],
                offset: 0,
              },
            ],
          },
        ],
      },
      versions: [],
    };
    const parsed = parsePersisted(v1)!;
    assert.strictEqual(parsed.book.scenes.length, 1);
    assert.strictEqual(parsed.book.templates.length, 1, '为旧场次拆出独立模板');
    const scene = parsed.book.scenes[0]!;
    assert.strictEqual(scene.id, 'old-scene-1', '场次 ID 保留');
    assert.true(scene.locked, '锁定状态保留');
    assert.strictEqual(
      scene.cueOverrides.length,
      0,
      '场次不再携带提示副本，全部继承模板',
    );
    const cues = effectiveScene(parsed.book, scene).cues;
    assert.strictEqual(cues.length, 1);
    assert.strictEqual(cues[0]!.key, 'old-cue-1');
    assert.strictEqual(cues[0]!.duration, 88);
    assert.strictEqual(cues[0]!.sound, 'S');
    assert.deepEqual(
      cues[0]!.dependsOnKeys,
      ['old-cue-gone'],
      '失效依赖原样保留用于检查',
    );
  });

  test('旧锁定快照随版本一并迁移', function (assert) {
    const root = {
      book: {
        schemaVersion: SCHEMA_VERSION,
        title: '现演出',
        venue: '',
        date: '',
        templates: [],
        scenes: [],
        updatedAt: '',
      },
      versions: [
        {
          id: 'v-old',
          name: '旧锁定版',
          createdAt: '',
          data: {
            title: '快照演出',
            venue: 'v',
            date: '',
            scenes: [
              {
                id: 'sv1',
                act: '',
                name: 'S1',
                title: 't',
                startTime: '19:00',
                cues: [],
              },
            ],
          },
        },
      ],
      jobs: [],
    };
    const parsed = parsePersisted(root)!;
    assert.strictEqual(parsed.versions[0]!.book.title, '快照演出');
    assert.strictEqual(parsed.versions[0]!.book.schemaVersion, SCHEMA_VERSION);
  });
});

module('Unit | cue-book | 场次覆盖构造', function () {
  test('只保留与模板不同的字段，全部相同则返回 null', function (assert) {
    const base = cue('c1', { duration: 60, owner: '李岚', props: ['折扇'] });
    const changed = valuesOf(base);
    changed.duration = 40;
    changed.owner = '';
    const override = buildOverride(base, changed)!;
    assert.strictEqual(override.key, 'c1');
    assert.strictEqual(override.duration, 40);
    assert.strictEqual(override.owner, '', '空串是显式覆盖');
    assert.strictEqual(override.props, undefined, '相同的数组字段不写入覆盖');

    const same = buildOverride(base, valuesOf(base));
    assert.strictEqual(same, null, '与模板一致时不产生覆盖，恢复完全继承');
  });

  test('数组字段按内容比较，顺序或元素不同才算覆盖', function (assert) {
    const base = cue('c1', { props: ['甲', '乙'] });
    const reordered = valuesOf(base);
    reordered.props = ['乙', '甲'];
    assert.ok(buildOverride(base, reordered), '顺序变化视为覆盖');

    const sameOrder = valuesOf(base);
    assert.strictEqual(buildOverride(base, sameOrder), null);
  });
});

module('Unit | cue-book | 本地存储与旧键迁移', function () {
  function memoryStorage(initial: Record<string, string> = {}): Storage {
    const map = new Map(Object.entries(initial));
    return {
      get length() {
        return map.size;
      },
      clear() {
        map.clear();
      },
      getItem(key: string) {
        return map.has(key) ? map.get(key)! : null;
      },
      key(index: number) {
        return [...map.keys()][index] ?? null;
      },
      removeItem(key: string) {
        map.delete(key);
      },
      setItem(key: string, value: string) {
        map.set(key, value);
      },
    };
  }

  test('v2 键存在时直接使用，不触发旧键迁移', function (assert) {
    const storage = memoryStorage({
      [STORAGE_KEY]: JSON.stringify({
        book: {
          schemaVersion: SCHEMA_VERSION,
          title: '新数据',
          venue: '',
          date: '',
          templates: [],
          scenes: [],
          updatedAt: '',
        },
        versions: [],
        jobs: [],
      }),
    });
    const state = loadState(storage);
    assert.strictEqual(state.book.title, '新数据');
  });

  test('仅旧 v1 键存在时自动迁移、写入 v2 键并清掉旧键', function (assert) {
    const storage = memoryStorage({
      [LEGACY_STORAGE_KEY]: JSON.stringify({
        show: {
          title: '旧键演出',
          venue: '旧剧场',
          date: '',
          scenes: [
            {
              id: 'legacy-scene',
              act: '第一幕',
              name: 'S1',
              title: '旧场',
              startTime: '19:30',
              locked: false,
              cues: [],
            },
          ],
        },
        versions: [],
      }),
    });
    const state = loadState(storage);
    assert.strictEqual(state.book.title, '旧键演出', '迁移后内容可读');
    assert.strictEqual(state.book.scenes[0]!.id, 'legacy-scene');
    assert.ok(storage.getItem(STORAGE_KEY), '已写入新 v2 键');
    assert.strictEqual(storage.getItem(LEGACY_STORAGE_KEY), null, '旧键已清理');
  });

  test('保存与读取往返一致（含作业）', function (assert) {
    const storage = memoryStorage();
    const book = makeBook(
      [template('t1', [cue('c1')])],
      [{ id: 's1', templateId: 't1' }],
    );
    const job = upgradeSceneJob('s1', 't1', 2);
    saveState({ book, versions: [], jobs: [job] }, storage);
    const reloaded = loadState(storage);
    assert.strictEqual(reloaded.jobs[0]!.sceneId, 's1');
    assert.strictEqual(reloaded.book.scenes.length, 1);
  });
});

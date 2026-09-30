import type {
  CueField,
  CueKind,
  CueOverride,
  CueTemplate,
  LocalCue,
  PendingApply,
  ResolvedCue,
  Scene,
  ShowData,
  TemplateCue,
  TemplateVersion,
  VersionSnapshot,
  WorkspaceState,
} from 'stage-cue-editor/models/show';
import { SCHEMA_VERSION } from 'stage-cue-editor/models/show';

export const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

export const uid = (prefix: string): string =>
  `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

export function emptyTemplateCue(cueId: string): TemplateCue {
  return {
    cueId,
    kind: '灯光',
    title: '',
    duration: 60,
    owner: '',
    lighting: '',
    sound: '',
    props: [],
    cast: [],
    notes: '',
    dependsOn: [],
  };
}

export function emptyLocalCue(): LocalCue {
  return {
    id: uid('local'),
    kind: '灯光',
    title: '',
    duration: 60,
    owner: '',
    lighting: '',
    sound: '',
    props: [],
    cast: [],
    notes: '',
    dependsOn: [],
  };
}

/* ------------------------------------------------------------------ */
/* 初始数据与 v1 迁移                                                  */
/* ------------------------------------------------------------------ */

function templateCue(
  cueId: string,
  kind: CueKind,
  title: string,
  duration: number,
  owner: string,
  extra: Partial<TemplateCue> = {},
): TemplateCue {
  return {
    ...emptyTemplateCue(''),
    ...{ cueId, kind, title, duration, owner },
    ...extra,
  };
}

export function makeTemplate(
  id: string,
  name: string,
  cues: TemplateCue[],
): CueTemplate {
  return {
    id,
    name,
    createdAt: new Date().toISOString(),
    current: { version: 1, updatedAt: new Date().toISOString(), cues },
    releases: [],
  };
}

export function emptyTemplate(name = '新建模板'): CueTemplate {
  return makeTemplate(uid('tpl'), name, []);
}

export function initialWorkspace(): WorkspaceState {
  const base = makeTemplate('tpl-base', '通用串联模板', [
    templateCue('base-light', '灯光', '观众席渐暗 · 面光起', 45, '李岚', {
      lighting: 'FOH 1 号面光 65%，侧光暖白 40%',
      notes: '开演铃后 10 秒执行',
    }),
    templateCue('base-actor', '演员', '说书人自左台入场', 90, '赵一帆', {
      cast: ['说书人／周启'],
      props: ['折扇'],
      notes: '追光跟随；入场后停留台中',
    }),
    templateCue('base-sound', '音响', '古琴引子淡入', 120, '陈默', {
      sound: 'Q1 古琴引子，-18dB 淡入 6 秒',
    }),
    templateCue('base-prop', '道具', '月牙灯升至舞台中线', 75, '孙禾', {
      props: ['月牙灯'],
      lighting: '顶排 3 号定点',
    }),
  ]);

  const banquet = makeTemplate('tpl-banquet', '夜场宴会模板', [
    templateCue('bq-stage', '舞台', '中景屏风换为朱红', 60, '待指定', {
      notes: '负责人由各剧场确认',
    }),
    templateCue('bq-actor', '演员', '群臣列队入场', 110, '赵一帆', {
      cast: ['群演 6 人', '侍女 4 人'],
      props: ['宫灯'],
    }),
    templateCue('bq-light', '灯光', '暖金顶光覆盖后区', 80, '李岚', {
      lighting: '顶光 4、5 号 70%，色温 3200K',
    }),
  ]);

  const scenes: Scene[] = [
    {
      id: 'scene-1',
      act: '第一幕',
      name: 'S1',
      title: '月下序场',
      startTime: '19:30',
      locked: false,
      templateId: 'tpl-base',
      templateVersion: null,
      overrides: [
        // 本场临时把面光负责人放空：模板值仍归模板所有
        { cueId: 'base-light', fields: { owner: '' } },
        // 本场把古琴引子拉长到 150 秒
        { cueId: 'base-sound', fields: { duration: 150 } },
      ],
      order: null,
      skippedCueIds: [],
      localCues: [
        {
          id: 'local-hold-1',
          kind: '舞台',
          title: '幕间候场连线',
          duration: 30,
          owner: '',
          lighting: '',
          sound: '',
          props: [],
          cast: [],
          notes: '依赖一条已删除提示，用于演示失效引用检查',
          dependsOn: ['cue-deleted-old'],
        },
      ],
      detachedOverrides: [],
    },
    {
      id: 'scene-2',
      act: '第一幕',
      name: 'S2',
      title: '宫门夜宴',
      startTime: '19:40',
      locked: false,
      templateId: 'tpl-banquet',
      templateVersion: null,
      overrides: [{ cueId: 'bq-stage', fields: { owner: '' } }],
      order: null,
      skippedCueIds: [],
      localCues: [],
      detachedOverrides: [],
    },
  ];

  return {
    show: {
      schemaVersion: SCHEMA_VERSION,
      title: '《长夜行》首演提示表',
      venue: '实验剧场 A 厅',
      date: '2026-10-18',
      scenes,
      updatedAt: new Date().toISOString(),
    },
    templates: [base, banquet],
  };
}

interface LegacyCue {
  id: string;
  kind: CueKind;
  title: string;
  duration: number;
  owner: string;
  lighting: string;
  sound: string;
  props: string[];
  cast: string[];
  notes: string;
  dependsOn: string[];
  offset?: number;
}

interface LegacyScene {
  id: string;
  act: string;
  name: string;
  title: string;
  startTime: string;
  locked: boolean;
  cues: LegacyCue[];
}

interface LegacyShow {
  title: string;
  venue: string;
  date: string;
  scenes: LegacyScene[];
  updatedAt: string;
}

/** 把 v1（场次内嵌完整提示）迁移成「一场一模板 + 空覆盖」的新结构。 */
export function migrateLegacyShow(legacy: LegacyShow): WorkspaceState {
  const templates: CueTemplate[] = [];
  const scenes: Scene[] = legacy.scenes.map((legacyScene) => {
    const templateId = `tpl-legacy-${legacyScene.id}`;
    templates.push(
      makeTemplate(
        templateId,
        `${legacyScene.name} ${legacyScene.title} 模板`,
        legacyScene.cues.map((item) => ({
          cueId: item.id,
          kind: item.kind,
          title: item.title,
          duration: item.duration,
          owner: item.owner,
          lighting: item.lighting ?? '',
          sound: item.sound ?? '',
          props: item.props ?? [],
          cast: item.cast ?? [],
          notes: item.notes ?? '',
          dependsOn: item.dependsOn ?? [],
        })),
      ),
    );
    return {
      id: legacyScene.id,
      act: legacyScene.act,
      name: legacyScene.name,
      title: legacyScene.title,
      startTime: legacyScene.startTime,
      locked: legacyScene.locked,
      templateId,
      templateVersion: null,
      overrides: [],
      order: null,
      skippedCueIds: [],
      localCues: [],
      detachedOverrides: [],
    } satisfies Scene;
  });

  return {
    show: {
      schemaVersion: SCHEMA_VERSION,
      title: legacy.title,
      venue: legacy.venue,
      date: legacy.date,
      scenes,
      updatedAt: legacy.updatedAt ?? new Date().toISOString(),
    },
    templates,
  };
}

/** 兼容读取历史锁定版本快照（旧快照内联 ShowData，新快照存 WorkspaceState）。 */
export function migrateLegacySnapshot(
  snapshot: VersionSnapshot,
): VersionSnapshot {
  const state = snapshot.state as unknown as WorkspaceState | undefined;
  if (state && state.show && Array.isArray(state.templates)) return snapshot;
  const legacy = (snapshot as unknown as { data: LegacyShow }).data;
  return { ...snapshot, state: migrateLegacyShow(legacy) };
}

/* ------------------------------------------------------------------ */
/* 模板版本与合并解析                                                  */
/* ------------------------------------------------------------------ */

export function findTemplate(
  state: WorkspaceState,
  templateId: string | null,
): CueTemplate | undefined {
  if (!templateId) return undefined;
  return state.templates.find((template) => template.id === templateId);
}

export function effectiveVersion(
  scene: Scene,
  template: CueTemplate | undefined,
): TemplateVersion | undefined {
  if (!template) return undefined;
  if (scene.templateVersion != null) {
    const pinned = template.releases.find(
      (release) => release.version === scene.templateVersion,
    );
    if (pinned) return pinned;
  }
  return template.current;
}

/**
 * 合并解析：模板值 + 本场覆盖 + 本场自有提示。
 * 纯读取，不修改入参；offset 在合并结果上重算。
 */
export function resolveScene(
  scene: Scene,
  template: CueTemplate | undefined,
): ResolvedCue[] {
  const version = effectiveVersion(scene, template);
  const templateCues = version ? [...version.cues] : [];
  const skipped = new Set(scene.skippedCueIds);

  if (scene.order) {
    const rank = (cueId: string): number => {
      const index = scene.order!.indexOf(cueId);
      return index < 0 ? Number.MAX_SAFE_INTEGER : index;
    };
    templateCues.sort((a, b) => {
      const diff = rank(a.cueId) - rank(b.cueId);
      return diff !== 0 ? diff : 0;
    });
  }

  const overrideOf = (cueId: string): CueOverride | undefined =>
    scene.overrides.find((override) => override.cueId === cueId);

  const resolved: ResolvedCue[] = templateCues
    .filter((base) => !skipped.has(base.cueId))
    .map((base) => {
      const override = overrideOf(base.cueId);
      const fields = (
        override ? Object.keys(override.fields) : []
      ) as CueField[];
      const merged = { ...base, ...(override?.fields ?? {}) };
      return {
        id: `t:${scene.id}:${base.cueId}`,
        cueId: base.cueId,
        source: 'template' as const,
        kind: merged.kind,
        title: merged.title,
        duration: merged.duration,
        owner: merged.owner,
        lighting: merged.lighting,
        sound: merged.sound,
        props: merged.props,
        cast: merged.cast,
        notes: merged.notes,
        dependsOn: merged.dependsOn,
        offset: 0,
        overridden: fields,
        pinned: scene.templateVersion != null && version !== template?.current,
      };
    });

  scene.localCues.forEach((local) => {
    resolved.push({
      id: `l:${scene.id}:${local.id}`,
      cueId: local.id,
      source: 'local',
      kind: local.kind,
      title: local.title,
      duration: local.duration,
      owner: local.owner,
      lighting: local.lighting,
      sound: local.sound,
      props: local.props,
      cast: local.cast,
      notes: local.notes,
      dependsOn: local.dependsOn,
      offset: 0,
      overridden: [],
      pinned: false,
    });
  });

  let elapsed = 0;
  resolved.forEach((item) => {
    item.offset = elapsed;
    elapsed += Number(item.duration) || 0;
  });
  return resolved;
}

export function allResolvedCues(state: WorkspaceState): Array<{
  scene: Scene;
  template: CueTemplate | undefined;
  cues: ResolvedCue[];
}> {
  return state.show.scenes.map((scene) => ({
    scene,
    template: findTemplate(state, scene.templateId),
    cues: resolveScene(scene, findTemplate(state, scene.templateId)),
  }));
}

/* ------------------------------------------------------------------ */
/* 模板编辑：工作版原地改，发布才产生不可变版本                        */
/* ------------------------------------------------------------------ */

export function nextCueId(template: CueTemplate): string {
  const existing = new Set(template.current.cues.map((cue) => cue.cueId));
  let index = template.current.cues.length + 1;
  let cueId = `cue-${index}`;
  while (existing.has(cueId)) {
    index += 1;
    cueId = `cue-${index}`;
  }
  return cueId;
}

export function updateTemplateCue(
  template: CueTemplate,
  cueId: string,
  patch: Partial<Omit<TemplateCue, 'cueId'>>,
): void {
  const target = template.current.cues.find((cue) => cue.cueId === cueId);
  if (target) Object.assign(target, patch);
  template.current.updatedAt = new Date().toISOString();
}

export function addTemplateCue(template: CueTemplate, cue: TemplateCue): void {
  template.current.cues.push(cue);
  template.current.updatedAt = new Date().toISOString();
}

export function removeTemplateCue(template: CueTemplate, cueId: string): void {
  template.current.cues = template.current.cues.filter(
    (cue) => cue.cueId !== cueId,
  );
  template.current.updatedAt = new Date().toISOString();
}

export function moveTemplateCue(
  template: CueTemplate,
  fromId: string,
  toId: string,
): void {
  if (fromId === toId) return;
  const cues = template.current.cues;
  const from = cues.findIndex((cue) => cue.cueId === fromId);
  const to = cues.findIndex((cue) => cue.cueId === toId);
  if (from < 0 || to < 0) return;
  const [moved] = cues.splice(from, 1);
  cues.splice(to, 0, moved!);
  template.current.updatedAt = new Date().toISOString();
}

export function renameTemplate(template: CueTemplate, name: string): void {
  template.name = name;
}

/** 发布当前工作版：冻结为 release，工作版推进到下一个草稿版本号。 */
export function releaseTemplate(template: CueTemplate, note = ''): number {
  const frozen: TemplateVersion = {
    ...clone(template.current),
    note: note || undefined,
  };
  template.releases = [
    ...template.releases.filter((item) => item.version !== frozen.version),
    frozen,
  ].sort((a, b) => a.version - b.version);
  template.current = {
    version: frozen.version + 1,
    updatedAt: new Date().toISOString(),
    cues: clone(frozen.cues),
  };
  return frozen.version;
}

export function latestReleasedVersion(
  template: CueTemplate,
): TemplateVersion | undefined {
  return template.releases[template.releases.length - 1];
}

/** 钉版前确保工作版已经发布，返回应钉住的版本号。 */
export function ensureVersionForPin(template: CueTemplate): number {
  const latest = latestReleasedVersion(template);
  if (latest && latest.version === template.current.version - 1)
    return latest.version;
  return releaseTemplate(template, '锁定场次时自动发布');
}

/* ------------------------------------------------------------------ */
/* 场次迁移：跟随新模板版本，覆盖按 cueId 保留，失配转 detached        */
/* ------------------------------------------------------------------ */

export function migrateScene(
  scene: Scene,
  template: CueTemplate,
  targetVersion: number,
): { retained: number; detached: number; added: number } {
  const target = template.releases.find(
    (release) => release.version === targetVersion,
  );
  if (!target) throw new Error(`模板缺少版本 v${targetVersion}`);

  const from =
    scene.templateVersion ??
    latestReleasedVersion(template)?.version ??
    Math.max(1, targetVersion - 1);
  const source =
    scene.templateVersion != null
      ? template.releases.find(
          (release) => release.version === scene.templateVersion,
        )
      : template.current;
  const sourceIds = new Set((source?.cues ?? []).map((cue) => cue.cueId));
  const targetIds = new Set(target.cues.map((cue) => cue.cueId));

  const retained: CueOverride[] = [];
  const newlyDetached: CueOverride[] = [];
  scene.overrides.forEach((override) => {
    if (targetIds.has(override.cueId)) retained.push(override);
    else newlyDetached.push(override);
  });

  const detachedMap = new Map<string, CueOverride>();
  [...scene.detachedOverrides, ...newlyDetached].forEach((override) => {
    detachedMap.set(override.cueId, override);
  });

  scene.overrides = retained;
  scene.detachedOverrides = Array.from(detachedMap.values());
  scene.order = scene.order
    ? scene.order.filter((cueId) => targetIds.has(cueId))
    : null;
  scene.skippedCueIds = scene.skippedCueIds.filter((cueId) =>
    targetIds.has(cueId),
  );
  scene.templateVersion = targetVersion;
  scene.lastMigration = {
    from,
    to: targetVersion,
    at: new Date().toISOString(),
    retained: retained.length,
    detached: newlyDetached.length,
    added: target.cues.filter((cue) => !sourceIds.has(cue.cueId)).length,
  };
  return {
    retained: retained.length,
    detached: newlyDetached.length,
    added: scene.lastMigration.added,
  };
}

/* ------------------------------------------------------------------ */
/* 场次覆盖与本场自有提示                                              */
/* ------------------------------------------------------------------ */

const ARRAY_FIELDS: CueField[] = ['props', 'cast', 'dependsOn'];

function fieldEquals(field: CueField, a: unknown, b: unknown): boolean {
  if (ARRAY_FIELDS.includes(field))
    return JSON.stringify(a ?? []) === JSON.stringify(b ?? []);
  // 负责人空字符串与「待指定」视为不同值，保留覆盖语义
  return a === b;
}

export function setOverrideField(
  scene: Scene,
  template: CueTemplate | undefined,
  cueId: string,
  field: CueField,
  value: unknown,
): void {
  const base = effectiveVersion(scene, template)?.cues.find(
    (cue) => cue.cueId === cueId,
  );
  if (!base) return;
  let override = scene.overrides.find((item) => item.cueId === cueId);
  if (!override) {
    override = { cueId, fields: {} };
    scene.overrides.push(override);
  }
  if (fieldEquals(field, value, base[field as keyof TemplateCue])) {
    delete (override.fields as Record<string, unknown>)[field];
  } else {
    (override.fields as Record<string, unknown>)[field] = value;
  }
  if (Object.keys(override.fields).length === 0) {
    scene.overrides = scene.overrides.filter((item) => item.cueId !== cueId);
  }
}

export function clearOverrideField(
  scene: Scene,
  cueId: string,
  field: CueField,
): void {
  const override = scene.overrides.find((item) => item.cueId === cueId);
  if (!override) return;
  delete (override.fields as Record<string, unknown>)[field];
  if (Object.keys(override.fields).length === 0) {
    scene.overrides = scene.overrides.filter((item) => item.cueId !== cueId);
  }
}

export function resetCueOverrides(scene: Scene, cueId: string): void {
  scene.overrides = scene.overrides.filter((item) => item.cueId !== cueId);
  scene.order = scene.order?.filter((id) => id !== cueId) ?? null;
}

export function toggleSkippedCue(
  scene: Scene,
  cueId: string,
  skip?: boolean,
): void {
  const shouldSkip = skip ?? !scene.skippedCueIds.includes(cueId);
  if (shouldSkip) {
    if (!scene.skippedCueIds.includes(cueId)) scene.skippedCueIds.push(cueId);
  } else {
    scene.skippedCueIds = scene.skippedCueIds.filter((id) => id !== cueId);
  }
}

export function restoreDetachedOverride(
  scene: Scene,
  template: CueTemplate,
  cueId: string,
): void {
  const targetIds = new Set(
    effectiveVersion(scene, template)?.cues.map((cue) => cue.cueId) ?? [],
  );
  if (!targetIds.has(cueId)) return;
  const detached = scene.detachedOverrides.find((item) => item.cueId === cueId);
  if (!detached) return;
  const existing = scene.overrides.find((item) => item.cueId === cueId);
  if (existing) existing.fields = { ...detached.fields, ...existing.fields };
  else scene.overrides.push(clone(detached));
  scene.detachedOverrides = scene.detachedOverrides.filter(
    (item) => item.cueId !== cueId,
  );
}

export function discardDetachedOverride(scene: Scene, cueId: string): void {
  scene.detachedOverrides = scene.detachedOverrides.filter(
    (item) => item.cueId !== cueId,
  );
}

export function updateLocalCue(
  scene: Scene,
  cueId: string,
  patch: Partial<LocalCue>,
): void {
  const target = scene.localCues.find((item) => item.id === cueId);
  if (target) Object.assign(target, patch);
}

export function addLocalCue(scene: Scene, cue: LocalCue): void {
  scene.localCues.push(cue);
}

export function removeLocalCue(scene: Scene, cueId: string): void {
  scene.localCues = scene.localCues.filter((item) => item.id !== cueId);
}

function sourceOfResolved(
  globalId: string,
): { kind: 'template' | 'local'; id: string } | null {
  if (globalId.startsWith('t:')) {
    const rest = globalId.slice(2);
    const sep = rest.indexOf(':');
    return sep < 0 ? null : { kind: 'template', id: rest.slice(sep + 1) };
  }
  if (globalId.startsWith('l:')) {
    const rest = globalId.slice(2);
    const sep = rest.indexOf(':');
    return sep < 0 ? null : { kind: 'local', id: rest.slice(sep + 1) };
  }
  return null;
}

/** 在合并视图上拖动排序：模板 cue 写 order 覆盖，本场 cue 调整本地数组，不跨区。 */
export function moveResolvedCue(
  scene: Scene,
  template: CueTemplate | undefined,
  sourceGlobalId: string,
  targetGlobalId: string,
): boolean {
  const source = sourceOfResolved(sourceGlobalId);
  const target = sourceOfResolved(targetGlobalId);
  if (
    !source ||
    !target ||
    source.kind !== target.kind ||
    sourceGlobalId === targetGlobalId
  )
    return false;

  if (source.kind === 'template') {
    const current = resolveScene(scene, template)
      .filter((cue) => cue.source === 'template')
      .map((cue) => cue.cueId);
    const from = current.indexOf(source.id);
    const to = current.indexOf(target.id);
    if (from < 0 || to < 0) return false;
    const next = [...current];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved!);
    scene.order = next;
    return true;
  }

  const locals = scene.localCues.map((cue) => cue.id);
  const from = locals.indexOf(source.id);
  const to = locals.indexOf(target.id);
  if (from < 0 || to < 0) return false;
  const next = [...scene.localCues];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved!);
  scene.localCues = next;
  return true;
}

/* ------------------------------------------------------------------ */
/* 复制新场次（套用模板）：校验 + 构造，事务由组件包裹                 */
/* ------------------------------------------------------------------ */

export class ApplyTemplateError extends Error {
  reasons: string[];
  constructor(reasons: string[]) {
    super(reasons[0] ?? '套用模板失败');
    this.reasons = reasons;
  }
}

export function validateTemplate(
  template: CueTemplate | undefined,
  version: TemplateVersion | undefined,
): string[] {
  const reasons: string[] = [];
  if (!template) {
    reasons.push('所选模板不存在，可能已被删除');
    return reasons;
  }
  if (!version) {
    reasons.push(`模板「${template.name}」缺少要套用的版本`);
    return reasons;
  }
  if (version.cues.length === 0)
    reasons.push(`模板「${template.name}」v${version.version} 没有任何提示点`);
  version.cues.forEach((cue, index) => {
    if (!cue.title.trim()) reasons.push(`第 ${index + 1} 条提示缺少标题`);
    if (!(Number(cue.duration) > 0))
      reasons.push(`「${cue.title || `第 ${index + 1} 条`}」时长必须大于 0 秒`);
    if (!cue.owner.trim())
      reasons.push(`「${cue.title || `第 ${index + 1} 条`}」模板未指定负责人`);
  });
  const ids = new Set<string>();
  version.cues.forEach((cue) => {
    if (ids.has(cue.cueId)) reasons.push(`模板内提示标识重复：${cue.cueId}`);
    ids.add(cue.cueId);
  });
  return reasons;
}

export function buildSceneFromTemplate(
  template: CueTemplate,
  version: TemplateVersion,
  fields: Pick<Scene, 'act' | 'name' | 'title' | 'startTime'>,
): Scene {
  return {
    id: uid('scene'),
    act: fields.act,
    name: fields.name,
    title: fields.title,
    startTime: fields.startTime,
    locked: false,
    templateId: template.id,
    // 新场复制的是发布时的固定流程；之后可一键跟随或迁移到更新版本
    templateVersion: version.version,
    overrides: [],
    order: null,
    skippedCueIds: [],
    localCues: [],
    detachedOverrides: [],
  };
}

/** 复制已有场次：模板引用、钉版、覆盖与本场提示各自深拷贝并换新 ID。 */
export function duplicateScene(
  source: Scene,
  index: number,
  total: number,
): Scene {
  const copy = clone(source);
  copy.id = uid('scene');
  copy.name = `${source.name}-副本`;
  copy.title = `${source.title}（复制）`;
  copy.act = source.act;
  copy.locked = false;
  copy.localCues = source.localCues.map((cue) => ({
    ...cue,
    id: uid('local'),
    dependsOn: [...cue.dependsOn],
  }));
  copy.skippedCueIds = [...source.skippedCueIds];
  copy.lastMigration = source.lastMigration
    ? clone(source.lastMigration)
    : undefined;
  void index;
  void total;
  return copy;
}

/* ------------------------------------------------------------------ */
/* 时间轴工具、校验摘要与校验和                                        */
/* ------------------------------------------------------------------ */

export function startSeconds(value: string): number {
  const [hour = '0', minute = '0'] = value.split(':');
  return Number(hour) * 3600 + Number(minute) * 60;
}

export function timeLabel(startTime: string, offset: number): string {
  const total = startSeconds(startTime) + offset;
  const hour = Math.floor((total % 86400) / 3600);
  const minute = Math.floor((total % 3600) / 60);
  const second = total % 60;
  return [hour, minute, second]
    .map((part) => String(part).padStart(2, '0'))
    .join(':');
}

export function overlaps(
  aStart: number,
  aDuration: number,
  bStart: number,
  bDuration: number,
): boolean {
  return aStart < bStart + bDuration && bStart < aStart + aDuration;
}

export function workspaceCounts(state: WorkspaceState): {
  scenes: number;
  templates: number;
  cues: number;
} {
  return {
    scenes: state.show.scenes.length,
    templates: state.templates.length,
    cues: allResolvedCues(state).reduce(
      (total, entry) => total + entry.cues.length,
      0,
    ),
  };
}

/** FNV-1a 32 位校验和：回滚恢复后核对检查点是否完整。 */
export function checksum(state: WorkspaceState): string {
  const json = JSON.stringify(state);
  let hash = 0x811c9dc5;
  for (let index = 0; index < json.length; index += 1) {
    hash ^= json.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export function pendingApplySummary(pending: PendingApply): {
  intact: boolean;
  scenes: number;
  templates: number;
  cues: number;
} {
  const counts = workspaceCounts(pending.checkpoint);
  return {
    intact: checksum(pending.checkpoint) === pending.checkpointChecksum,
    ...counts,
  };
}

export function touchShow(show: ShowData): void {
  show.updatedAt = new Date().toISOString();
}

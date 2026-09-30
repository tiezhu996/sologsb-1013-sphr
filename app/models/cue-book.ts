/**
 * 提示表领域模型。
 *
 * 所有权边界：
 * - {@link ShowTemplate}（模板）拥有提示的「顺序 / 时长 / 负责人」等默认值，并以
 *   append-only 的版本号演进；模板可被任意多个剧场的场次引用。
 * - {@link SceneInstance}（场次）只保存本场的稀疏覆盖（{@link SceneCueOverride}），
 *   以及开场时间、幕次、锁定状态等纯场次字段。未覆盖的字段始终从模板当前版本继承，
 *   因此复制新场次不会把上一站的临时调整带过去。
 */

export type CueKind = '灯光' | '音响' | '道具' | '演员' | '舞台' | '字幕';

export const CUE_KINDS: CueKind[] = [
  '灯光',
  '音响',
  '道具',
  '演员',
  '舞台',
  '字幕',
];
export const OWNERS = ['李岚', '周启', '陈默', '赵一帆', '孙禾', '待指定'];

/** 模板拥有、且允许场次逐条覆盖的提示字段。顺序（数组次序）始终只归模板所有。 */
export const TEMPLATE_OWNED_CUE_FIELDS = [
  'kind',
  'title',
  'duration',
  'owner',
  'lighting',
  'sound',
  'props',
  'cast',
  'notes',
] as const;

export type TemplateOwnedCueField = (typeof TEMPLATE_OWNED_CUE_FIELDS)[number];

/** 模板中的一条提示。`key` 是跨版本、跨场次稳定的身份标识。 */
export interface TemplateCue {
  key: string;
  kind: CueKind;
  title: string;
  duration: number;
  owner: string;
  lighting: string;
  sound: string;
  props: string[];
  cast: string[];
  notes: string;
  /** 前置依赖，以稳定 key 引用，排序/复制后不会因数组下标变化而失效。 */
  dependsOnKeys: string[];
}

/** 模板的一个不可变版本，数组顺序即提示顺序。 */
export interface TemplateVersion {
  version: number;
  createdAt: string;
  note: string;
  cues: TemplateCue[];
}

export interface ShowTemplate {
  id: string;
  name: string;
  description: string;
  currentVersion: number;
  /** append-only，只增不改，旧场次据此迁移兼容。 */
  versions: TemplateVersion[];
  createdAt: string;
  updatedAt: string;
}

/**
 * 场次对某条模板提示的稀疏覆盖：仅列出与模板不同的字段。
 * - 字段缺省 = 继承模板当前值（模板一改立即重算）。
 * - `owner: ''` 表示本场显式清空负责人（与「继承」区分）。
 * - `props: []` / `cast: []` 表示本场显式置空。
 */
export interface SceneCueOverride {
  key: string;
  kind?: CueKind;
  title?: string;
  duration?: number;
  owner?: string;
  lighting?: string;
  sound?: string;
  props?: string[];
  cast?: string[];
  notes?: string;
}

export interface SceneInstance {
  id: string;
  templateId: string;
  /** 场次最近一次迁移/套用时对齐到的模板版本；实际取值始终按模板当前版本解析。 */
  templateVersion: number;
  act: string;
  name: string;
  title: string;
  startTime: string;
  locked: boolean;
  cueOverrides: SceneCueOverride[];
  /** 升级模板后保留的兼容性提示（如孤立覆盖），不丢弃任何本场数据。 */
  migrationWarnings: string[];
}

export interface CueBook {
  schemaVersion: 2;
  title: string;
  venue: string;
  date: string;
  templates: ShowTemplate[];
  scenes: SceneInstance[];
  updatedAt: string;
}

export interface VersionSnapshot {
  id: string;
  name: string;
  createdAt: string;
  book: CueBook;
}

export type JobKind = 'create-scene' | 'upgrade-scene';
export type JobStatus = 'pending' | 'applying' | 'succeeded' | 'failed';

/**
 * 「套用模板」的长事务作业。作业与业务数据分开持久化：
 * 套用中途失败或页面重开时，凭作业记录回滚并重试，原场次与模板均不丢数据。
 */
export interface ApplyJob {
  id: string;
  kind: JobKind;
  status: JobStatus;
  label: string;
  templateId: string;
  targetVersion: number;
  /** create-scene：待建新场次；upgrade-scene：目标既有场次。 */
  sceneId: string;
  draft: {
    act: string;
    name: string;
    title: string;
    startTime: string;
    cueOverrides: SceneCueOverride[];
  } | null;
  error: string;
  attempts: number;
  createdAt: string;
  updatedAt: string;
}

export interface PersistShape {
  book: CueBook;
  versions: VersionSnapshot[];
  jobs: ApplyJob[];
}

/** 模板提示与场次覆盖合并后的「生效提示」。 */
export interface EffectiveCue {
  key: string;
  kind: CueKind;
  title: string;
  duration: number;
  owner: string;
  lighting: string;
  sound: string;
  props: string[];
  cast: string[];
  notes: string;
  dependsOnKeys: string[];
  offset: number;
  overriddenFields: TemplateOwnedCueField[];
}

export interface EffectiveScene {
  scene: SceneInstance;
  template: ShowTemplate | undefined;
  version: TemplateVersion | undefined;
  cues: EffectiveCue[];
  /** 模板里已不存在、但本场覆盖仍保留的条目（不删除，等待人工处理）。 */
  orphanOverrides: SceneCueOverride[];
  upToDate: boolean;
}

export interface CueIssue {
  id: string;
  severity: 'error' | 'warning' | 'info';
  title: string;
  detail: string;
  icon?: string;
  sceneId?: string;
  cueKey?: string;
}

export interface VersionDiff {
  id: string;
  changed: boolean;
  label: string;
  before: string;
  after: string;
}

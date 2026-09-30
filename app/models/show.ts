export type CueKind = '灯光' | '音响' | '道具' | '演员' | '舞台' | '字幕';

/** 模板中可被场次覆盖的字段。 */
export type CueField =
  | 'kind'
  | 'title'
  | 'duration'
  | 'owner'
  | 'lighting'
  | 'sound'
  | 'props'
  | 'cast'
  | 'notes'
  | 'dependsOn';

/**
 * 模板提示点：固定流程的唯一事实来源。
 * 只存在于模板版本中，场次绝不复制这部分数据。
 */
export interface TemplateCue {
  cueId: string;
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
}

/** 模板的一个不可变版本（release）。current 为正在编辑的最新版。 */
export interface TemplateVersion {
  version: number;
  updatedAt: string;
  note?: string;
  cues: TemplateCue[];
}

export interface CueTemplate {
  id: string;
  name: string;
  createdAt: string;
  /** 最新工作版：对它的字段编辑会立即反映到所有跟随最新版的场次。 */
  current: TemplateVersion;
  /** 已发布版本：锁定/钉版的场次从这里取数，升级后仍可解析。 */
  releases: TemplateVersion[];
}

/** 场次对单条模板提示的本场覆盖，仅记录与模板不同的字段。 */
export interface CueOverride {
  cueId: string;
  fields: {
    kind?: CueKind;
    title?: string;
    duration?: number;
    owner?: string;
    lighting?: string;
    sound?: string;
    props?: string[];
    cast?: string[];
    notes?: string;
    dependsOn?: string[];
  };
}

/** 场次自有提示：不属于任何模板，只在本场出现。 */
export interface LocalCue {
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
}

export interface Scene {
  id: string;
  act: string;
  name: string;
  title: string;
  startTime: string;
  locked: boolean;
  /** 引用的模板；null 表示纯手工场次（v1 数据迁移而来）。 */
  templateId: string | null;
  /** 钉住的模板版本号；null 表示始终跟随模板最新版。 */
  templateVersion: number | null;
  /** 本场覆盖，按模板 cueId 索引。 */
  overrides: CueOverride[];
  /** 本场顺序覆盖（模板 cueId 序列）；null 表示沿用模板顺序。 */
  order: string[] | null;
  /** 本场停用的模板提示（模板保留，仅此场跳过）。 */
  skippedCueIds: string[];
  /** 本场自有提示，追加在模板提示之后。 */
  localCues: LocalCue[];
  /** 模板升级后无法匹配 cueId 的覆盖，保留不丢，可人工恢复。 */
  detachedOverrides: CueOverride[];
  lastMigration?: {
    from: number;
    to: number;
    at: string;
    retained: number;
    detached: number;
    added: number;
  };
}

export const SCHEMA_VERSION = 2;

export interface ShowData {
  schemaVersion: number;
  title: string;
  venue: string;
  date: string;
  scenes: Scene[];
  updatedAt: string;
}

/** 模板 + 场次构成一份完整工作区，事务与快照以此为边界。 */
export interface WorkspaceState {
  show: ShowData;
  templates: CueTemplate[];
}

export interface VersionSnapshot {
  id: string;
  name: string;
  createdAt: string;
  state: WorkspaceState;
}

/**
 * 套用模板失败后的待处理记录。
 * checkpoint 保存操作前的完整工作区，重开页面后仍可重试或确认放弃。
 */
export interface PendingApply {
  id: string;
  templateId: string;
  templateVersion: number;
  reason: string;
  attemptedAt: string;
  /** 套用失败时用户已填写的新场次信息，重试时接着用。 */
  sceneFields: {
    act: string;
    name: string;
    title: string;
    startTime: string;
  };
  /** 插入位置参考：该场次之后。 */
  insertAfterSceneId: string | null;
  checkpoint: WorkspaceState;
  checkpointChecksum: string;
}

export interface PersistShape {
  show: ShowData;
  templates: CueTemplate[];
  versions: VersionSnapshot[];
  pendingApply: PendingApply | null;
}

/** 模板提示与场次覆盖合并后，用于时间轴展示与检查的提示点。 */
export interface ResolvedCue {
  /** 组件内全局唯一标识：模板提示为 t:<sceneId>:<cueId>。 */
  id: string;
  /** 模板 cueId；本场自有提示为自身 id。 */
  cueId: string;
  source: 'template' | 'local';
  kind: CueKind;
  title: string;
  duration: number;
  owner: string;
  lighting: string;
  sound: string;
  props: string[];
  cast: string[];
  notes: string;
  /** 同场内按 cueId 表达的前置依赖。 */
  dependsOn: string[];
  offset: number;
  overridden: CueField[];
  /** 是否解析自钉住的历史版本（而非最新版）。 */
  pinned: boolean;
}

export interface CueDraft {
  source?: 'template' | 'local';
  cueId?: string;
  kind: CueKind;
  title: string;
  duration: number;
  owner: string;
  lighting: string;
  sound: string;
  props: string;
  cast: string;
  notes: string;
  dependsOn: string;
}

export interface CueIssue {
  id: string;
  severity: 'error' | 'warning' | 'info';
  title: string;
  detail: string;
  icon?: string;
  sceneId?: string;
  cueId?: string;
}

export interface VersionDiff {
  id: string;
  changed: boolean;
  label: string;
  before: string;
  after: string;
}

export const CUE_KINDS: CueKind[] = [
  '灯光',
  '音响',
  '道具',
  '演员',
  '舞台',
  '字幕',
];
export const OWNERS = ['李岚', '周启', '陈默', '赵一帆', '孙禾', '待指定'];

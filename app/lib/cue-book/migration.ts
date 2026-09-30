/**
 * 迁移与归一化。
 *
 * - 旧版（schema v1，{ show, versions }，每场整份 cues）无损升级到 v2：
 *   每个旧场次拆出一个独立模板（提示顺序/时长/负责人等默认值）与一个空覆盖场次
 *   （全部字段改为继承），不丢任何提示、依赖或备注。
 * - 旧锁定快照（snapshot.data = ShowData）同样迁移，历史版本仍可比较。
 * - 中断在「套用中」的作业在重新打开时回到「待处理」，由用户一键继续（见 apply.ts）。
 */

import type {
  ApplyJob,
  CueBook,
  PersistShape,
  SceneCueOverride,
  SceneInstance,
  ShowTemplate,
  TemplateCue,
  VersionSnapshot,
} from 'stage-cue-editor/models/cue-book';
import { CUE_KINDS } from 'stage-cue-editor/models/cue-book';
import type { CueKind } from 'stage-cue-editor/models/cue-book';
import { uid } from './util';

export const SCHEMA_VERSION = 2;

interface LegacyCue {
  id?: string;
  kind?: unknown;
  title?: string;
  duration?: number;
  owner?: string;
  lighting?: string;
  sound?: string;
  props?: string[];
  cast?: string[];
  notes?: string;
  dependsOn?: string[];
  offset?: number;
}

interface LegacyScene {
  id?: string;
  act?: string;
  name?: string;
  title?: string;
  startTime?: string;
  locked?: boolean;
  cues?: LegacyCue[];
}

interface LegacyShow {
  title?: string;
  venue?: string;
  date?: string;
  scenes?: LegacyScene[];
  updatedAt?: string;
}

interface LegacyRoot {
  show?: LegacyShow;
  versions?: Array<{
    id?: string;
    name?: string;
    createdAt?: string;
    data?: LegacyShow;
  }>;
}

function isCueKind(value: unknown): value is CueKind {
  return CUE_KINDS.includes(value as CueKind);
}

function toTemplateCue(raw: LegacyCue): TemplateCue {
  return {
    key: raw.id && raw.id.length ? raw.id : uid('cue'),
    kind: isCueKind(raw.kind) ? raw.kind : '舞台',
    title: raw.title ?? '未命名提示',
    duration: Math.max(1, Number(raw.duration) || 1),
    owner: raw.owner ?? '',
    lighting: raw.lighting ?? '',
    sound: raw.sound ?? '',
    props: Array.isArray(raw.props) ? raw.props.filter(Boolean) : [],
    cast: Array.isArray(raw.cast) ? raw.cast.filter(Boolean) : [],
    notes: raw.notes ?? '',
    dependsOnKeys: Array.isArray(raw.dependsOn)
      ? raw.dependsOn.filter(Boolean)
      : [],
  };
}

function buildTemplateFromLegacy(
  legacy: LegacyScene,
  index: number,
): ShowTemplate {
  const now = new Date().toISOString();
  const cues = (legacy.cues ?? []).map(toTemplateCue);
  const label =
    `${legacy.act ?? ''}${legacy.name ?? `S${index + 1}`}`.trim() ||
    `流程 ${index + 1}`;
  return {
    id: uid('template'),
    name: `迁移模板 · ${label}`,
    description: `由旧版「${legacy.title ?? label}」自动拆分生成，提示顺序/时长/负责人归模板所有。`,
    currentVersion: 1,
    versions: [
      {
        version: 1,
        createdAt: now,
        note: '旧版数据迁移',
        cues,
      },
    ],
    createdAt: now,
    updatedAt: now,
  };
}

function buildSceneFromLegacy(
  legacy: LegacyScene,
  template: ShowTemplate,
): SceneInstance {
  return {
    id: legacy.id && legacy.id.length ? legacy.id : uid('scene'),
    templateId: template.id,
    templateVersion: 1,
    act: legacy.act ?? '',
    name: legacy.name ?? '',
    title: legacy.title ?? '未命名场次',
    startTime: legacy.startTime ?? '19:30',
    locked: Boolean(legacy.locked),
    // 旧场次的所有提示值已整体上移为模板默认值，因此迁移后没有任何本场覆盖，
    // 旧数据一条不丢，且后续可独立调整而不影响模板或其他场次。
    cueOverrides: [],
    migrationWarnings: [],
  };
}

export function migrateLegacyShow(show: LegacyShow): CueBook {
  const now = new Date().toISOString();
  const templates: ShowTemplate[] = [];
  const scenes: SceneInstance[] = [];
  (show.scenes ?? []).forEach((legacy, index) => {
    const template = buildTemplateFromLegacy(legacy, index);
    templates.push(template);
    scenes.push(buildSceneFromLegacy(legacy, template));
  });
  return normalizeBook({
    schemaVersion: SCHEMA_VERSION,
    title: show.title ?? '未命名演出',
    venue: show.venue ?? '',
    date: show.date ?? '',
    templates,
    scenes,
    updatedAt: show.updatedAt ?? now,
  });
}

function normalizeOverride(raw: Partial<SceneCueOverride>): SceneCueOverride {
  const override: SceneCueOverride = { key: String(raw.key ?? '') };
  if (isCueKind(raw.kind)) override.kind = raw.kind;
  if (raw.title !== undefined) override.title = String(raw.title);
  if (raw.duration !== undefined)
    override.duration = Math.max(1, Number(raw.duration) || 1);
  if (raw.owner !== undefined) override.owner = String(raw.owner);
  if (raw.lighting !== undefined) override.lighting = String(raw.lighting);
  if (raw.sound !== undefined) override.sound = String(raw.sound);
  if (raw.props !== undefined)
    override.props = String(raw.props).split('、').filter(Boolean);
  if (raw.cast !== undefined)
    override.cast = String(raw.cast).split('、').filter(Boolean);
  if (raw.notes !== undefined) override.notes = String(raw.notes);
  return override;
}

/** 防御性归一化：只补全结构，绝不删除任何场次、覆盖或模板版本。 */
export function normalizeBook(
  input: Partial<CueBook> | null | undefined,
): CueBook {
  const book = (input ?? {}) as Partial<CueBook>;
  const templates = Array.isArray(book.templates)
    ? book.templates.map((template) => {
        const versions = Array.isArray(template.versions)
          ? template.versions
          : [];
        const ordered = [...versions].sort((a, b) => a.version - b.version);
        const currentVersion =
          template.currentVersion &&
          ordered.some((item) => item.version === template.currentVersion)
            ? template.currentVersion
            : (ordered[ordered.length - 1]?.version ?? 1);
        return {
          ...template,
          id: String(template.id ?? uid('template')),
          name: String(template.name ?? '未命名模板'),
          description: String(template.description ?? ''),
          currentVersion,
          versions: ordered,
          createdAt: String(template.createdAt ?? new Date().toISOString()),
          updatedAt: String(template.updatedAt ?? new Date().toISOString()),
        } satisfies ShowTemplate;
      })
    : [];
  const scenes = Array.isArray(book.scenes)
    ? book.scenes.map((raw) => ({
        id: String(raw.id ?? uid('scene')),
        templateId: String(raw.templateId ?? ''),
        templateVersion: Number(raw.templateVersion) || 1,
        act: String(raw.act ?? ''),
        name: String(raw.name ?? ''),
        title: String(raw.title ?? '未命名场次'),
        startTime: String(raw.startTime ?? '19:30'),
        locked: Boolean(raw.locked),
        cueOverrides: Array.isArray(raw.cueOverrides)
          ? raw.cueOverrides
              .filter((item) => item && String(item.key ?? '').length)
              .map((item) => normalizeOverride(item))
          : [],
        migrationWarnings: Array.isArray(raw.migrationWarnings)
          ? raw.migrationWarnings.map(String)
          : [],
      }))
    : [];
  return {
    schemaVersion: SCHEMA_VERSION,
    title: String(book.title ?? '未命名演出'),
    venue: String(book.venue ?? ''),
    date: String(book.date ?? ''),
    templates,
    scenes,
    updatedAt: String(book.updatedAt ?? new Date().toISOString()),
  };
}

function normalizeSnapshot(
  raw: Partial<VersionSnapshot> & { data?: LegacyShow },
): VersionSnapshot {
  const book =
    raw.book && (raw.book as CueBook).schemaVersion === SCHEMA_VERSION
      ? normalizeBook(raw.book)
      : raw.data
        ? migrateLegacyShow(raw.data)
        : normalizeBook(null);
  return {
    id: String(raw.id ?? uid('version')),
    name: String(raw.name ?? '锁定版'),
    createdAt: String(raw.createdAt ?? new Date().toISOString()),
    book,
  };
}

/** 套用中宕机：提交是单次原子赋值，中断不可能写脏业务数据，作业回到待处理即可重试。 */
export function recoverJobs(jobs: ApplyJob[]): ApplyJob[] {
  return jobs.map((job) =>
    job.status === 'applying'
      ? {
          ...job,
          status: 'pending',
          error: '',
          updatedAt: new Date().toISOString(),
        }
      : job,
  );
}

function isLegacyRoot(raw: unknown): raw is LegacyRoot {
  const root = raw as LegacyRoot | null;
  return Boolean(
    root &&
    typeof root === 'object' &&
    root.show &&
    Array.isArray(root.show.scenes),
  );
}

/**
 * 解析持久化内容。兼容：
 * - v2：{ book, versions, jobs }
 * - v1：{ show, versions }（整份深拷贝的旧模型）
 */
export function parsePersisted(raw: unknown): PersistShape | null {
  if (!raw || typeof raw !== 'object') return null;
  const root = raw as Partial<PersistShape> & LegacyRoot;

  let book: CueBook;
  if (root.book && (root.book as CueBook).schemaVersion === SCHEMA_VERSION) {
    book = normalizeBook(root.book);
  } else if (isLegacyRoot(raw)) {
    book = migrateLegacyShow(root.show as LegacyShow);
  } else {
    return null;
  }

  const versions = Array.isArray(root.versions)
    ? root.versions.map(normalizeSnapshot)
    : [];
  const jobs = recoverJobs(
    Array.isArray(root.jobs) ? (root.jobs as ApplyJob[]) : [],
  );
  return { book, versions, jobs };
}

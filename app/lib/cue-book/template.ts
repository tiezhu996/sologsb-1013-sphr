/**
 * 模板所有权操作：编辑草稿、维护提示顺序、发布不可变新版本。
 *
 * 模板版本 append-only：发布后旧版本永久保留，停留在旧版本的场次仍可解析，
 * 并通过 apply.ts 迁移到新版本。
 */

import type {
  CueBook,
  CueKind,
  SceneCueOverride,
  ShowTemplate,
  TemplateCue,
} from 'stage-cue-editor/models/cue-book';
import { findVersion } from './resolve';
import { uid } from './util';

export function getTemplate(book: CueBook, templateId: string): ShowTemplate {
  const template = book.templates.find((item) => item.id === templateId);
  if (!template) throw new Error('模板不存在');
  return template;
}

export function draftToTemplateCue(draft: {
  key?: string;
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
}): TemplateCue {
  return {
    key: draft.key && draft.key.length ? draft.key : uid('cue'),
    kind: draft.kind,
    title: draft.title.trim() || '未命名提示',
    duration: Math.max(1, Number(draft.duration) || 1),
    owner: draft.owner,
    lighting: draft.lighting,
    sound: draft.sound,
    props: draft.props,
    cast: draft.cast,
    notes: draft.notes,
    dependsOnKeys: draft.dependsOnKeys,
  };
}

/**
 * 在模板「工作副本」（当前版本的可编辑拷贝）上写一条提示：
 * 已存在则替换，否则追加。模板编辑只改这份草稿，发布时才形成新版本。
 */
export function upsertTemplateCue(
  cues: TemplateCue[],
  cue: TemplateCue,
): TemplateCue[] {
  const next = cues.map((item) => ({
    ...item,
    props: [...item.props],
    cast: [...item.cast],
    dependsOnKeys: [...item.dependsOnKeys],
  }));
  const index = next.findIndex((item) => item.key === cue.key);
  if (index >= 0) next.splice(index, 1, cue);
  else next.push(cue);
  return next;
}

export function removeTemplateCue(
  cues: TemplateCue[],
  key: string,
): TemplateCue[] {
  return cues.filter((item) => item.key !== key);
}

/** 模板拥有顺序：移动提示位置（场次不能改顺序）。 */
export function moveTemplateCue(
  cues: TemplateCue[],
  sourceKey: string,
  targetKey: string,
): TemplateCue[] {
  const next = [...cues];
  const from = next.findIndex((item) => item.key === sourceKey);
  const to = next.findIndex((item) => item.key === targetKey);
  if (from < 0 || to < 0 || from === to) return cues;
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved!);
  return next;
}

/**
 * 发布一个不可变新版本，返回新模板。提示用稳定 key 做身份，重命名/移动也能匹配。
 */
export function publishTemplateVersion(
  template: ShowTemplate,
  cues: TemplateCue[],
  note: string,
): ShowTemplate {
  const nextVersion = template.currentVersion + 1;
  return {
    ...template,
    currentVersion: nextVersion,
    versions: [
      ...template.versions,
      { version: nextVersion, createdAt: new Date().toISOString(), note, cues },
    ],
    updatedAt: new Date().toISOString(),
  };
}

/** 模板改名/描述（不产生新版本，不影响任何场次解析）。 */
export function updateTemplateMeta(
  template: ShowTemplate,
  patch: Pick<ShowTemplate, 'name' | 'description'>,
): ShowTemplate {
  return { ...template, ...patch, updatedAt: new Date().toISOString() };
}

export interface OverrideMigration {
  overrides: SceneCueOverride[];
  /** 新模板版本中已不存在的覆盖键（升级不删除，保留并提示人工处理）。 */
  orphans: string[];
  /** 升级后覆盖字段与新默认值恰好相同的键（覆盖保留，但提示可一键清理）。 */
  redundantKeys: string[];
}

/**
 * 把一场覆盖从旧版本迁移到新版本：只按稳定 key 重新匹配，不丢任何覆盖。
 * - key 在新版本仍存在：原样保留（即使新默认值已相同，也保留用户显式选择）。
 * - key 已删除：归入 orphans，覆盖仍在场次数据中。
 */
export function migrateOverrides(
  overrides: SceneCueOverride[],
  nextCues: TemplateCue[],
): OverrideMigration {
  const nextByKey = new Map(nextCues.map((cue) => [cue.key, cue]));
  const kept: SceneCueOverride[] = [];
  const orphans: string[] = [];
  const redundantKeys: string[] = [];
  overrides.forEach((override) => {
    const cue = nextByKey.get(override.key);
    if (!cue) {
      orphans.push(override.key);
      kept.push(override);
      return;
    }
    kept.push(override);
    const allFields: (keyof SceneCueOverride)[] = [
      'kind',
      'title',
      'duration',
      'owner',
      'lighting',
      'sound',
      'props',
      'cast',
      'notes',
    ];
    const redundant = allFields.every((field) => {
      if (override[field] === undefined) return true;
      const templateValue = cue[field as keyof TemplateCue];
      const overrideValue = override[field];
      if (Array.isArray(templateValue) && Array.isArray(overrideValue)) {
        return templateValue.join('|') === overrideValue.join('|');
      }
      return templateValue === overrideValue;
    });
    if (redundant) redundantKeys.push(override.key);
  });
  return { overrides: kept, orphans, redundantKeys };
}

/** 便捷：取某版本的提示（默认当前版本）。 */
export function templateCues(
  template: ShowTemplate,
  version?: number,
): TemplateCue[] {
  return findVersion(template, version)?.cues ?? [];
}

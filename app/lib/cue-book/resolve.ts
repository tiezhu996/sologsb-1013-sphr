/**
 * 解析层：把「模板版本」与「场次稀疏覆盖」合并为生效提示。
 *
 * 这里是所有权边界的体现——顺序永远来自模板版本（数组次序），场次只能改变
 * 模板已有提示的字段；未覆盖字段直接读模板当前版本，所以模板一改，未覆盖场次
 * 在下一次读取时立即得到新值，无需任何回填或通知。
 */

import type {
  CueBook,
  EffectiveCue,
  EffectiveScene,
  SceneCueOverride,
  SceneInstance,
  ShowTemplate,
  TemplateCue,
  TemplateOwnedCueField,
  TemplateVersion,
} from 'stage-cue-editor/models/cue-book';
import { TEMPLATE_OWNED_CUE_FIELDS } from 'stage-cue-editor/models/cue-book';

export function findTemplate(
  book: CueBook,
  templateId: string,
): ShowTemplate | undefined {
  return book.templates.find((template) => template.id === templateId);
}

/** 读取指定版本；不传版本号时取当前版本。版本是 append-only 的，旧版本永不丢失。 */
export function findVersion(
  template: ShowTemplate,
  version?: number,
): TemplateVersion | undefined {
  const target = version ?? template.currentVersion;
  return template.versions.find((item) => item.version === target);
}

export function listOverrideFields(
  override: SceneCueOverride,
): TemplateOwnedCueField[] {
  return TEMPLATE_OWNED_CUE_FIELDS.filter(
    (field) => override[field] !== undefined,
  );
}

/** 单条提示合并：以模板为底，叠加场次覆盖（只覆盖实际存在的键）。 */
export function mergeCue(
  base: TemplateCue,
  override: SceneCueOverride | undefined,
): EffectiveCue {
  const merged: EffectiveCue = {
    key: base.key,
    kind: base.kind,
    title: base.title,
    duration: base.duration,
    owner: base.owner,
    lighting: base.lighting,
    sound: base.sound,
    props: base.props,
    cast: base.cast,
    notes: base.notes,
    dependsOnKeys: base.dependsOnKeys,
    offset: 0,
    overriddenFields: [],
  };
  if (override) {
    for (const field of listOverrideFields(override)) {
      const value = override[field];
      if (value !== undefined) {
        // 覆盖值类型与模板字段一致（owner:''、props:[] 等空值也代表显式覆盖）。
        (merged as unknown as Record<string, unknown>)[field] = value;
      }
    }
    merged.overriddenFields = listOverrideFields(override);
  }
  return merged;
}

/**
 * 计算一个场次的生效视图：
 * - 顺序、提示集合按模板当前版本；
 * - 覆盖只改字段，不能新增/删除提示，也不能改顺序；
 * - 模板里已删除但本场仍覆盖的提示保留在 `orphanOverrides`，绝不静默丢弃。
 */
export function effectiveScene(
  book: CueBook,
  scene: SceneInstance,
): EffectiveScene {
  const template = findTemplate(book, scene.templateId);
  const version = template ? findVersion(template) : undefined;
  if (!template || !version) {
    return {
      scene,
      template,
      version,
      cues: [],
      orphanOverrides: scene.cueOverrides.map((item) => ({ ...item })),
      upToDate: false,
    };
  }

  const overrideByKey = new Map(
    scene.cueOverrides.map((item) => [item.key, item]),
  );
  let elapsed = 0;
  const cues: EffectiveCue[] = version.cues.map((base) => {
    const cue = mergeCue(base, overrideByKey.get(base.key));
    cue.offset = elapsed;
    elapsed += Number(cue.duration) || 0;
    return cue;
  });

  const liveKeys = new Set(version.cues.map((cue) => cue.key));
  const orphanOverrides = scene.cueOverrides
    .filter((item) => !liveKeys.has(item.key))
    .map((item) => ({ ...item }));

  return {
    scene,
    template,
    version,
    cues,
    orphanOverrides,
    upToDate: scene.templateVersion === version.version,
  };
}

export function effectiveScenes(book: CueBook): EffectiveScene[] {
  return book.scenes.map((scene) => effectiveScene(book, scene));
}

export interface FlatCue {
  effective: EffectiveScene;
  cue: EffectiveCue;
}

/** 全场次扁平化的生效提示，供校验、统计使用。 */
export function flatCues(book: CueBook): FlatCue[] {
  return effectiveScenes(book).flatMap((effective) =>
    effective.cues.map((cue) => ({ effective, cue })),
  );
}

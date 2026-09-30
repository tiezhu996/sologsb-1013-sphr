import type { SceneCueOverride } from 'stage-cue-editor/models/cue-book';

/** 把孤立覆盖对象压成「字段=值」的可读字符串列表，用于迁移残留展示。 */
export function compactOverride(override: SceneCueOverride): string[] {
  const lines: string[] = [];
  const push = (label: string, value: unknown) => {
    if (value !== undefined && value !== null && value !== '')
      lines.push(`${label}:${String(value)}`);
  };
  push('类型', override.kind);
  push('标题', override.title);
  push('时长', override.duration);
  push('负责人', override.owner === '' ? '（清空）' : override.owner);
  push('灯光', override.lighting);
  push('音响', override.sound);
  if (override.props?.length) push('道具', override.props.join('、'));
  if (override.cast?.length) push('演员', override.cast.join('、'));
  push('备注', override.notes);
  return lines;
}

import { helper } from '@ember/component/helper';

export default helper(function compactOverrideHelper([override]: [
  SceneCueOverride,
]): string[] {
  return compactOverride(override);
});

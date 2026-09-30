/**
 * 场次覆盖构造：编辑器拿到的是「生效值」，保存时必须还原成「相对模板基线的差异」，
 * 否则会把继承值误存成本场覆盖，导致模板改动无法传导到该字段。
 */

import type {
  CueKind,
  SceneCueOverride,
  TemplateCue,
  TemplateOwnedCueField,
} from 'stage-cue-editor/models/cue-book';

export interface CueFieldValues {
  kind: CueKind;
  title: string;
  duration: number;
  owner: string;
  lighting: string;
  sound: string;
  props: string[];
  cast: string[];
  notes: string;
}

const FIELDS: TemplateOwnedCueField[] = [
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

export function valuesOf(cue: CueFieldValues): CueFieldValues {
  return {
    kind: cue.kind,
    title: cue.title,
    duration: cue.duration,
    owner: cue.owner,
    lighting: cue.lighting,
    sound: cue.sound,
    props: [...cue.props],
    cast: [...cue.cast],
    notes: cue.notes,
  };
}

function sameField(
  field: TemplateOwnedCueField,
  base: TemplateCue,
  values: CueFieldValues,
): boolean {
  const a = base[field];
  const b = values[field];
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, index) => item === b[index]);
  }
  return a === b;
}

/**
 * 以模板基线为准生成稀疏覆盖：只保留与模板不同的字段；全部相同则返回 null
 * （调用方应删除该提示的覆盖条目，使其完全继承模板）。
 */
export function buildOverride(
  base: TemplateCue,
  values: CueFieldValues,
): SceneCueOverride | null {
  const override: SceneCueOverride = { key: base.key };
  let changed = false;
  for (const field of FIELDS) {
    if (sameField(field, base, values)) continue;
    changed = true;
    switch (field) {
      case 'kind':
        override.kind = values.kind;
        break;
      case 'title':
        override.title = values.title;
        break;
      case 'duration':
        override.duration = values.duration;
        break;
      case 'owner':
        override.owner = values.owner;
        break;
      case 'lighting':
        override.lighting = values.lighting;
        break;
      case 'sound':
        override.sound = values.sound;
        break;
      case 'props':
        override.props = [...values.props];
        break;
      case 'cast':
        override.cast = [...values.cast];
        break;
      case 'notes':
        override.notes = values.notes;
        break;
    }
  }
  return changed ? override : null;
}

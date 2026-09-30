/** 首演示例：一个跨剧场复用的模板 + 两个剧场场次（各自只存覆盖）。 */

import type { CueBook, ShowTemplate } from 'stage-cue-editor/models/cue-book';
import { SCHEMA_VERSION } from './migration';

const stamp = new Date().toISOString();

const touringTemplate: ShowTemplate = {
  id: 'template-touring',
  name: '《长夜行》巡演通用流程',
  description: '固定提示顺序、时长与默认负责人；各剧场场次只记录本场覆盖。',
  currentVersion: 1,
  createdAt: stamp,
  updatedAt: stamp,
  versions: [
    {
      version: 1,
      createdAt: stamp,
      note: '首演基线',
      cues: [
        {
          key: 'cue-light-1',
          kind: '灯光',
          title: '观众席渐暗 · 面光起',
          duration: 45,
          owner: '李岚',
          lighting: 'FOH 1 号面光 65%，侧光暖白 40%',
          sound: '',
          props: [],
          cast: [],
          notes: '开演铃后 10 秒执行',
          dependsOnKeys: [],
        },
        {
          key: 'cue-actor-1',
          kind: '演员',
          title: '说书人自左台入场',
          duration: 90,
          owner: '赵一帆',
          lighting: '',
          sound: '',
          props: ['折扇'],
          cast: ['说书人／周启'],
          notes: '追光跟随；入场后停留台中',
          dependsOnKeys: ['cue-light-1'],
        },
        {
          key: 'cue-sound-1',
          kind: '音响',
          title: '古琴引子淡入',
          duration: 120,
          owner: '陈默',
          lighting: '',
          sound: 'Q1 古琴引子，-18dB 淡入 6 秒',
          props: [],
          cast: [],
          notes: '',
          dependsOnKeys: ['cue-deleted-old'],
        },
        {
          key: 'cue-prop-1',
          kind: '道具',
          title: '月牙灯升至舞台中线',
          duration: 75,
          owner: '孙禾',
          lighting: '顶排 3 号定点',
          sound: '',
          props: ['月牙灯'],
          cast: [],
          notes: '',
          dependsOnKeys: [],
        },
      ],
    },
  ],
};

export function sampleBook(): CueBook {
  return {
    schemaVersion: SCHEMA_VERSION,
    title: '《长夜行》巡演提示表',
    venue: '实验剧场 A 厅',
    date: '2026-10-18',
    templates: [touringTemplate],
    scenes: [
      {
        id: 'scene-a',
        templateId: 'template-touring',
        templateVersion: 1,
        act: '第一幕',
        name: 'A 站',
        title: '首演 · 月下序场',
        startTime: '19:30',
        locked: false,
        // 本场临时调整：只覆盖了一条提示的时长；其余全部继承模板，复制下一站不会带走。
        cueOverrides: [{ key: 'cue-sound-1', duration: 95 }],
        migrationWarnings: [],
      },
      {
        id: 'scene-b',
        templateId: 'template-touring',
        templateVersion: 1,
        act: '第一幕',
        name: 'B 站',
        title: '下一站 · 月下序场',
        startTime: '19:45',
        locked: false,
        // 本场临时调整：换了灯光负责人、道具备注，与 A 站互不影响。
        cueOverrides: [
          { key: 'cue-light-1', owner: '周启' },
          { key: 'cue-prop-1', notes: '本站月牙灯改由上场门吊装' },
        ],
        migrationWarnings: [],
      },
    ],
    updatedAt: stamp,
  };
}

/**
 * 套用模板的事务层。
 *
 * 不变量：
 * - 业务数据（book）只在「预检全部通过」后做一次原子替换；任何失败都发生在替换之前，
 *   因此回滚 = 直接丢弃本次计算结果，原场次与模板一条数据都不会少。
 * - 作业（ApplyJob）独立持久化：成功/失败/待处理状态都单独保存；页面重开后
 *   `recoverJobs` 把卡在 applying 的作业恢复为 pending，用户可「继续处理」重试。
 */

import type {
  ApplyJob,
  CueBook,
  JobKind,
  SceneCueOverride,
  SceneInstance,
} from 'stage-cue-editor/models/cue-book';
import { migrateOverrides } from './template';
import { findTemplate, findVersion } from './resolve';
import { uid } from './util';

function now(): string {
  return new Date().toISOString();
}

function jobBase(
  kind: JobKind,
  templateId: string,
  targetVersion: number,
  label: string,
): ApplyJob {
  const stamp = now();
  return {
    id: uid('job'),
    kind,
    status: 'pending',
    label,
    templateId,
    targetVersion,
    sceneId: '',
    draft: null,
    error: '',
    attempts: 0,
    createdAt: stamp,
    updatedAt: stamp,
  };
}

/** 复制新场次：先选择模板，再携带本场草案入队（此时不动任何业务数据）。 */
export function createSceneJob(
  templateId: string,
  targetVersion: number,
  draft: {
    act: string;
    name: string;
    title: string;
    startTime: string;
    cueOverrides: SceneCueOverride[];
  },
): ApplyJob {
  return {
    ...jobBase(
      'create-scene',
      templateId,
      targetVersion,
      `按模板新建场次「${draft.title}」`,
    ),
    sceneId: uid('scene'),
    draft: {
      ...draft,
      cueOverrides: draft.cueOverrides.map((item) => ({ ...item })),
    },
  };
}

/** 升级既有场次到模板新版本。 */
export function upgradeSceneJob(
  sceneId: string,
  templateId: string,
  targetVersion: number,
): ApplyJob {
  return {
    ...jobBase(
      'upgrade-scene',
      templateId,
      targetVersion,
      `升级场次到模板 v${targetVersion}`,
    ),
    sceneId,
  };
}

/** 预检：只读取并校验，绝不修改 book。失败信息直接用于界面提示。 */
export function preflight(book: CueBook, job: ApplyJob): CueBook {
  const template = findTemplate(book, job.templateId);
  if (!template)
    throw new Error('所选模板不存在，无法套用（模板数据未改动）。');
  const version = findVersion(template, job.targetVersion);
  if (!version)
    throw new Error(`模板 v${job.targetVersion} 不存在（模板数据未改动）。`);

  if (job.kind === 'create-scene') {
    if (!job.draft) throw new Error('缺少场次草案，无法套用。');
    if (book.scenes.some((scene) => scene.id === job.sceneId)) {
      throw new Error('待建场次 ID 已存在，已中止以避免覆盖（原场次未改动）。');
    }
  } else {
    const scene = book.scenes.find((item) => item.id === job.sceneId);
    if (!scene)
      throw new Error('待升级的原场次不存在，已中止（模板与其他场次未改动）。');
    if (scene.templateId !== job.templateId) {
      throw new Error(
        '原场次绑定的是另一个模板，不能跨模板升级（原场次未改动）。',
      );
    }
    if (scene.templateVersion >= job.targetVersion) {
      throw new Error('原场次版本不低于目标版本，无需升级。');
    }
  }
  return book;
}

/**
 * 执行套用。先 preflight，再在 book 的深拷贝上构造结果，全部成功后才返回新 book；
 * 构造过程中任一步抛错都不会触及入参 book —— 这就是回滚保证。
 */
export function applyJob(
  book: CueBook,
  job: ApplyJob,
): { book: CueBook; job: ApplyJob } {
  preflight(book, job); // 失败即抛出，book 保持原样
  const next: CueBook = JSON.parse(JSON.stringify(book)) as CueBook;
  const template = findTemplate(next, job.templateId)!;
  const version = findVersion(template, job.targetVersion)!;

  if (job.kind === 'create-scene') {
    const draft = job.draft!;
    const scene: SceneInstance = {
      id: job.sceneId,
      templateId: job.templateId,
      templateVersion: job.targetVersion,
      act: draft.act,
      name: draft.name,
      title: draft.title,
      startTime: draft.startTime,
      locked: false,
      cueOverrides: draft.cueOverrides.map((item) => ({ ...item })),
      migrationWarnings: [],
    };
    next.scenes = [...next.scenes, scene];
  } else {
    next.scenes = next.scenes.map((scene) => {
      if (scene.id !== job.sceneId) return scene;
      const migration = migrateOverrides(scene.cueOverrides, version.cues);
      const warnings: string[] = [];
      if (migration.orphans.length) {
        warnings.push(
          `v${job.targetVersion} 中以下提示已删除，本场覆盖已保留：${migration.orphans.join('、')}`,
        );
      }
      if (migration.redundantKeys.length) {
        warnings.push(
          `以下覆盖与新模板默认值相同，可考虑清理：${migration.redundantKeys.join('、')}`,
        );
      }
      return {
        ...scene,
        templateVersion: job.targetVersion,
        cueOverrides: migration.overrides.map((item) => ({ ...item })),
        migrationWarnings: warnings,
      };
    });
    if (
      !next.scenes.some(
        (scene) =>
          scene.id === job.sceneId &&
          scene.templateVersion === job.targetVersion,
      )
    ) {
      // 理论不可达（预检已保证）；作为最后防线抛错，调用方保留旧 book。
      throw new Error('升级结果校验失败，已回滚（原场次与模板均未改动）。');
    }
  }

  next.updatedAt = now();
  return {
    book: next,
    job: {
      ...job,
      status: 'succeeded',
      error: '',
      attempts: job.attempts + 1,
      updatedAt: now(),
    },
  };
}

/** 标记失败：记录原因与尝试次数；book 维持原样，等待重试/继续处理。 */
export function failJob(job: ApplyJob, error: unknown): ApplyJob {
  return {
    ...job,
    status: 'failed',
    error: error instanceof Error ? error.message : String(error),
    attempts: job.attempts + 1,
    updatedAt: now(),
  };
}

/** 重开后继续处理：把失败/待处理作业重新置为待执行。 */
export function resumeJob(job: ApplyJob): ApplyJob {
  return { ...job, status: 'pending', error: '', updatedAt: now() };
}

export function isBlockedJob(job: ApplyJob): boolean {
  return (
    job.status === 'pending' ||
    job.status === 'failed' ||
    job.status === 'applying'
  );
}

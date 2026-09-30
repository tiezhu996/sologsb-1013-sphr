/**
 * 校验层：在「生效视图」上检查问题。模板与覆盖合并后再校验，避免把
 * 模板继承值误判成本场问题。
 */

import type { CueBook, CueIssue } from 'stage-cue-editor/models/cue-book';
import { effectiveScenes } from './resolve';
import { overlaps, startSeconds } from './timing';

export function collectIssues(book: CueBook): CueIssue[] {
  const issues: CueIssue[] = [];
  const scenes = effectiveScenes(book);

  scenes.forEach((effective) => {
    const { scene, cues, orphanOverrides, template, upToDate } = effective;

    if (!template) {
      issues.push({
        id: `missing-template-${scene.id}`,
        severity: 'error',
        title: '模板缺失',
        detail: `「${scene.title}」引用的模板已不存在，本场覆盖被完整保留，请重新选择模板。`,
        sceneId: scene.id,
      });
      return;
    }
    if (!upToDate) {
      issues.push({
        id: `stale-${scene.id}`,
        severity: 'info',
        title: '模板待迁移',
        detail: `「${scene.title}」停留在 v${scene.templateVersion}，模板已到 v${template.currentVersion}，可升级迁移。`,
        sceneId: scene.id,
      });
    }

    const liveKeys = new Set(cues.map((cue) => cue.key));
    cues.forEach((cue) => {
      if (!cue.owner) {
        issues.push({
          id: `owner-${scene.id}-${cue.key}`,
          severity: 'error',
          title: '负责人空缺',
          detail: `${scene.act} ${scene.name}「${cue.title}」尚未指定负责人。`,
          sceneId: scene.id,
          cueKey: cue.key,
        });
      }
      cue.dependsOnKeys.forEach((reference) => {
        if (!liveKeys.has(reference)) {
          issues.push({
            id: `ref-${scene.id}-${cue.key}-${reference}`,
            severity: 'error',
            title: '提示被引用但已删除',
            detail: `「${cue.title}」依赖的提示 ${reference} 在当前模板版本中不存在。`,
            sceneId: scene.id,
            cueKey: cue.key,
          });
        }
      });
    });

    orphanOverrides.forEach((override) => {
      issues.push({
        id: `orphan-${scene.id}-${override.key}`,
        severity: 'warning',
        title: '孤立的本场覆盖',
        detail: `本场对 ${override.key} 的调整在模板 v${template.currentVersion} 中已无对应提示，数据保留待处理。`,
        sceneId: scene.id,
        cueKey: override.key,
      });
    });
  });

  // 跨场道具 / 演员撞场。
  const flat = scenes.flatMap((effective) =>
    effective.cues.map((cue) => ({ effective, cue })),
  );
  for (let index = 0; index < flat.length; index += 1) {
    for (let next = index + 1; next < flat.length; next += 1) {
      const left = flat[index]!;
      const right = flat[next]!;
      if (left.effective.scene.id === right.effective.scene.id) continue;
      const leftStart =
        startSeconds(left.effective.scene.startTime) + left.cue.offset;
      const rightStart =
        startSeconds(right.effective.scene.startTime) + right.cue.offset;
      if (
        !overlaps(leftStart, left.cue.duration, rightStart, right.cue.duration)
      )
        continue;
      const sharedProps = left.cue.props.filter((value) =>
        right.cue.props.includes(value),
      );
      const sharedCast = left.cue.cast.filter((value) =>
        right.cue.cast.includes(value),
      );
      if (sharedProps.length) {
        issues.push({
          id: `prop-${left.cue.key}-${right.cue.key}`,
          severity: 'warning',
          title: '道具撞场',
          detail: `「${left.cue.title}」与「${right.cue.title}」同时使用：${sharedProps.join('、')}。`,
          sceneId: right.effective.scene.id,
          cueKey: right.cue.key,
        });
      }
      if (sharedCast.length) {
        issues.push({
          id: `cast-${left.cue.key}-${right.cue.key}`,
          severity: 'warning',
          title: '演员撞场',
          detail: `「${left.cue.title}」与「${right.cue.title}」同时需要：${sharedCast.join('、')}。`,
          sceneId: right.effective.scene.id,
          cueKey: right.cue.key,
        });
      }
    }
  }

  return issues.map((issue) => ({
    ...issue,
    icon: issue.severity === 'error' ? '!' : 'i',
  }));
}

import Component from '@glimmer/component';
import { tracked } from '@glimmer/tracking';
import { action } from '@ember/object';
import type {
  CueDraft,
  CueField,
  CueIssue,
  CueKind,
  CueTemplate,
  LocalCue,
  PendingApply,
  ResolvedCue,
  Scene,
  ShowData,
  TemplateCue,
  VersionDiff,
  VersionSnapshot,
  WorkspaceState,
} from 'stage-cue-editor/models/show';
import { CUE_KINDS, OWNERS } from 'stage-cue-editor/models/show';
import {
  loadWorkspace,
  persistWorkspace,
} from 'stage-cue-editor/utils/workspace-store';
import {
  ApplyTemplateError,
  addLocalCue,
  addTemplateCue,
  buildSceneFromTemplate,
  checksum,
  clearOverrideField,
  clone,
  discardDetachedOverride,
  duplicateScene,
  effectiveVersion,
  emptyTemplate,
  ensureVersionForPin,
  findTemplate,
  latestReleasedVersion,
  migrateScene,
  moveResolvedCue,
  moveTemplateCue,
  nextCueId,
  overlaps,
  pendingApplySummary,
  releaseTemplate,
  removeLocalCue,
  removeTemplateCue,
  renameTemplate,
  resetCueOverrides,
  resolveScene,
  restoreDetachedOverride,
  setOverrideField,
  startSeconds,
  timeLabel,
  toggleSkippedCue,
  touchShow,
  uid,
  updateLocalCue,
  updateTemplateCue,
  validateTemplate,
  workspaceCounts,
} from 'stage-cue-editor/utils/template-engine';

type WorkspaceMode = 'scenes' | 'templates';
type EditTarget = { source: 'template' | 'local'; cueId: string };

const splitList = (value: string): string[] =>
  value
    .split(/[、,，]/)
    .map((item) => item.trim())
    .filter(Boolean);

export default class CueEditorComponent extends Component {
  @tracked state: WorkspaceState;
  @tracked versions: VersionSnapshot[] = [];
  @tracked pendingApply: PendingApply | null = null;
  @tracked migratedFromV1 = false;

  @tracked mode: WorkspaceMode = 'scenes';
  @tracked activeSceneId = '';
  @tracked selectedCueGlobalId = '';
  @tracked draft: CueDraft | null = null;
  @tracked editTarget: EditTarget | null = null;
  @tracked compareVersionId = '';
  @tracked message = '';
  @tracked search = '';

  @tracked activeTemplateId = '';
  @tracked templateDraft: CueDraft | null = null;
  @tracked templateDraftCueId: string | null = null;
  @tracked releaseNote = '';

  @tracked applyPickerOpen = false;
  @tracked applyTemplateId = '';
  @tracked applyAct = '';
  @tracked applyName = '';
  @tracked applyTitle = '';
  @tracked applyStartTime = '20:00';
  @tracked applyFailSimulation = false;

  private undoStack: WorkspaceState[] = [];
  private redoStack: WorkspaceState[] = [];
  private dragCueGlobalId = '';
  private dragTemplateCueId = '';

  constructor(owner: unknown, args: Record<string, unknown>) {
    super(owner, args);
    const loaded = loadWorkspace();
    this.state = loaded.state;
    this.versions = loaded.versions;
    this.pendingApply = loaded.pendingApply;
    this.migratedFromV1 = loaded.migratedFromV1;
    this.activeSceneId = this.state.show.scenes[0]?.id ?? '';
    this.selectedCueGlobalId = this.activeResolvedCues[0]?.id ?? '';
    this.activeTemplateId = this.state.templates[0]?.id ?? '';
    window.addEventListener('keydown', this.handleKeyboard);
    if (this.migratedFromV1)
      this.notify('已从旧版结构迁移：流程转为模板，场次只保留本场调整');
  }

  /* ---------------------------------------------------------------- */
  /* 基础派生数据                                                      */
  /* ---------------------------------------------------------------- */

  get show(): ShowData {
    return this.state.show;
  }

  get templates(): CueTemplate[] {
    return this.state.templates;
  }

  get activeScene(): Scene | undefined {
    return this.state.show.scenes.find(
      (scene) => scene.id === this.activeSceneId,
    );
  }

  get activeTemplate(): CueTemplate | undefined {
    return this.state.templates.find(
      (template) => template.id === this.activeTemplateId,
    );
  }

  get activeResolvedCues(): ResolvedCue[] {
    const scene = this.activeScene;
    if (!scene) return [];
    return resolveScene(scene, findTemplate(this.state, scene.templateId));
  }

  get selectedCue(): ResolvedCue | undefined {
    return this.activeResolvedCues.find(
      (cue) => cue.id === this.selectedCueGlobalId,
    );
  }

  get cueRows() {
    const scene = this.activeScene;
    if (!scene) return [];
    return this.activeResolvedCues.map((item, index) => ({
      ...item,
      index: index + 1,
      start: timeLabel(scene.startTime, item.offset),
      end: timeLabel(scene.startTime, item.offset + item.duration),
      selected: item.id === this.selectedCueGlobalId,
      hasIssue: this.issues.some((issue) => issue.cueId === item.id),
      kindClass:
        item.kind === '灯光'
          ? 'light'
          : item.kind === '音响'
            ? 'sound'
            : item.kind === '道具'
              ? 'prop'
              : item.kind === '演员'
                ? 'cast'
                : item.kind === '字幕'
                  ? 'caption'
                  : 'stage',
      propsLabel: item.props.join('、'),
      castLabel: item.cast.join('、'),
      overrideLabel: item.overridden.length
        ? `本场覆盖 ${item.overridden.length} 项`
        : '',
    }));
  }

  get sceneRows() {
    return this.state.show.scenes.map((scene) => {
      const template = findTemplate(this.state, scene.templateId);
      const version = effectiveVersion(scene, template);
      const cues = resolveScene(scene, template);
      const duration = cues.reduce((total, item) => total + item.duration, 0);
      return {
        id: scene.id,
        act: scene.act,
        name: scene.name,
        title: scene.title,
        startTime: scene.startTime,
        locked: scene.locked,
        active: scene.id === this.activeSceneId,
        cueCount: cues.length,
        issueCount: this.issues.filter((issue) => issue.sceneId === scene.id)
          .length,
        duration,
        templateName: template?.name ?? '无模板（手工场次）',
        versionLabel:
          scene.templateVersion == null
            ? '跟随最新'
            : `v${version?.version ?? scene.templateVersion}`,
        stale:
          scene.templateVersion != null &&
          template != null &&
          scene.templateVersion <
            (latestReleasedVersion(template)?.version ?? 0),
        detachedCount: scene.detachedOverrides.length,
      };
    });
  }

  get filteredScenes() {
    const term = this.search.trim().toLowerCase();
    return this.sceneRows.filter(
      (scene) =>
        !term ||
        `${scene.act}${scene.name}${scene.title}${scene.templateName}`
          .toLowerCase()
          .includes(term),
    );
  }

  get cueKindOptions(): CueKind[] {
    return CUE_KINDS;
  }

  get draftHeading(): string {
    if (!this.draft) return '提示详情';
    return this.editTarget?.source === 'template'
      ? '编辑本场覆盖'
      : '编辑本场提示';
  }

  get activeBinding(): {
    templateName: string;
    versionLabel: string;
    pinned: boolean;
    stale: boolean;
    latestVersion: number;
  } | null {
    const scene = this.activeScene;
    if (!scene || !scene.templateId) return null;
    const template = findTemplate(this.state, scene.templateId);
    if (!template) {
      return {
        templateName: '模板缺失',
        versionLabel:
          scene.templateVersion != null
            ? `v${scene.templateVersion}`
            : '跟随最新',
        pinned: scene.templateVersion != null,
        stale: false,
        latestVersion: 0,
      };
    }
    const pinned = scene.templateVersion != null;
    const effective = effectiveVersion(scene, template);
    const newestRelease = latestReleasedVersion(template)?.version ?? 0;
    return {
      templateName: template.name,
      versionLabel: pinned
        ? `钉住 v${effective?.version ?? scene.templateVersion}`
        : `跟随最新（v${template.current.version}）`,
      pinned,
      stale: pinned && (scene.templateVersion ?? 0) < newestRelease,
      latestVersion: newestRelease,
    };
  }

  get ownerOptions(): string[] {
    return OWNERS;
  }

  get totalCueCount(): number {
    return workspaceCounts(this.state).cues;
  }

  get pendingSummary() {
    return this.pendingApply ? pendingApplySummary(this.pendingApply) : null;
  }

  get pendingTemplate(): CueTemplate | undefined {
    return this.pendingApply
      ? this.state.templates.find(
          (template) => template.id === this.pendingApply!.templateId,
        )
      : undefined;
  }

  /* ---------------------------------------------------------------- */
  /* 检查：负责人、时间、撞场、失效引用、版本与模板归属                 */
  /* ---------------------------------------------------------------- */

  get issues(): CueIssue[] {
    const issues: CueIssue[] = [];
    const expanded: Array<{ scene: Scene; cues: ResolvedCue[] }> =
      this.state.show.scenes.map((scene) => ({
        scene,
        cues: resolveScene(scene, findTemplate(this.state, scene.templateId)),
      }));

    expanded.forEach(({ scene, cues }) => {
      const cueIds = new Set(cues.map((cue) => cue.cueId));
      cues.forEach((item) => {
        if (!item.owner) {
          issues.push({
            id: `owner-${item.id}`,
            severity: 'error',
            title: '负责人空缺',
            detail: `${scene.act} ${scene.name}「${item.title}」尚未指定负责人。`,
            sceneId: scene.id,
            cueId: item.id,
          });
        }
        item.dependsOn.forEach((reference) => {
          if (!cueIds.has(reference)) {
            issues.push({
              id: `ref-${item.id}-${reference}`,
              severity: 'error',
              title: '提示被引用但已删除',
              detail: `「${item.title}」仍依赖已删除或已停用的提示 ${reference}。`,
              sceneId: scene.id,
              cueId: item.id,
            });
          }
        });
        const previous = cues[cues.indexOf(item) - 1];
        if (previous && item.offset < previous.offset + previous.duration) {
          issues.push({
            id: `overlap-${item.id}`,
            severity: 'error',
            title: '同场时间冲突',
            detail: `「${item.title}」与上一条提示重叠。`,
            sceneId: scene.id,
            cueId: item.id,
          });
        }
      });

      const template = findTemplate(this.state, scene.templateId);
      if (scene.templateId && !template) {
        issues.push({
          id: `missing-tpl-${scene.id}`,
          severity: 'error',
          title: '模板缺失',
          detail: `${scene.name} 引用的模板已不存在，请重新选择模板或转为本场自有流程。`,
          sceneId: scene.id,
        });
      }
      if (
        template &&
        scene.templateVersion != null &&
        !template.releases.some(
          (release) => release.version === scene.templateVersion,
        )
      ) {
        issues.push({
          id: `missing-ver-${scene.id}`,
          severity: 'warning',
          title: '模板版本丢失',
          detail: `${scene.name} 钉住的 v${scene.templateVersion} 在模板「${template.name}」中已找不到。`,
          sceneId: scene.id,
        });
      }
      const liveIds = new Set(
        effectiveVersion(scene, template)?.cues.map((cue) => cue.cueId) ?? [],
      );
      scene.overrides.forEach((override) => {
        if (!liveIds.has(override.cueId)) {
          issues.push({
            id: `stray-override-${scene.id}-${override.cueId}`,
            severity: 'warning',
            title: '覆盖缺少对应模板提示',
            detail: `${scene.name} 中 ${override.cueId} 的本场覆盖在当前模板版本里没有对应项，可在面板中保留或恢复。`,
            sceneId: scene.id,
          });
        }
      });
      if (scene.detachedOverrides.length) {
        issues.push({
          id: `detached-${scene.id}`,
          severity: 'info',
          title: '存在迁移后待处理覆盖',
          detail: `${scene.name} 有 ${scene.detachedOverrides.length} 条覆盖在模板升级后失去对应提示，未删除，可人工恢复。`,
          sceneId: scene.id,
        });
      }
      if (
        scene.templateVersion != null &&
        template &&
        scene.templateVersion < (latestReleasedVersion(template)?.version ?? 0)
      ) {
        issues.push({
          id: `stale-${scene.id}`,
          severity: 'info',
          title: '场次停留在旧模板版本',
          detail: `${scene.name} 使用 v${scene.templateVersion}，模板「${template.name}」已发布 v${latestReleasedVersion(template)?.version}，可迁移。`,
          sceneId: scene.id,
        });
      }
    });

    const flat = expanded.flatMap(({ scene, cues }) =>
      cues.map((cue) => ({ scene, cue })),
    );
    for (let index = 0; index < flat.length; index += 1) {
      for (let next = index + 1; next < flat.length; next += 1) {
        const left = flat[index]!;
        const right = flat[next]!;
        if (left.scene.id === right.scene.id) continue;
        const leftStart = startSeconds(left.scene.startTime) + left.cue.offset;
        const rightStart =
          startSeconds(right.scene.startTime) + right.cue.offset;
        if (
          !overlaps(
            leftStart,
            left.cue.duration,
            rightStart,
            right.cue.duration,
          )
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
            id: `prop-${left.cue.id}-${right.cue.id}`,
            severity: 'warning',
            title: '道具撞场',
            detail: `「${left.cue.title}」与「${right.cue.title}」同时使用：${sharedProps.join('、')}。`,
            sceneId: right.scene.id,
            cueId: right.cue.id,
          });
        }
        if (sharedCast.length) {
          issues.push({
            id: `cast-${left.cue.id}-${right.cue.id}`,
            severity: 'warning',
            title: '演员撞场',
            detail: `「${left.cue.title}」与「${right.cue.title}」同时需要：${sharedCast.join('、')}。`,
            sceneId: right.scene.id,
            cueId: right.cue.id,
          });
        }
      }
    }

    return issues.map((issue) => ({
      ...issue,
      icon: issue.severity === 'error' ? '!' : 'i',
    }));
  }

  get errors(): number {
    return this.issues.filter((issue) => issue.severity === 'error').length;
  }

  /* ---------------------------------------------------------------- */
  /* 版本比较（快照解析为合并视图后逐条对比）                          */
  /* ---------------------------------------------------------------- */

  get compareVersion(): VersionSnapshot | undefined {
    return this.versions.find(
      (version) => version.id === this.compareVersionId,
    );
  }

  get versionDiff(): VersionDiff[] {
    const version = this.compareVersion;
    if (!version) return [];
    const render = (state: WorkspaceState): string[] =>
      state.show.scenes.flatMap((scene) =>
        resolveScene(scene, findTemplate(state, scene.templateId)).map(
          (item) =>
            `${scene.act}/${scene.name} · ${item.title} | ${item.owner || '未指定'} | ${item.duration}s${
              item.overridden.length
                ? `（覆盖 ${item.overridden.length} 项）`
                : ''
            }`,
        ),
      );
    const before = render(version.state);
    const after = render(this.state);
    return Array.from(
      { length: Math.max(before.length, after.length) },
      (_, index) => ({
        id: `diff-${index}`,
        changed: before[index] !== after[index],
        label: `提示 ${index + 1}`,
        before: before[index] ?? '—',
        after: after[index] ?? '—',
      }),
    );
  }

  /* ---------------------------------------------------------------- */
  /* 模板模式派生                                                      */
  /* ---------------------------------------------------------------- */

  get templateRows() {
    return this.state.templates.map((template) => ({
      id: template.id,
      name: template.name,
      active: template.id === this.activeTemplateId,
      cueCount: template.current.cues.length,
      version: template.current.version,
      releaseCount: template.releases.length,
      publishedLabel:
        template.releases.length === 0
          ? '未发布'
          : `已发布到 v${latestReleasedVersion(template)?.version ?? '?'}`,
      pinnedScenes: this.state.show.scenes.filter(
        (scene) =>
          scene.templateId === template.id && scene.templateVersion != null,
      ).length,
    }));
  }

  get activeTemplateCues(): TemplateCue[] {
    return this.activeTemplate?.current.cues ?? [];
  }

  get templateCueRows() {
    return this.activeTemplateCues.map((cue, index) => ({
      ...cue,
      index: index + 1,
      selected: this.templateDraftCueId === cue.cueId,
    }));
  }

  get templateReleaseRows() {
    const template = this.activeTemplate;
    if (!template) return [];
    return [...template.releases].reverse().map((release) => {
      const pinned = this.state.show.scenes.filter(
        (scene) =>
          scene.templateId === template.id &&
          scene.templateVersion === release.version,
      );
      return {
        version: release.version,
        note: release.note ?? '常规发布',
        updatedAt: release.updatedAt,
        cueCount: release.cues.length,
        pinnedLabel: pinned.length
          ? `${pinned.map((scene) => scene.name).join('、')} 钉住`
          : '暂无场次钉住',
      };
    });
  }

  /* ---------------------------------------------------------------- */
  /* 场次选择与演出信息                                                */
  /* ---------------------------------------------------------------- */

  @action
  selectScene(id: string): void {
    this.activeSceneId = id;
    this.selectedCueGlobalId = this.activeResolvedCues[0]?.id ?? '';
    this.draft = null;
    this.editTarget = null;
  }

  @action
  selectCue(globalId: string): void {
    this.selectedCueGlobalId = globalId;
    this.draft = null;
    this.editTarget = null;
  }

  @action
  updateShowTitle(value: string): void {
    this.mutate((state) => {
      state.show.title = value;
    });
  }

  @action
  setSearch(value: string): void {
    this.search = value;
  }

  @action
  focusIssue(
    sceneId: string | undefined,
    cueGlobalId: string | undefined,
  ): void {
    if (!sceneId) return;
    this.mode = 'scenes';
    this.activeSceneId = sceneId;
    this.draft = null;
    this.editTarget = null;
    if (
      cueGlobalId &&
      this.activeResolvedCues.some((cue) => cue.id === cueGlobalId)
    ) {
      this.selectedCueGlobalId = cueGlobalId;
    }
  }

  /* ---------------------------------------------------------------- */
  /* 场次内提示：覆盖编辑与本场自有提示                                */
  /* ---------------------------------------------------------------- */

  @action
  createLocalCueDraft(): void {
    if (this.guardLocked()) return;
    this.editTarget = { source: 'local', cueId: '' };
    this.draft = {
      kind: '灯光',
      title: '',
      duration: 60,
      owner: '',
      lighting: '',
      sound: '',
      props: '',
      cast: '',
      notes: '',
      dependsOn: '',
    };
  }

  @action
  editCue(globalId: string): void {
    if (this.guardLocked()) return;
    const cue = this.activeResolvedCues.find((item) => item.id === globalId);
    if (!cue) return;
    this.selectedCueGlobalId = globalId;
    this.editTarget = { source: cue.source, cueId: cue.cueId };
    this.draft = {
      source: cue.source,
      cueId: cue.cueId,
      kind: cue.kind,
      title: cue.title,
      duration: cue.duration,
      owner: cue.owner,
      lighting: cue.lighting,
      sound: cue.sound,
      props: cue.props.join('、'),
      cast: cue.cast.join('、'),
      notes: cue.notes,
      dependsOn: cue.dependsOn.join('、'),
    };
  }

  @action
  updateDraft<K extends keyof CueDraft>(field: K, value: CueDraft[K]): void {
    if (this.draft) this.draft = { ...this.draft, [field]: value };
  }

  @action
  cancelDraft(): void {
    this.draft = null;
    this.editTarget = null;
  }

  @action
  saveCueDraft(): void {
    const draft = this.draft;
    const scene = this.activeScene;
    if (!draft || !draft.title.trim() || !scene) return;

    if (this.editTarget?.source === 'template') {
      const cueId = this.editTarget.cueId;
      this.mutate((state) => {
        const target = state.show.scenes.find((item) => item.id === scene.id);
        const template = findTemplate(state, target!.templateId);
        if (!target || !template) return;
        setOverrideField(target, template, cueId, 'kind', draft.kind);
        setOverrideField(target, template, cueId, 'title', draft.title.trim());
        setOverrideField(
          target,
          template,
          cueId,
          'duration',
          Math.max(1, Number(draft.duration) || 1),
        );
        setOverrideField(target, template, cueId, 'owner', draft.owner);
        setOverrideField(target, template, cueId, 'lighting', draft.lighting);
        setOverrideField(target, template, cueId, 'sound', draft.sound);
        setOverrideField(
          target,
          template,
          cueId,
          'props',
          splitList(draft.props),
        );
        setOverrideField(
          target,
          template,
          cueId,
          'cast',
          splitList(draft.cast),
        );
        setOverrideField(target, template, cueId, 'notes', draft.notes);
        setOverrideField(
          target,
          template,
          cueId,
          'dependsOn',
          splitList(draft.dependsOn),
        );
      });
    } else {
      const payload = {
        kind: draft.kind,
        title: draft.title.trim(),
        duration: Math.max(1, Number(draft.duration) || 1),
        owner: draft.owner,
        lighting: draft.lighting,
        sound: draft.sound,
        props: splitList(draft.props),
        cast: splitList(draft.cast),
        notes: draft.notes,
        dependsOn: splitList(draft.dependsOn),
      } satisfies Omit<LocalCue, 'id'>;
      this.mutate((state) => {
        const target = state.show.scenes.find((item) => item.id === scene.id);
        if (!target) return;
        const existingId =
          this.editTarget?.source === 'local' ? this.editTarget.cueId : '';
        const existing = target.localCues.find((cue) => cue.id === existingId);
        if (existing) updateLocalCue(target, existing.id, payload);
        else addLocalCue(target, { id: uid('local'), ...payload });
      });
    }
    this.draft = null;
    this.editTarget = null;
  }

  @action
  resetCue(cueId: string): void {
    if (this.guardLocked()) return;
    this.mutate((state) => {
      const scene = state.show.scenes.find(
        (item) => item.id === this.activeSceneId,
      );
      if (scene) resetCueOverrides(scene, cueId);
    });
    this.notify('已恢复为模板值，本场覆盖已清除');
  }

  @action
  resetSingleField(cueId: string, field: CueField): void {
    if (this.guardLocked()) return;
    this.mutate((state) => {
      const scene = state.show.scenes.find(
        (item) => item.id === this.activeSceneId,
      );
      if (scene) clearOverrideField(scene, cueId, field);
    });
  }

  @action
  toggleSkip(cueId: string, event?: Event): void {
    if (this.guardLocked()) return;
    const skip = event ? (event.target as HTMLInputElement).checked : undefined;
    this.mutate((state) => {
      const scene = state.show.scenes.find(
        (item) => item.id === this.activeSceneId,
      );
      if (scene) toggleSkippedCue(scene, cueId, skip);
    });
  }

  @action
  removeSelectedCue(globalId: string): void {
    const cue = this.activeResolvedCues.find((item) => item.id === globalId);
    if (!cue || cue.source === 'template') {
      if (cue?.source === 'template')
        this.notify('模板提示请用「本场停用」，模板内容归模板所有');
      return;
    }
    if (this.guardLocked()) return;
    this.mutate((state) => {
      const scene = state.show.scenes.find(
        (item) => item.id === this.activeSceneId,
      );
      if (scene) removeLocalCue(scene, cue.cueId);
    });
    this.selectedCueGlobalId = this.activeResolvedCues[0]?.id ?? '';
    this.draft = null;
    this.editTarget = null;
  }

  @action
  addScene(): void {
    const scene: Scene = {
      id: uid('scene'),
      act: `第${this.state.show.scenes.length + 1}幕`,
      name: `S${this.state.show.scenes.length + 1}`,
      title: '未命名手工场次',
      startTime: '20:00',
      locked: false,
      templateId: null,
      templateVersion: null,
      overrides: [],
      order: null,
      skippedCueIds: [],
      localCues: [],
      detachedOverrides: [],
    };
    this.mutate((state) => state.show.scenes.push(scene));
    this.activeSceneId = scene.id;
    this.selectedCueGlobalId = '';
  }

  @action
  copyPreviousScene(): void {
    if (this.guardLocked()) return;
    const index = this.state.show.scenes.findIndex(
      (scene) => scene.id === this.activeSceneId,
    );
    const previous = this.state.show.scenes[index - 1];
    if (!previous) {
      this.notify('当前已是第一场');
      return;
    }
    this.mutate((state) => {
      const copied = duplicateScene(previous, index, state.show.scenes.length);
      state.show.scenes.splice(index + 1, 0, copied);
      this.activeSceneId = copied.id;
    });
    this.selectedCueGlobalId = this.activeResolvedCues[0]?.id ?? '';
    this.notify('已复制上一场：模板引用与本场覆盖各自独立');
  }

  @action
  updateSceneField(
    field: 'title' | 'startTime' | 'act' | 'name',
    value: string,
  ): void {
    this.mutate((state) => {
      const scene = state.show.scenes.find(
        (item) => item.id === this.activeSceneId,
      );
      if (scene && !scene.locked) scene[field] = value;
    });
  }

  @action
  moveSelected(direction: -1 | 1): void {
    const cues = this.activeResolvedCues;
    const from = cues.findIndex((item) => item.id === this.selectedCueGlobalId);
    const target = cues[from + direction];
    if (from < 0 || !target) return;
    this.moveCue(cues[from]!.id, target.id);
  }

  @action
  startDrag(id: string): void {
    this.dragCueGlobalId = id;
  }

  @action
  allowDrop(event: DragEvent): boolean {
    event.preventDefault();
    return false;
  }

  @action
  dropOn(id: string): void {
    if (this.dragCueGlobalId) this.moveCue(this.dragCueGlobalId, id);
    this.dragCueGlobalId = '';
  }

  @action
  moveCue(sourceGlobalId: string, targetGlobalId: string): void {
    if (sourceGlobalId === targetGlobalId || this.guardLocked()) return;
    this.mutate((state) => {
      const scene = state.show.scenes.find(
        (item) => item.id === this.activeSceneId,
      );
      if (!scene) return;
      const moved = moveResolvedCue(
        scene,
        findTemplate(state, scene.templateId),
        sourceGlobalId,
        targetGlobalId,
      );
      if (moved) this.selectedCueGlobalId = sourceGlobalId;
    });
    this.notify('顺序已更新：模板顺序未变，仅记录本场顺序覆盖');
  }

  /* ---------------------------------------------------------------- */
  /* 场次锁定 / 模板跟随 / 迁移                                        */
  /* ---------------------------------------------------------------- */

  @action
  toggleSceneLock(): void {
    const willLock = !this.activeScene?.locked;
    this.mutate((state) => {
      const scene = state.show.scenes.find(
        (item) => item.id === this.activeSceneId,
      );
      if (!scene) return;
      if (!willLock) {
        scene.locked = false;
        return;
      }
      const template = findTemplate(state, scene.templateId);
      if (template) {
        // 锁定即钉版：模板继续升级也不改变本场
        scene.templateVersion = ensureVersionForPin(template);
      }
      scene.locked = true;
    });
    this.notify(willLock ? '本场已锁定并钉住当前模板版本' : '本场已解锁');
  }

  @action
  createRevision(): void {
    this.mutate((state) => {
      const scene = state.show.scenes.find(
        (item) => item.id === this.activeSceneId,
      );
      if (scene) scene.locked = false;
    });
    this.notify('已建立可编辑修订，场次仍钉在原模板版本，需要时可迁移');
  }

  @action
  followLatestTemplate(): void {
    if (this.guardLocked()) return;
    this.mutate((state) => {
      const scene = state.show.scenes.find(
        (item) => item.id === this.activeSceneId,
      );
      if (scene) scene.templateVersion = null;
    });
    this.notify('已切换为跟随模板最新版，未覆盖字段立即按新值重算');
  }

  @action
  migrateSceneToLatest(): void {
    if (this.guardLocked()) return;
    const scene = this.activeScene;
    const template = scene
      ? findTemplate(this.state, scene.templateId)
      : undefined;
    const targetRelease = template
      ? latestReleasedVersion(template)
      : undefined;
    if (
      !scene ||
      !template ||
      !targetRelease ||
      (scene.templateVersion ?? 0) >= targetRelease.version
    )
      return;
    const result: { retained: number; detached: number; added: number } = {
      retained: 0,
      detached: 0,
      added: 0,
    };
    this.mutate((state) => {
      const targetScene = state.show.scenes.find(
        (item) => item.id === scene.id,
      );
      const targetTemplate = state.templates.find(
        (item) => item.id === template.id,
      );
      const release = targetTemplate
        ? latestReleasedVersion(targetTemplate)
        : undefined;
      if (!targetScene || !targetTemplate || !release) return;
      Object.assign(
        result,
        migrateScene(targetScene, targetTemplate, release.version),
      );
    });
    this.notify(
      `迁移完成：保留 ${result.retained} 条覆盖，${result.detached} 条失配待处理，新增 ${result.added} 条模板提示`,
    );
  }

  @action
  restoreOverride(cueId: string): void {
    this.mutate((state) => {
      const scene = state.show.scenes.find(
        (item) => item.id === this.activeSceneId,
      );
      const template = scene
        ? findTemplate(state, scene.templateId)
        : undefined;
      if (scene && template) restoreDetachedOverride(scene, template, cueId);
    });
  }

  @action
  discardOverride(cueId: string): void {
    this.mutate((state) => {
      const scene = state.show.scenes.find(
        (item) => item.id === this.activeSceneId,
      );
      if (scene) discardDetachedOverride(scene, cueId);
    });
  }

  /* ---------------------------------------------------------------- */
  /* 复制新场次：选择模板 → 校验 → 事务提交，失败回滚并挂起            */
  /* ---------------------------------------------------------------- */

  get applyTemplateRows() {
    return this.state.templates.map((template) => {
      const latest = latestReleasedVersion(template) ?? template.current;
      const validation = validateTemplate(
        template,
        template.releases.length
          ? latestReleasedVersion(template)
          : template.current,
      );
      return {
        id: template.id,
        name: template.name,
        versionLabel: `v${latest.version}`,
        cueCount: latest.cues.length,
        selected: this.applyTemplateId === template.id,
        reasons: validation,
        valid: validation.length === 0,
      };
    });
  }

  get applyValidationReasons(): string[] {
    const template = this.state.templates.find(
      (item) => item.id === this.applyTemplateId,
    );
    if (!template) return ['请选择一个模板'];
    const version = latestReleasedVersion(template) ?? template.current;
    return validateTemplate(template, version);
  }

  get applyCanSubmit(): boolean {
    return Boolean(
      this.applyTemplateId &&
      this.applyAct.trim() &&
      this.applyName.trim() &&
      this.applyTitle.trim() &&
      this.applyStartTime.trim() &&
      this.applyValidationReasons.length === 0,
    );
  }

  @action
  openApplyPicker(): void {
    const nextIndex = this.state.show.scenes.length + 1;
    this.applyTemplateId = this.state.templates[0]?.id ?? '';
    this.applyAct = `第${nextIndex}幕`;
    this.applyName = `S${nextIndex}`;
    this.applyTitle = '新场次';
    this.applyStartTime = '20:00';
    this.applyFailSimulation = false;
    this.applyPickerOpen = true;
  }

  @action
  closeApplyPicker(): void {
    this.applyPickerOpen = false;
  }

  @action
  selectApplyTemplate(id: string): void {
    this.applyTemplateId = id;
  }

  @action
  updateApplyField(
    field: 'act' | 'name' | 'title' | 'startTime',
    value: string,
  ): void {
    if (field === 'act') this.applyAct = value;
    else if (field === 'name') this.applyName = value;
    else if (field === 'title') this.applyTitle = value;
    else this.applyStartTime = value;
  }

  @action
  toggleFailSimulation(event: Event): void {
    this.applyFailSimulation = (event.target as HTMLInputElement).checked;
  }

  @action
  confirmApplyTemplate(): void {
    if (!this.applyCanSubmit) {
      this.notify(this.applyValidationReasons[0] ?? '请补全新场次信息');
      return;
    }
    const templateId = this.applyTemplateId;
    const sceneFields = {
      act: this.applyAct.trim(),
      name: this.applyName.trim(),
      title: this.applyTitle.trim(),
      startTime: this.applyStartTime.trim(),
    };
    const insertAfterSceneId = this.activeSceneId || null;

    // 事务边界：先深拷贝完整前态。任何一步失败都回到它，原场次与模板都不丢数据
    const checkpoint = clone(this.state);
    let pendingState = checkpoint;
    try {
      const working = clone(this.state);
      const template = working.templates.find((item) => item.id === templateId);
      if (!template)
        throw new ApplyTemplateError(['所选模板不存在，可能已被删除']);
      // 未发布过的模板：在同一事务内冻结 v1，保证新场钉住的是不可变版本
      if (!latestReleasedVersion(template)) {
        releaseTemplate(template, '套用新场次时自动发布');
      }
      const version = latestReleasedVersion(template)!;
      const reasons = validateTemplate(template, version);
      if (reasons.length) throw new ApplyTemplateError(reasons);

      // 演练故障：在提交前中断，验证回滚与恢复链路
      if (this.applyFailSimulation) {
        throw new ApplyTemplateError([
          '模拟故障：写入阶段中断（用于验证回滚）',
        ]);
      }

      const scene = buildSceneFromTemplate(template, version, sceneFields);
      const insertAt = working.show.scenes.findIndex(
        (item) => item.id === insertAfterSceneId,
      );
      if (insertAt < 0) working.show.scenes.push(scene);
      else working.show.scenes.splice(insertAt + 1, 0, scene);
      touchShow(working.show);

      pendingState = working;
      this.undoStack.push(checkpoint);
      if (this.undoStack.length > 80) this.undoStack.shift();
      this.redoStack = [];
      this.commitState(working);
      this.pendingApply = null;
      this.applyPickerOpen = false;
      this.activeSceneId = scene.id;
      this.selectedCueGlobalId = this.activeResolvedCues[0]?.id ?? '';
      this.persist();
      this.notify(
        `已按模板「${template.name}」v${version.version} 创建场次，流程归模板、覆盖归本场`,
      );
    } catch (error) {
      // 回滚：恢复检查点，并把待处理任务落盘，重开页面后继续
      this.commitState(pendingState);
      const reason =
        error instanceof ApplyTemplateError
          ? error.reasons.join('；')
          : `套用失败：${String(error)}`;
      const rolledBackTemplate = findTemplate(pendingState, templateId);
      this.pendingApply = {
        id: uid('pending'),
        templateId,
        templateVersion: rolledBackTemplate
          ? (latestReleasedVersion(rolledBackTemplate)?.version ??
            rolledBackTemplate.current.version)
          : 0,
        reason,
        attemptedAt: new Date().toISOString(),
        sceneFields,
        insertAfterSceneId,
        checkpoint: pendingState,
        checkpointChecksum: checksum(pendingState),
      };
      this.applyPickerOpen = false;
      this.persist();
      this.notify('套用失败，已回滚到操作前状态；可在顶部横幅重试或放弃');
    }
  }

  @action
  retryPendingApply(): void {
    const pending = this.pendingApply;
    if (!pending) return;
    if (checksum(pending.checkpoint) !== pending.checkpointChecksum) {
      this.notify('回滚检查点校验不通过，已保留数据，请人工核对');
      return;
    }
    // 从检查点重新开始，等价于从未发生过失败
    this.commitState(clone(pending.checkpoint));
    this.applyTemplateId = pending.templateId;
    this.applyAct = pending.sceneFields.act;
    this.applyName = pending.sceneFields.name;
    this.applyTitle = pending.sceneFields.title;
    this.applyStartTime = pending.sceneFields.startTime;
    this.applyFailSimulation = false;
    this.activeSceneId = pending.insertAfterSceneId ?? '';
    this.pendingApply = null;
    this.applyPickerOpen = true;
    this.persist();
    this.notify('已恢复到套用前状态并重新打开表单，确认后继续');
  }

  @action
  discardPendingApply(): void {
    const pending = this.pendingApply;
    if (!pending) return;
    if (checksum(pending.checkpoint) !== pending.checkpointChecksum) {
      this.notify('检查点校验不通过，放弃操作已取消以保护数据');
      return;
    }
    // 放弃即采纳回滚检查点（当前状态本就应与它一致）
    this.commitState(clone(pending.checkpoint));
    this.pendingApply = null;
    this.persist();
    this.notify('已放弃本次套用，工作区保持操作前状态');
  }

  /* ---------------------------------------------------------------- */
  /* 模板编辑                                                          */
  /* ---------------------------------------------------------------- */

  @action
  switchMode(mode: WorkspaceMode): void {
    this.mode = mode;
    this.draft = null;
    this.editTarget = null;
    this.templateDraft = null;
    this.templateDraftCueId = null;
  }

  @action
  selectTemplate(id: string): void {
    this.activeTemplateId = id;
    this.templateDraft = null;
    this.templateDraftCueId = null;
  }

  @action
  createTemplate(): void {
    const template = emptyTemplate(
      `新建模板 ${this.state.templates.length + 1}`,
    );
    this.mutate((state) => state.templates.push(template));
    this.activeTemplateId = template.id;
    this.notify('已新建空白模板');
  }

  @action
  updateTemplateName(value: string): void {
    this.mutate((state) => {
      const template = state.templates.find(
        (item) => item.id === this.activeTemplateId,
      );
      if (template) renameTemplate(template, value);
    });
  }

  @action
  createTemplateCueDraft(): void {
    this.templateDraftCueId = null;
    this.templateDraft = {
      kind: '灯光',
      title: '',
      duration: 60,
      owner: '',
      lighting: '',
      sound: '',
      props: '',
      cast: '',
      notes: '',
      dependsOn: '',
    };
  }

  @action
  editTemplateCue(cueId: string): void {
    const cue = this.activeTemplate?.current.cues.find(
      (item) => item.cueId === cueId,
    );
    if (!cue) return;
    this.templateDraftCueId = cueId;
    this.templateDraft = {
      source: 'template',
      cueId,
      kind: cue.kind,
      title: cue.title,
      duration: cue.duration,
      owner: cue.owner,
      lighting: cue.lighting,
      sound: cue.sound,
      props: cue.props.join('、'),
      cast: cue.cast.join('、'),
      notes: cue.notes,
      dependsOn: cue.dependsOn.join('、'),
    };
  }

  @action
  updateTemplateDraft<K extends keyof CueDraft>(
    field: K,
    value: CueDraft[K],
  ): void {
    if (this.templateDraft)
      this.templateDraft = { ...this.templateDraft, [field]: value };
  }

  @action
  cancelTemplateDraft(): void {
    this.templateDraft = null;
    this.templateDraftCueId = null;
  }

  @action
  saveTemplateDraft(): void {
    const draft = this.templateDraft;
    const template = this.activeTemplate;
    if (!draft || !template || !draft.title.trim()) return;
    const payload = {
      kind: draft.kind,
      title: draft.title.trim(),
      duration: Math.max(1, Number(draft.duration) || 1),
      owner: draft.owner,
      lighting: draft.lighting,
      sound: draft.sound,
      props: splitList(draft.props),
      cast: splitList(draft.cast),
      notes: draft.notes,
      dependsOn: splitList(draft.dependsOn),
    } satisfies Omit<TemplateCue, 'cueId'>;
    this.mutate((state) => {
      const target = state.templates.find((item) => item.id === template.id);
      if (!target) return;
      if (this.templateDraftCueId) {
        updateTemplateCue(target, this.templateDraftCueId, payload);
      } else {
        addTemplateCue(target, { cueId: nextCueId(target), ...payload });
      }
    });
    this.templateDraft = null;
    this.templateDraftCueId = null;
  }

  @action
  removeTemplateCue(cueId: string): void {
    this.mutate((state) => {
      const template = state.templates.find(
        (item) => item.id === this.activeTemplateId,
      );
      if (!template) return;
      removeTemplateCue(template, cueId);
      // 只处理跟随最新工作版的场次：删除项的覆盖转入 detached，数据不丢；
      // 钉在已发布版本上的场次仍从 release 取数，覆盖继续有效
      state.show.scenes.forEach((scene) => {
        if (scene.templateId !== template.id || scene.templateVersion != null)
          return;
        const liveIds = new Set(
          effectiveVersion(scene, template)?.cues.map((cue) => cue.cueId) ?? [],
        );
        scene.overrides.forEach((override) => {
          if (
            !liveIds.has(override.cueId) &&
            !scene.detachedOverrides.some((d) => d.cueId === override.cueId)
          ) {
            scene.detachedOverrides.push(clone(override));
          }
        });
        scene.overrides = scene.overrides.filter((override) =>
          liveIds.has(override.cueId),
        );
        scene.skippedCueIds = scene.skippedCueIds.filter((id) =>
          liveIds.has(id),
        );
        scene.order = scene.order?.filter((id) => liveIds.has(id)) ?? null;
      });
    });
    this.notify('已从模板删除；已使用场次的本场覆盖转入待处理，未删除数据');
    this.templateDraft = null;
    this.templateDraftCueId = null;
  }

  @action
  startTemplateDrag(cueId: string): void {
    this.dragTemplateCueId = cueId;
  }

  @action
  dropTemplateOn(cueId: string): void {
    if (!this.dragTemplateCueId) return;
    const fromId = this.dragTemplateCueId;
    this.dragTemplateCueId = '';
    this.mutate((state) => {
      const template = state.templates.find(
        (item) => item.id === this.activeTemplateId,
      );
      if (template) moveTemplateCue(template, fromId, cueId);
    });
    this.notify('模板顺序已更新，未覆盖顺序的场次立即按新顺序重算');
  }

  @action
  updateReleaseNote(value: string): void {
    this.releaseNote = value;
  }

  @action
  publishTemplate(): void {
    const template = this.activeTemplate;
    if (!template) return;
    let version = 0;
    this.mutate((state) => {
      const target = state.templates.find((item) => item.id === template.id);
      if (!target) return;
      version = releaseTemplate(target, this.releaseNote.trim());
    });
    this.releaseNote = '';
    this.notify(
      `模板已发布 v${version}：钉版/锁定场次使用旧版，跟随场次已取新值`,
    );
  }

  /* ---------------------------------------------------------------- */
  /* 锁定版本与撤销重做                                                */
  /* ---------------------------------------------------------------- */

  @action
  lockVersion(): void {
    const snapshot: VersionSnapshot = {
      id: uid('version'),
      name: `锁定版 ${this.versions.length + 1}`,
      createdAt: new Date().toISOString(),
      state: clone(this.state),
    };
    this.versions = [snapshot, ...this.versions];
    this.compareVersionId = snapshot.id;
    this.persist();
    this.notify('已锁定当前完整工作区版本（模板与场次各自保留）');
  }

  @action
  selectCompareVersion(version: VersionSnapshot): void {
    this.compareVersionId = version.id;
  }

  @action
  undo(): void {
    if (this.pendingApply) {
      this.notify('有待处理的套用，请先重试或放弃，再继续编辑');
      return;
    }
    const previous = this.undoStack.pop();
    if (!previous) return;
    this.redoStack.push(clone(this.state));
    this.commitState(previous);
    this.ensureSelection();
    this.persist();
  }

  @action
  redo(): void {
    if (this.pendingApply) return;
    const next = this.redoStack.pop();
    if (!next) return;
    this.undoStack.push(clone(this.state));
    this.commitState(next);
    this.ensureSelection();
    this.persist();
  }

  willDestroy(): void {
    super.willDestroy();
    window.removeEventListener('keydown', this.handleKeyboard);
  }

  /* ---------------------------------------------------------------- */
  /* 内部：事务、持久化与守卫                                          */
  /* ---------------------------------------------------------------- */

  private mutate(mutator: (state: WorkspaceState) => void): void {
    if (this.pendingApply) {
      this.notify('有待处理的套用，请先重试或放弃，再继续编辑');
      return;
    }
    this.undoStack.push(clone(this.state));
    if (this.undoStack.length > 80) this.undoStack.shift();
    this.redoStack = [];
    const next = clone(this.state);
    mutator(next);
    touchShow(next.show);
    this.commitState(next);
    this.ensureSelection();
    this.persist();
  }

  private commitState(state: WorkspaceState): void {
    this.state = state;
  }

  private persist(): void {
    persistWorkspace(this.state, this.versions, this.pendingApply);
  }

  private guardLocked(): boolean {
    if (this.pendingApply) {
      this.notify('有待处理的套用，请先重试或放弃，再继续编辑');
      return true;
    }
    if (this.activeScene?.locked) {
      this.notify('该场次已锁定，请先建立修订');
      return true;
    }
    return false;
  }

  private ensureSelection(): void {
    if (
      !this.state.show.scenes.some((scene) => scene.id === this.activeSceneId)
    ) {
      this.activeSceneId = this.state.show.scenes[0]?.id ?? '';
    }
    if (
      !this.activeResolvedCues.some(
        (cue) => cue.id === this.selectedCueGlobalId,
      )
    ) {
      this.selectedCueGlobalId = this.activeResolvedCues[0]?.id ?? '';
    }
    if (
      !this.state.templates.some(
        (template) => template.id === this.activeTemplateId,
      )
    ) {
      this.activeTemplateId = this.state.templates[0]?.id ?? '';
    }
  }

  private notify(value: string): void {
    this.message = value;
    window.setTimeout(() => {
      if (this.message === value) this.message = '';
    }, 2600);
  }

  private handleKeyboard = (event: KeyboardEvent): void => {
    const target = event.target as HTMLElement | null;
    const inEditor =
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target?.tagName === 'SELECT';
    const command = event.ctrlKey || event.metaKey;
    if (command && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      event.shiftKey ? this.redo() : this.undo();
      return;
    }
    if (command && event.key.toLowerCase() === 'y') {
      event.preventDefault();
      this.redo();
      return;
    }
    if (inEditor) return;
    if (event.altKey && event.key === 'ArrowUp') {
      event.preventDefault();
      this.moveSelected(-1);
    } else if (event.altKey && event.key === 'ArrowDown') {
      event.preventDefault();
      this.moveSelected(1);
    } else if (event.key.toLowerCase() === 'n') {
      event.preventDefault();
      this.mode === 'templates'
        ? this.createTemplateCueDraft()
        : this.createLocalCueDraft();
    }
  };
}

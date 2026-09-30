import Component from '@glimmer/component';
import { tracked } from '@glimmer/tracking';
import { action } from '@ember/object';
import type {
  ApplyJob,
  CueBook,
  CueKind,
  EffectiveCue,
  EffectiveScene,
  ShowTemplate,
  TemplateCue,
  VersionDiff,
  VersionSnapshot,
} from 'stage-cue-editor/models/cue-book';
import { CUE_KINDS, OWNERS } from 'stage-cue-editor/models/cue-book';
import {
  effectiveScene,
  effectiveScenes,
  findTemplate,
  findVersion,
} from 'stage-cue-editor/lib/cue-book/resolve';
import { collectIssues } from 'stage-cue-editor/lib/cue-book/validation';
import {
  draftToTemplateCue,
  moveTemplateCue,
  publishTemplateVersion,
  removeTemplateCue,
  updateTemplateMeta,
  upsertTemplateCue,
} from 'stage-cue-editor/lib/cue-book/template';
import {
  applyJob,
  createSceneJob,
  failJob,
  resumeJob,
  upgradeSceneJob,
} from 'stage-cue-editor/lib/cue-book/apply';
import {
  buildOverride,
  type CueFieldValues,
} from 'stage-cue-editor/lib/cue-book/override';
import { timeLabel } from 'stage-cue-editor/lib/cue-book/timing';
import { loadState, saveState } from 'stage-cue-editor/lib/cue-book/repository';
import { clone, splitList, uid } from 'stage-cue-editor/lib/cue-book/util';

type ViewMode = 'scene' | 'template';

interface TemplateDraftCue {
  key: string;
  kind: CueKind;
  title: string;
  duration: number;
  owner: string;
  lighting: string;
  sound: string;
  props: string;
  cast: string;
  notes: string;
  dependsOnKeys: string;
}

const blankTemplateCue = (): TemplateDraftCue => ({
  key: uid('cue'),
  kind: '灯光',
  title: '',
  duration: 60,
  owner: '',
  lighting: '',
  sound: '',
  props: '',
  cast: '',
  notes: '',
  dependsOnKeys: '',
});

const toDraftCue = (cue: TemplateCue): TemplateDraftCue => ({
  key: cue.key,
  kind: cue.kind,
  title: cue.title,
  duration: cue.duration,
  owner: cue.owner,
  lighting: cue.lighting,
  sound: cue.sound,
  props: cue.props.join('、'),
  cast: cue.cast.join('、'),
  notes: cue.notes,
  dependsOnKeys: cue.dependsOnKeys.join('、'),
});

interface SceneDraftCue extends TemplateDraftCue {}

export default class CueEditorComponent extends Component {
  @tracked book: CueBook;
  @tracked versions: VersionSnapshot[];
  @tracked jobs: ApplyJob[];

  @tracked mode: ViewMode = 'scene';
  @tracked activeSceneId = '';
  @tracked selectedCueKey = '';

  @tracked activeTemplateId = '';
  @tracked templateDraftCues: TemplateCue[] = [];
  @tracked templateNameDraft = '';
  @tracked templateDescriptionDraft = '';
  @tracked versionNote = '';
  @tracked templateCueDraft: TemplateDraftCue | null = null;

  @tracked sceneCueDraft: SceneDraftCue | null = null;

  @tracked showCopyPanel = false;
  @tracked copyTemplateId = '';
  @tracked copyName = '';
  @tracked copyTitle = '';
  @tracked copyStartTime = '20:00';

  @tracked compareVersionId = '';
  @tracked message = '';
  @tracked search = '';

  private undoStack: CueBook[] = [];
  private redoStack: CueBook[] = [];
  private dragKey = '';

  constructor(owner: unknown, args: Record<string, unknown>) {
    super(owner, args);
    const state = loadState();
    this.book = state.book;
    this.versions = state.versions;
    this.jobs = state.jobs;
    this.activeSceneId = this.book.scenes[0]?.id ?? '';
    this.selectedCueKey = this.activeEffective?.cues[0]?.key ?? '';
    this.activeTemplateId = this.book.templates[0]?.id ?? '';
    this.copyTemplateId = this.activeTemplateId;
    if (this.activeTemplate) this.loadTemplateDraft(this.activeTemplate);
    window.addEventListener('keydown', this.handleKeyboard);
  }

  // ---------- 基础选项 ----------
  get cueKindOptions(): CueKind[] {
    return CUE_KINDS;
  }
  get ownerOptions(): string[] {
    return OWNERS;
  }

  // ---------- 生效视图 ----------
  get effectiveScenesView(): EffectiveScene[] {
    return effectiveScenes(this.book);
  }

  get activeEffective(): EffectiveScene | undefined {
    const scene = this.book.scenes.find(
      (item) => item.id === this.activeSceneId,
    );
    return scene ? effectiveScene(this.book, scene) : undefined;
  }

  get selectedCue(): EffectiveCue | undefined {
    return this.activeEffective?.cues.find(
      (cue) => cue.key === this.selectedCueKey,
    );
  }

  get sceneRows() {
    const term = this.search.trim().toLowerCase();
    return this.effectiveScenesView
      .map((effective) => {
        const templateName = effective.template?.name ?? '模板缺失';
        const stale = !effective.upToDate;
        const cueCount = effective.cues.length;
        const duration = effective.cues.reduce(
          (total, cue) => total + cue.duration,
          0,
        );
        return {
          scene: effective.scene,
          active: effective.scene.id === this.activeSceneId,
          act: effective.scene.act,
          name: effective.scene.name,
          title: effective.scene.title,
          startTime: effective.scene.startTime,
          cueCount,
          duration,
          templateName,
          stale,
          version: effective.scene.templateVersion,
          current: effective.template?.currentVersion,
          issueCount: this.issues.filter(
            (issue) => issue.sceneId === effective.scene.id,
          ).length,
          match:
            !term ||
            `${effective.scene.act}${effective.scene.name}${effective.scene.title}${templateName}`
              .toLowerCase()
              .includes(term),
        };
      })
      .filter((row) => row.match);
  }

  get cueRows() {
    const effective = this.activeEffective;
    if (!effective) return [];
    return effective.cues.map((cue, index) => ({
      key: cue.key,
      index,
      kind: cue.kind,
      title: cue.title,
      duration: cue.duration,
      owner: cue.owner,
      kindClass: this.kindClass(cue.kind),
      selected: cue.key === this.selectedCueKey,
      overridden: cue.overriddenFields.length > 0,
      overriddenLabel: cue.overriddenFields.length
        ? `本场已覆盖 ${cue.overriddenFields.length} 项`
        : '继承模板',
      hasIssue: this.issues.some(
        (issue) =>
          issue.cueKey === cue.key && issue.sceneId === effective.scene.id,
      ),
      propsLabel: cue.props.join('、'),
      castLabel: cue.cast.join('、'),
      start: timeLabel(effective.scene.startTime, cue.offset),
      end: timeLabel(effective.scene.startTime, cue.offset + cue.duration),
    }));
  }

  // ---------- 模板 ----------
  get activeTemplate(): ShowTemplate | undefined {
    return findTemplate(this.book, this.activeTemplateId);
  }

  get currentTemplateVersion() {
    return this.activeTemplate ? findVersion(this.activeTemplate) : undefined;
  }

  get templateRows() {
    return this.book.templates.map((template) => ({
      id: template.id,
      active: template.id === this.activeTemplateId,
      name: template.name,
      version: template.currentVersion,
      cueCount: findVersion(template)?.cues.length ?? 0,
      sceneCount: this.book.scenes.filter(
        (scene) => scene.templateId === template.id,
      ).length,
    }));
  }

  get templateDraftRows() {
    return this.templateDraftCues.map((cue, index) => ({
      key: cue.key,
      index,
      kind: cue.kind,
      title: cue.title,
      duration: cue.duration,
      owner: cue.owner || '待指定',
      kindClass: this.kindClass(cue.kind),
      selected: this.templateCueDraft?.key === cue.key,
    }));
  }

  get templateVersionRows() {
    return [...(this.activeTemplate?.versions ?? [])]
      .sort((a, b) => b.version - a.version)
      .map((version) => ({
        version: version.version,
        note: version.note,
        createdAt: version.createdAt.slice(0, 16).replace('T', ' '),
        current: version.version === this.activeTemplate?.currentVersion,
        cueCount: version.cues.length,
      }));
  }

  get templateDirty(): boolean {
    const current = this.currentTemplateVersion;
    if (!current) return this.templateDraftCues.length > 0;
    if (current.cues.length !== this.templateDraftCues.length) return true;
    return current.cues.some((cue, index) => {
      const draft = this.templateDraftCues[index];
      if (!draft || draft.key !== cue.key) return true;
      return (
        JSON.stringify(this.comparableCue(cue)) !==
        JSON.stringify(this.comparableCue(draft))
      );
    });
  }

  get templateClean(): boolean {
    return !this.templateDirty;
  }

  private comparableCue(cue: TemplateCue | TemplateCue) {
    return {
      key: cue.key,
      kind: cue.kind,
      title: cue.title,
      duration: cue.duration,
      owner: cue.owner,
      lighting: cue.lighting,
      sound: cue.sound,
      props: [...cue.props],
      cast: [...cue.cast],
      notes: cue.notes,
      dependsOnKeys: [...cue.dependsOnKeys],
    };
  }

  // ---------- 复制新场次 ----------
  // 打开面板时生成一次并缓存，保证 options 与 @selected 引用同一批对象
  // （ember-power-select 用引用相等判断选中项）。
  @tracked copyTemplateOptions: { id: string; label: string }[] = [];

  get copyTemplateSelection() {
    return this.copyTemplateOptions.find(
      (option) => option.id === this.copyTemplateId,
    );
  }

  // ---------- 校验 ----------
  get issues() {
    return collectIssues(this.book);
  }

  get errors(): number {
    return this.issues.filter((issue) => issue.severity === 'error').length;
  }

  get pendingJobs(): ApplyJob[] {
    return this.jobs.filter((job) => job.status !== 'succeeded');
  }

  get totalCueCount(): number {
    return this.effectiveScenesView.reduce(
      (total, effective) => total + effective.cues.length,
      0,
    );
  }

  // ---------- 版本比较 ----------
  get compareVersion(): VersionSnapshot | undefined {
    return this.versions.find(
      (version) => version.id === this.compareVersionId,
    );
  }

  get versionDiff(): VersionDiff[] {
    const snapshot = this.compareVersion;
    if (!snapshot) return [];
    const line = (book: CueBook) =>
      effectiveScenes(book).flatMap((effective) =>
        effective.cues.map(
          (cue) =>
            `${effective.scene.act}/${effective.scene.name} · ${cue.title} | ${cue.owner || '未指定'} | ${cue.duration}s`,
        ),
      );
    const before = line(snapshot.book);
    const after = line(this.book);
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

  get selectedProps(): string {
    return this.selectedCue?.props.join('、') ?? '';
  }
  get selectedCast(): string {
    return this.selectedCue?.cast.join('、') ?? '';
  }

  private kindClass(kind: CueKind): string {
    return kind === '灯光'
      ? 'light'
      : kind === '音响'
        ? 'sound'
        : kind === '道具'
          ? 'prop'
          : kind === '演员'
            ? 'cast'
            : kind === '字幕'
              ? 'caption'
              : 'stage';
  }

  // ---------- 视图切换 ----------
  @action
  switchMode(mode: ViewMode): void {
    this.mode = mode;
    this.sceneCueDraft = null;
    this.templateCueDraft = null;
    if (mode === 'template' && this.activeTemplate)
      this.loadTemplateDraft(this.activeTemplate);
  }

  @action
  selectScene(id: string): void {
    this.activeSceneId = id;
    this.selectedCueKey = this.activeEffective?.cues[0]?.key ?? '';
    this.sceneCueDraft = null;
  }

  @action
  selectCue(key: string): void {
    this.selectedCueKey = key;
    this.sceneCueDraft = null;
  }

  @action
  selectTemplate(id: string): void {
    this.activeTemplateId = id;
    const template = findTemplate(this.book, id);
    if (template) this.loadTemplateDraft(template);
    this.templateCueDraft = null;
  }

  private loadTemplateDraft(template: ShowTemplate): void {
    const version = findVersion(template);
    this.templateDraftCues = (version?.cues ?? []).map((cue) => ({
      ...cue,
      props: [...cue.props],
      cast: [...cue.cast],
      dependsOnKeys: [...cue.dependsOnKeys],
    }));
    this.templateNameDraft = template.name;
    this.templateDescriptionDraft = template.description;
  }

  // ---------- 演出级 ----------
  @action
  updateBookField(field: 'title' | 'venue' | 'date', value: string): void {
    this.commit((book) => {
      book[field] = value;
    });
  }

  // ---------- 场次字段 ----------
  @action
  updateSceneField(
    field: 'act' | 'name' | 'title' | 'startTime',
    value: string,
  ): void {
    this.commit((book) => {
      const scene = book.scenes.find((item) => item.id === this.activeSceneId);
      if (scene && !scene.locked) scene[field] = value;
    });
  }

  @action
  toggleSceneLock(): void {
    this.commit((book) => {
      const scene = book.scenes.find((item) => item.id === this.activeSceneId);
      if (scene) scene.locked = !scene.locked;
    });
  }

  @action
  addScene(): void {
    const template = this.book.templates[0];
    if (!template) {
      this.notify('请先创建模板');
      return;
    }
    this.openCopyPanel(template.id);
  }

  // ---------- 场次提示覆盖 ----------
  @action
  createSceneCueDraft(kind: CueKind = '灯光'): void {
    const effective = this.activeEffective;
    if (!effective || effective.scene.locked) {
      this.notify('该场次已锁定或模板缺失');
      return;
    }
    const draft = blankTemplateCue();
    draft.kind = kind;
    this.sceneCueDraft = draft;
  }

  @action
  editSelectedSceneCue(): void {
    const cue = this.selectedCue;
    if (!cue || this.activeEffective?.scene.locked) return;
    this.sceneCueDraft = {
      key: cue.key,
      kind: cue.kind,
      title: cue.title,
      duration: cue.duration,
      owner: cue.owner,
      lighting: cue.lighting,
      sound: cue.sound,
      props: cue.props.join('、'),
      cast: cue.cast.join('、'),
      notes: cue.notes,
      dependsOnKeys: cue.dependsOnKeys.join('、'),
    };
  }

  @action
  updateSceneDraft<K extends keyof SceneDraftCue>(
    field: K,
    value: SceneDraftCue[K],
  ): void {
    if (this.sceneCueDraft)
      this.sceneCueDraft = { ...this.sceneCueDraft, [field]: value };
  }

  @action
  cancelSceneDraft(): void {
    this.sceneCueDraft = null;
  }

  @action
  saveSceneCueDraft(): void {
    const effective = this.activeEffective;
    const draft = this.sceneCueDraft;
    if (!effective || !draft) return;
    const base = effective.version?.cues.find((cue) => cue.key === draft.key);
    if (!base) {
      this.notify('该提示不属于当前模板版本，无法保存覆盖');
      return;
    }
    if (!draft.title.trim()) {
      this.notify('请填写提示标题');
      return;
    }
    const values: CueFieldValues = {
      kind: draft.kind,
      title: draft.title.trim(),
      duration: Math.max(1, Number(draft.duration) || 1),
      owner: draft.owner,
      lighting: draft.lighting,
      sound: draft.sound,
      props: splitList(draft.props),
      cast: splitList(draft.cast),
      notes: draft.notes,
    };
    // 依赖顺序归模板所有，场次不单独改；草稿里只读展示。
    const override = buildOverride(base, values);
    this.commit((book) => {
      const scene = book.scenes.find((item) => item.id === effective.scene.id);
      if (!scene || scene.locked) return;
      scene.cueOverrides = scene.cueOverrides.filter(
        (item) => item.key !== base.key,
      );
      if (override) scene.cueOverrides.push(override);
    });
    this.sceneCueDraft = null;
    this.selectedCueKey = draft.key;
  }

  @action
  resetSceneCueOverride(key: string): void {
    this.commit((book) => {
      const scene = book.scenes.find((item) => item.id === this.activeSceneId);
      if (scene && !scene.locked) {
        scene.cueOverrides = scene.cueOverrides.filter(
          (item) => item.key !== key,
        );
      }
    });
  }

  // ---------- 模板编辑（工作副本，发布才生成新版本） ----------
  @action
  updateTemplateNameDraft(value: string): void {
    this.templateNameDraft = value;
  }

  @action
  saveTemplateMeta(): void {
    const template = this.activeTemplate;
    if (!template) return;
    this.commit((book) => {
      const target = book.templates.find((item) => item.id === template.id);
      if (!target) return;
      const updated = updateTemplateMeta(target, {
        name: this.templateNameDraft.trim() || target.name,
        description: this.templateDescriptionDraft,
      });
      Object.assign(target, updated);
    });
    this.notify('模板信息已保存（不影响场次解析）');
  }

  @action
  createTemplateCueDraft(kind: CueKind = '灯光'): void {
    this.templateCueDraft = { ...blankTemplateCue(), kind };
  }

  @action
  editTemplateCue(key: string): void {
    const cue = this.templateDraftCues.find((item) => item.key === key);
    if (cue) this.templateCueDraft = toDraftCue(cue);
  }

  @action
  updateTemplateDraftCue<K extends keyof TemplateDraftCue>(
    field: K,
    value: TemplateDraftCue[K],
  ): void {
    if (this.templateCueDraft)
      this.templateCueDraft = { ...this.templateCueDraft, [field]: value };
  }

  @action
  cancelTemplateCueDraft(): void {
    this.templateCueDraft = null;
  }

  @action
  saveTemplateCueDraft(): void {
    const draft = this.templateCueDraft;
    if (!draft) return;
    if (!draft.title.trim()) {
      this.notify('请填写提示标题');
      return;
    }
    const cue = draftToTemplateCue({
      key: draft.key,
      kind: draft.kind,
      title: draft.title,
      duration: Number(draft.duration) || 1,
      owner: draft.owner,
      lighting: draft.lighting,
      sound: draft.sound,
      props: splitList(draft.props),
      cast: splitList(draft.cast),
      notes: draft.notes,
      dependsOnKeys: splitList(draft.dependsOnKeys),
    });
    this.templateDraftCues = upsertTemplateCue(this.templateDraftCues, cue);
    this.templateCueDraft = null;
  }

  @action
  removeTemplateCueDraft(key: string): void {
    this.templateDraftCues = removeTemplateCue(this.templateDraftCues, key);
    if (this.templateCueDraft?.key === key) this.templateCueDraft = null;
  }

  @action
  selectTemplateDraftCue(key: string): void {
    const cue = this.templateDraftCues.find((item) => item.key === key);
    if (cue) this.templateCueDraft = toDraftCue(cue);
  }

  @action
  startTemplateDrag(key: string): void {
    this.dragKey = key;
  }

  @action
  allowTemplateDrop(event: DragEvent): boolean {
    event.preventDefault();
    return false;
  }

  @action
  dropTemplateOn(key: string): void {
    if (this.dragKey) {
      this.templateDraftCues = moveTemplateCue(
        this.templateDraftCues,
        this.dragKey,
        key,
      );
    }
    this.dragKey = '';
  }

  @action
  updateVersionNote(value: string): void {
    this.versionNote = value;
  }

  @action
  updateTemplateDescriptionDraft(value: string): void {
    this.templateDescriptionDraft = value;
  }

  // PaperSelect（ember-power-select）回传整个 option 对象，这里适配为标量字段。
  @action
  selectTemplateCueKind(value: CueKind | { kind?: unknown }): void {
    if (this.templateCueDraft)
      this.templateCueDraft = {
        ...this.templateCueDraft,
        kind: value as CueKind,
      };
  }

  @action
  selectTemplateCueOwner(value: string): void {
    if (this.templateCueDraft)
      this.templateCueDraft = { ...this.templateCueDraft, owner: value };
  }

  @action
  selectSceneCueKind(value: CueKind): void {
    if (this.sceneCueDraft)
      this.sceneCueDraft = { ...this.sceneCueDraft, kind: value };
  }

  @action
  selectSceneCueOwner(value: string): void {
    if (this.sceneCueDraft)
      this.sceneCueDraft = { ...this.sceneCueDraft, owner: value };
  }

  @action
  selectCopyTemplate(option: { id: string } | string): void {
    this.copyTemplateId = typeof option === 'string' ? option : option.id;
  }

  @action
  selectCompareVersion(option: VersionSnapshot | string): void {
    this.compareVersionId = typeof option === 'string' ? option : option.id;
  }

  @action
  publishTemplate(): void {
    const template = this.activeTemplate;
    if (!template) return;
    if (!this.templateDirty) {
      this.notify('与当前版本一致，无需发布');
      return;
    }
    const note =
      this.versionNote.trim() || `v${template.currentVersion + 1} 调整`;
    this.commit((book) => {
      const target = book.templates.find((item) => item.id === template.id);
      if (!target) return;
      const published = publishTemplateVersion(
        target,
        this.templateDraftCues,
        note,
      );
      Object.assign(target, published);
    });
    const refreshed = findTemplate(this.book, template.id);
    if (refreshed) this.loadTemplateDraft(refreshed);
    this.versionNote = '';
    this.templateCueDraft = null;
    this.notify(
      `已发布模板 v${template.currentVersion + 1}；旧场次保留旧版本，可逐一迁移`,
    );
  }

  @action
  discardTemplateDraft(): void {
    if (this.activeTemplate) this.loadTemplateDraft(this.activeTemplate);
    this.templateCueDraft = null;
    this.notify('已放弃未发布的模板改动');
  }

  @action
  createTemplate(): void {
    const id = uid('template');
    const stamp = new Date().toISOString();
    const template: ShowTemplate = {
      id,
      name: '新模板',
      description: '',
      currentVersion: 1,
      versions: [{ version: 1, createdAt: stamp, note: '创建', cues: [] }],
      createdAt: stamp,
      updatedAt: stamp,
    };
    this.commit((book) => {
      book.templates.push(template);
    });
    this.activeTemplateId = id;
    this.loadTemplateDraft(template);
    this.mode = 'template';
  }

  // ---------- 复制新场次（选模板 -> 事务套用，失败回滚/可续处理） ----------
  @action
  openCopyPanel(templateId?: string): void {
    const count = this.book.scenes.length + 1;
    this.copyTemplateId =
      templateId ?? this.activeTemplateId ?? this.book.templates[0]?.id ?? '';
    this.copyName = `S${count}`;
    this.copyTitle = `第 ${count} 站`;
    this.copyStartTime = '20:00';
    this.copyTemplateOptions = this.book.templates.map((template) => ({
      id: template.id,
      label: `${template.name}（v${template.currentVersion} · ${findVersion(template)?.cues.length ?? 0} 条提示）`,
    }));
    this.showCopyPanel = true;
  }

  @action
  closeCopyPanel(): void {
    this.showCopyPanel = false;
  }

  @action
  updateCopyField(
    field: 'copyTemplateId' | 'copyName' | 'copyTitle' | 'copyStartTime',
    value: string,
  ): void {
    this[field] = value;
  }

  @action
  confirmCopyScene(): void {
    const template = findTemplate(this.book, this.copyTemplateId);
    if (!template) {
      this.notify('请选择有效的模板');
      return;
    }
    const job = createSceneJob(template.id, template.currentVersion, {
      act:
        this.activeEffective?.scene.act ?? `第${this.book.scenes.length + 1}幕`,
      name: this.copyName.trim() || `S${this.book.scenes.length + 1}`,
      title: this.copyTitle.trim() || '未命名场次',
      startTime: this.copyStartTime || '20:00',
      // 新场次从零开始：不携带任何其他场次的覆盖，从模板干净继承。
      cueOverrides: [],
    });
    this.runJob(job);
    this.showCopyPanel = false;
  }

  // ---------- 升级场次到模板新版本 ----------
  @action
  upgradeActiveScene(): void {
    const effective = this.activeEffective;
    if (!effective?.template) return;
    const job = upgradeSceneJob(
      effective.scene.id,
      effective.template.id,
      effective.template.currentVersion,
    );
    this.runJob(job);
  }

  // ---------- 作业执行 / 失败处理 / 重开续处理 ----------
  private runJob(job: ApplyJob): void {
    this.persistJobs([...this.jobs, job]);
    let result: ReturnType<typeof applyJob>;
    try {
      // applyJob 在内部深拷贝上构造结果；抛错时 this.book 完全不变 = 回滚。
      result = applyJob(this.book, job);
    } catch (error) {
      const failed = failJob(job, error);
      this.persistJobs(
        this.jobs.map((item) => (item.id === failed.id ? failed : item)),
      );
      this.jobs = [
        ...this.jobs.map((item) => (item.id === failed.id ? failed : item)),
      ];
      this.notify(
        `套用失败已回滚：${failed.error}（可在上方「待处理套用」继续）`,
      );
      return;
    }
    // 成功：新 book 与「移除该作业」一次性原子写入。
    const remaining = this.jobs.filter((item) => item.id !== result.job.id);
    this.applyBook(result.book, {
      pushUndo: true,
      clearRedo: true,
      jobs: remaining,
    });
    if (job.kind === 'create-scene') {
      this.activeSceneId = result.job.sceneId;
      this.selectedCueKey = this.activeEffective?.cues[0]?.key ?? '';
    }
    this.notify(
      job.kind === 'create-scene'
        ? '已按模板创建新场次'
        : '场次已迁移到模板新版本',
    );
  }

  @action
  continueJob(jobId: string): void {
    const job = this.jobs.find((item) => item.id === jobId);
    if (!job) return;
    this.runJob(resumeJob(job));
  }

  @action
  discardJob(jobId: string): void {
    const remaining = this.jobs.filter((item) => item.id !== jobId);
    this.jobs = remaining;
    this.persistJobs(remaining);
    this.notify('已移除该待处理套用（原场次与模板均未改动）');
  }

  // ---------- 孤立覆盖处理 ----------
  @action
  dropOrphanOverride(key: string): void {
    this.commit((book) => {
      const scene = book.scenes.find((item) => item.id === this.activeSceneId);
      if (!scene) return;
      scene.cueOverrides = scene.cueOverrides.filter(
        (item) => item.key !== key,
      );
      scene.migrationWarnings = scene.migrationWarnings.filter(
        (warning) => !warning.includes(key),
      );
    });
  }

  @action
  clearMigrationWarnings(): void {
    this.commit((book) => {
      const scene = book.scenes.find((item) => item.id === this.activeSceneId);
      if (scene) scene.migrationWarnings = [];
    });
  }

  // ---------- 锁定版本 ----------
  @action
  lockVersion(): void {
    const snapshot: VersionSnapshot = {
      id: uid('version'),
      name: `锁定版 ${this.versions.length + 1}`,
      createdAt: new Date().toISOString(),
      book: clone(this.book),
    };
    this.versions = [snapshot, ...this.versions];
    this.compareVersionId = snapshot.id;
    this.persistState(this.jobs);
    this.notify('已锁定当前版本');
  }

  @action
  setSearch(value: string): void {
    this.search = value;
  }

  // ---------- 撤销 / 重做 ----------
  @action
  undo(): void {
    const previous = this.undoStack.pop();
    if (!previous) return;
    this.redoStack.push(clone(this.book));
    this.applyBook(previous, { pushUndo: false, clearRedo: false });
    this.afterBookChange();
  }

  @action
  redo(): void {
    const next = this.redoStack.pop();
    if (!next) return;
    this.undoStack.push(clone(this.book));
    this.applyBook(next, { pushUndo: false, clearRedo: false });
    this.afterBookChange();
  }

  willDestroy(): void {
    super.willDestroy();
    window.removeEventListener('keydown', this.handleKeyboard);
  }

  private handleKeyboard = (event: KeyboardEvent): void => {
    const command = event.ctrlKey || event.metaKey;
    if (command && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      event.shiftKey ? this.redo() : this.undo();
      return;
    }
    if (command && event.key.toLowerCase() === 'y') {
      event.preventDefault();
      this.redo();
    }
  };

  // ---------- 状态提交 / 持久化 ----------
  private commit(mutator: (book: CueBook) => void): void {
    const next = clone(this.book);
    mutator(next);
    next.updatedAt = new Date().toISOString();
    this.applyBook(next, { pushUndo: true, clearRedo: true });
  }

  private applyBook(
    book: CueBook,
    options: { pushUndo: boolean; clearRedo: boolean; jobs?: ApplyJob[] },
  ): void {
    if (options.pushUndo) {
      this.undoStack.push(clone(this.book));
      if (this.undoStack.length > 80) this.undoStack.shift();
    }
    if (options.clearRedo) this.redoStack = [];
    this.book = book;
    this.afterBookChange();
    // book 与 jobs 一次性原子写入，避免「新 book 已落盘、已完成作业仍在」造成重开后重复套用。
    this.persistState(options.jobs ?? this.jobs);
  }

  private afterBookChange(): void {
    if (!this.book.scenes.some((scene) => scene.id === this.activeSceneId)) {
      this.activeSceneId = this.book.scenes[0]?.id ?? '';
    }
    const effective = this.activeEffective;
    if (
      effective &&
      !effective.cues.some((cue) => cue.key === this.selectedCueKey)
    ) {
      this.selectedCueKey = effective.cues[0]?.key ?? '';
    }
    if (
      !this.book.templates.some(
        (template) => template.id === this.activeTemplateId,
      )
    ) {
      this.activeTemplateId = this.book.templates[0]?.id ?? '';
    }
  }

  private persistState(jobs: ApplyJob[]): void {
    this.jobs = jobs;
    saveState({ book: this.book, versions: this.versions, jobs });
  }

  private persistJobs(jobs: ApplyJob[]): void {
    this.jobs = jobs;
    saveState({ book: this.book, versions: this.versions, jobs });
  }

  private notify(value: string): void {
    this.message = value;
    window.setTimeout(() => {
      if (this.message === value) this.message = '';
    }, 2600);
  }
}

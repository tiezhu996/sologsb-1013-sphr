import type {
  PendingApply,
  PersistShape,
  VersionSnapshot,
  WorkspaceState,
} from 'stage-cue-editor/models/show';
import {
  checksum,
  clone,
  initialWorkspace,
  migrateLegacyShow,
  migrateLegacySnapshot,
} from 'stage-cue-editor/utils/template-engine';

const STORAGE_KEY = 'sologsb-1013-stage-cue-editor-v2';
const LEGACY_STORAGE_KEY = 'sologsb-1013-stage-cue-editor-v1';

export interface LoadedState {
  state: WorkspaceState;
  versions: VersionSnapshot[];
  pendingApply: PendingApply | null;
  migratedFromV1: boolean;
}

function isWorkspaceState(value: unknown): value is WorkspaceState {
  const candidate = value as WorkspaceState | null;
  return Boolean(
    candidate &&
    candidate.show &&
    Array.isArray(candidate.show.scenes) &&
    Array.isArray(candidate.templates),
  );
}

export function loadWorkspace(): LoadedState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<PersistShape>;
      if (
        isWorkspaceState({ show: parsed.show, templates: parsed.templates })
      ) {
        const state: WorkspaceState = {
          show: parsed.show!,
          templates: parsed.templates!,
        };
        const versions = (parsed.versions ?? []).map(migrateLegacySnapshot);
        const pendingApply = parsed.pendingApply ?? null;
        // 校验回滚检查点是否完整；损坏则直接恢复，避免带伤继续
        if (
          pendingApply &&
          checksum(pendingApply.checkpoint) !== pendingApply.checkpointChecksum
        ) {
          return {
            state: pendingApply.checkpoint,
            versions,
            pendingApply: null,
            migratedFromV1: false,
          };
        }
        return { state, versions, pendingApply, migratedFromV1: false };
      }
    }

    const legacyRaw = localStorage.getItem(LEGACY_STORAGE_KEY);
    if (legacyRaw) {
      const legacy = JSON.parse(legacyRaw) as {
        show?: Parameters<typeof migrateLegacyShow>[0];
        versions?: VersionSnapshot[];
      };
      if (legacy.show) {
        return {
          state: migrateLegacyShow(legacy.show),
          versions: (legacy.versions ?? []).map(migrateLegacySnapshot),
          pendingApply: null,
          migratedFromV1: true,
        };
      }
    }
  } catch {
    // 存储损坏时回到示例数据
  }
  return {
    state: initialWorkspace(),
    versions: [],
    pendingApply: null,
    migratedFromV1: false,
  };
}

export function persistWorkspace(
  state: WorkspaceState,
  versions: VersionSnapshot[],
  pendingApply: PendingApply | null,
): void {
  const payload: PersistShape = {
    show: state.show,
    templates: state.templates,
    versions,
    pendingApply,
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
}

export { clone };

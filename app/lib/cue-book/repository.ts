/** localStorage 仓储：统一读写 book / 锁定版本 / 套用作业，并负责旧格式迁移。 */

import type { PersistShape } from 'stage-cue-editor/models/cue-book';
import { parsePersisted } from './migration';
import { sampleBook } from './sample';

export const STORAGE_KEY = 'sologsb-1013-stage-cue-editor-v2';
/** 旧版（schema v1，整份深拷贝模型）使用的存储键，用于首次打开时无缝迁移。 */
export const LEGACY_STORAGE_KEY = 'sologsb-1013-stage-cue-editor-v1';

export function emptyState(): PersistShape {
  return { book: sampleBook(), versions: [], jobs: [] };
}

function readKey(key: string, storage: Storage): PersistShape | null {
  const raw = storage.getItem(key);
  if (!raw) return null;
  return parsePersisted(JSON.parse(raw) as unknown);
}

export function loadState(storage: Storage = localStorage): PersistShape {
  try {
    // 先读 v2；v2 不存在时回退旧 v1 键并迁移，迁移成功后落到 v2 键。
    const current = readKey(STORAGE_KEY, storage);
    if (current) return current;

    const legacy = readKey(LEGACY_STORAGE_KEY, storage);
    if (legacy) {
      saveState(legacy, storage);
      storage.removeItem(LEGACY_STORAGE_KEY);
      return legacy;
    }
    return emptyState();
  } catch {
    return emptyState();
  }
}

export function saveState(
  state: PersistShape,
  storage: Storage = localStorage,
): void {
  const payload: PersistShape = {
    book: state.book,
    versions: state.versions,
    jobs: state.jobs,
  };
  storage.setItem(STORAGE_KEY, JSON.stringify(payload));
}

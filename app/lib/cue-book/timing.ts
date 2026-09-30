/** 时间轴纯函数：开场时间与相对偏移换算、重叠判定。 */

export function startSeconds(value: string): number {
  const [hour = '0', minute = '0'] = value.split(':');
  return Number(hour) * 3600 + Number(minute) * 60;
}

/** 场次开场时间 + 相对偏移秒数 → HH:MM:SS。 */
export function timeLabel(sceneStart: string, offset: number): string {
  const total = startSeconds(sceneStart) + offset;
  const hour = Math.floor((total % 86400) / 3600);
  const minute = Math.floor((total % 3600) / 60);
  const second = total % 60;
  return [hour, minute, second]
    .map((part) => String(part).padStart(2, '0'))
    .join(':');
}

export function overlaps(
  aStart: number,
  aDuration: number,
  bStart: number,
  bDuration: number,
): boolean {
  return aStart < bStart + bDuration && bStart < aStart + aDuration;
}

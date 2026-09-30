import { helper } from '@ember/component/helper';

export default helper(function mapKeys(
  positional: [Record<string, unknown> | undefined | null],
): string[] {
  const [record] = positional;
  return record ? Object.keys(record) : [];
});

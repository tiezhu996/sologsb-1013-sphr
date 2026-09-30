import { module, test } from 'qunit';
import { click, find, render, settled } from '@ember/test-helpers';
import { setupRenderingTest } from 'stage-cue-editor/tests/helpers';
import { hbs } from 'ember-cli-htmlbars';

const STORAGE_KEY = 'sologsb-1013-stage-cue-editor-v2';

async function renderEditor() {
  await render(hbs`<CueEditor />`);
}

module('Integration | Component | cue editor · 套用模板事务', function (hooks) {
  setupRenderingTest(hooks);

  hooks.beforeEach(function () {
    localStorage.removeItem(STORAGE_KEY);
  });

  hooks.afterEach(function () {
    localStorage.removeItem(STORAGE_KEY);
  });

  test('复制新场次失败时回滚并挂起，重试后成功且数据完整', async function (assert) {
    await renderEditor();

    const initialSceneButtons = document.querySelectorAll('.scene-item').length;
    assert.ok(initialSceneButtons >= 2, '示例场次已加载');

    // 打开套用弹窗
    await click('[data-test-open-apply]');
    assert.ok(find('[data-test-apply-modal]'), '模板选择弹窗出现');

    // 勾选模拟失败并提交
    const failCheckbox = find('.fail-toggle input') as HTMLInputElement;
    failCheckbox.checked = true;
    failCheckbox.dispatchEvent(new Event('change', { bubbles: true }));
    await settled();
    await click('[data-test-apply-confirm]');

    assert.notOk(find('[data-test-apply-modal]'), '失败后弹窗关闭');
    assert.ok(find('[data-test-pending-banner]'), '出现待处理横幅');
    assert.strictEqual(
      document.querySelectorAll('.scene-item').length,
      initialSceneButtons,
      '已回滚：没有残留半途场次',
    );
    assert.ok(
      (find('[data-test-pending-banner]') as HTMLElement).textContent?.includes(
        '检查点校验通过',
      ),
      '检查点完整',
    );

    // 刷新（重新挂载组件）：待处理任务仍在
    await renderEditor();
    assert.ok(find('[data-test-pending-banner]'), '重开后仍提示待处理套用');

    // 重试：弹窗带着原填写重新打开，这次不模拟失败
    await click('[data-test-pending-banner] button');
    assert.ok(find('[data-test-apply-modal]'), '重试重新打开弹窗');
    const retryCheckbox = find('.fail-toggle input') as HTMLInputElement;
    assert.notOk(retryCheckbox.checked, '重试默认不再注入故障');
    await click('[data-test-apply-confirm]');

    assert.notOk(find('[data-test-pending-banner]'), '成功后横幅消失');
    assert.strictEqual(
      document.querySelectorAll('.scene-item').length,
      initialSceneButtons + 1,
      '新场次创建成功',
    );
    assert.ok(
      (find('.binding-strip') as HTMLElement).textContent?.includes('钉住 v1'),
      '新场次钉住所套用的模板版本',
    );
  });
});

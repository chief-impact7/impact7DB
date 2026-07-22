import test from 'node:test';
import assert from 'node:assert/strict';

import { requiresAcquisitionSource, setAcquisitionSourceRequired } from '../student-form-policy.js';

test('유입 채널은 완전 신규 학생에게만 필수다', () => {
    assert.equal(requiresAcquisitionSource(false, null), true);
    assert.equal(requiresAcquisitionSource(true, null), false);
    assert.equal(requiresAcquisitionSource(false, { id: 'existing' }), false);

    const form = { acquisition_source: { required: false, labels: [{ textContent: '유입 채널' }] } };
    setAcquisitionSourceRequired(form, true);
    assert.equal(form.acquisition_source.required, true);
    assert.equal(form.acquisition_source.labels[0].textContent, '유입 채널 *');
    setAcquisitionSourceRequired(form, false);
    assert.equal(form.acquisition_source.required, false);
    assert.equal(form.acquisition_source.labels[0].textContent, '유입 채널');
});

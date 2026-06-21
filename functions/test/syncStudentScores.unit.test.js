import { describe, it, expect, vi } from 'vitest';
import { deleteSummaryField } from '../src/syncStudentScores.js';

describe('deleteSummaryField — NOT_FOUND만 멱등 성공, 그 외 재전파 (M-01)', () => {
  it('NOT_FOUND(gRPC code 5)는 삼킨다(지울 것 없음 = 멱등 성공)', async () => {
    const ref = { update: vi.fn().mockRejectedValue(Object.assign(new Error('no entity to update'), { code: 5 })) };
    await expect(deleteSummaryField(ref, 'academy.ex1')).resolves.toBeUndefined();
  });

  it("code 'not-found' 문자열도 삼킨다", async () => {
    const ref = { update: vi.fn().mockRejectedValue(Object.assign(new Error('x'), { code: 'not-found' })) };
    await expect(deleteSummaryField(ref, 'academy.ex1')).resolves.toBeUndefined();
  });

  it('그 외 오류(권한·일시장애)는 재전파한다 — 과거엔 .catch(()=>{})로 삼켜 stale 잔존', async () => {
    const ref = { update: vi.fn().mockRejectedValue(Object.assign(new Error('PERMISSION_DENIED'), { code: 7 })) };
    await expect(deleteSummaryField(ref, 'academy.ex1')).rejects.toThrow(/PERMISSION_DENIED/);
  });

  it('성공 시 해당 필드 delete로 update 호출', async () => {
    const ref = { update: vi.fn().mockResolvedValue() };
    await deleteSummaryField(ref, 'external.ev1');
    expect(ref.update).toHaveBeenCalledOnce();
    expect('external.ev1' in ref.update.mock.calls[0][0]).toBe(true);
  });
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computePhoneKey, employeeToStaff, shortTermToStaff } from './personnelMapping.mjs';

test('computePhoneKey: 010 제거 앞6자리', () => {
  assert.equal(computePhoneKey('010-1234-5678'), '123456');
  assert.equal(computePhoneKey('01098765432'), '987654');
});

test('employeeToStaff: 행정 부서·position 보존·중첩 유지', () => {
  const s = employeeToStaff({ name:'김행정', phone:'01011112222', position:'교무', bankInfo:{bank:'우리',accountNumber:'1',holder:'김행정'}, taxInfo:{taxType:'근로소득',dependents:0,hasOtherIncome:false}, status:'active', joinDate:'2025-01-01', memo:'' });
  assert.equal(s.department, '행정');
  assert.equal(s.phoneKey, '111122');
  assert.equal(s.position, '교무');
  assert.equal(s.bankInfo.bank, '우리');
});

test('shortTermToStaff: 단기 부서·플랫뱅크→중첩·기본 status active', () => {
  const s = shortTermToStaff({ name:'박단기', phone:'01033334444', bank:'하나', accountNumber:'9', accountHolder:'박단기', email:'a@b.c', residentNumber:'000000-0000000', address:'서울', createdAt:{ toDate:()=>new Date('2026-03-01') } });
  assert.equal(s.department, '단기');
  assert.equal(s.phoneKey, '333344');
  assert.equal(s.bankInfo.accountNumber, '9');
  assert.equal(s.status, 'active');
});

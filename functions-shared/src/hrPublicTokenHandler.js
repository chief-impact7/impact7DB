import { getFirestore } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import { tsToMillis } from './timestampUtil.js';

// HR 공개 페이지(비로그인 신규입사자·계약자)가 토큰만으로 읽던 Firestore 공개 read를
// 대체하는 토큰 게이트 callable. Admin SDK는 rules를 우회하므로, 토큰 검증 후
// 각 페이지가 화면에 실제로 표시하는 최소 필드만 마스킹해 반환한다.
// 민감정보(주민번호 평문·계좌번호 평문·taxInfo·문서스캔)는 절대 반환하지 않는다.

// tokenType → { collection, usedStatus } 매핑. usedStatus는 "이미 사용됨" 거절 기준.
const TOKEN_TYPES = {
  onboarding: { collection: 'onboardingTokens', usedStatus: 'completed', nameField: 'staffName' },
  employeeOnboarding: { collection: 'employeeOnboardingTokens', usedStatus: 'completed', nameField: 'staffName' },
  shortTerm: { collection: 'shortTermTokens', usedStatus: 'completed', nameField: 'name' },
  contractSigning: { collection: 'contractSigningTokens', usedStatus: 'signed', nameField: 'staffName' },
  salaryAgreement: { collection: 'salaryAgreementTokens', usedStatus: 'signed', nameField: 'staffName' },
  employeeContractSigning: { collection: 'employeeContractSigningTokens', usedStatus: 'signed', nameField: 'employeeName' },
};

function textOf(v) { return String(v ?? '').trim(); }

// 주민번호 → "YYMMDD-N******" (생년월일 6자리 + 성별 1자리만, 나머지 마스킹).
// HR 계약서/약정서 폼이 이미 동일 형태로 표시하므로 화면에 손실 없음.
export function maskResidentNumber(rn) {
  const clean = textOf(rn).replace(/-/g, '');
  if (clean.length < 7) return null;
  return `${clean.slice(0, 6)}-${clean.charAt(6)}******`;
}

// 계좌번호 → 끝 4자리만 노출. 평문 계좌번호는 반환하지 않는다.
export function maskAccountNumber(acc) {
  const clean = textOf(acc).replace(/\D/g, '');
  if (!clean) return null;
  if (clean.length <= 4) return clean;
  return `${'*'.repeat(clean.length - 4)}${clean.slice(-4)}`;
}

// 입금계좌 표시용 — 은행·예금주는 그대로, 계좌번호만 마스킹.
function maskBankInfo(bankInfo) {
  if (!bankInfo) return null;
  return {
    bank: textOf(bankInfo.bank) || null,
    accountNumberMasked: maskAccountNumber(bankInfo.accountNumber),
    holder: textOf(bankInfo.holder) || null,
  };
}

// staff/employee 마스터 → 계약서 폼이 표시하는 신원 필드만(주민번호·계좌는 마스킹).
function maskParty(data) {
  if (!data) return null;
  return {
    name: textOf(data.name) || null,
    phone: textOf(data.phone) || null,
    address: textOf(data.address) || null,
    residentNumberMasked: maskResidentNumber(data.residentNumber),
    bankInfo: maskBankInfo(data.bankInfo),
  };
}

// 계약서 본문 — 서명 화면이 렌더하는 비민감 조항/금액/서명 메타만 추린다.
// taxInfo·문서스캔 등은 계약서 폼이 쓰지 않으므로 제외.
function pickContract(id, c) {
  return {
    id,
    contractType: c.contractType ?? null,
    status: c.status ?? null,
    startDate: c.startDate ?? null,
    endDate: c.endDate ?? null,
    deliveryDate: c.deliveryDate ?? null,
    workPlace: c.workPlace ?? null,
    workContent: c.workContent ?? null,
    workDays: c.workDays ?? null,
    restDays: c.restDays ?? null,
    workHours: c.workHours ?? null,
    paymentTerms: c.paymentTerms ?? null,
    insurance: c.insurance ?? null,
    probation: c.probation ?? null,
    retirementFund: c.retirementFund ?? null,
    specialTerms: Array.isArray(c.specialTerms) ? c.specialTerms : [],
    // 서명 화면 최소 필드만 — 원장 서명 이미지 + 강사/직원 서명 여부. deviceInfo(UA)·signedAt 등 제외(M-1).
    signatures: c.signatures ? {
      director: c.signatures.director?.signatureUrl ? { signatureUrl: c.signatures.director.signatureUrl } : null,
      staffSigned: !!c.signatures.staff?.signatureUrl,
      employeeSigned: !!c.signatures.employee?.signatureUrl,
    } : null,
    entityId: c.entityId ?? null,
    entitySnapshot: c.entitySnapshot ?? null,
  };
}

async function readDoc(ref) {
  const snap = await ref.get();
  return snap.exists ? { id: snap.id, data: snap.data() } : null;
}

// 토큰 doc을 읽고 존재/사용여부/만료를 검증해 반환. 실패 시 HttpsError throw.
// PUBLIC 업로드(서명 PDF) callable도 같은 게이트를 써야 하므로 export한다.
export async function loadValidToken(db, tokenType, tokenId) {
  const meta = TOKEN_TYPES[tokenType];
  if (!meta) throw new HttpsError('invalid-argument', '알 수 없는 tokenType입니다.');
  if (!tokenId) throw new HttpsError('invalid-argument', 'tokenId가 필요합니다.');

  const found = await readDoc(db.collection(meta.collection).doc(tokenId));
  if (!found) throw new HttpsError('not-found', '유효하지 않은 링크입니다.');

  const token = found.data;
  if (token.status === meta.usedStatus) {
    throw new HttpsError('failed-precondition', '이미 처리된 링크입니다.');
  }
  // expiresAt 없음/파싱불가도 만료로 처리(fail-closed, L-2). 서버가 항상 설정하므로 정상 토큰엔 영향 없음.
  const expiresMs = tsToMillis(token.expiresAt);
  if (expiresMs == null || expiresMs < Date.now()) {
    throw new HttpsError('deadline-exceeded', '링크가 만료되었습니다.');
  }
  return { meta, token };
}

export async function handleGetHrPublicToken(request, deps = {}) {
  const db = deps.db ?? getFirestore();
  const data = request?.data ?? {};
  const tokenType = textOf(data.tokenType);
  const tokenId = textOf(data.tokenId);

  const { meta, token } = await loadValidToken(db, tokenType, tokenId);

  // 온보딩 계열: 폼이 표시하는 건 대상자 이름뿐. 추가 doc read 없음.
  if (tokenType === 'onboarding' || tokenType === 'employeeOnboarding' || tokenType === 'shortTerm') {
    return { tokenType, targetName: textOf(token[meta.nameField]) || null };
  }

  // 계약/근로계약 서명: staff/employee 마스터 + 해당 계약 subdoc을 함께 반환.
  if (tokenType === 'contractSigning' || tokenType === 'employeeContractSigning') {
    const isEmployee = tokenType === 'employeeContractSigning';
    const partyCol = isEmployee ? 'employees' : 'staff';
    const partyId = textOf(isEmployee ? token.employeeId : token.staffId);
    const contractId = textOf(token.contractId);
    if (!partyId || !contractId) {
      throw new HttpsError('failed-precondition', '계약 정보가 올바르지 않습니다.');
    }

    const [party, contract] = await Promise.all([
      readDoc(db.collection(partyCol).doc(partyId)),
      readDoc(db.collection(partyCol).doc(partyId).collection('contracts').doc(contractId)),
    ]);
    if (!contract) throw new HttpsError('not-found', '계약서를 찾을 수 없습니다.');

    return {
      tokenType,
      targetName: textOf(token[meta.nameField]) || null,
      party: maskParty(party?.data),
      contract: pickContract(contract.id, contract.data),
    };
  }

  // 급여 약정서: 금액·수습·퇴직 조건은 토큰 자체에 들어있고, 폼은 staff 이름·주민번호(마스킹)만 추가로 표시.
  if (tokenType === 'salaryAgreement') {
    const partyId = textOf(token.staffId);
    const contractId = textOf(token.contractId);
    const party = partyId ? await readDoc(db.collection('staff').doc(partyId)) : null;

    let entitySnapshot = null;
    let entityId = null;
    if (partyId && contractId) {
      const contract = await readDoc(db.collection('staff').doc(partyId).collection('contracts').doc(contractId));
      if (contract) {
        entitySnapshot = contract.data.entitySnapshot ?? null;
        entityId = contract.data.entityId ?? null;
      }
    }

    return {
      tokenType,
      targetName: textOf(token.staffName) || null,
      party: maskParty(party?.data),
      agreement: {
        contractType: token.contractType ?? null,
        amount: typeof token.amount === 'number' ? token.amount : null,
        probation: token.probation ?? null,
        retirementFund: token.retirementFund ?? null,
      },
      entityId,
      entitySnapshot,
    };
  }

  // 도달 불가(매핑된 tokenType만 위에서 처리). 방어적.
  throw new HttpsError('invalid-argument', '지원하지 않는 tokenType입니다.');
}

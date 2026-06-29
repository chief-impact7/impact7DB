export function computePhoneKey(phone) {
  const digits = String(phone ?? '').replace(/\D/g, '');
  const body = digits.startsWith('010') ? digits.slice(3) : digits;
  return body.slice(0, 6);
}

const EMPTY_DOCS = { idCopy:null, bankbook:null, resume:null, certificates:[], taxWithholdingConsent:null };

export function employeeToStaff(emp) {
  return {
    department: '행정',
    name: emp.name ?? '', englishName: '', phone: emp.phone ?? '',
    phoneKey: computePhoneKey(emp.phone), affiliation: '',
    email: emp.email ?? '', residentNumber: emp.residentNumber ?? '',
    birthDate: emp.birthDate ?? '', address: emp.address ?? '',
    subject: '', position: emp.position ?? '',
    interviewDate: '', joinDate: emp.joinDate ?? '', resignationDate: '',
    bankInfo: emp.bankInfo ?? { bank:'', accountNumber:'', holder:'' },
    taxInfo: emp.taxInfo ?? { taxType:'근로소득', dependents:0, hasOtherIncome:false },
    documents: emp.documents ? { ...EMPTY_DOCS, ...emp.documents } : { ...EMPTY_DOCS },
    staffType: 'parttime', status: emp.status ?? 'active',
    onboardingCompletedAt: emp.onboardingCompletedAt ?? null, memo: emp.memo ?? '',
  };
}

export function shortTermToStaff(st) {
  const joinDate = st.createdAt?.toDate ? st.createdAt.toDate().toISOString().slice(0,10) : '';
  return {
    department: '단기',
    name: st.name ?? '', englishName: '', phone: st.phone ?? '',
    phoneKey: computePhoneKey(st.phone), affiliation: '',
    email: st.email ?? '', residentNumber: st.residentNumber ?? '',
    birthDate: '', address: st.address ?? '',
    subject: '', position: '',
    interviewDate: '', joinDate, resignationDate: '',
    bankInfo: { bank: st.bank ?? '', accountNumber: st.accountNumber ?? '', holder: st.accountHolder ?? st.name ?? '' },
    taxInfo: { taxType:'근로소득', dependents:0, hasOtherIncome:false },
    documents: { ...EMPTY_DOCS },
    staffType: 'freelancer', status: 'active',
    onboardingCompletedAt: null, memo: '',
  };
}

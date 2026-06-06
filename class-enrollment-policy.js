export function isSelectableClass(classType, settings) {
    if (!settings) return false;
    if (classType === '특강') return settings.class_type === '특강';
    if (classType === '정규') return !settings.class_type || settings.class_type === '정규';
    return false;
}

export function selectableClassCodes(classSettings, classType) {
    return Object.entries(classSettings || {})
        .filter(([, settings]) => isSelectableClass(classType, settings))
        .map(([code]) => code)
        .sort((a, b) => a.localeCompare(b, 'ko'));
}

export function enrollmentClassParts(classType, classCode) {
    const code = (classCode || '').trim();
    if (!code) return { levelSymbol: '', classNumber: '' };
    if (classType === '특강') return { levelSymbol: '', classNumber: code };

    const firstDigit = code.search(/\d/);
    if (firstDigit <= 0) return { levelSymbol: '', classNumber: '' };
    return {
        levelSymbol: code.slice(0, firstDigit),
        classNumber: code.slice(firstDigit),
    };
}

export function validateExistingClass(classSettings, classType, classCode) {
    if (!classCode) return '등록할 반을 선택하세요.';
    if (!isSelectableClass(classType, classSettings?.[classCode])) {
        return `"${classCode}"는 반 생성 마법사에서 생성된 ${classType}반이 아닙니다.`;
    }
    const { levelSymbol, classNumber } = enrollmentClassParts(classType, classCode);
    if (!classNumber || (classType === '정규' && !levelSymbol)) {
        return `"${classCode}" 반 코드를 enrollment 형식으로 변환할 수 없습니다.`;
    }
    return null;
}

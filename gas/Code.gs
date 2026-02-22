// ===========================================================================
// impact7DB Dashboard — Google Apps Script (Firestore ↔ Google Sheets)
// ===========================================================================
// 서비스 계정 키 없이 배포자의 OAuth 토큰으로 Firestore REST API 직접 호출
//
// 스크립트 속성 (Script Properties):
//   FIREBASE_PROJECT_ID  — Firebase 프로젝트 ID (예: impact7db)
//   BACKUP_FOLDER_ID     — Google Drive 백업 폴더 ID
// ===========================================================================

function getProjectId_() {
  return PropertiesService.getScriptProperties().getProperty('FIREBASE_PROJECT_ID') || 'impact7db';
}

function getFirestoreBase_() {
  return 'https://firestore.googleapis.com/v1/projects/' + getProjectId_() + '/databases/(default)/documents';
}

// 시트 헤더 (enrollment별 1행, 비정규화)
var HEADERS = [
  '이름', '학부', '학교', '학년', '학생연락처',
  '학부모연락처1', '학부모연락처2', '소속', '레벨기호', '반넘버',
  '수업종류', '시작일', '종료일', '요일',
  '상태', '휴원시작일', '휴원종료일'
];

// ===========================================================================
// Firestore REST API 헬퍼
// ===========================================================================

// 인증 헤더
function authHeaders_() {
  return {
    'Authorization': 'Bearer ' + ScriptApp.getOAuthToken(),
    'Content-Type': 'application/json'
  };
}

// Firestore 값 → JS 값 변환
function fromFirestoreValue_(v) {
  if (v == null) return '';
  if (v.stringValue !== undefined) return v.stringValue;
  if (v.integerValue !== undefined) return String(v.integerValue);
  if (v.doubleValue !== undefined) return v.doubleValue;
  if (v.booleanValue !== undefined) return v.booleanValue;
  if (v.nullValue !== undefined) return '';
  if (v.timestampValue !== undefined) return v.timestampValue;
  if (v.arrayValue) {
    return (v.arrayValue.values || []).map(fromFirestoreValue_);
  }
  if (v.mapValue) {
    return fromFirestoreFields_(v.mapValue.fields || {});
  }
  return '';
}

// Firestore fields 객체 → 일반 JS 객체
function fromFirestoreFields_(fields) {
  var obj = {};
  for (var key in fields) {
    obj[key] = fromFirestoreValue_(fields[key]);
  }
  return obj;
}

// JS 값 → Firestore 값 변환
function toFirestoreValue_(val) {
  if (val === null || val === undefined || val === '') {
    return { stringValue: '' };
  }
  if (typeof val === 'boolean') return { booleanValue: val };
  if (typeof val === 'number') {
    if (Number.isInteger(val)) return { integerValue: String(val) };
    return { doubleValue: val };
  }
  if (typeof val === 'string') return { stringValue: val };
  if (Array.isArray(val)) {
    return { arrayValue: { values: val.map(toFirestoreValue_) } };
  }
  if (typeof val === 'object') {
    var fields = {};
    for (var key in val) {
      fields[key] = toFirestoreValue_(val[key]);
    }
    return { mapValue: { fields: fields } };
  }
  return { stringValue: String(val) };
}

// JS 객체 → Firestore fields 변환
function toFirestoreFields_(obj) {
  var fields = {};
  for (var key in obj) {
    fields[key] = toFirestoreValue_(obj[key]);
  }
  return fields;
}

// 컬렉션의 모든 문서 가져오기 (페이지네이션 포함)
function getAllDocuments_(collectionPath) {
  var docs = [];
  var pageToken = '';

  do {
    var url = getFirestoreBase_() + '/' + collectionPath + '?pageSize=300';
    if (pageToken) url += '&pageToken=' + pageToken;

    var resp = UrlFetchApp.fetch(url, {
      method: 'get',
      headers: authHeaders_(),
      muteHttpExceptions: true
    });

    if (resp.getResponseCode() !== 200) {
      throw new Error('Firestore 읽기 실패: ' + resp.getContentText());
    }

    var json = JSON.parse(resp.getContentText());
    var documents = json.documents || [];

    documents.forEach(function(doc) {
      var obj = fromFirestoreFields_(doc.fields || {});
      // 문서 이름에서 ID 추출
      var parts = doc.name.split('/');
      obj._docId = parts[parts.length - 1];
      docs.push(obj);
    });

    pageToken = json.nextPageToken || '';
  } while (pageToken);

  return docs;
}

// 문서 생성 또는 업데이트 (PATCH with upsert)
function upsertDocument_(collectionPath, docId, data) {
  var url = getFirestoreBase_() + '/' + collectionPath + '/' + encodeURIComponent(docId);
  // updateMask 없이 PATCH = 전체 덮어쓰기 (upsert)
  var resp = UrlFetchApp.fetch(url + '?currentDocument.exists=true', {
    method: 'patch',
    headers: authHeaders_(),
    payload: JSON.stringify({ fields: toFirestoreFields_(data) }),
    muteHttpExceptions: true
  });

  // 문서가 없으면 (404) 새로 생성
  if (resp.getResponseCode() === 404) {
    resp = UrlFetchApp.fetch(url, {
      method: 'patch',
      headers: authHeaders_(),
      payload: JSON.stringify({ fields: toFirestoreFields_(data) }),
      muteHttpExceptions: true
    });
  }

  if (resp.getResponseCode() !== 200) {
    throw new Error('Firestore 저장 실패 (' + docId + '): ' + resp.getContentText());
  }
}

// 문서 생성 (auto ID)
function createDocument_(collectionPath, data) {
  var url = getFirestoreBase_() + '/' + collectionPath;
  var resp = UrlFetchApp.fetch(url, {
    method: 'post',
    headers: authHeaders_(),
    payload: JSON.stringify({ fields: toFirestoreFields_(data) }),
    muteHttpExceptions: true
  });

  if (resp.getResponseCode() !== 200) {
    throw new Error('Firestore 문서 생성 실패: ' + resp.getContentText());
  }
}

// ---------------------------------------------------------------------------
// class_number 첫 자리로 소속 파생
// ---------------------------------------------------------------------------
function branchFromClassNumber(num) {
  var first = (num || '').toString().trim().charAt(0);
  if (first === '1') return '2단지';
  if (first === '2') return '10단지';
  return '';
}

// ---------------------------------------------------------------------------
// Firestore 학생 → 시트 행 배열 변환
// ---------------------------------------------------------------------------
function studentsToRows(docs) {
  var rows = [];
  docs.forEach(function(s) {
    var enrollments = s.enrollments || [];
    var branch = s.branch || '';

    if (enrollments.length === 0) {
      rows.push([
        s.name || '', s.level || '', s.school || '', s.grade || '',
        s.student_phone || '', s.parent_phone_1 || '', s.parent_phone_2 || '',
        branch, '', '', '정규', '', '', '',
        s.status || '재원', s.pause_start_date || '', s.pause_end_date || ''
      ]);
    } else {
      enrollments.forEach(function(e) {
        var dayStr = '';
        if (Array.isArray(e.day)) dayStr = e.day.join(',');
        else if (e.day) dayStr = String(e.day);

        rows.push([
          s.name || '', s.level || '', s.school || '', s.grade || '',
          s.student_phone || '', s.parent_phone_1 || '', s.parent_phone_2 || '',
          branch,
          e.level_symbol || '', e.class_number || '', e.class_type || '정규',
          e.start_date || '', e.end_date || '', dayStr,
          s.status || '재원', s.pause_start_date || '', s.pause_end_date || ''
        ]);
      });
    }
  });
  return rows;
}

// ---------------------------------------------------------------------------
// 내보내기: Firestore → 새 구글시트 생성
// ---------------------------------------------------------------------------
function exportToSheet() {
  var docs = getAllDocuments_('students');

  var today = Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyy-MM-dd');
  var ss = SpreadsheetApp.create('impact7DB_' + today);
  var sheet = ss.getActiveSheet();
  sheet.setName('학생데이터');

  // 헤더
  sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
  sheet.getRange(1, 1, 1, HEADERS.length)
    .setFontWeight('bold')
    .setBackground('#4285f4')
    .setFontColor('#ffffff');

  // 데이터
  var rows = studentsToRows(docs);
  if (rows.length > 0) {
    sheet.getRange(2, 1, rows.length, HEADERS.length).setValues(rows);
  }

  // 열 너비 자동 맞춤
  for (var i = 1; i <= HEADERS.length; i++) {
    sheet.autoResizeColumn(i);
  }

  // 필터 활성화
  if (rows.length > 0) {
    sheet.getRange(1, 1, rows.length + 1, HEADERS.length).createFilter();
  }

  sheet.setFrozenRows(1);

  return ss.getUrl();
}

// ---------------------------------------------------------------------------
// 가져오기 템플릿: 빈 시트 생성 (헤더 + 데이터 유효성)
// ---------------------------------------------------------------------------
function createImportTemplate() {
  var ss = SpreadsheetApp.create('impact7DB_가져오기_템플릿');
  var sheet = ss.getActiveSheet();
  sheet.setName('데이터입력');

  // 헤더
  sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
  sheet.getRange(1, 1, 1, HEADERS.length)
    .setFontWeight('bold')
    .setBackground('#34a853')
    .setFontColor('#ffffff');

  // 열 너비
  for (var i = 1; i <= HEADERS.length; i++) {
    sheet.autoResizeColumn(i);
  }

  // 데이터 유효성 규칙 (100행까지)
  var lastRow = 100;

  // 학부 (B열): 초등/중등/고등
  var levelRule = SpreadsheetApp.newDataValidation()
    .requireValueInList(['초등', '중등', '고등'], true)
    .setAllowInvalid(false)
    .build();
  sheet.getRange(2, 2, lastRow, 1).setDataValidation(levelRule);

  // 수업종류 (K열): 정규/특강/내신
  var classTypeRule = SpreadsheetApp.newDataValidation()
    .requireValueInList(['정규', '특강', '내신'], true)
    .setAllowInvalid(false)
    .build();
  sheet.getRange(2, 11, lastRow, 1).setDataValidation(classTypeRule);

  // 상태 (O열)
  var statusRule = SpreadsheetApp.newDataValidation()
    .requireValueInList(['등원예정', '재원', '실휴원', '가휴원', '퇴원'], true)
    .setAllowInvalid(false)
    .build();
  sheet.getRange(2, 15, lastRow, 1).setDataValidation(statusRule);

  // 날짜 형식 (시작일/종료일/휴원)
  var dateColumns = [12, 13, 16, 17];
  dateColumns.forEach(function(col) {
    sheet.getRange(2, col, lastRow, 1).setNumberFormat('yyyy-mm-dd');
  });

  sheet.setFrozenRows(1);

  return ss.getUrl();
}

// ---------------------------------------------------------------------------
// 가져오기: 현재 시트 데이터 → Firestore
// ---------------------------------------------------------------------------
function importFromSheet() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
  var data = sheet.getDataRange().getValues();
  if (data.length < 2) {
    SpreadsheetApp.getUi().alert('데이터가 없습니다. 2행부터 입력해주세요.');
    return;
  }

  var headers = data[0];
  var imported = 0;
  var errors = [];

  // 학생별 enrollment 그룹핑 (docId 기준)
  var studentMap = {};

  for (var i = 1; i < data.length; i++) {
    var row = data[i];
    var rowObj = {};
    for (var j = 0; j < headers.length; j++) {
      rowObj[headers[j]] = row[j] != null ? String(row[j]).trim() : '';
    }

    var name = rowObj['이름'];
    var parentPhone = rowObj['학부모연락처1'];
    if (!name || !parentPhone) continue;

    var classNumber = rowObj['반넘버'] || '';
    var branch = rowObj['소속'] || branchFromClassNumber(classNumber);
    var phone = parentPhone.replace(/\D/g, '');
    var docId = name + '_' + phone + '_' + branch;
    docId = docId.replace(/\s+/g, '_');

    // 요일 파싱
    var dayStr = rowObj['요일'] || '';
    var dayArr = dayStr.split(/[,\s]+/).filter(function(d) { return d; });

    var enrollment = {
      class_type: rowObj['수업종류'] || '정규',
      level_symbol: rowObj['레벨기호'] || '',
      class_number: classNumber,
      day: dayArr,
      start_date: formatDateValue(rowObj['시작일'])
    };
    var endDate = formatDateValue(rowObj['종료일']);
    if (endDate) enrollment.end_date = endDate;

    if (!studentMap[docId]) {
      studentMap[docId] = {
        name: name,
        level: rowObj['학부'] || '초등',
        school: rowObj['학교'] || '',
        grade: rowObj['학년'] || '',
        student_phone: rowObj['학생연락처'] || '',
        parent_phone_1: parentPhone,
        parent_phone_2: rowObj['학부모연락처2'] || '',
        branch: branch,
        status: rowObj['상태'] || '재원',
        pause_start_date: formatDateValue(rowObj['휴원시작일']),
        pause_end_date: formatDateValue(rowObj['휴원종료일']),
        enrollments: []
      };
    }
    studentMap[docId].enrollments.push(enrollment);
  }

  // Firestore에 저장
  var docIds = Object.keys(studentMap);
  for (var k = 0; k < docIds.length; k++) {
    var did = docIds[k];
    var student = studentMap[did];
    try {
      upsertDocument_('students', did, student);

      // history_logs 기록
      var enrollCodes = student.enrollments.map(function(e) {
        return (e.level_symbol || '') + (e.class_number || '');
      }).filter(function(c) { return c; }).join(', ');

      createDocument_('history_logs', {
        doc_id: did,
        change_type: 'UPDATE',
        before: '—',
        after: '시트 가져오기: ' + student.name + ' (상태:' + student.status + ', 반:' + enrollCodes + ')',
        google_login_id: Session.getActiveUser().getEmail() || 'system',
        timestamp: new Date().toISOString()
      });
      imported++;
    } catch (e) {
      errors.push(did + ': ' + e.message);
    }
  }

  var msg = imported + '명의 학생 정보를 Firestore에 저장했습니다.';
  if (errors.length > 0) {
    msg += '\n\n오류 (' + errors.length + '건):\n' + errors.slice(0, 5).join('\n');
  }
  SpreadsheetApp.getUi().alert(msg);
}

// ---------------------------------------------------------------------------
// 날짜 값 포맷 헬퍼 (Date 객체/문자열 → yyyy-MM-dd)
// ---------------------------------------------------------------------------
function formatDateValue(val) {
  if (!val) return '';
  if (val instanceof Date) {
    return Utilities.formatDate(val, 'Asia/Seoul', 'yyyy-MM-dd');
  }
  var str = String(val).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str;
  var d = new Date(str);
  if (!isNaN(d.getTime())) {
    return Utilities.formatDate(d, 'Asia/Seoul', 'yyyy-MM-dd');
  }
  return str;
}

// ---------------------------------------------------------------------------
// 매일 자동 백업: 스냅샷 시트 → 백업 폴더
// ---------------------------------------------------------------------------
function dailyBackup() {
  var docs = getAllDocuments_('students');

  var today = Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyy-MM-dd');
  var ss = SpreadsheetApp.create('impact7DB_백업_' + today);
  var sheet = ss.getActiveSheet();
  sheet.setName('백업_' + today);

  // 헤더
  sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
  sheet.getRange(1, 1, 1, HEADERS.length)
    .setFontWeight('bold')
    .setBackground('#fbbc04')
    .setFontColor('#000000');

  // 데이터
  var rows = studentsToRows(docs);
  if (rows.length > 0) {
    sheet.getRange(2, 1, rows.length, HEADERS.length).setValues(rows);
  }

  for (var i = 1; i <= HEADERS.length; i++) {
    sheet.autoResizeColumn(i);
  }

  sheet.setFrozenRows(1);

  // 백업 폴더로 이동
  var props = PropertiesService.getScriptProperties();
  var folderId = props.getProperty('BACKUP_FOLDER_ID');
  if (folderId) {
    var file = DriveApp.getFileById(ss.getId());
    var folder = DriveApp.getFolderById(folderId);
    folder.addFile(file);
    DriveApp.getRootFolder().removeFile(file);
  }

  // 오래된 백업 정리 (30일 이상: 월별 1개만 유지)
  cleanOldBackups(folderId);

  Logger.log('백업 완료: impact7DB_백업_' + today);
}

// ---------------------------------------------------------------------------
// 오래된 백업 정리 — 30일 이상 된 백업은 월별 1개만 유지
// ---------------------------------------------------------------------------
function cleanOldBackups(folderId) {
  if (!folderId) return;

  try {
    var folder = DriveApp.getFolderById(folderId);
    var files = folder.getFiles();
    var backups = [];

    while (files.hasNext()) {
      var file = files.next();
      var name = file.getName();
      var match = name.match(/^impact7DB_백업_(\d{4}-\d{2}-\d{2})$/);
      if (match) {
        backups.push({ file: file, date: match[1], month: match[1].substring(0, 7) });
      }
    }

    var cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 30);
    var cutoffStr = Utilities.formatDate(cutoff, 'Asia/Seoul', 'yyyy-MM-dd');

    var oldBackups = backups.filter(function(b) { return b.date < cutoffStr; });

    var monthGroups = {};
    oldBackups.forEach(function(b) {
      if (!monthGroups[b.month]) monthGroups[b.month] = [];
      monthGroups[b.month].push(b);
    });

    Object.keys(monthGroups).forEach(function(month) {
      var group = monthGroups[month];
      group.sort(function(a, b) { return b.date.localeCompare(a.date); });
      for (var i = 1; i < group.length; i++) {
        group[i].file.setTrashed(true);
        Logger.log('오래된 백업 삭제: ' + group[i].file.getName());
      }
    });
  } catch (e) {
    Logger.log('백업 정리 오류: ' + e.message);
  }
}

// ---------------------------------------------------------------------------
// 최초 1회: 매일 오전 6시 트리거 등록
// ---------------------------------------------------------------------------
function setupDailyTrigger() {
  var triggers = ScriptApp.getProjectTriggers();
  triggers.forEach(function(t) {
    if (t.getHandlerFunction() === 'dailyBackup') {
      ScriptApp.deleteTrigger(t);
    }
  });

  ScriptApp.newTrigger('dailyBackup')
    .timeBased()
    .atHour(6)
    .everyDays(1)
    .inTimezone('Asia/Seoul')
    .create();

  Logger.log('dailyBackup 트리거 등록 완료 (매일 오전 6시)');
}

// ---------------------------------------------------------------------------
// 시트 열 때: 커스텀 메뉴 추가 (템플릿 시트용)
// ---------------------------------------------------------------------------
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('impact7DB')
    .addItem('Firestore에 업로드', 'importFromSheet')
    .addToUi();
}

// ---------------------------------------------------------------------------
// Web App 진입점
// ---------------------------------------------------------------------------
function doGet(e) {
  var action = (e && e.parameter && e.parameter.action) || 'export';
  var url;

  if (action === 'template') {
    url = createImportTemplate();
  } else {
    url = exportToSheet();
  }

  return HtmlService.createHtmlOutput(
    '<html><head><script>window.top.location.href="' + url + '";</script></head>' +
    '<body>시트로 이동 중... <a href="' + url + '">여기를 클릭하세요</a></body></html>'
  );
}

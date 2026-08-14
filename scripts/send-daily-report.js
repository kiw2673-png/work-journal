// GitHub Actions용 CS업무일지 텔레그램 자동 전송 스크립트
// Node.js 18+ (native fetch) — npm 패키지 불필요
// 30분마다 실행되며 Firestore의 tgAutoTime을 읽어 시간 일치 시 전송
const PROJECT_ID = 'work-journal-99e5a';
const API_KEY = 'AIzaSyCETRrYLTEw-EqBfTm0cD6Sh5nc7kP6_oc';
const BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;

// Firestore REST 응답 → JS 객체 변환
function parseValue(v) {
  if (!v) return null;
  if ('stringValue'  in v) return v.stringValue;
  if ('integerValue' in v) return parseInt(v.integerValue, 10);
  if ('doubleValue'  in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('nullValue'    in v) return null;
  if ('arrayValue'   in v) return (v.arrayValue.values || []).map(parseValue);
  if ('mapValue'     in v) return parseFields(v.mapValue.fields || {});
  return null;
}
function parseFields(fields) {
  const obj = {};
  for (const [k, v] of Object.entries(fields || {})) obj[k] = parseValue(v);
  return obj;
}

// Firestore settings/config 조회
async function getSettings() {
  const res = await fetch(`${BASE}/settings/config?key=${API_KEY}`);
  if (!res.ok) throw new Error(`설정 조회 실패: ${res.status}`);
  const data = await res.json();
  return parseFields(data.fields);
}

// 마지막 자동전송 날짜 기록 (같은 날 중복 전송 방지)
async function markSent(dateStr) {
  const url = `${BASE}/settings/config?updateMask.fieldPaths=lastAutoSendDate&key=${API_KEY}`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: { lastAutoSendDate: { stringValue: dateStr } } })
  });
  if (!res.ok) console.error('lastAutoSendDate 기록 실패:', res.status);
}

// Firestore 컬렉션 전체 조회
async function listDocs(collection) {
  const url = `${BASE}/${collection}?key=${API_KEY}&pageSize=500`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Firestore ${collection} 조회 실패: ${res.status}`);
  const data = await res.json();
  return (data.documents || []).map(d => parseFields(d.fields));
}

// reports 컬렉션을 날짜로 필터 조회
async function queryReports(dateStr) {
  const url = `${BASE}:runQuery?key=${API_KEY}`;
  const body = JSON.stringify({
    structuredQuery: {
      from: [{ collectionId: 'reports' }],
      where: {
        fieldFilter: {
          field: { fieldPath: 'date' },
          op: 'EQUAL',
          value: { stringValue: dateStr }
        }
      }
    }
  });
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
  if (!res.ok) throw new Error(`Firestore reports 쿼리 실패: ${res.status}`);
  const rows = await res.json();
  return (Array.isArray(rows) ? rows : [rows])
    .filter(r => r.document)
    .map(r => parseFields(r.document.fields));
}

// buildDailyText — index.html의 동일 함수 이식
async function buildDailyText(dateStr) {
  const [entries, allUsers, allSchedules] = await Promise.all([
    queryReports(dateStr),
    listDocs('users'),
    listDocs('schedules')
  ]);

  entries.sort((a, b) => (a.branch || '').localeCompare(b.branch || ''));
  if (!entries.length) return null;

  const activeUsers = allUsers.filter(u => u.name && u.empId && u.branch !== 'CS본부' && u.status !== '무' && u.status !== '퇴사');
  const SC_ABSENT = ['연차', '반차(오전)', '반차(오후)', '출장', '교육', 'B/S현장지원'];
  const absentMap = {};
  allSchedules.forEach(s => { if (s.startDate <= dateStr && s.endDate >= dateStr) absentMap[s.empId] = s.type || '기타'; });
  const submittedIds = new Set(entries.map(e => e.empId));
  const notSubmitted = activeUsers
    .filter(u => !submittedIds.has(u.empId) && !absentMap[u.empId])
    .sort((a, b) => (a.branch || '').localeCompare(b.branch || ''));
  const onLeave = activeUsers
    .filter(u => !submittedIds.has(u.empId) && absentMap[u.empId])
    .sort((a, b) => (a.branch || '').localeCompare(b.branch || ''));

  const dObj = new Date(dateStr + 'T00:00:00');
  const wd = ['일','월','화','수','목','금','토'][dObj.getDay()];
  const dtLabel = `${dObj.getFullYear()}년 ${String(dObj.getMonth()+1).padStart(2,'0')}월 ${String(dObj.getDate()).padStart(2,'0')}일 (${wd})`;

  const grouped = {};
  entries.forEach(e => { if (!grouped[e.branch]) grouped[e.branch] = []; grouped[e.branch].push(e); });

  const hasCase = c => c.model || c.symptom || c.note || c.prevAs || c.custResp || c.diag;
  let totalCases = 0;
  entries.forEach(e => { totalCases += (e.cases || []).filter(hasCase).length; });

  let txt = '━━━━━━━━━━━━━━━━━━\n📋 CS업무일지 일일보고\n📅 ' + dtLabel + '\n━━━━━━━━━━━━━━━━━━\n';
  txt += '📊 제출 ' + entries.length + '명 · 미제출 ' + notSubmitted.length + '명' + (onLeave.length ? ' · 휴가 ' + onLeave.length + '명' : '') + ' · 현장지원 ' + totalCases + '건\n';

  for (const [branch, list] of Object.entries(grouped)) {
    const brCases = list.reduce((s, e) => s + (e.cases || []).filter(hasCase).length, 0);
    txt += '\n━━━ 🏢 ' + branch + ' (' + list.length + '명, ' + brCases + '건) ━━━\n';
    list.forEach(e => {
      const fc = (e.cases || []).filter(hasCase);
      txt += '👤 ' + e.name + '\n';
      fc.forEach(c => {
        const parts = [c.model, c.capacity, c.category].filter(Boolean).join(' ');
        txt += '  • ' + (parts || '현장지원') + (c.symptom ? ' / ' + c.symptom : '') + (c.action ? ' → ' + c.action : '') + '\n';
        if (c.prevAs) txt += '    [이전AS] ' + c.prevAs.trim().split('\n').join(' ') + '\n';
        if (c.custResp) txt += '    [고객반응] ' + c.custResp.trim().split('\n').join(' ') + '\n';
        if (c.diag) txt += '    [초기진단] ' + c.diag.trim().split('\n').join(' ') + '\n';
        if (c.note) txt += c.note.trim().split('\n').map(l => '    ' + l).join('\n') + '\n';
      });
      if (e.field2 && e.field2.trim()) txt += '  💬 ' + e.field2.trim().slice(0, 120) + '\n';
      if (e.field3 && e.field3.trim()) txt += '  📢 [VOC] ' + e.field3.trim().slice(0, 120) + '\n';
    });
  }

  if (notSubmitted.length) {
    txt += '\n━━━ 🚨 미제출 (' + notSubmitted.length + '명) ━━━\n';
    const grpNS = {};
    notSubmitted.forEach(u => { if (!grpNS[u.branch]) grpNS[u.branch] = []; grpNS[u.branch].push(u.name); });
    for (const [br, names] of Object.entries(grpNS)) txt += '🏢 ' + br + ': ' + names.join(', ') + '\n';
  }

  if (onLeave.length) {
    txt += '\n━━━ 📅 휴가/반차 (' + onLeave.length + '명) ━━━\n';
    const grpOL = {};
    onLeave.forEach(u => { if (!grpOL[u.branch]) grpOL[u.branch] = []; grpOL[u.branch].push(u.name + '(' + absentMap[u.empId] + ')'); });
    for (const [br, names] of Object.entries(grpOL)) txt += '🏢 ' + br + ': ' + names.join(', ') + '\n';
  }

  txt += '\n━━━━━━━━━━━━━━━━━━\n대성쎌틱에너시스(주) CS업무일지';
  return txt;
}

// 텔레그램 4000자 청크 분할 전송
async function sendTg(token, chatId, text) {
  for (let i = 0; i < text.length; i += 4000) {
    const chunk = text.slice(i, i + 4000);
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: chunk })
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error('Telegram 오류: ' + (err.description || res.status));
    }
  }
}

async function main() {
  const settings = await getSettings();

  // GitHub Secrets 우선, 없으면 Firestore 설정 사용
  const token  = process.env.TG_BOT_TOKEN || settings.tgBotToken || '';
  const chatId = process.env.TG_CHAT_ID   || settings.tgChatId   || '';
  const autoTime = settings.tgAutoTime || '21:00';

  if (!token || !chatId) {
    console.error('텔레그램 봇 토큰 또는 채팅 ID 없음');
    process.exit(1);
  }

  // KST (UTC+9) 기준 현재 시간
  const now = new Date();
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const kstH = kst.getUTCHours();
  const kstM = kst.getUTCMinutes();
  const dateStr = kst.toISOString().slice(0, 10);

  // GitHub Actions cron은 정확한 분 단위로 실행되지 않으므로 목표시각 이후 2시간 윈도우로 체크,
  // 중복 전송은 lastAutoSendDate로 방지
  const isManual = process.env.MANUAL_RUN === 'true';
  if (!isManual) {
    if (settings.lastAutoSendDate === dateStr) {
      console.log(`오늘(${dateStr}) 이미 자동전송 완료됨, 스킵`);
      return;
    }
    const [targetH, targetM] = autoTime.split(':').map(Number);
    const nowMin = kstH * 60 + kstM;
    const targetMin = targetH * 60 + targetM;
    if (nowMin < targetMin || nowMin >= targetMin + 120) {
      console.log(`현재 KST ${String(kstH).padStart(2,'0')}:${String(kstM).padStart(2,'0')} — 전송 시간(${autoTime}) 대상 구간 아님, 스킵`);
      return;
    }
  }

  console.log(`전송 시작 — 날짜: ${dateStr}, 설정 시간: ${autoTime}`);

  const txt = await buildDailyText(dateStr);
  if (!txt) { console.log('오늘 제출된 보고서 없음'); return; }

  await sendTg(token, chatId, txt);
  if (!isManual) await markSent(dateStr);
  console.log('전송 완료!');
}

main().catch(e => { console.error(e.message); process.exit(1); });

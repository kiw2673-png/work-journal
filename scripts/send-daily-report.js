// GitHub Actions용 CS업무일지 텔레그램 자동 전송 스크립트
// Node.js 18+ (native fetch) — npm 패키지 불필요
const PROJECT_ID = 'work-journal-99e5a';
const API_KEY = 'AIzaSyCETRrYLTEw-EqBfTm0cD6Sh5nc7kP6_oc';
const BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;

const TG_TOKEN = process.env.TG_BOT_TOKEN;
const TG_CHAT  = process.env.TG_CHAT_ID;

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

// Firestore 컬렉션 전체 조회
async function listDocs(collection) {
  const url = `${BASE}/${collection}?key=${API_KEY}&pageSize=500`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Firestore ${collection} 조회 실패: ${res.status} ${await res.text()}`);
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
  if (!res.ok) throw new Error(`Firestore reports 쿼리 실패: ${res.status} ${await res.text()}`);
  const rows = await res.json();
  return (Array.isArray(rows) ? rows : [rows])
    .filter(r => r.document)
    .map(r => parseFields(r.document.fields));
}

// buildDailyText — index.html의 동일 함수 이식
async function buildDailyText(dateStr) {
  const [entries, allUsers] = await Promise.all([
    queryReports(dateStr),
    listDocs('users')
  ]);

  entries.sort((a, b) => (a.branch || '').localeCompare(b.branch || ''));
  if (!entries.length) return null;

  const activeUsers = allUsers.filter(u => u.name && u.empId && u.branch !== 'CS본부' && u.status === '유');
  const submittedIds = new Set(entries.map(e => e.empId));
  const notSubmitted = activeUsers
    .filter(u => !submittedIds.has(u.empId))
    .sort((a, b) => (a.branch || '').localeCompare(b.branch || ''));

  const dObj = new Date(dateStr + 'T00:00:00');
  const wd = ['일','월','화','수','목','금','토'][dObj.getDay()];
  const dtLabel = `${dObj.getFullYear()}년 ${String(dObj.getMonth()+1).padStart(2,'0')}월 ${String(dObj.getDate()).padStart(2,'0')}일 (${wd})`;

  const grouped = {};
  entries.forEach(e => { if (!grouped[e.branch]) grouped[e.branch] = []; grouped[e.branch].push(e); });

  let totalCases = 0;
  entries.forEach(e => { totalCases += (e.cases || []).filter(c => c.model || c.symptom || c.note).length; });

  let txt = '━━━━━━━━━━━━━━━━━━\n📋 CS업무일지 일일보고\n📅 ' + dtLabel + '\n━━━━━━━━━━━━━━━━━━\n';
  txt += '📊 제출 ' + entries.length + '명 · 미제출 ' + notSubmitted.length + '명 · 현장지원 ' + totalCases + '건\n';

  for (const [branch, list] of Object.entries(grouped)) {
    const brCases = list.reduce((s, e) => s + (e.cases || []).filter(c => c.model || c.symptom || c.note).length, 0);
    txt += '\n━━━ 🏢 ' + branch + ' (' + list.length + '명, ' + brCases + '건) ━━━\n';
    list.forEach(e => {
      const fc = (e.cases || []).filter(c => c.model || c.symptom || c.note);
      txt += '👤 ' + e.name + '\n';
      fc.forEach(c => {
        const parts = [c.model, c.capacity, c.category].filter(Boolean).join(' ');
        txt += '  • ' + (parts || '현장지원') + (c.symptom ? ' \\ ' + c.symptom : '') + (c.action ? ' → ' + c.action : '') + '\n';
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
  if (!TG_TOKEN || !TG_CHAT) {
    console.error('환경변수 TG_BOT_TOKEN, TG_CHAT_ID 가 설정되지 않았습니다.');
    process.exit(1);
  }

  // KST (UTC+9) 기준 오늘 날짜
  const now = new Date();
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const dateStr = kst.toISOString().slice(0, 10);

  console.log('날짜:', dateStr);
  const txt = await buildDailyText(dateStr);
  if (!txt) { console.log('오늘 제출된 보고서 없음'); return; }

  await sendTg(TG_TOKEN, TG_CHAT, txt);
  console.log('전송 완료!');
}

main().catch(e => { console.error(e.message); process.exit(1); });

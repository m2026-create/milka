/* ============================================================
   app.js  -  앱의 흐름을 담당하는 파일
   ------------------------------------------------------------
   전체 흐름
   [이름 고르기] -> [사진 찍기] -> [판별 중] -> [결과] -> [내 기록]

   판별 방법 (중요!)
   학생이 먼저 자기 이름을 고르기 때문에, 모델에게
   "25명 중 누구야?" 를 묻는 게 아니라
   "이게 김하준 글씨 맞아?" 를 확인하는 방식입니다.
   이렇게 하면 정확도가 훨씬 높아집니다.
   ============================================================ */

/* ---------- 앱이 기억하는 것들 ---------- */
let state = loadState();      // 설정 + 기록
let model = null;             // 티처블 머신 모델
let modelLabels = [];         // 모델이 가진 클래스 이름들
let stream = null;            // 카메라 영상
let current = null;           // 지금 사진 찍는 학생
let busy = false;             // 판별 중 중복 클릭 막기
let lastOk = false;           // 마지막 결과가 성공이었는지

/* ---------- 자주 쓰는 짧은 함수 ---------- */
const $ = (id) => document.getElementById(id);
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

/* 화면 바꾸기 */
function show(screenId) {
  document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active'));
  $(screenId).classList.add('active');
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

/* =============================================================
   1. 시작하기
   ============================================================= */
function init() {
  $('classLabel').textContent = state.config.className;
  renderRoster();
  bindEvents();

  // 모델 주소가 있으면 미리 불러오기 (학생이 기다리지 않게)
  if (state.config.modelURL) {
    loadModel(state.config.modelURL).catch((e) => {
      console.error(e);
      $('modelWarn').classList.remove('hidden');
      $('modelWarn').innerHTML =
        '⚠️ 모델을 불러오지 못했어요.<br>모델 주소를 다시 확인해 주세요.';
    });
  } else {
    $('modelWarn').classList.remove('hidden');
  }
}

/* =============================================================
   2. 티처블 머신 모델 불러오기
   ============================================================= */
async function loadModel(baseURL) {
  // 주소 끝에 / 가 없으면 붙여줌
  const url = baseURL.endsWith('/') ? baseURL : baseURL + '/';
  model = await tmImage.load(url + 'model.json', url + 'metadata.json');
  modelLabels = model.getClassLabels();
  console.log('모델 클래스:', modelLabels);
  return modelLabels;
}

/* =============================================================
   3. 학생 카드 그리기
   ============================================================= */
function renderRoster() {
  const box = $('roster');
  box.innerHTML = '';

  state.config.roster.forEach((student) => {
    const rec = getRecord(state, student.name);
    const done = doneToday(rec);

    const card = document.createElement('button');
    card.className = 'card' + (done ? ' done' : '');
    card.innerHTML = `
      <span class="face">${student.emoji || '🥛'}</span>
      <span class="nm">${student.name}</span>
      <span class="mini">${rec.streak}일 연속</span>
      ${rec.coupons - rec.couponsUsed > 0
        ? `<span class="cp">🎟️${rec.coupons - rec.couponsUsed}</span>` : ''}
    `;
    // 이미 먹은 학생은 바로 '내 기록' 화면으로
    card.onclick = () => (done ? openMy(student) : startCamera(student));
    box.appendChild(card);
  });
}

/* =============================================================
   4. 카메라 켜기
   ============================================================= */
async function startCamera(student) {
  if (!model) {
    alert('아직 준비가 안 됐어요. 선생님께 알려주세요!');
    return;
  }
  current = student;
  $('camName').textContent = student.name;
  $('camHint').textContent = '';
  show('screen-camera');

  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: 'environment',   // 뒷면 카메라 우선 (우유갑 찍기 편하게)
        width: { ideal: 1280 },
        height: { ideal: 960 },
      },
      audio: false,
    });
    $('video').srcObject = stream;
  } catch (e) {
    console.error(e);
    $('camHint').innerHTML =
      '카메라를 켤 수 없어요.<br>브라우저에서 카메라 사용을 <b>허용</b>해 주세요.';
  }
}

/* 카메라 끄기 (안 끄면 불이 계속 켜져 있어요) */
function stopCamera() {
  if (stream) {
    stream.getTracks().forEach((t) => t.stop());
    stream = null;
  }
  $('video').srcObject = null;
}

/* =============================================================
   5. 사진 찍고 판별하기 - 이 앱의 가장 중요한 부분
   ============================================================= */
async function shoot() {
  if (busy || !current || !model) return;
  busy = true;
  $('btnShoot').disabled = true;

  // 찰칵 효과
  $('camFlash').classList.add('on');
  setTimeout(() => $('camFlash').classList.remove('on'), 450);

  // (1) 영상의 한 장면을 캔버스에 정사각형으로 그리기
  //     티처블 머신 모델은 224x224 정사각형 사진으로 학습하므로
  //     가운데를 정사각형으로 잘라서 넣어줍니다.
  const video = $('video');
  const canvas = $('canvas');
  const size = 224;
  canvas.width = size;
  canvas.height = size;

  const vw = video.videoWidth || 640;
  const vh = video.videoHeight || 480;
  const side = Math.min(vw, vh);                 // 짧은 쪽 기준
  const sx = (vw - side) / 2;                    // 가운데 자르기
  const sy = (vh - side) / 2;
  canvas.getContext('2d').drawImage(video, sx, sy, side, side, 0, 0, size, size);

  // 화면에 '판별 중' 보여주기
  show('screen-checking');

  // (2) 모델에게 물어보기
  let predictions;
  try {
    predictions = await model.predict(canvas);
  } catch (e) {
    console.error(e);
    busy = false;
    $('btnShoot').disabled = false;
    showResult({ ok: false, reason: 'error' });
    return;
  }

  // (3) 확률이 높은 순서로 정렬
  predictions.sort((a, b) => b.probability - a.probability);
  const top1 = predictions[0];
  const top2 = predictions[1] || { probability: 0 };

  // (4) 통과 조건 3가지를 모두 만족해야 성공
  const cfg = state.config;
  const myLabel = current.label || current.name;

  const isMine   = top1.className === myLabel;                        // 1위가 내 이름인가
  const confOk   = top1.probability >= cfg.confidenceMin;             // 충분히 확신하는가
  const marginOk = (top1.probability - top2.probability) >= cfg.marginMin; // 2위와 차이가 큰가
  const ok = isMine && confOk && marginOk;

  // (5) 실패한 이유를 구분해 두면 안내 문구를 맞춤으로 띄울 수 있습니다
  let reason = 'pass';
  if (!isMine) reason = 'other';          // 다른 사람 글씨로 보임
  else if (!confOk) reason = 'lowconf';   // 흐릿함 / 잘 안 보임
  else if (!marginOk) reason = 'unsure';  // 헷갈림

  stopCamera();

  // (6) 기록 남기기
  const practice = $('practiceMode').checked;
  const info = {
    ok, reason,
    name: current.name,
    top1: top1.className,
    p1: Number(top1.probability.toFixed(4)),
    p2: Number(top2.probability.toFixed(4)),
    practice,
  };

  if (cfg.savePhoto && ok && !practice) {
    info.photo = canvas.toDataURL('image/jpeg', 0.5);   // 용량 줄여 저장
  }

  let streakInfo = null;
  if (!practice) {
    appendLog(state, info);                              // 모든 시도 기록
    if (ok) {
      const rec = getRecord(state, current.name);
      const res = addSuccess(rec, todayStr(), cfg);
      state.records[current.name] = res.rec;
      streakInfo = res;
    }
    saveState(state);
  }

  busy = false;
  $('btnShoot').disabled = false;
  showResult({ ...info, streakInfo, practice });
}

/* =============================================================
   6. 결과 보여주기
   ============================================================= */
function showResult(info) {
  lastOk = !!info.ok;
  const card = $('resultCard');
  const cfg = state.config;
  $('couponPop').classList.add('hidden');

  if (info.ok) {
    /* ----- 성공! ----- */
    card.classList.remove('fail');
    $('resultEmoji').textContent = pick(['🎉', '🥳', '✨', '🌟', '🥛']);
    $('resultTitle').textContent = `${info.name} 확인 완료!`;
    $('resultMsg').textContent = info.practice
      ? '연습 모드예요. 기록에는 남지 않아요!'
      : pick(PRAISE);

    const rec = getRecord(state, info.name);
    drawStamps(rec);

    if (info.practice) {
      $('streakLine').textContent = '연습이라 도장은 안 찍었어요';
    } else if (info.streakInfo && info.streakInfo.status === 'already') {
      $('streakLine').textContent = '오늘은 이미 먹었어요! 😊';
    } else {
      const { left } = stampProgress(rec, cfg);
      $('streakLine').textContent =
        `${rec.streak}일 연속! ` +
        (left > 0 ? `쿠폰까지 ${left}개 남았어요` : '도장판을 다 채웠어요!');
    }

    // 쿠폰을 받았으면 크게 축하
    if (info.streakInfo && info.streakInfo.newCoupon) {
      $('couponPop').classList.remove('hidden');
      $('couponWhy').textContent = `${rec.streak}일 연속 성공 보상`;
      rain(60);
    } else if (!info.practice) {
      rain(26);
    }

    $('btnRetry').classList.add('hidden');
  } else {
    /* ----- 다시 찍기 ----- */
    card.classList.add('fail');
    $('resultEmoji').textContent = '🤔';
    $('resultTitle').textContent = '다시 한 번!';

    const guide = {
      other:   '음… 다른 친구 글씨 같아요. 내 우유갑인지 확인해 주세요!',
      lowconf: '글씨가 잘 안 보여요. 밝은 곳에서 가까이 찍어주세요!',
      unsure:  '조금 헷갈려요. 이름이 잘 보이게 똑바로 맞춰주세요!',
      error:   '앗, 문제가 생겼어요. 선생님께 알려주세요!',
    };
    $('resultMsg').textContent = guide[info.reason] || pick(RETRY_MSG);

    $('stampboard').innerHTML = '';
    $('streakLine').textContent = '';
    $('btnRetry').classList.remove('hidden');
  }

  show('screen-result');
}

/* 도장판 그리기 */
function drawStamps(rec) {
  const { filled, goal } = stampProgress(rec, state.config);
  const box = $('stampboard');
  box.innerHTML = '';
  for (let i = 0; i < goal; i++) {
    const s = document.createElement('div');
    s.className = 'stamp' + (i < filled ? ' on' : '');
    s.textContent = i < filled ? '🥛' : i + 1;
    box.appendChild(s);
  }
}

/* 색종이 뿌리기 */
function rain(count) {
  const box = $('confetti');
  const emojis = ['🥛', '⭐', '🎉', '💛', '🐄', '✨'];
  for (let i = 0; i < count; i++) {
    const p = document.createElement('span');
    p.className = 'piece';
    p.textContent = pick(emojis);
    p.style.left = Math.random() * 100 + '%';
    p.style.animationDuration = 2.2 + Math.random() * 1.8 + 's';
    p.style.animationDelay = Math.random() * 0.5 + 's';
    box.appendChild(p);
    setTimeout(() => p.remove(), 4600);
  }
}

/* =============================================================
   7. 내 기록 화면
   ============================================================= */
function openMy(student) {
  current = student;
  const rec = getRecord(state, student.name);

  $('myEmoji').textContent = student.emoji || '🥛';
  $('myName').textContent = student.name;
  $('statStreak').textContent = rec.streak;
  $('statBest').textContent = rec.best;
  $('statTotal').textContent = rec.dates.length;
  $('statCoupon').textContent = rec.coupons - rec.couponsUsed;

  drawCalendar(rec);
  show('screen-my');
}

/* 이번 달 달력에 우유 도장 찍기 */
function drawCalendar(rec) {
  const box = $('calendar');
  box.innerHTML = '';

  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth();
  const today = todayStr();

  // 요일 머리글
  ['일', '월', '화', '수', '목', '금', '토'].forEach((d, i) => {
    const h = document.createElement('div');
    h.className = 'cal-head' + (i === 0 ? ' sun' : i === 6 ? ' sat' : '');
    h.textContent = d;
    box.appendChild(h);
  });

  // 1일 앞의 빈 칸
  const firstDow = new Date(year, month, 1).getDay();
  for (let i = 0; i < firstDow; i++) {
    const e = document.createElement('div');
    e.className = 'cal-cell empty';
    box.appendChild(e);
  }

  // 날짜 칸
  const lastDate = new Date(year, month + 1, 0).getDate();
  for (let d = 1; d <= lastDate; d++) {
    const ds = toDateStr(new Date(year, month, d));
    const cell = document.createElement('div');
    cell.className = 'cal-cell'
      + (rec.dates.includes(ds) ? ' on' : '')
      + (ds === today ? ' today' : '');
    cell.textContent = d;
    box.appendChild(cell);
  }
}

/* =============================================================
   8. 선생님 화면
   ============================================================= */
function openTeacher() {
  const pin = prompt('선생님 비밀번호를 입력하세요');
  if (pin === null) return;
  if (pin !== String(state.config.teacherPin)) {
    alert('비밀번호가 달라요!');
    return;
  }

  const c = state.config;
  $('cfgClassName').value = c.className;
  $('cfgModelURL').value = c.modelURL;
  $('cfgConf').value = c.confidenceMin;
  $('cfgMargin').value = c.marginMin;
  $('cfgGoal').value = c.streakGoal;
  $('cfgSkipWeekend').checked = c.skipWeekend;
  $('cfgSavePhoto').checked = c.savePhoto;
  $('cfgHolidays').value = (c.holidays || []).join('\n');
  $('cfgRoster').value = c.roster
    .map((s) => `${s.name}, ${s.label || s.name}, ${s.emoji || '🥛'}`)
    .join('\n');
  $('modelTestResult').textContent = '';

  renderTeacherTable();
  show('screen-teacher');
}

/* 설정 저장 */
function saveConfig() {
  const c = state.config;

  c.className = $('cfgClassName').value.trim() || '우리 반';
  c.modelURL = $('cfgModelURL').value.trim();
  c.confidenceMin = Math.min(0.99, Math.max(0.3, Number($('cfgConf').value) || 0.8));
  c.marginMin = Math.min(0.9, Math.max(0, Number($('cfgMargin').value) || 0));
  c.streakGoal = Math.max(2, parseInt($('cfgGoal').value, 10) || 5);
  c.skipWeekend = $('cfgSkipWeekend').checked;
  c.savePhoto = $('cfgSavePhoto').checked;

  c.holidays = $('cfgHolidays').value
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => /^\d{4}-\d{2}-\d{2}$/.test(s));

  // '이름, 클래스명, 이모지' 한 줄씩 읽기
  const roster = $('cfgRoster').value
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [name, label, emoji] = line.split(',').map((x) => (x || '').trim());
      return { name, label: label || name, emoji: emoji || '🥛' };
    })
    .filter((s) => s.name);

  if (roster.length === 0) {
    alert('명단이 비어 있어요! 한 명 이상 적어주세요.');
    return;
  }
  c.roster = roster;

  saveState(state);
  $('classLabel').textContent = c.className;
  renderRoster();

  // 모델 주소가 바뀌었으면 다시 불러오기
  if (c.modelURL) {
    loadModel(c.modelURL)
      .then(() => {
        $('modelWarn').classList.add('hidden');
        alert('저장했어요! 모델도 잘 연결됐습니다. 👍');
        show('screen-home');
      })
      .catch(() => {
        alert('저장은 됐지만 모델 주소를 확인해 주세요.');
      });
  } else {
    alert('저장했어요!');
    show('screen-home');
  }
}

/* 모델 연결 확인 버튼 */
async function testModel() {
  const url = $('cfgModelURL').value.trim();
  const out = $('modelTestResult');
  if (!url) { out.textContent = '주소를 먼저 넣어주세요.'; return; }

  out.textContent = '확인 중…';
  try {
    const labels = await loadModel(url);
    // 명단에 적힌 클래스명이 모델에 다 있는지 검사 -> 흔한 실수를 잡아줍니다
    const missing = state.config.roster
      .map((s) => s.label || s.name)
      .filter((l) => !labels.includes(l));

    out.innerHTML =
      `✅ 연결 성공! 클래스 ${labels.length}개<br>` +
      `<small>${labels.join(' / ')}</small>` +
      (missing.length
        ? `<br>⚠️ 명단에 있는데 모델에 없는 클래스: <b>${missing.join(', ')}</b>`
        : '<br>명단과 모델 클래스가 모두 일치합니다 👍');
  } catch (e) {
    // 흔한 실수를 짚어서 알려줍니다
    const local = !/^https?:\/\//i.test(url);
    out.innerHTML =
      '❌ 모델을 불러오지 못했어요.<br>' +
      (local
        ? '<small>· <b>' + url + '</b> 폴더 안에 <b>model.json · weights.bin · metadata.json</b> ' +
          '3개가 모두 있는지 확인하세요<br>' +
          '· zip 안에 폴더가 한 겹 더 있는 경우가 많아요 (model/model/model.json ❌)<br>' +
          '· <b>.tm 파일</b>은 쓸 수 없어요. [모델 내보내기 → Tensorflow.js → 다운로드]로 받으세요</small>'
        : '<small>· 주소 끝에 <b>/</b> 가 있는지 확인하세요<br>' +
          '· 티처블 머신에서 <b>업로드</b> 버튼까지 눌렀는지 확인하세요</small>') +
      '<br><small style="opacity:.6">' + e.message + '</small>';
  }
}

/* 선생님용 현황표 */
function renderTeacherTable() {
  const box = $('teacherTable');
  box.innerHTML = '';

  state.config.roster.forEach((s) => {
    const rec = getRecord(state, s.name);
    const left = rec.coupons - rec.couponsUsed;

    const row = document.createElement('div');
    row.className = 'trow';
    row.innerHTML = `
      <span>${s.emoji || '🥛'}</span>
      <span class="t-name">${s.name}${doneToday(rec) ? ' ✅' : ''}</span>
      <span class="t-num">${rec.streak}연속 / 총${rec.dates.length}</span>
      <span class="t-cp">🎟️ ${left}</span>
    `;

    // 쿠폰 사용 처리 버튼
    const useBtn = document.createElement('button');
    useBtn.textContent = '사용';
    useBtn.disabled = left <= 0;
    useBtn.onclick = () => {
      if (!confirm(`${s.name} 쿠폰 1장을 사용 처리할까요?`)) return;
      rec.couponsUsed += 1;
      saveState(state);
      renderTeacherTable();
      renderRoster();
    };
    row.appendChild(useBtn);

    // 오늘 수동 인정 (모델이 계속 못 맞힐 때 대비)
    const okBtn = document.createElement('button');
    okBtn.textContent = '오늘인정';
    okBtn.disabled = doneToday(rec);
    okBtn.onclick = () => {
      if (!confirm(`${s.name}의 오늘 우유를 선생님이 직접 인정할까요?`)) return;
      const res = addSuccess(rec, todayStr(), state.config);
      state.records[s.name] = res.rec;
      appendLog(state, { ok: true, reason: 'manual', name: s.name, top1: '(수동)', p1: 1, p2: 0 });
      saveState(state);
      renderTeacherTable();
      renderRoster();
    };
    row.appendChild(okBtn);

    box.appendChild(row);
  });
}

/* 기록 불러오기 (백업 파일에서) */
function importFile(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result);
      if (!data.records) throw new Error('기록이 없는 파일이에요');
      if (!confirm('지금 기록을 덮어씁니다. 계속할까요?')) return;

      state = {
        version: 1,
        config: { ...DEFAULT_CONFIG, ...(data.config || {}) },
        records: data.records,
        log: data.log || [],
      };
      saveState(state);
      alert('불러왔어요!');
      location.reload();
    } catch (e) {
      alert('파일을 읽지 못했어요: ' + e.message);
    }
  };
  reader.readAsText(file);
}

/* =============================================================
   9. 버튼 연결
   ============================================================= */
function bindEvents() {
  $('btnTeacher').onclick = openTeacher;

  $('btnShoot').onclick = shoot;
  $('btnBackHome').onclick = () => { stopCamera(); renderRoster(); show('screen-home'); };

  $('btnRetry').onclick = () => startCamera(current);
  $('btnDone').onclick = () => {
    renderRoster();
    // 성공했으면 자기 기록(도장판)을 보여주고, 실패했으면 처음 화면으로
    if (lastOk && current) openMy(current); else show('screen-home');
  };

  $('btnMyBack').onclick = () => { renderRoster(); show('screen-home'); };

  $('btnSaveCfg').onclick = saveConfig;
  $('btnTestModel').onclick = testModel;
  $('btnUseFolder').onclick = () => {
    $('cfgModelURL').value = 'model/';
    testModel();
  };
  $('btnTeacherBack').onclick = () => { renderRoster(); show('screen-home'); };

  $('btnExport').onclick = () => exportState(state);
  $('btnImport').onclick = () => $('fileImport').click();
  $('fileImport').onchange = (e) => { if (e.target.files[0]) importFile(e.target.files[0]); };

  $('btnReset').onclick = () => {
    if (!confirm('모든 기록이 사라집니다. 정말 초기화할까요?')) return;
    if (!confirm('되돌릴 수 없어요. 내보내기로 백업했나요?')) return;
    localStorage.removeItem(STORAGE_KEY);
    location.reload();
  };

  // 다른 화면으로 갈 때 카메라가 켜져 있으면 끄기
  window.addEventListener('pagehide', stopCamera);
}

/* ---------- 출발! ---------- */
init();

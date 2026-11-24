// 우정 사진관 카메라: 아이패드 카메라 영상을 화면 가운데 16:9 칸에 꽉 채워 보여 준다.
// 맥(친구사랑 우정 사진관)은 케이블로 이 화면을 받아 가운데 16:9만 잘라 카메라로 쓴다.
// 이 페이지는 영상을 어디에도 보내지 않는다.
//
// 위쪽 검은 띠 오른쪽의 흰 네모 줄은 사진관 도우미가 '카메라 페이지가 제자리에 떠 있다'고 알아보는 표시다.
// 사진관 tools/ipad-camera.swift와 같은 약속(표시 4판)이어야 한다. 가로를 W라 하면
//   표시: 한 변 0.02W 칸 열다섯 개, i번째 칸 가운데 x = W × (0.555 + 0.03 i)
//         1 0 1 1 0 1(맞춤) + g 네 자리 + s 네 자리(큰 자리부터) + 1의 개수를 홀수로 맞추는 한 칸
//   영상 칸: 가로 W × (1 − 0.01 s), 가운데 정렬, 높이 = 가로 × 9/16, 위 끝 = 표시 줄 가운데 + W × (0.02 + 0.004 g)
// 도우미가 표시 줄을 화면 위쪽에서 찾고 g, s를 읽으므로 배치는 이 페이지만 고치면 된다.
//
// 2026-11-24 iPad mini 6 웹 앱에서 확인한 것: 페이지는 화면 맨 위부터 그려지지만 아래 약 30pt는 페이지 밖이다.
// 맨 위 시계 줄 높이는 아이패드가 어둡게 덮어 흰 네모가 회색이 된다. 사파리 전체 화면과 웹 앱에서 왼쪽 위에
// X 단추가 보일 때가 있다(위에서 약 78pt). 그래서 표시는 시계 줄 아래에, 영상 칸은 X 단추 아래에 두고,
// 영상 칸이 페이지 아래 끝에 들어가지 않으면 가로를 1%씩 줄인다.
// 홈 화면에 추가한 웹 앱으로 열었을 때만 표시를 켠다(사파리 전체 화면은 X 단추가 늘 남는다).
const SYNC_BITS = [1, 0, 1, 1, 0, 1];
const TOP_DIM = 52; // 맨 위에서 어둡게 덮이는 높이(CSS px): 표시를 이보다 아래에 둔다
const CORNER_CLEAR = 84; // 영상 칸 위 끝의 최소 높이(CSS px): 왼쪽 위 X 단추 아래 끝 + 여유
const BOTTOM_GAP = 4; // 영상 칸 아래 여유(CSS px). 홈 막대가 페이지 안에 있으면 그 높이(안전 여백)만큼 더 비운다.
const bitsOf = (n) => [8, 4, 2, 1].map((b) => (n & b ? 1 : 0));
const FACING_LABEL = { environment: '뒤 카메라', user: '앞 카메라' };

const $ = (s) => document.querySelector(s);
const video = $('#video');
const prefs = { facing: localStorage.getItem('friendship-cam.facing') === 'user' ? 'user' : 'environment' };

let stream = null;
let running = false;
let starting = false;
let cameraError = null;
let wakeLock = null;

const webApp = () => navigator.standalone === true || matchMedia('(display-mode: standalone)').matches || matchMedia('(display-mode: fullscreen)').matches;

// ---------- 화면 ----------
// 영상 칸, 띠, 흰 네모 자리를 지금 화면 크기에 맞춘다.
// landscape: 가로로 놓였는지, fits: 띠와 표시가 약속대로 들어가는지.
function layout() {
  const W = window.innerWidth;
  const H = window.innerHeight;
  const size = W * 0.02;
  const insetBottom = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--sab')) || 0;
  const bottom = H - Math.max(BOTTOM_GAP, insetBottom);
  const row = TOP_DIM + size / 2;
  // g: 영상 칸 위 끝이 X 단추 아래로 오게 표시와 칸 사이를 벌린다.
  let g = 0;
  while (g < 15 && row + W * (0.02 + 0.004 * g) < CORNER_CLEAR) g += 1;
  const top = row + W * (0.02 + 0.004 * g);
  // s: 영상 칸이 페이지 아래 끝에 들어가도록 가로를 1%씩 줄인다.
  let s = 0;
  while (s < 15 && top + (W * (1 - 0.01 * s) * 9) / 16 > bottom) s += 1;
  const boxW = W * (1 - 0.01 * s);
  const boxH = (boxW * 9) / 16;
  const parity = [...bitsOf(g), ...bitsOf(s)].reduce((a, b) => a + b, 0) % 2 === 0 ? 1 : 0;
  const bits = [...SYNC_BITS, ...bitsOf(g), ...bitsOf(s), parity];
  const root = document.documentElement.style;
  root.setProperty('--box-x', `${(W - boxW) / 2}px`);
  root.setProperty('--box-w', `${boxW}px`);
  root.setProperty('--box-h', `${boxH}px`);
  root.setProperty('--top', `${top}px`);
  root.setProperty('--row', `${row}px`);
  const marks = $('#marks');
  if (marks.children.length !== bits.length) marks.replaceChildren(...bits.map(() => document.createElement('i')));
  [...marks.children].forEach((el, i) => {
    el.className = bits[i] ? '' : 'off';
    el.style.width = `${size}px`;
    el.style.height = `${size}px`;
    el.style.left = `${W * (0.555 + 0.03 * i) - size / 2}px`;
    el.style.top = `${row - size / 2}px`;
  });
  // 화면 나누기로 창이 좁아지면 가로라도 화면 전체가 아니다.
  return { landscape: W > H, fits: W > H && W / H > 1.25 && top + boxH <= bottom };
}

// 문제를 찾을 때 읽어 달라고 할 화면 숫자: 페이지가 받은 크기, 화면 크기, 배율, 안전 여백(위·왼쪽·아래).
function screenFacts() {
  const css = getComputedStyle(document.documentElement);
  const inset = ['--sat', '--sal', '--sab'].map((v) => Math.round(parseFloat(css.getPropertyValue(v)) || 0)).join('·');
  const vv = window.visualViewport;
  return `페이지 ${innerWidth}×${innerHeight} · 보이는 곳 ${Math.round(vv?.width || 0)}×${Math.round(vv?.height || 0)} · 화면 ${screen.width}×${screen.height} · ${devicePixelRatio}배 · 여백 ${inset}`;
}

function showNotice(n) {
  const box = $('#notice');
  box.hidden = !n;
  $('#facts').textContent = n?.facts ? screenFacts() : '';
  if (!n) return;
  $('#notice-title').textContent = n.title;
  $('#notice-text').textContent = n.text;
  const btn = $('#notice-action');
  btn.hidden = !n.action;
  if (n.action) {
    btn.textContent = n.action.label;
    btn.onclick = n.action.run;
  }
}

function cameraErrorNotice(err) {
  const again = { label: '다시 켜기', run: () => startCamera() };
  if (err?.name === 'NotAllowedError') {
    return { title: '카메라가 막혀 있어요', text: '설정 > 앱 > Safari > 카메라를 \'허용\'으로 바꾼 뒤 다시 켜 주세요.', action: again };
  }
  if (err?.name === 'NotReadableError') {
    return { title: '다른 앱이 카메라를 쓰고 있어요', text: '카메라 앱이나 영상 통화를 닫은 뒤 다시 켜 주세요.', action: again };
  }
  return { title: '카메라를 켜지 못했어요', text: err?.message || '잠시 뒤에 다시 켜 주세요.', action: again };
}

function update() {
  const { landscape, fits } = layout();
  document.body.classList.toggle('browser', !webApp());
  const live = document.body.dataset.state === 'live';
  const camOn = Boolean(stream?.active) && !cameraError;
  let notice = null;
  if (live) {
    if (cameraError) notice = cameraErrorNotice(cameraError);
    else if (!landscape) notice = { title: '가로로 돌려 주세요', text: '사진관은 아이패드를 가로로 놓았을 때만 화면을 받아요.' };
    else if (!fits) notice = { title: '화면 나누기를 꺼 주세요', text: '사진관 카메라만 화면 가득 띄워야 맥이 알아봐요.', facts: true };
    else if (!camOn) notice = { title: '카메라를 켜는 중', text: '잠시만 기다려 주세요.' };
  }
  showNotice(notice);

  const marked = live && webApp() && fits && camOn;
  document.body.classList.toggle('marked', marked);

  const track = stream?.getVideoTracks()[0];
  const s = track?.getSettings?.() || {};
  const size = s.width && s.height ? ` · ${s.width}×${s.height}` : '';
  $('#status').textContent = `${FACING_LABEL[prefs.facing]}${size}`;
  $('#flip').textContent = prefs.facing === 'user' ? '뒤 카메라로' : '앞 카메라로';
}

// ---------- 카메라 ----------
function stopTracks() {
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  video.srcObject = null;
}

const open = (constraints) => navigator.mediaDevices.getUserMedia({ audio: false, video: constraints });

async function startCamera() {
  if (starting) return;
  starting = true;
  cameraError = null;
  stopTracks();
  update();
  try {
    if (!navigator.mediaDevices?.getUserMedia) throw Object.assign(new Error('이 브라우저에서는 카메라를 쓸 수 없어요.'), { name: 'NotSupportedError' });
    try {
      // 4K로 받아 아이패드 화면 해상도에 맞게 줄여 보여 준다(1080p보다 사진관에 또렷하게 간다).
      stream = await open({ facingMode: { ideal: prefs.facing }, width: { ideal: 3840 }, height: { ideal: 2160 }, frameRate: { ideal: 30 } });
    } catch (err) {
      if (err.name !== 'OverconstrainedError') throw err;
      stream = await open({ facingMode: prefs.facing });
    }
    const track = stream.getVideoTracks()[0];
    track?.addEventListener('ended', () => {
      if (!running) return;
      // 다른 앱으로 넘어갔다 오면 iPadOS가 카메라를 끈다. 돌아오면 다시 켠다.
      if (document.visibilityState === 'visible') setTimeout(() => { if (running && !stream?.active) startCamera(); }, 600);
      update();
    });
    track?.addEventListener('mute', update);
    track?.addEventListener('unmute', update);
    video.srcObject = stream;
    await video.play().catch(() => {});
  } catch (err) {
    stopTracks();
    cameraError = err;
  } finally {
    starting = false;
    update();
  }
}

async function keepAwake() {
  try {
    if (wakeLock && !wakeLock.released) return;
    wakeLock = await navigator.wakeLock?.request('screen');
  } catch { /* 저전력 모드 등으로 막히면 자동 잠금을 '안 함'으로 두도록 안내한다 */ }
}

function begin() {
  running = true;
  document.body.dataset.state = 'live';
  keepAwake();
  startCamera();
}

function end() {
  running = false;
  stopTracks();
  wakeLock?.release?.().catch?.(() => {});
  wakeLock = null;
  document.body.dataset.state = 'setup';
  update();
  $('#start').focus({ preventScroll: true });
}

// ---------- 처음 화면 ----------
function markPick() {
  document.querySelectorAll('.pick button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.facing === prefs.facing)));
}

function setFacing(facing) {
  prefs.facing = facing === 'user' ? 'user' : 'environment';
  localStorage.setItem('friendship-cam.facing', prefs.facing);
  markPick();
}

document.querySelectorAll('.pick button').forEach((b) => b.addEventListener('click', () => setFacing(b.dataset.facing)));
$('#start').addEventListener('click', begin);
$('#stop').addEventListener('click', end);
$('#flip').addEventListener('click', () => {
  setFacing(prefs.facing === 'user' ? 'environment' : 'user');
  startCamera();
});

for (const ev of ['resize', 'orientationchange']) window.addEventListener(ev, update);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !running) return;
  keepAwake();
  if (!stream?.active && !starting) startCamera();
  update();
});

if (!navigator.mediaDevices?.getUserMedia && window.isSecureContext) {
  const note = $('#setup-note');
  note.dataset.kind = 'error';
  note.textContent = '이 브라우저에서는 카메라를 쓸 수 없어요. 아이패드의 Safari로 열어 주세요.';
}

if ('serviceWorker' in navigator && window.isSecureContext) navigator.serviceWorker.register('sw.js').catch(() => {});

markPick();
update();
// 처음 화면 맨 아래에 화면 숫자를 작게 둔다(문제가 생겼을 때 읽어 달라고 할 수 있게).
$('#setup-facts').textContent = screenFacts();
window.addEventListener('resize', () => { $('#setup-facts').textContent = screenFacts(); });

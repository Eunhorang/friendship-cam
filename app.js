// 우정 사진관 카메라: 아이패드 카메라 영상을 화면 가운데 16:9 칸에 꽉 채워 보여 준다.
// 맥(친구사랑 우정 사진관)은 케이블로 이 화면을 받아 가운데 16:9만 잘라 카메라로 쓴다.
// 이 페이지는 영상을 어디에도 보내지 않는다.
//
// 아래 검은 띠의 흰 네모(1 0 1 1 0 1)는 사진관 도우미가 '카메라 페이지가 제자리에 떠 있다'고 알아보는 표시다.
// 사진관 tools/ipad-camera.swift와 같은 약속이어야 한다. 가로 W, 세로 H인 화면에서
//   영상 칸 높이 = W × 9/16(위아래 가운데), 띠 높이 b = (H − W × 9/16) / 2
//   아래 띠 가운데(y = H − b/2)에 한 변 0.02W 칸 여섯 개, i번째 칸 가운데 x = W × (0.025 + 0.03 i)
// 화면 전체를 쓸 때(전체 화면이나 홈 화면 앱)만 이 위치가 맞으므로 그때만 표시를 켠다.
const MARK_BITS = [1, 0, 1, 1, 0, 1];
const FACING_LABEL = { environment: '뒤 카메라', user: '앞 카메라' };

const $ = (s) => document.querySelector(s);
const video = $('#video');
const prefs = { facing: localStorage.getItem('friendship-cam.facing') === 'user' ? 'user' : 'environment' };

let stream = null;
let running = false;
let starting = false;
let cameraError = null;
let wakeLock = null;
let fullscreenFailed = false;

// ---------- 화면 ----------
const standalone = () => navigator.standalone === true || matchMedia('(display-mode: standalone)').matches || matchMedia('(display-mode: fullscreen)').matches;
const fullscreenElement = () => document.fullscreenElement || document.webkitFullscreenElement || null;
const coversScreen = () => standalone() || Boolean(fullscreenElement());
const canFullscreen = () => Boolean(document.documentElement.requestFullscreen || document.documentElement.webkitRequestFullscreen);

function enterFullscreen() {
  const el = document.documentElement;
  try {
    const p = el.requestFullscreen ? el.requestFullscreen({ navigationUI: 'hide' }) : el.webkitRequestFullscreen?.();
    p?.catch?.(() => {});
  } catch { /* 전체 화면을 못 쓰는 브라우저 */ }
}

function exitFullscreen() {
  if (!fullscreenElement()) return;
  try {
    const p = document.exitFullscreen ? document.exitFullscreen() : document.webkitExitFullscreen?.();
    p?.catch?.(() => {});
  } catch { /* 무시 */ }
}

// 영상 칸, 띠, 흰 네모 자리를 지금 화면 크기에 맞춘다.
// landscape: 가로로 놓였는지, fits: 띠에 흰 네모가 들어갈 만큼 위아래가 남는지(사파리 주소 막대가 보이면 모자란다).
function layout() {
  const W = window.innerWidth;
  const H = window.innerHeight;
  const box = (W * 9) / 16;
  const band = (H - box) / 2;
  const size = W * 0.02;
  const root = document.documentElement.style;
  root.setProperty('--box', `${box}px`);
  root.setProperty('--band', `${Math.max(0, band)}px`);
  const marks = $('#marks');
  if (marks.children.length !== MARK_BITS.length) marks.replaceChildren(...MARK_BITS.map(() => document.createElement('i')));
  [...marks.children].forEach((el, i) => {
    el.className = MARK_BITS[i] ? '' : 'off';
    el.style.width = `${size}px`;
    el.style.height = `${size}px`;
    el.style.left = `${W * (0.025 + 0.03 * i) - size / 2}px`;
    el.style.top = `${H - band / 2 - size / 2}px`;
  });
  return { landscape: W > H, fits: W > H && band > size * 1.2 };
}

function showNotice(n) {
  const box = $('#notice');
  box.hidden = !n;
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
  if (err?.name === 'NotAllowedError') {
    return {
      title: '카메라가 막혀 있어요',
      text: '설정 > 앱 > Safari > 카메라를 \'허용\'으로 바꾼 뒤 다시 켜 주세요.',
      action: { label: '다시 켜기', run: () => startCamera() },
    };
  }
  if (err?.name === 'NotReadableError') {
    return {
      title: '다른 앱이 카메라를 쓰고 있어요',
      text: '카메라 앱이나 영상 통화를 닫은 뒤 다시 켜 주세요.',
      action: { label: '다시 켜기', run: () => startCamera() },
    };
  }
  return {
    title: '카메라를 켜지 못했어요',
    text: err?.message ? `${err.message}` : '잠시 뒤에 다시 켜 주세요.',
    action: { label: '다시 켜기', run: () => startCamera() },
  };
}

function update() {
  const { landscape, fits } = layout();
  const live = document.body.dataset.state === 'live';
  const full = coversScreen();
  const camOn = Boolean(stream?.active) && !cameraError;
  let notice = null;
  if (live) {
    if (cameraError) notice = cameraErrorNotice(cameraError);
    else if (!landscape) notice = { title: '가로로 돌려 주세요', text: '사진관은 아이패드를 가로로 놓았을 때만 화면을 받아요.' };
    else if (!full) {
      const button = canFullscreen() && !fullscreenFailed;
      notice = {
        title: '전체 화면으로 바꿔 주세요',
        text: button
          ? '주소 막대가 보이면 사진관이 화면을 알아보지 못해요. 홈 화면에 추가해서 열면 늘 전체 화면이에요.'
          : '공유 단추에서 \'홈 화면에 추가\'를 누르고 홈 화면에 생긴 사진관 카메라로 열어 주세요.',
        action: button ? { label: '전체 화면', run: enterFullscreen } : null,
      };
    } else if (!fits) notice = { title: '이 화면에서는 쓸 수 없어요', text: '아이패드 화면 위아래에 남는 자리가 너무 좁아요. 화면 나누기를 끄고 사진관 카메라만 띄워 주세요.' };
    else if (!camOn) notice = { title: '카메라를 켜는 중', text: '잠시만 기다려 주세요.' };
  }
  showNotice(notice);

  const marked = live && fits && full && camOn;
  document.body.classList.toggle('marked', marked);

  const track = stream?.getVideoTracks()[0];
  const s = track?.getSettings?.() || {};
  const size = s.width && s.height ? ` · ${s.width}×${s.height}` : '';
  $('#status').textContent = marked
    ? `${FACING_LABEL[prefs.facing]}${size} · 케이블로 이으면 사진관에 보여요`
    : `${FACING_LABEL[prefs.facing]}${size}`;
  $('#flip').textContent = prefs.facing === 'user' ? '뒤 카메라로' : '앞 카메라로';
  $('#full').hidden = full || !canFullscreen();
}

// ---------- 카메라 ----------
function stopTracks() {
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  video.srcObject = null;
}

async function open(constraints) {
  return navigator.mediaDevices.getUserMedia({ audio: false, video: constraints });
}

async function startCamera() {
  if (starting) return;
  starting = true;
  cameraError = null;
  stopTracks();
  update();
  try {
    if (!navigator.mediaDevices?.getUserMedia) throw Object.assign(new Error('이 브라우저에서는 카메라를 쓸 수 없어요. 아이패드의 Safari로 열어 주세요.'), { name: 'NotSupportedError' });
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
  // 전체 화면은 누른 순간에만 요청할 수 있어서 카메라보다 먼저 부른다.
  if (!standalone() && canFullscreen()) enterFullscreen();
  keepAwake();
  startCamera();
}

function end() {
  running = false;
  stopTracks();
  exitFullscreen();
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
$('#full').addEventListener('click', enterFullscreen);
$('#flip').addEventListener('click', () => {
  setFacing(prefs.facing === 'user' ? 'environment' : 'user');
  startCamera();
});

for (const ev of ['resize', 'orientationchange']) window.addEventListener(ev, update);
document.addEventListener('fullscreenchange', update);
document.addEventListener('webkitfullscreenchange', update);
// 전체 화면을 거절당하면 홈 화면에 추가하는 길을 알려 준다.
for (const ev of ['fullscreenerror', 'webkitfullscreenerror']) {
  document.addEventListener(ev, () => { fullscreenFailed = true; update(); });
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !running) return;
  keepAwake();
  if (!stream?.active && !starting) startCamera();
  update();
});

if (!navigator.mediaDevices?.getUserMedia) {
  const note = $('#setup-note');
  note.dataset.kind = 'error';
  note.textContent = window.isSecureContext
    ? '이 브라우저에서는 카메라를 쓸 수 없어요. 아이패드의 Safari로 열어 주세요.'
    : 'https 주소로 열어야 카메라를 쓸 수 있어요: https://eunhorang.github.io/friendship-cam/';
}

if ('serviceWorker' in navigator && window.isSecureContext) navigator.serviceWorker.register('sw.js').catch(() => {});

markPick();
update();

// ── Subject registry ──────────────────────────────────────────────────────────
// To add a new subject: drop a JSON file in src/data/, append its path to DATA_FILES,
// and add an entry here with a unique `key` and matching `section` (the value of
// q.section in the JSON). It will automatically show up in the dropdown.
const SUBJECTS = [
  { key: 'p1',  section: '金融市場常識', label: '金融市場常識', category: '共同科目' },
  { key: 'p2',  section: '職業道德',     label: '職業道德',     category: '共同科目' },
  { key: 'ins', section: '保險實務',     label: '保險實務',     category: '專業科目' },
  { key: 'law', section: '保險法規',     label: '保險法規',     category: '專業科目' },
  { key: 'fx',  section: '外幣保單',     label: '外幣保單',     category: '外幣證照' },
  { key: 'prop', section: '財產保險',    label: '財產保險',     category: '產險證照' },
  { key: 'inv1', section: '投資型保險第一節', label: '投資型保險商品、金融體系概述', category: '投資型保險證照' },
  { key: 'inv2', section: '投資型保險第二節', label: '投資學、債券證券評價、投資組合', category: '投資型保險證照' },
];
const SUBJECT_MAP = Object.fromEntries(SUBJECTS.map(s => [s.key, s]));

function populateSubjectSelect() {
  const sel = document.getElementById('subjectSel');
  sel.innerHTML = '';
  const groups = new Map();
  for (const s of SUBJECTS) {
    if (!groups.has(s.category)) groups.set(s.category, []);
    groups.get(s.category).push(s);
  }
  for (const [category, subjects] of groups) {
    const og = document.createElement('optgroup');
    og.label = category;
    for (const s of subjects) {
      const opt = document.createElement('option');
      opt.value       = s.key;
      opt.textContent = s.label;
      og.appendChild(opt);
    }
    sel.appendChild(og);
  }
}

// ── Data ──────────────────────────────────────────────────────────────────────
let RAW_QUESTIONS = [];

const DATA_FILES = [
  'src/data/d1.enc',
  'src/data/d2.enc',
  'src/data/d3.enc',
  'src/data/d4.enc',
  'src/data/d5.enc',
  'src/data/d6.enc',
  'src/data/d7.enc',
];

// AES-GCM 256-bit key — must match KEY_HEX in scripts/encrypt_data.py
const ENC_KEY = '3a8f2c1e5b9d4f7a6c0e2b8d1f5a3c9e7d4b8f2a6e0c4d8f1b3e7a5c9d2f8b4e';
let _aesKey = null;

async function getAesKey() {
  if (_aesKey) return _aesKey;
  const raw = new Uint8Array(ENC_KEY.match(/.{2}/g).map(b => parseInt(b, 16)));
  _aesKey = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['decrypt']);
  return _aesKey;
}

function b64ToBytes(b64) {
  return Uint8Array.from(atob(b64), c => c.charCodeAt(0));
}

async function fetchEncrypted(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(res.status);
  const { iv, ct } = await res.json();
  const key = await getAesKey();
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64ToBytes(iv) }, key, b64ToBytes(ct));
  return JSON.parse(new TextDecoder().decode(plain));
}

function init() {
  populateSubjectSelect();
  Promise.all(DATA_FILES.map(url => fetchEncrypted(url)))
    .then(datasets => {
      RAW_QUESTIONS = datasets.flat();
      SECTIONS_WITH_KEY = new Set(RAW_QUESTIONS.filter(q => q.star).map(q => q.section));
      let session = null;
      try { session = JSON.parse(localStorage.getItem(SESSION_KEY)); } catch {}
      if (session) {
        activeSubject = SUBJECT_MAP[session.activeSubject] ? session.activeSubject : SUBJECTS[0].key;
        activeMode    = ['all','review','star','key'].includes(session.activeMode) ? session.activeMode : 'all';
        if (activeMode === 'key' && !subjectHasKey()) activeMode = 'all';
        shuffled      = !!session.shuffled;
        document.querySelectorAll('.toggle-shuffle').forEach(el => el.classList.toggle('active', shuffled));
      }
      document.querySelectorAll('.toggle-hide-known').forEach(el => el.classList.toggle('active', hideKnown));
      document.querySelectorAll('.toggle-card-fx').forEach(el => el.classList.toggle('active', cardFx));
      document.querySelectorAll('.toggle-shuffle-opts').forEach(el => el.classList.toggle('active', shuffleOpts));
      document.querySelectorAll('.toggle-show-seen').forEach(el => el.classList.toggle('active', showSeen));
      syncFilterUI();
      buildDeck(session);
    })
    .catch(() => showLoadError());
}

function showLoadError() {
  document.getElementById('errorBox').classList.add('visible');
  document.getElementById('cardWrap').style.display = 'none';
  document.getElementById('controls').style.display = 'none';
  document.getElementById('kbdHints').style.display = 'none';
}

// ── Persistent state ──────────────────────────────────────────────────────────
let marks = JSON.parse(localStorage.getItem('flashcard_marks') || '{}');
let stars = new Set(JSON.parse(localStorage.getItem('flashcard_stars') || '[]'));

function saveMark(id, status) {
  marks[id] = status;
  localStorage.setItem('flashcard_marks', JSON.stringify(marks));
}
function saveStars() {
  localStorage.setItem('flashcard_stars', JSON.stringify([...stars]));
}

// ── Session (position) persistence ───────────────────────────────────────────
const SESSION_KEY        = 'flashcard_session';
const FILTER_SESSION_KEY = 'flashcard_filter_sessions';

function saveSession() {
  if (!deck.length || currentIdx >= deck.length) return;
  localStorage.setItem(SESSION_KEY, JSON.stringify({
    activeSubject, activeMode, shuffled,
    currentQId: deck[currentIdx].id,
    selectedOpt
  }));
}

// ── Scoped sessions (review/star per subject) ─────────────────────────────────
// Keys: '{subject}:{mode}' e.g. 'p1:review', 'ins:star'
function emptyFS() {
  return { answeredIds: new Set(), correctIds: new Set(), initialDeckIds: [], currentQId: null, selectedOpt: null, selectedOpts: {} };
}

function loadFilterSessions() {
  try {
    const raw = JSON.parse(localStorage.getItem(FILTER_SESSION_KEY) || '{}');
    const result = {};
    for (const s of SUBJECTS) {
      for (const m of ['review', 'star']) {
        const k = `${s.key}:${m}`;
        if (raw[k]) {
          raw[k].answeredIds    = new Set(raw[k].answeredIds || []);
          raw[k].correctIds     = new Set(raw[k].correctIds  || []);
          raw[k].initialDeckIds = raw[k].initialDeckIds || [];
          raw[k].selectedOpts   = raw[k].selectedOpts   || {};
          result[k] = raw[k];
        } else {
          result[k] = emptyFS();
        }
      }
    }
    return result;
  } catch {
    const result = {};
    for (const s of SUBJECTS)
      for (const m of ['review', 'star'])
        result[`${s.key}:${m}`] = emptyFS();
    return result;
  }
}

let filterSessions = loadFilterSessions();

function saveFilterSession(k) {
  const all = JSON.parse(localStorage.getItem(FILTER_SESSION_KEY) || '{}');
  const fs  = filterSessions[k];
  all[k] = { ...fs, answeredIds: [...fs.answeredIds], correctIds: [...fs.correctIds] };
  localStorage.setItem(FILTER_SESSION_KEY, JSON.stringify(all));
}

function clearFilterSession(k) {
  filterSessions[k] = emptyFS();
  const all = JSON.parse(localStorage.getItem(FILTER_SESSION_KEY) || '{}');
  delete all[k];
  localStorage.setItem(FILTER_SESSION_KEY, JSON.stringify(all));
}

// ── Session state ─────────────────────────────────────────────────────────────
let deck          = [];
let currentIdx    = 0;
let selectedOpt   = null;
let activeSubject = 'p1';
let activeMode    = 'all';
let shuffled      = false;
let _freshAnswer  = false;
let hideKnown     = JSON.parse(localStorage.getItem('flashcard_hide_known')    || 'false');
let cardFx        = JSON.parse(localStorage.getItem('flashcard_card_fx')       ?? 'true');
let shuffleOpts   = JSON.parse(localStorage.getItem('flashcard_shuffle_opts')  || 'false');
let showSeen      = JSON.parse(localStorage.getItem('flashcard_show_seen')     || 'false');

function filterKey() { return `${activeSubject}:${activeMode}`; }

// ── Deck ──────────────────────────────────────────────────────────────────────
function buildDeck(session = null) {
  const isScoped  = activeMode === 'review' || activeMode === 'star';
  const fk        = filterKey();
  const subjSection = SUBJECT_MAP[activeSubject].section;

  let base;
  if (isScoped && filterSessions[fk].initialDeckIds.length > 0) {
    // Restart path: rebuild from the initial snapshot so correctly-answered
    // questions aren't filtered out by their updated marks.
    const idSet = new Set(filterSessions[fk].initialDeckIds);
    base = RAW_QUESTIONS.filter(q => idSet.has(q.id));
  } else {
    base = RAW_QUESTIONS.filter(q => q.section === subjSection);
    if      (activeMode === 'review') base = base.filter(q => marks[q.id] === 'review');
    else if (activeMode === 'star')   base = base.filter(q => stars.has(q.id));
    else if (activeMode === 'key')    base = base.filter(q => q.star);
  }

  if (hideKnown && !isScoped) {
    base = base.filter(q => marks[q.id] !== 'know');
  }

  deck = [...base];
  if (shuffled) deck.sort(() => Math.random() - 0.5);

  // Snapshot the deck IDs on fresh scoped session start (not a restart)
  if (isScoped && filterSessions[fk].initialDeckIds.length === 0) {
    filterSessions[fk].initialDeckIds = deck.map(q => q.id);
    saveFilterSession(fk);
  }

  // Restore position
  const src = isScoped ? filterSessions[fk] : session;
  if (src && src.currentQId) {
    const idx = deck.findIndex(q => q.id === src.currentQId);
    currentIdx  = idx >= 0 ? idx : 0;
    selectedOpt = idx >= 0 ? (src.selectedOpt || null) : null;
  } else {
    currentIdx  = 0;
    selectedOpt = null;
  }

  renderCard();
  updateProgress();
  saveSession();
}

// ── Subject / mode selection ──────────────────────────────────────────────────
// Returns true if the caller may proceed, false if user cancelled.
async function confirmLeaveScoped() {
  const isOldScoped = activeMode === 'review' || activeMode === 'star';
  if (!isOldScoped) return true;
  const oldKey = filterKey();
  const fs     = filterSessions[oldKey];
  if (fs.answeredIds.size === 0 || fs.answeredIds.size >= deck.length) return true;
  const modeLabel = activeMode === 'review' ? '複習' : '星號';
  const subjLabel = SUBJECT_MAP[activeSubject].label;
  const ok = await showConfirm({
    message: `離開「${subjLabel} · ${modeLabel}」後，本輪的答題進度將會重置。\n確定要離開嗎？`
  });
  if (!ok) return false;
  clearFilterSession(oldKey);
  return true;
}

async function setSubject(key) {
  if (!SUBJECT_MAP[key] || key === activeSubject) return;
  if (!await confirmLeaveScoped()) {
    document.getElementById('subjectSel').value = activeSubject;  // revert
    return;
  }
  activeSubject = key;
  activeMode = 'all';
  hideKnown = false;
  shuffled  = false;
  localStorage.setItem('flashcard_hide_known', 'false');
  document.querySelectorAll('.toggle-hide-known').forEach(el => el.classList.remove('active'));
  document.querySelectorAll('.toggle-shuffle').forEach(el => el.classList.remove('active'));
  syncFilterUI();
  buildDeck();
}

async function setMode(mode) {
  if (mode === activeMode) mode = 'all';
  const prevMode = activeMode;
  if (!await confirmLeaveScoped()) return;
  if ((prevMode === 'review' || prevMode === 'star') && mode !== prevMode) {
    clearFilterSession(`${activeSubject}:${prevMode}`);
  }
  activeMode = mode;
  syncFilterUI();
  buildDeck();
}

function syncFilterUI() {
  document.getElementById('subjectSel').value = activeSubject;
  document.getElementById('hdrCatLabel').textContent = SUBJECT_MAP[activeSubject].label;

  // Show the 精選 segment only for subjects that have 精選 questions
  const keyBtn = document.querySelector('.seg-btn[data-seg="key"]');
  if (keyBtn) keyBtn.style.display = subjectHasKey() ? '' : 'none';

  const seg = ['review','star','key'].includes(activeMode) ? activeMode : 'all';
  document.querySelectorAll('.seg-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.seg === seg));
  updateSegThumb();

  const isScoped = activeMode === 'review' || activeMode === 'star';
  document.querySelectorAll('.hide-known-row').forEach(row => row.classList.toggle('sheet-row-disabled', isScoped));
}

function toggleShuffle() {
  shuffled = !shuffled;
  document.querySelectorAll('.toggle-shuffle').forEach(btn => {
    btn.classList.toggle('active', shuffled);
    jellyToggle(btn);
  });
  buildDeck();
}

function toggleHideKnown() {
  hideKnown = !hideKnown;
  localStorage.setItem('flashcard_hide_known', JSON.stringify(hideKnown));
  document.querySelectorAll('.toggle-hide-known').forEach(btn => {
    btn.classList.toggle('active', hideKnown);
    jellyToggle(btn);
  });
  buildDeck();
}

function toggleCardFx() {
  cardFx = !cardFx;
  localStorage.setItem('flashcard_card_fx', JSON.stringify(cardFx));
  document.querySelectorAll('.toggle-card-fx').forEach(btn => {
    btn.classList.toggle('active', cardFx);
    jellyToggle(btn);
  });
}

function toggleShuffleOpts() {
  shuffleOpts = !shuffleOpts;
  localStorage.setItem('flashcard_shuffle_opts', JSON.stringify(shuffleOpts));
  document.querySelectorAll('.toggle-shuffle-opts').forEach(btn => {
    btn.classList.toggle('active', shuffleOpts);
    jellyToggle(btn);
  });
  deck.forEach(q => delete q._optOrder);
  renderCard();
}

function toggleShowSeen() {
  showSeen = !showSeen;
  localStorage.setItem('flashcard_show_seen', JSON.stringify(showSeen));
  document.querySelectorAll('.toggle-show-seen').forEach(btn => {
    btn.classList.toggle('active', showSeen);
    jellyToggle(btn);
  });
  renderCard();
}

function triggerCardFx(isCorrect) {
  if (!cardFx) return;
  const wrap = document.getElementById('cardWrap');
  wrap.classList.remove('fx-bounce', 'fx-shake');
  void wrap.offsetWidth;
  wrap.classList.add(isCorrect ? 'fx-bounce' : 'fx-shake');
  setTimeout(() => wrap.classList.remove('fx-bounce', 'fx-shake'), 620);
}

function jellyToggle(el) {
  el.classList.remove('toggle-jelly');
  void el.offsetWidth;
  el.classList.add('toggle-jelly');
}

// ── Render ────────────────────────────────────────────────────────────────────
const BADGE_MAP = {
  '金融市場常識': ['共同｜金融市場常識', 'badge-p1'],
  '職業道德':     ['共同｜職業道德',     'badge-p2'],
  '保險實務':     ['專業｜保險實務',     'badge-ins'],
  '保險法規':     ['專業｜保險法規',     'badge-law'],
  '投資型保險第一節': ['投資｜第一節', 'badge-p1'],
  '投資型保險第二節': ['投資｜第二節', 'badge-p2'],
};

// When options are shuffled, an explanation that cites option numbers like "故選(2)"
// would point at the wrong displayed position. Remap "(1)"–"(4)" references to the
// order in `optOrder` (the same array that labels the displayed options). When options
// are not shuffled, optOrder is ['1','2','3','4'] and this is a no-op.
function remapExplanation(text, optOrder) {
  if (!text || !optOrder) return text;
  const map = {};
  optOrder.forEach((k, i) => { map[k] = String(i + 1); });
  return text.replace(/\(([1-4])\)/g, (m, d) => (map[d] ? `(${map[d]})` : m));
}

function renderCard() {
  const doneScreen = document.getElementById('doneScreen');
  const cardWrap   = document.getElementById('cardWrap');
  const controls   = document.getElementById('controls');

  if (deck.length === 0 || currentIdx >= deck.length) {
    cardWrap.style.display = 'none';
    controls.style.display = 'none';
    doneScreen.classList.add('visible');
    renderDone();
    return;
  }

  doneScreen.classList.remove('visible');
  cardWrap.style.display = 'block';
  controls.style.display = '';

  const q = deck[currentIdx];
  if ((activeMode === 'review' || activeMode === 'star') && selectedOpt === null) {
    const saved = filterSessions[filterKey()].selectedOpts?.[q.id];
    if (saved !== undefined) selectedOpt = saved;
  }
  if (!q._optOrder) {
    const keys = ['1','2','3','4'].filter(k => q.options[k]);
    q._optOrder = shuffleOpts ? keys.sort(() => Math.random() - 0.5) : keys;
  }
  const [badge, badgeCls] = BADGE_MAP[q.section] || [q.section, 'badge-p1'];
  const cls = 'section-badge ' + badgeCls;
  cardWrap.classList.toggle('card-seen-know',   showSeen && (activeMode === 'all' || activeMode === 'key') && marks[q.id] === 'know');
  cardWrap.classList.toggle('card-seen-review', showSeen && (activeMode === 'all' || activeMode === 'key') && marks[q.id] === 'review');

  if (selectedOpt === null) {
    // ── Front face ──
    document.getElementById('cardBack').style.display  = 'none';
    document.getElementById('cardFront').style.display = '';

    document.getElementById('cardNum').textContent = `第 ${q.num} 題`;
    const sb = document.getElementById('sectionBadge');
    sb.textContent = badge; sb.className = cls;

    document.getElementById('questionText').textContent = q.question;

    const optList = document.getElementById('optionsList');
    optList.innerHTML = '';
    q._optOrder.forEach((k, i) => {
      const btn = document.createElement('button');
      btn.className = 'option-btn';
      btn.innerHTML = `<span class="opt-label">(${i + 1})</span><span>${q.options[k]}</span>`;
      btn.onclick = () => selectOption(k);
      optList.appendChild(btn);
    });

    renderStarBtns(q.id);
    document.getElementById('btnPrev').disabled = (currentIdx === 0);
    document.getElementById('btnNext').disabled = false;
    document.getElementById('btnNext').textContent = currentIdx === deck.length - 1 ? '完成測驗' : '下一題 →';

  } else {
    // ── Back face ──
    document.getElementById('cardFront').style.display = 'none';
    const cardBackEl = document.getElementById('cardBack');
    cardBackEl.classList.toggle('do-reveal', _freshAnswer);
    _freshAnswer = false;
    cardBackEl.style.display = '';

    document.getElementById('cardNumBack').textContent = `第 ${q.num} 題`;
    const sbB = document.getElementById('sectionBadgeBack');
    sbB.textContent = badge; sbB.className = cls;

    document.getElementById('questionTextBack').textContent = q.question;

    const isCorrect = selectedOpt === q.answer;

const resultOpts = document.getElementById('resultOptions');
    resultOpts.innerHTML = '';
    q._optOrder.forEach((k, i) => {
      const div = document.createElement('div');
      const isAns    = k === q.answer;
      const isChosen = k === selectedOpt;
      let extraClass = '', tag = '';
      if (isAns && isChosen) { extraClass = 'is-correct';      tag = '<span class="result-tag">✓ 正確</span>'; }
      else if (isAns)        { extraClass = 'is-correct';      tag = '<span class="result-tag">✓ 正確</span>'; }
      else if (isChosen)     { extraClass = 'is-chosen-wrong'; tag = '<span class="result-tag">✗ 你的選擇</span>'; }
      div.className = `result-opt ${extraClass}`;
      div.innerHTML = `<span class="opt-label">(${i + 1})</span><span>${q.options[k]}</span>${tag}`;
      resultOpts.appendChild(div);
    });

    document.getElementById('explanationText').textContent =
      remapExplanation(q.explanation, q._optOrder) || '請參閱相關教材。';

    renderStarBtns(q.id);
    document.getElementById('btnPrev').disabled = (currentIdx === 0);
    document.getElementById('btnNext').disabled = false;
    document.getElementById('btnNext').textContent = currentIdx === deck.length - 1 ? '完成測驗' : '下一題 →';
  }
}

function renderDone() {
  const doneSubtitle = document.getElementById('doneSubtitle');
  const doneStats    = document.getElementById('doneStats');
  const fk           = filterKey();
  const isScoped     = activeMode === 'review' || activeMode === 'star';

  if (deck.length === 0) {
    doneSubtitle.textContent =
      activeMode === 'review' ? '目前沒有答錯的題目'
      : activeMode === 'star' ? '尚未標記任何星號題'
      : '沒有符合條件的題目';
    doneStats.innerHTML = '';
    const showExtra = activeMode === 'all';
    document.getElementById('doneRemoveKnownBtn').style.display = activeMode === 'review' ? '' : 'none';
    document.getElementById('doneReviewBtn').style.display = showExtra ? '' : 'none';
    document.getElementById('doneStarBtn').style.display   = showExtra ? '' : 'none';
    return;
  }

  let know = 0, wrong = 0;
  for (const q of deck) {
    if (isScoped && !filterSessions[fk].answeredIds.has(q.id)) continue;
    if (activeMode === 'review' && filterSessions[fk].correctIds.has(q.id)) { know++; continue; }
    const m = marks[q.id];
    if (m === 'know') know++;
    else if (m === 'review') wrong++;
  }
  doneSubtitle.textContent = `完成本輪 ${deck.length} 題`;
  doneStats.innerHTML = `
    <div class="stat-box">
      <div class="stat-num" style="color:var(--green)">${know}</div>
      <div class="stat-label">答對 ✓</div>
    </div>
    <div class="stat-box">
      <div class="stat-num" style="color:var(--red)">${wrong}</div>
      <div class="stat-label">答錯 ✗</div>
    </div>
    <div class="stat-box">
      <div class="stat-num" style="color:var(--text-muted)">${deck.length - know - wrong}</div>
      <div class="stat-label">未答</div>
    </div>`;
  const showExtra = activeMode === 'all';
  document.getElementById('doneRemoveKnownBtn').style.display = activeMode === 'review' ? '' : 'none';
  document.getElementById('doneReviewBtn').style.display = showExtra ? '' : 'none';
  document.getElementById('doneStarBtn').style.display   = showExtra ? '' : 'none';
}

// ── Star ──────────────────────────────────────────────────────────────────────
function renderStarBtns(id) {
  const isStarred = stars.has(id);
  ['starBtnFront', 'starBtnBack'].forEach(bid => {
    const btn = document.getElementById(bid);
    btn.classList.remove('jelly');
    btn.classList.toggle('starred', isStarred);
  });
}

async function resetStarsForSubject() {
  const subjLabel = SUBJECT_MAP[activeSubject].label;
  const ok = await showConfirm({
    message: `重置「${subjLabel}」的所有星號標記？`,
    confirmLabel: '重置',
    danger: true
  });
  if (!ok) return;
  const subjSection = SUBJECT_MAP[activeSubject].section;
  for (const q of RAW_QUESTIONS) {
    if (q.section === subjSection) stars.delete(q.id);
  }
  saveStars();
  clearFilterSession(`${activeSubject}:star`);
  buildDeck();
}

function toggleStar() {
  if (!deck.length || currentIdx >= deck.length) return;
  const id = deck[currentIdx].id;
  if (stars.has(id)) stars.delete(id);
  else stars.add(id);
  saveStars();
  renderStarBtns(id);
  updateProgress();
  ['starBtnFront', 'starBtnBack'].forEach(bid => {
    const btn = document.getElementById(bid);
    btn.classList.remove('jelly');
    void btn.offsetWidth;
    btn.classList.add('jelly');
  });
}

// ── Actions ───────────────────────────────────────────────────────────────────
function selectOption(k) {
  if (selectedOpt !== null) return;
  const q  = deck[currentIdx];
  const fk = filterKey();
  selectedOpt = k;
  const isCorrect = k === q.answer;
  if (activeMode === 'review') {
    if (isCorrect) {
      filterSessions[fk].correctIds.add(q.id);
    } else {
      saveMark(q.id, 'review');
    }
    filterSessions[fk].answeredIds.add(q.id);
    filterSessions[fk].currentQId    = q.id;
    filterSessions[fk].selectedOpt   = k;
    filterSessions[fk].selectedOpts[q.id] = k;
    saveFilterSession(fk);
  } else {
    saveMark(q.id, isCorrect ? 'know' : 'review');
    if (activeMode === 'star') {
      filterSessions[fk].answeredIds.add(q.id);
      filterSessions[fk].currentQId    = q.id;
      filterSessions[fk].selectedOpt   = k;
      filterSessions[fk].selectedOpts[q.id] = k;
      saveFilterSession(fk);
    }
  }
  updateProgress();
  _freshAnswer = true;
  renderCard();
  triggerCardFx(isCorrect);
  saveSession();
}

function scrollToCardTopIfNeeded() {
  const wrap     = document.getElementById('cardWrap');
  if (wrap.style.display === 'none') return;
  const stickyEl = document.querySelector('.sticky-top');
  const stickyH  = stickyEl ? stickyEl.offsetHeight : 0;
  const cardTop  = wrap.getBoundingClientRect().top;
  if (cardTop < stickyH) {
    window.scrollTo({ top: window.scrollY + cardTop - stickyH, behavior: 'smooth' });
  }
}

function nextCard() {
  if (currentIdx >= deck.length) return;
  currentIdx++;
  selectedOpt = null;
  const fk = filterKey();
  if ((activeMode === 'review' || activeMode === 'star') && currentIdx < deck.length) {
    filterSessions[fk].currentQId  = deck[currentIdx].id;
    filterSessions[fk].selectedOpt = null;
    saveFilterSession(fk);
  }
  renderCard();
  updateProgress();
  saveSession();
  scrollToCardTopIfNeeded();
}

function prevCard() {
  if (currentIdx <= 0) return;
  currentIdx--;
  selectedOpt = null;
  const fk = filterKey();
  if ((activeMode === 'review' || activeMode === 'star') && currentIdx < deck.length) {
    filterSessions[fk].currentQId  = deck[currentIdx].id;
    filterSessions[fk].selectedOpt = null;
    saveFilterSession(fk);
  }
  renderCard();
  updateProgress();
  saveSession();
  scrollToCardTopIfNeeded();
}

function goToFirst() {
  if (!deck.length || currentIdx === 0) return;
  currentIdx = 0;
  selectedOpt = null;
  const fk = filterKey();
  if ((activeMode === 'review' || activeMode === 'star')) {
    filterSessions[fk].currentQId  = deck[0].id;
    filterSessions[fk].selectedOpt = null;
    saveFilterSession(fk);
  }
  renderCard();
  updateProgress();
  saveSession();
  scrollToCardTopIfNeeded();
}

function goToNextUnseen() {
  if (!deck.length) return;
  for (let i = 1; i < deck.length; i++) {
    const idx = (currentIdx + i) % deck.length;
    if (!marks[deck[idx].id]) {
      currentIdx = idx;
      selectedOpt = null;
      const fk = filterKey();
      if (activeMode === 'review' || activeMode === 'star') {
        filterSessions[fk].currentQId  = deck[idx].id;
        filterSessions[fk].selectedOpt = null;
        saveFilterSession(fk);
      }
      renderCard();
      updateProgress();
      saveSession();
      scrollToCardTopIfNeeded();
      return;
    }
  }
}

function restartDeck(mode) {
  if (mode === 'review' || mode === 'star') {
    // Force the mode directly — bypass the toggle-off logic in setMode
    activeMode = mode;
    clearFilterSession(filterKey());
    syncFilterUI();
    buildDeck();
    return;
  }
  // Restart same subject+mode
  const fk = filterKey();
  if (activeMode === 'review' || activeMode === 'star') {
    // Preserve initialDeckIds so the same question set is used again
    const savedIds = [...filterSessions[fk].initialDeckIds];
    clearFilterSession(fk);
    filterSessions[fk].initialDeckIds = savedIds;
  }
  buildDeck();
}

function restartDeckRemoveKnown() {
  const fk = filterKey();
  for (const id of filterSessions[fk].correctIds) {
    saveMark(id, 'know');
  }
  clearFilterSession(fk);
  buildDeck();
}

async function resetProgress() {
  const wasSheetOpen = document.getElementById('sheetBackdrop').classList.contains('open');
  closeSettingsPopover();
  if (wasSheetOpen) {
    // Slide sheet down but keep body locked through the modal, so iOS Safari
    // doesn't bounce the URL bar / home indicator between scroll states.
    const panel = document.getElementById('settingsSheetPanel');
    panel.style.transition = 'transform 0.24s ease-in';
    document.getElementById('sheetBackdrop').classList.remove('open');
    await new Promise(r => setTimeout(r, 240));
    panel.style.transition = '';
  }
  const subjLabel = SUBJECT_MAP[activeSubject].label;
  const ok = await showConfirm({
    message: `重置「${subjLabel}」的答題進度？\n（星號標記不受影響）`,
    danger: true
  });
  if (wasSheetOpen) {
    // Wait for modal fade-out to finish before releasing body lock,
    // otherwise iOS Safari shows a stale grey strip in the safe-area.
    await new Promise(r => setTimeout(r, 200));
    _unlockScroll();
  }
  if (!ok) return;
  const subjSection = SUBJECT_MAP[activeSubject].section;
  const subjIds = new Set(RAW_QUESTIONS.filter(q => q.section === subjSection).map(q => q.id));
  for (const id of subjIds) delete marks[id];
  localStorage.setItem('flashcard_marks', JSON.stringify(marks));
  for (const mode of ['review', 'star']) {
    const fk = `${activeSubject}:${mode}`;
    clearFilterSession(fk);
  }
  buildDeck();
}

// ── Progress ──────────────────────────────────────────────────────────────────
function updateProgress() {
  const fk       = filterKey();
  const isScoped = activeMode === 'review' || activeMode === 'star';
  const total    = deck.length;

  let answered, knowInDeck, wrongInDeck;
  if (isScoped) {
    const aid   = filterSessions[fk].answeredIds;
    const cid   = filterSessions[fk].correctIds;
    answered    = deck.filter(q => aid.has(q.id)).length;
    knowInDeck  = deck.filter(q => aid.has(q.id) && (activeMode === 'review' ? cid.has(q.id) : marks[q.id] === 'know')).length;
    wrongInDeck = deck.filter(q => aid.has(q.id) && (activeMode === 'review' ? !cid.has(q.id) : marks[q.id] === 'review')).length;
  } else {
    answered    = deck.filter(q => marks[q.id] !== undefined).length;
    knowInDeck  = deck.filter(q => marks[q.id] === 'know').length;
    wrongInDeck = deck.filter(q => marks[q.id] === 'review').length;
  }

  const knowPct     = total > 0 ? knowInDeck  / total * 100 : 0;
  const wrongPct    = total > 0 ? wrongInDeck / total * 100 : 0;
  const correctRate = answered > 0 ? Math.round(knowInDeck / answered * 100) : 0;

  document.getElementById('progressLabel').textContent = `${answered} / ${total} 已答`;
  document.getElementById('pctLabel').textContent      = answered > 0 ? `正確率 ${correctRate}%` : '0%';
  document.getElementById('progressKnow').style.width  = knowPct  + '%';
  document.getElementById('progressWrong').style.width = wrongPct + '%';

  // Pills: stats for the current subject (all its questions, not just current deck)
  const subjSection = SUBJECT_MAP[activeSubject].section;
  let know = 0, wrong = 0, unseen = 0, starTotal = 0, keyTotal = 0;
  for (const q of RAW_QUESTIONS) {
    if (q.section !== subjSection) continue;
    const m = marks[q.id];
    if (m === 'know') know++;
    else if (m === 'review') wrong++;
    else unseen++;
    if (stars.has(q.id)) starTotal++;
    if (q.star) keyTotal++;
  }
  document.getElementById('knowCount').textContent   = know;
  document.getElementById('reviewCount').textContent = wrong;
  document.getElementById('unseenCount').textContent = unseen;
  document.getElementById('starCount').textContent   = starTotal;

  updateSegBadge('segBadgeAll',    know + wrong + unseen);
  updateSegBadge('segBadgeReview', wrong);
  updateSegBadge('segBadgeKey',    keyTotal);
  updateSegBadge('segBadgeStar',   starTotal);
}

// ── Keyboard ──────────────────────────────────────────────────────────────────
document.addEventListener('keydown', e => {
  if (['INPUT','TEXTAREA','SELECT'].includes(e.target.tagName)) return;

  if (selectedOpt === null) {
    if (['1','2','3','4'].includes(e.key)) {
      const q = deck[currentIdx];
      const key = q?._optOrder?.[parseInt(e.key) - 1] ?? e.key;
      selectOption(key);
    }
    else if (e.code === 'ArrowLeft')  prevCard();
    else if (e.code === 'ArrowRight') nextCard();
  } else {
    if (e.code === 'ArrowRight' || e.code === 'Enter') { e.preventDefault(); nextCard(); }
    else if (e.code === 'ArrowLeft') prevCard();
  }

  if (e.key === 's' || e.key === 'S') toggleStar();
});

// ── Touch swipe ───────────────────────────────────────────────────────────────
(function () {
  let x0 = null, y0 = null, t0 = 0, threshold = 0, dragging = false, swipeDir = 0, atBoundary = false, axis = null;

  const wrap = document.getElementById('cardWrap');
  const peek = document.getElementById('cardPeek');

  function showPeek(dir) {
    const targetIdx = currentIdx + dir;
    if (targetIdx < 0 || targetIdx >= deck.length) { peek.style.display = 'none'; return; }
    const q = deck[targetIdx];
    const [badge, badgeCls] = BADGE_MAP[q.section] || [q.section, 'badge-p1'];

    document.getElementById('peekNum').textContent = `第 ${q.num} 題`;
    peek.classList.toggle('card-seen-know',   showSeen && (activeMode === 'all' || activeMode === 'key') && marks[q.id] === 'know');
    peek.classList.toggle('card-seen-review', showSeen && (activeMode === 'all' || activeMode === 'key') && marks[q.id] === 'review');
    const sb = document.getElementById('peekSectionBadge');
    sb.textContent = badge; sb.className = 'section-badge ' + badgeCls;
    document.getElementById('peekStarBtn').classList.toggle('starred', stars.has(q.id));
    document.getElementById('peekText').textContent = q.question;
    if (!q._optOrder) {
      const keys = ['1','2','3','4'].filter(k => q.options[k]);
      q._optOrder = shuffleOpts ? keys.sort(() => Math.random() - 0.5) : keys;
    }
    const isScoped = activeMode === 'review' || activeMode === 'star';
    const peekOpt  = isScoped ? (filterSessions[filterKey()].selectedOpts?.[q.id] ?? null) : null;
    const optList  = document.getElementById('peekOptions');
    const hint     = peek.querySelector('.select-hint');
    const expBlock = document.getElementById('peekExplanationBlock');
    const expText  = document.getElementById('peekExplanationText');
    const peekTextEl = document.getElementById('peekText');
    optList.innerHTML = '';
    peek.classList.toggle('card-front', peekOpt === null);
    peek.classList.toggle('card-back',  peekOpt !== null);
    if (peekOpt !== null) {
      optList.className = 'result-options';
      q._optOrder.forEach((k, i) => {
        const div = document.createElement('div');
        const isAns    = k === q.answer;
        const isChosen = k === peekOpt;
        let extraClass = '', tag = '';
        if (isAns && isChosen) { extraClass = 'is-correct';      tag = '<span class="result-tag">✓ 正確</span>'; }
        else if (isAns)        { extraClass = 'is-correct';      tag = '<span class="result-tag">✓ 正確</span>'; }
        else if (isChosen)     { extraClass = 'is-chosen-wrong'; tag = '<span class="result-tag">✗ 你的選擇</span>'; }
        div.className = `result-opt ${extraClass}`;
        div.innerHTML = `<span class="opt-label">(${i + 1})</span><span>${q.options[k]}</span>${tag}`;
        optList.appendChild(div);
      });
      if (hint) hint.style.display = 'none';
      peekTextEl.style.cssText = 'font-size:16px;line-height:1.65;color:var(--text-dim);font-weight:400';
      expText.textContent = remapExplanation(q.explanation, q._optOrder) || '請參閱相關教材。';
      expBlock.style.display = '';
    } else {
      optList.className = 'options-list';
      q._optOrder.forEach((k, i) => {
        const btn = document.createElement('button');
        btn.className = 'option-btn';
        btn.innerHTML = `<span class="opt-label">(${i + 1})</span><span>${q.options[k]}</span>`;
        optList.appendChild(btn);
      });
      if (hint) hint.style.display = '';
      peekTextEl.style.cssText = '';
      expBlock.style.display = 'none';
    }
    peek.style.transition = 'none';
    peek.style.transform  = 'translateY(20px) scale(0.95)';
    peek.style.opacity    = '0.5';
    peek.style.display    = 'flex';
  }

  function hidePeek() {
    peek.style.display    = 'none';
    peek.style.transform  = '';
    peek.style.opacity    = '';
    peek.style.transition = '';
  }

  function snapBack() {
    wrap.style.transition = 'transform 0.3s cubic-bezier(0.34,1.4,0.64,1), opacity 0.22s ease';
    wrap.style.transform  = '';
    wrap.style.opacity    = '';
    setTimeout(() => { wrap.style.transition = ''; }, 300);
  }

  function peekBack() {
    peek.style.transition = 'transform 0.25s ease, opacity 0.25s ease';
    peek.style.transform  = 'translateY(20px) scale(0.95)';
    peek.style.opacity    = '0';
    setTimeout(hidePeek, 250);
  }

  wrap.addEventListener('touchstart', e => {
    if (e.touches.length !== 1) return;
    x0 = e.touches[0].clientX;
    y0 = e.touches[0].clientY;
    t0 = Date.now();
    threshold  = window.innerWidth * 0.3;
    dragging   = true;
    swipeDir   = 0;
    atBoundary = false;
    axis       = null;
    wrap.style.transition = 'none';
  }, { passive: true });

  wrap.addEventListener('touchmove', e => {
    if (!dragging || x0 === null) return;
    const dx = e.touches[0].clientX - x0;
    const dy = e.touches[0].clientY - y0;

    // Lock axis on first movement past 6px
    if (axis === null && (Math.abs(dx) > 6 || Math.abs(dy) > 6)) {
      axis = Math.abs(dx) >= Math.abs(dy) ? 'x' : 'y';
    }
    if (axis === 'y') { dragging = false; snapBack(); peekBack(); return; }
    if (axis !== 'x') return;

    e.preventDefault(); // block page scroll while swiping horizontally

    const dir = dx < 0 ? 1 : -1;
    if (swipeDir !== dir) {
      swipeDir   = dir;
      atBoundary = (dir === -1 && currentIdx === 0);
      if (!atBoundary) showPeek(dir); // showPeek returns early with no peek when targetIdx >= deck.length
    }

    if (atBoundary) {
      const resist = dx * 0.22;
      wrap.style.transform = `translateX(${resist}px) rotate(${resist * 0.02}deg)`;
      wrap.style.opacity   = String(1 - Math.abs(resist) / (window.innerWidth * 1.5));
    } else {
      const p = Math.min(Math.abs(dx) / threshold, 1);
      wrap.style.transform = `translateX(${dx}px) rotate(${dx * 0.02}deg)`;
      wrap.style.opacity   = '1';
      peek.style.transition = 'none';
      peek.style.transform  = `translateY(${20 * (1 - p)}px) scale(${0.95 + 0.05 * p})`;
      peek.style.opacity    = String(0.5 + 0.5 * p);
    }
  }, { passive: false });

  wrap.addEventListener('touchend', e => {
    if (!dragging || x0 === null) return;
    const dx = e.changedTouches[0].clientX - x0;
    dragging = false;

    const velocity = Math.abs(dx) / (Date.now() - t0);
    const fastSwipe = velocity >= 0.4 && Math.abs(dx) >= 20;
    if (!atBoundary && (Math.abs(dx) >= threshold || fastSwipe)) {
      const dir = dx < 0 ? 1 : -1;
      wrap.style.transition = 'transform 0.22s ease, opacity 0.22s ease';
      wrap.style.transform  = `translateX(${dir * -115}%) rotate(${dir * -5}deg)`;
      wrap.style.opacity    = '0';
      peek.style.transition = 'transform 0.22s ease, opacity 0.22s ease';
      peek.style.transform  = 'translateY(0) scale(1)';
      peek.style.opacity    = '1';
      setTimeout(() => {
        wrap.style.transition = 'none';
        wrap.style.transform  = '';
        wrap.style.opacity    = '0';
        if (dx < 0) nextCard(); else prevCard();
        requestAnimationFrame(() => {
          wrap.style.opacity = '';
          hidePeek();
        });
      }, 220);
    } else {
      snapBack();
      peekBack();
    }
    x0 = null; y0 = null; swipeDir = 0; atBoundary = false; axis = null;
  }, { passive: true });
})();

// ── Segment badge pop animation ───────────────────────────────────────────────
function updateSegBadge(id, value) {
  const el = document.getElementById(id);
  const newVal = String(value);
  if (el.textContent === newVal) return;
  el.textContent = newVal;
  el.classList.remove('badge-pop');
  void el.offsetWidth;
  el.classList.add('badge-pop');
}

// ── Announcement modal ───────────────────────────────────────────────────────
const _bubbleSharedTips = [
  '💡 長按「下一題」可跳到下一個未做過的題目！',
  '💡 長按「上一題」可直接跳回第一題！',
  '💡 長按「全部」可快速切換科目！',
  '💡 長按「待複習」可清除複習進度重新開始！',
  '💡 長按「星號」可清除目前科目的全部星號！',
  '💡 左右滑動卡片可切換上一題 / 下一題！',
];
const _bubbleMsgsDay   = ['汪汪～汪汪～', '肚子好餓...', '✅新增投資型考題'];
const _bubbleMsgsNight = ['Zzz....', '肉肉...好吃...', '✅新增投資型考題'];
let _bubbleTips = [..._bubbleSharedTips, ..._bubbleMsgsDay];
let _bubbleMsgs = _bubbleMsgsDay;
let _bubbleMsgIdx = 0;
let _lastTipIdx = -1;
let _typewriterTimer = null;

function _isTaipeiNight() {
  const h = parseInt(new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Taipei', hour: 'numeric', hour12: false }).format(new Date()));
  return h >= 21 || h < 6;
}

function typewriteBubble(text) {
  const el = document.querySelector('.announce-bubble');
  if (_typewriterTimer) clearInterval(_typewriterTimer);
  el.textContent = '';
  const chars = Array.from(text);
  let i = 0;
  _typewriterTimer = setInterval(() => {
    el.textContent += chars[i++];
    if (i >= chars.length) { clearInterval(_typewriterTimer); _typewriterTimer = null; }
  }, 80);
}

function openAnnouncement() {
  const btn = document.querySelector('.hdr-info-btn');
  btn.classList.remove('jelly');
  void btn.offsetWidth;
  btn.classList.add('jelly');
  const backdrop = document.getElementById('announceBackdrop');
  backdrop.removeAttribute('inert');
  backdrop.classList.add('open');
  const scrollY = window.scrollY;
  document.body.style.position = 'fixed';
  document.body.style.top = `-${scrollY}px`;
  document.body.style.width = '100%';
  const night = _isTaipeiNight();
  _bubbleMsgs = night ? _bubbleMsgsNight : _bubbleMsgsDay;
  _bubbleTips = [..._bubbleSharedTips, ..._bubbleMsgs];
  const shibaEl = document.querySelector('.announce-shiba');
  shibaEl.src = night ? 'src/imgs/shiba_sleeping.png' : 'src/imgs/shiba_sitting.png';
  shibaEl.style.width = night ? '210px' : '';
  shibaEl.classList.toggle('breathing', night);
  _bubbleMsgIdx = 0;
  document.querySelector('.announce-bubble').textContent = '';
  setTimeout(() => typewriteBubble(_bubbleMsgs[0]), 300);
}
function closeAnnouncement() {
  const backdrop = document.getElementById('announceBackdrop');
  backdrop.classList.remove('open');
  backdrop.setAttribute('inert', '');
  if (_typewriterTimer) { clearInterval(_typewriterTimer); _typewriterTimer = null; }
  const scrollY = Math.abs(parseInt(document.body.style.top || '0'));
  document.body.style.position = '';
  document.body.style.top = '';
  document.body.style.width = '';
  window.scrollTo(0, scrollY);
}

// ── Confirm modal ────────────────────────────────────────────────────────────
function showConfirm({ message, confirmLabel = '確定', danger = false }) {
  return new Promise(resolve => {
    const backdrop = document.getElementById('modalBackdrop');
    document.getElementById('modalMsg').textContent = message;
    const okBtn     = document.getElementById('modalOk');
    const cancelBtn = document.getElementById('modalCancel');
    okBtn.textContent = confirmLabel;
    okBtn.classList.toggle('danger', danger);
    backdrop.removeAttribute('inert');
    backdrop.classList.add('open');

    function done(result) {
      backdrop.classList.remove('open');
      backdrop.setAttribute('inert', '');
      resolve(result);
    }
    okBtn.addEventListener('click',     () => done(true),  { once: true });
    cancelBtn.addEventListener('click', () => done(false), { once: true });
  });
}

// ── Settings sheet ───────────────────────────────────────────────────────────
let _sheetScrollY = 0;
function _lockScroll() {
  _sheetScrollY = window.scrollY;
  document.body.style.position = 'fixed';
  document.body.style.top = `-${_sheetScrollY}px`;
  document.body.style.width = '100%';
}
function _unlockScroll() {
  document.body.style.position = '';
  document.body.style.top = '';
  document.body.style.width = '';
  window.scrollTo(0, _sheetScrollY);
}

function openSettingsSheet() {
  document.querySelectorAll('.hdr-gear-btn').forEach(btn => {
    btn.classList.remove('jelly');
    void btn.offsetWidth;
    btn.classList.add('jelly');
  });
  if (window.innerWidth > 767) {
    document.getElementById('settingsPopover').classList.toggle('open');
    return;
  }
  _lockScroll();
  document.getElementById('sheetBackdrop').classList.add('open');
}
function closeSettingsPopover() {
  document.getElementById('settingsPopover').classList.remove('open');
}
function closeSettingsSheet() {
  const panel = document.getElementById('settingsSheetPanel');
  panel.style.transition = 'transform 0.24s ease-in';
  document.getElementById('sheetBackdrop').classList.remove('open');
  setTimeout(() => { panel.style.transition = ''; _unlockScroll(); }, 240);
}

// ── Sheet drag-to-dismiss ─────────────────────────────────────────────────────
(function () {
  let startY = null, t0 = 0;
  const panel = document.getElementById('settingsSheetPanel');

  panel.addEventListener('touchstart', e => {
    if (!document.getElementById('sheetBackdrop').classList.contains('open')) return;
    const touchY = e.touches[0].clientY;
    const panelTop = panel.getBoundingClientRect().top;
    if (touchY - panelTop > 64) return; // 僅 handle + 標題區觸發
    startY = touchY;
    t0 = Date.now();
    panel.style.transition = 'none';
  }, { passive: true });

  panel.addEventListener('touchmove', e => {
    if (startY === null) return;
    const dy = e.touches[0].clientY - startY;
    const offset = dy > 0 ? dy : dy * 0.2;
    panel.style.transform = `translateY(${offset}px)`;
  }, { passive: true });

  panel.addEventListener('touchend', e => {
    if (startY === null) return;
    const dy = e.changedTouches[0].clientY - startY;
    const velocity = dy / (Date.now() - t0);
    startY = null;

    if (dy > 80 || velocity > 0.45) {
      panel.style.transition = 'transform 0.22s ease-in';
      panel.style.transform = 'translateY(100%)';
      document.getElementById('sheetBackdrop').classList.remove('open');
      setTimeout(() => {
        panel.style.transition = '';
        panel.style.transform = '';
        _unlockScroll();
      }, 220);
    } else {
      panel.style.transition = 'transform 0.3s cubic-bezier(0.34,1.56,0.64,1)';
      panel.style.transform = 'translateY(0)';
      setTimeout(() => {
        panel.style.transition = '';
        panel.style.transform = '';
      }, 300);
    }
  }, { passive: true });
})();

// ── Segmented control ─────────────────────────────────────────────────────────
async function setSegment(seg) {
  const mode = seg === 'all' ? 'all' : seg;
  if (mode === activeMode) return;
  await setMode(mode);
  // Always sync UI after await — if user cancelled the confirm, setMode returned early
  // without calling syncFilterUI, leaving seg-btn active classes in the drag hover state.
  syncFilterUI();
  const thumb = document.getElementById('segThumb');
  thumb.classList.remove('jelly');
  void thumb.offsetWidth;
  thumb.classList.add('jelly');
}

// Sections whose JSON contains 精選 (q.star) questions; the 精選 segment is
// only shown for those subjects. Populated once after data load.
let SECTIONS_WITH_KEY = new Set();
function subjectHasKey() {
  return SECTIONS_WITH_KEY.has(SUBJECT_MAP[activeSubject].section);
}
function visibleSegs() {
  return subjectHasKey() ? ['all', 'review', 'key', 'star'] : ['all', 'review', 'star'];
}

function updateSegThumb() {
  const order = visibleSegs();
  const idx = Math.max(0, order.indexOf(activeMode));
  const n = order.length;
  const thumb = document.getElementById('segThumb');
  thumb.style.left  = `calc(${idx * 100 / n}% + 3px)`;
  thumb.style.width = `calc(${100 / n}% - 6px)`;
}

// ── Segmented control drag ────────────────────────────────────────────────────
(function () {
  const ctrl = document.querySelector('.seg-ctrl');
  const thumb = document.getElementById('segThumb');
  let x0 = null, y0 = null, axis = null, dragging = false, dragHover = -1;

  function getIdx(clientX) {
    const r = ctrl.getBoundingClientRect();
    return Math.max(0, Math.min(visibleSegs().length - 1, Math.floor((clientX - r.left) / r.width * visibleSegs().length)));
  }

  function trackFinger(clientX) {
    const r = ctrl.getBoundingClientRect();
    const trackW = r.width - 6, thumbW = trackW / visibleSegs().length;
    const px = Math.max(3, Math.min(3 + trackW - thumbW, clientX - r.left - thumbW / 2));
    thumb.style.left = px + 'px';
    const idx = getIdx(clientX);
    if (idx !== dragHover) {
      dragHover = idx;
      const activeSeg = visibleSegs()[idx];
      document.querySelectorAll('.seg-btn').forEach(b => b.classList.toggle('active', b.dataset.seg === activeSeg));
    }
  }

  ctrl.addEventListener('touchstart', e => {
    x0 = e.touches[0].clientX;
    y0 = e.touches[0].clientY;
    axis = null; dragging = false;
    dragHover = visibleSegs().indexOf(activeMode);
  }, { passive: true });

  ctrl.addEventListener('touchmove', e => {
    if (x0 === null) return;
    const dx = Math.abs(e.touches[0].clientX - x0);
    const dy = Math.abs(e.touches[0].clientY - y0);
    if (!axis && (dx > 6 || dy > 6)) axis = dx >= dy ? 'h' : 'v';
    if (axis !== 'h') return;
    if (!dragging) { dragging = true; thumb.style.transition = 'none'; }
    trackFinger(e.touches[0].clientX);
  }, { passive: true });

  ctrl.addEventListener('touchend', e => {
    if (x0 === null) return;
    const endX = e.changedTouches[0].clientX;
    const dx = endX - x0, dy = e.changedTouches[0].clientY - y0;
    const wasDragging = dragging;
    dragging = false;

    if (wasDragging) {
      const snapSeg = visibleSegs()[dragHover >= 0 ? dragHover : visibleSegs().indexOf(activeMode)];
      thumb.style.transition = '';
      dragHover = -1; x0 = y0 = null; axis = null;
      if (snapSeg !== activeMode) {
        setSegment(snapSeg);
      } else {
        syncFilterUI();
        thumb.classList.remove('jelly'); void thumb.offsetWidth; thumb.classList.add('jelly');
      }
    } else if (Math.abs(dx) >= 35 && Math.abs(dx) > Math.abs(dy)) {
      // fast swipe (finger moved too quickly to enter drag mode)
      const idx = visibleSegs().indexOf(activeMode);
      const next = dx < 0 ? Math.min(idx + 1, visibleSegs().length - 1) : Math.max(idx - 1, 0);
      dragHover = -1; x0 = y0 = null; axis = null;
      if (next !== idx) setSegment(visibleSegs()[next]);
    } else {
      dragHover = -1; x0 = y0 = null; axis = null;
    }
  }, { passive: true });

  ctrl.addEventListener('touchcancel', () => {
    thumb.style.transition = '';
    dragging = false; dragHover = -1; x0 = y0 = null; axis = null;
    syncFilterUI();
  }, { passive: true });

  // Mouse drag support for desktop
  function snapOrSwipe(dx, wasDragging) {
    if (wasDragging) {
      const snapSeg = visibleSegs()[dragHover >= 0 ? dragHover : visibleSegs().indexOf(activeMode)];
      thumb.style.transition = '';
      ctrl.classList.remove('is-dragging');
      document.body.style.userSelect = '';
      dragHover = -1; x0 = y0 = null; axis = null;
      document.addEventListener('click', e => e.stopImmediatePropagation(), { capture: true, once: true });
      if (snapSeg !== activeMode) setSegment(snapSeg);
      else { syncFilterUI(); thumb.classList.remove('jelly'); void thumb.offsetWidth; thumb.classList.add('jelly'); }
    } else if (Math.abs(dx) >= 35) {
      const idx = visibleSegs().indexOf(activeMode);
      const next = dx < 0 ? Math.min(idx + 1, visibleSegs().length - 1) : Math.max(idx - 1, 0);
      dragHover = -1; x0 = y0 = null; axis = null;
      if (next !== idx) setSegment(visibleSegs()[next]);
    } else {
      dragHover = -1; x0 = y0 = null; axis = null;
    }
  }

  ctrl.addEventListener('mousedown', e => {
    if (e.button !== 0) return;
    x0 = e.clientX; y0 = e.clientY;
    axis = 'h'; dragging = false;
    dragHover = visibleSegs().indexOf(activeMode);
  });

  document.addEventListener('mousemove', e => {
    if (x0 === null || axis !== 'h') return;
    if (!dragging && Math.abs(e.clientX - x0) > 4) {
      dragging = true;
      thumb.style.transition = 'none';
      ctrl.classList.add('is-dragging');
      document.body.style.userSelect = 'none';
    }
    if (dragging) trackFinger(e.clientX);
  });

  document.addEventListener('mouseup', e => {
    if (x0 === null) return;
    const dx = e.clientX - x0;
    const wasDragging = dragging;
    dragging = false;
    snapOrSwipe(dx, wasDragging);
  });
})();

// ── Subject menu ─────────────────────────────────────────────────────────────
function buildSubjectMenu(listId, itemClass) {
  const container = document.getElementById(listId);
  container.innerHTML = '';
  const groups = new Map();
  for (const s of SUBJECTS) {
    if (!groups.has(s.category)) groups.set(s.category, []);
    groups.get(s.category).push(s);
  }
  const checkSvg = `<svg class="subj-check" width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 12l5 5L20 6" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  for (const [category, subjects] of groups) {
    const grp = document.createElement('div');
    grp.className = 'subj-group';
    const lbl = document.createElement('div');
    lbl.className = itemClass === 'subj-item' ? 'subj-group-label' : 'subj-sheet-group-label';
    lbl.textContent = category;
    grp.appendChild(lbl);
    for (const s of subjects) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = itemClass + (s.key === activeSubject ? ' active' : '');
      const total    = RAW_QUESTIONS.filter(q => q.section === s.section).length;
      const answered = RAW_QUESTIONS.filter(q => q.section === s.section && marks[q.id]).length;
      btn.innerHTML = `<span>${s.label}</span><span class="subj-progress">${answered}/${total}</span>${checkSvg}`;
      btn.onclick = () => selectSubject(s.key);
      grp.appendChild(btn);
    }
    container.appendChild(grp);
  }
}

function openSubjectMenu() {
  if (window.innerWidth > 767) {
    const pop = document.getElementById('subjPopover');
    if (pop.classList.contains('open')) { closeSubjectPopover(); return; }
    buildSubjectMenu('subjPopoverList', 'subj-item');
    pop.classList.add('open');
    document.getElementById('hdrCatLabel').closest('button').classList.add('menu-open');
  } else {
    buildSubjectMenu('subjSheetList', 'subj-sheet-item');
    _lockScroll();
    document.getElementById('subjSheetBackdrop').classList.add('open');
    document.getElementById('hdrCatLabel').closest('button').classList.add('menu-open');
  }
}

function closeSubjectPopover() {
  document.getElementById('subjPopover').classList.remove('open');
  document.getElementById('hdrCatLabel').closest('button').classList.remove('menu-open');
}

function closeSubjectSheet() {
  const panel = document.getElementById('subjSheetPanel');
  panel.style.transition = 'transform 0.24s ease-in';
  document.getElementById('subjSheetBackdrop').classList.remove('open');
  document.getElementById('hdrCatLabel').closest('button').classList.remove('menu-open');
  setTimeout(() => { panel.style.transition = ''; _unlockScroll(); }, 240);
}

function selectSubject(key) {
  if (window.innerWidth > 767) closeSubjectPopover();
  else closeSubjectSheet();
  setSubject(key);
}

// ── Subject sheet drag-to-dismiss ─────────────────────────────────────────────
(function () {
  let startY = null, t0 = 0;
  const panel = document.getElementById('subjSheetPanel');

  panel.addEventListener('touchstart', e => {
    if (!document.getElementById('subjSheetBackdrop').classList.contains('open')) return;
    const touchY = e.touches[0].clientY;
    if (touchY - panel.getBoundingClientRect().top > 64) return;
    startY = touchY; t0 = Date.now();
    panel.style.transition = 'none';
  }, { passive: true });

  panel.addEventListener('touchmove', e => {
    if (startY === null) return;
    const dy = e.touches[0].clientY - startY;
    panel.style.transform = `translateY(${dy > 0 ? dy : dy * 0.2}px)`;
  }, { passive: true });

  panel.addEventListener('touchend', e => {
    if (startY === null) return;
    const dy = e.changedTouches[0].clientY - startY;
    const vel = dy / (Date.now() - t0);
    startY = null;
    if (dy > 80 || vel > 0.45) {
      panel.style.transition = 'transform 0.22s ease-in';
      panel.style.transform = 'translateY(100%)';
      document.getElementById('subjSheetBackdrop').classList.remove('open');
      document.getElementById('hdrCatLabel').closest('button').classList.remove('menu-open');
      setTimeout(() => { panel.style.transition = ''; panel.style.transform = ''; _unlockScroll(); }, 220);
    } else {
      panel.style.transition = 'transform 0.3s cubic-bezier(0.34,1.56,0.64,1)';
      panel.style.transform = 'translateY(0)';
      setTimeout(() => { panel.style.transition = ''; panel.style.transform = ''; }, 300);
    }
  }, { passive: true });
})();

// ── Popover outside-click dismiss ────────────────────────────────────────────
document.addEventListener('click', e => {
  const settPop = document.getElementById('settingsPopover');
  if (settPop.classList.contains('open') && !e.target.closest('.gear-popover-wrap'))
    closeSettingsPopover();
  const subjPop = document.getElementById('subjPopover');
  if (subjPop.classList.contains('open') && !e.target.closest('.hdr-cat-wrap'))
    closeSubjectPopover();
});

// ── Long press ───────────────────────────────────────────────────────────────
function addLongPress(el, handler, delay = 600) {
  let timer = null;
  let fired = false;

  function start() {
    fired = false;
    timer = setTimeout(() => {
      fired = true;
      navigator.vibrate?.(40);
      handler();
    }, delay);
  }
  function cancel() { clearTimeout(timer); timer = null; }

  el.addEventListener('touchstart', start, { passive: true });
  el.addEventListener('touchend',   cancel);
  el.addEventListener('touchcancel', cancel);
  el.addEventListener('touchmove',  cancel);
  el.addEventListener('mousedown',  start);
  el.addEventListener('mouseup',    cancel);
  el.addEventListener('mouseleave', cancel);
  el.addEventListener('click', e => {
    if (fired) { e.stopImmediatePropagation(); fired = false; }
  }, { capture: true });
}

function jellyCtrlBtn(id) {
  const btn = document.getElementById(id);
  btn.classList.remove('jelly');
  void btn.offsetWidth;
  btn.classList.add('jelly');
}
addLongPress(document.getElementById('btnPrev'), () => { jellyCtrlBtn('btnPrev'); goToFirst(); });
addLongPress(document.getElementById('btnNext'), () => { jellyCtrlBtn('btnNext'); goToNextUnseen(); });
addLongPress(document.querySelector('.seg-btn[data-seg="all"]'), openSubjectMenu);
addLongPress(document.querySelector('.seg-btn[data-seg="review"]'), async () => {
  const ok = await showConfirm({ message: '確定要清除複習進度並重新開始嗎？', confirmLabel: '重新開始' });
  if (ok) restartDeck('review');
});
addLongPress(document.querySelector('.seg-btn[data-seg="star"]'), resetStarsForSubject);

document.querySelector('.announce-bubble').addEventListener('click', () => {
  let idx;
  do { idx = Math.floor(Math.random() * _bubbleTips.length); } while (idx === _lastTipIdx && _bubbleTips.length > 1);
  _lastTipIdx = idx;
  typewriteBubble(_bubbleTips[idx]);
});

// ── 意見回饋表單 → Firebase Realtime Database ──────────────────────────────────
const FEEDBACK_CD_MS = 60_000;        // 送出後 60 秒冷卻
const _feedbackInput    = document.getElementById('feedbackInput');
const _feedbackInputRow = document.getElementById('feedbackInputRow');
const _feedbackSent     = document.getElementById('feedbackSent');
const _feedbackCd       = document.getElementById('feedbackCd');
let _feedbackCdTimer = null;

function _autoGrowFeedback() {
  _feedbackInput.style.height = 'auto';
  _feedbackInput.style.height = Math.min(_feedbackInput.scrollHeight, 120) + 'px';
}
_feedbackInput.addEventListener('input', _autoGrowFeedback);

function _feedbackCdEnd() {
  return parseInt(localStorage.getItem('flashcard_feedback_cd') || '0', 10);
}
function _tickFeedbackCd() {
  const remain = _feedbackCdEnd() - Date.now();
  if (remain <= 0) {
    if (_feedbackCdTimer) { clearInterval(_feedbackCdTimer); _feedbackCdTimer = null; }
    _feedbackSent.hidden = true;
    _feedbackInputRow.hidden = false;
    return;
  }
  _feedbackInputRow.hidden = true;
  _feedbackSent.hidden = false;
  _feedbackCd.textContent = `${Math.ceil(remain / 1000)} 秒後可再傳送`;
}
function _refreshFeedbackCd() {
  if (_feedbackCdTimer) { clearInterval(_feedbackCdTimer); _feedbackCdTimer = null; }
  _tickFeedbackCd();
  if (_feedbackCdEnd() > Date.now()) _feedbackCdTimer = setInterval(_tickFeedbackCd, 1000);
}
_refreshFeedbackCd();   // 頁面載入時若仍在冷卻中，直接顯示倒數狀態

document.getElementById('feedbackForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input   = _feedbackInput;
  const sendBtn = document.getElementById('feedbackSend');
  const status  = document.getElementById('feedbackStatus');
  const message = input.value.trim();
  if (!message) { input.focus(); return; }
  if (typeof window.firebaseSendFeedback !== 'function') {
    status.textContent = '⚠️ 連線初始化中，請稍候再試一次';
    status.className = 'feedback-status error';
    return;
  }
  sendBtn.disabled = true;
  sendBtn.textContent = '送出中…';
  status.textContent = '';
  status.className = 'feedback-status';
  try {
    await window.firebaseSendFeedback(message, {
      subject: activeSubject,
      version: (document.querySelector('.announce-version')?.textContent || '').trim(),
      ua: navigator.userAgent,
    });
    input.value = '';
    _autoGrowFeedback();
    localStorage.setItem('flashcard_feedback_cd', String(Date.now() + FEEDBACK_CD_MS));
    _refreshFeedbackCd();   // 切換成「已送出 + 倒數」
  } catch (err) {
    console.error('feedback send failed', err);
    status.textContent = '⚠️ 送出失敗，請稍後再試';
    status.className = 'feedback-status error';
  } finally {
    sendBtn.disabled = false;
    sendBtn.textContent = '送出';
  }
});
function _spawnBone(shibaEl) {
  const rect = shibaEl.getBoundingClientRect();
  const el = document.createElement('span');
  el.textContent = '🍖';
  el.style.cssText = `position:fixed;left:${rect.left + rect.width * 0.15}px;top:${rect.top + rect.height * 0.05}px;font-size:42px;pointer-events:none;z-index:600;opacity:0;`;
  document.body.appendChild(el);
  el.animate([
    { opacity: 0, transform: 'translateY(0px)' },
    { opacity: 1, transform: 'translateY(-20px)', offset: 0.12 },
    { opacity: 1, transform: 'translateY(-26px)', offset: 0.75 },
    { opacity: 0, transform: 'translateY(-54px)' }
  ], { duration: 2800, easing: 'ease-out' }).onfinish = () => el.remove();
}

const _shibaClickTimes = [];
document.querySelector('.announce-shiba').addEventListener('click', () => {
  const el = document.querySelector('.announce-shiba');
  const wasBreathing = el.classList.contains('breathing');
  el.classList.remove('jelly', 'breathing');
  void el.offsetWidth;
  el.classList.add('jelly');
  el.addEventListener('animationend', () => {
    el.classList.remove('jelly');
    if (wasBreathing) el.classList.add('breathing');
  }, { once: true });

  const now = Date.now();
  _shibaClickTimes.push(now);
  const recent = _shibaClickTimes.filter(t => now - t < 1500);
  _shibaClickTimes.length = 0;
  _shibaClickTimes.push(...recent);
  if (recent.length >= 5) {
    _shibaClickTimes.length = 0;
    if (_isTaipeiNight()) {
      _spawnBone(el);
    } else {
      const angry = document.getElementById('shibaAngry');
      angry.classList.remove('show');
      void angry.offsetWidth;
      angry.classList.add('show');
    }
  }
});

// ── Boot ──────────────────────────────────────────────────────────────────────
init();

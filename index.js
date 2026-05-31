import { getContext } from "../../../extensions.js";

// ── 대용량 저장소(IndexedDB) 설정 ────────
const DB_NAME = 'ThemeImageManagerDB';
const STORE_NAME = 'images';
let dbInstance = null;

function initDB() {
    return new Promise((resolve, reject) => {
        if (dbInstance) return resolve(dbInstance);
        const request = indexedDB.open(DB_NAME, 1);
        request.onupgradeneeded = (e) => {
            const db = e.target.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME);
        };
        request.onsuccess = (e) => { dbInstance = e.target.result; resolve(dbInstance); };
        request.onerror = (e) => reject(e.target.error);
    });
}

async function loadImagesFromDB(uid) {
    const db = await initDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const store = tx.objectStore(STORE_NAME);
        const request = store.get(uid);
        request.onsuccess = () => resolve(request.result || {});
        request.onerror = () => reject(request.error);
    });
}

async function saveImagesToDB(uid, data) {
    const db = await initDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        const request = store.put(data, uid);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
    });
}

// ── 기본 변수 및 상태 ────────
let isExtensionEnabled = localStorage.getItem('tie_is_enabled') !== 'false';
let isShowButton = localStorage.getItem('tie_show_button') !== 'false';

let currentUid = 'DEFAULT_COMMON';
let currentImageCache = {};
let panelOpen = false;
let headObserver = null;

// ── ✅ 제미나이 개선: getContext() 공식 API 사용으로 UID 정확도 향상 ────────
function getCharUID() {
    try {
        const context = getContext();
        if (!context) return 'DEFAULT_COMMON';

        if (context.groupId) return 'GROUP_' + context.groupId;

        if (context.characterId !== undefined && context.characterId !== null) {
            let uidStr = 'CHID_' + context.characterId;
            if (context.characters && context.characters[context.characterId]) {
                const char = context.characters[context.characterId];
                if (char.avatar) uidStr += '_' + char.avatar;
                else if (char.name) uidStr += '_' + char.name;
            } else if (context.name2) {
                uidStr += '_' + context.name2;
            }
            return uidStr;
        }
    } catch (err) {
        console.warn("[테마 편집기] 식별 오류:", err);
    }
    return 'DEFAULT_COMMON';
}

function getCharDisplayName() {
    try {
        const context = getContext();
        if (context && context.groupId) return '그룹채팅';
        if (context && context.name2) return context.name2;
    } catch (err) {}
    return '기본(공통)';
}

// ── CSS 원본 소스 찾기 ────────
function findCSSSource() {
    const pu = window.power_user && window.power_user.custom_css;
    if (pu && pu.length > 100) return { css: pu, type: 'power_user' };

    const sheets = document.styleSheets;
    for (let i = 0; i < sheets.length; i++) {
        const sheet = sheets[i];
        if (sheet.ownerNode && sheet.ownerNode.tagName === 'STYLE') {
            const id = sheet.ownerNode.id;
            if (id === 'tie-override-css') continue;
            const txt = sheet.ownerNode.textContent || '';
            if (txt.includes('--sm-bg') || txt.includes('mes_block')) {
                return { css: txt, type: 'style_tag', node: sheet.ownerNode };
            }
        }
    }

    let best = null, bestLen = 500;
    const allStyles = document.querySelectorAll('style:not(#tie-override-css)');
    for (let j = 0; j < allStyles.length; j++) {
        const t = allStyles[j].textContent || '';
        if (t.length > bestLen && t.includes('background-image')) {
            bestLen = t.length;
            best = allStyles[j];
        }
    }
    if (best) return { css: best.textContent, type: 'style_tag', node: best };
    return null;
}

// ── 실시간 캐시 갱신 및 덮어쓰기 ────────
// ✅ 내 수정: IMG_RE 전역 선언 제거 - 함수 안에서 매번 새로 생성해야 안전

async function refreshCacheAndApply() {
    if (!isExtensionEnabled) {
        applyImageOverrides();
        return;
    }
    const newUid = getCharUID();
    console.log('[Theme Image Manager] 현재 적용 대상 UID:', newUid);
    currentUid = newUid;
    currentImageCache = await loadImagesFromDB(currentUid);
    applyImageOverrides();
}

function applyImageOverrides() {
    if (headObserver) headObserver.disconnect();

    let s = document.getElementById('tie-override-css');
    if (!s) {
        s = document.createElement('style');
        s.id = 'tie-override-css';
        document.head.appendChild(s);
    }

    // ✅ 내 수정 핵심: 봇 전환 시 이전 이미지 잔존 방지 - 항상 먼저 초기화
    s.textContent = '';

    if (!isExtensionEnabled || Object.keys(currentImageCache).length === 0) {
        startObservingHead();
        return;
    }

    const src = findCSSSource();
    if (!src) {
        startObservingHead();
        return;
    }

    const css = src.css;
    const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
    const blockRe = /([^{}]+)\{([^{}]*)\}/g;
    let m;
    let overrideCss = '';

    while ((m = blockRe.exec(clean)) !== null) {
        const rawSel = m[1].trim();
        const body = m[2];
        let matchFound = false;
        let newBody = body;

        // ✅ 내 수정 핵심: 블록마다 새 정규식 인스턴스 생성으로 lastIndex 오염 원천 차단
        const imgRe = /url\(\s*['"]?((?:https?:\/\/(?!fontsapi|cdn\.jsdelivr|fonts\.g)[^'")\s]+)|(?:data:image\/[^'")\s]+))['"]?\s*\)/gi;
        let um;
        while ((um = imgRe.exec(body)) !== null) {
            const url = um[1];
            if (currentImageCache[url]) {
                const escapedUrl = url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                newBody = newBody.replace(new RegExp(escapedUrl, 'g'), currentImageCache[url]);
                matchFound = true;
            }
        }
        if (matchFound) overrideCss += rawSel + ' {' + newBody + '} \n';
    }

    s.textContent = overrideCss;
    startObservingHead();
}

function startObservingHead() {
    if (!isExtensionEnabled) return;
    if (!headObserver) headObserver = new MutationObserver(applyImageOverrides);
    headObserver.observe(document.head, { childList: true, subtree: true, characterData: true });
}

// ── 이미지 URL 스캔 ────────
function scanImages() {
    const src = findCSSSource();
    if (!src) return [];

    const css = src.css;
    const seen = {};
    const list = [];
    const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
    const blockRe = /([^{}]+)\{([^{}]*)\}/g;
    let m;

    while ((m = blockRe.exec(clean)) !== null) {
        const rawSel = m[1].trim();
        const body = m[2];

        // ✅ 내 수정: 여기도 지역 변수로 선언
        const imgRe = /url\(\s*['"]?((?:https?:\/\/(?!fontsapi|cdn\.jsdelivr|fonts\.g)[^'")\s]+)|(?:data:image\/[^'")\s]+))['"]?\s*\)/gi;
        let um;
        while ((um = imgRe.exec(body)) !== null) {
            const url = um[1];
            if (seen[url]) {
                seen[url].count++;
            } else {
                let label = '기타 테마 이미지';
                if (rawSel.includes('is_user') && rawSel.includes('mes_text')) label = '유저 배너 이미지';
                else if (rawSel.includes('mes_text')) label = '캐릭터 배너 이미지';
                else if (rawSel.includes('is_user') && rawSel.includes('mes_block')) label = '유저 폴라로이드';
                else if (rawSel.includes('mes_block')) label = '캐릭터 폴라로이드';
                else if (rawSel.includes('is_user') && rawSel.includes('ch_name')) label = '유저 헤더 카드';
                else if (rawSel.includes('ch_name')) label = '캐릭터 헤더 카드';

                const entry = { url: url, selector: rawSel, label: label, count: 1 };
                seen[url] = entry;
                list.push(entry);
            }
        }
    }
    return list;
}

// ── 고화질 이미지 압축(WebP) ────────
function processAndCompressImage(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (e) => {
            const img = new Image();
            img.onload = () => {
                const canvas = document.createElement('canvas');
                let width = img.width;
                let height = img.height;
                const maxDim = 1500;

                if (width > maxDim || height > maxDim) {
                    if (width > height) { height = Math.round((height * maxDim) / width); width = maxDim; }
                    else { width = Math.round((width * maxDim) / height); height = maxDim; }
                }
                canvas.width = width;
                canvas.height = height;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0, width, height);
                resolve(canvas.toDataURL('image/webp', 0.9));
            };
            img.onerror = () => reject(new Error("이미지를 불러올 수 없습니다."));
            img.src = e.target.result;
        };
        reader.onerror = () => reject(new Error("파일을 읽을 수 없습니다."));
        reader.readAsDataURL(file);
    });
}

// ── 패널 UI ────────
function openPanel() {
    closePanel();
    panelOpen = true;
    const charName = getCharDisplayName();

    const backdrop = document.createElement('div');
    backdrop.id = 'tie-backdrop';
    backdrop.addEventListener('click', closePanel);
    document.body.appendChild(backdrop);

    const panel = document.createElement('div');
    panel.id = 'tie-panel';
    panel.innerHTML = `
        <div id="tie-panel-head">
          <span>🖼️ 이미지 매니저 (<span id="tie-dynamic-header" style="color: #D9AAB7; font-weight: bold;">${charName}</span>)</span>
          <div>
            <button id="tie-panel-reset" style="background: #e74c3c; color: white; border: none; border-radius: 6px; padding: 4px 10px; cursor: pointer; font-size: 12px; font-weight: bold; margin-right: 10px; transition: 0.2s;">이 봇 초기화</button>
            <button id="tie-panel-close" title="닫기">&times;</button>
          </div>
        </div>
        <div id="tie-panel-desc">이 봇에게만 적용될 이미지를 설정합니다.</div>
        <div id="tie-img-grid"></div>
        <div id="tie-panel-status"></div>
    `;
    document.body.appendChild(panel);

    document.getElementById('tie-panel-close').addEventListener('click', closePanel);

    document.getElementById('tie-panel-reset').addEventListener('click', async () => {
        if (confirm('이 캐릭터에 적용된 커스텀 이미지를 모두 지우고 원본 테마로 초기화하시겠습니까?')) {
            currentImageCache = {};
            await saveImagesToDB(currentUid, currentImageCache);
            applyImageOverrides();
            renderImageGrid();
            setStatus('✅ 원본 테마로 초기화되었습니다.', 'ok');
        }
    });

    renderImageGrid();
}

function renderImageGrid() {
    const grid = document.getElementById('tie-img-grid');
    if (!grid) return;
    grid.innerHTML = '';

    const images = scanImages();

    if (!images.length) {
        grid.innerHTML = '<div style="padding:20px;text-align:center;opacity:0.5;font-size:13px">테마 CSS에서 이미지를 찾지 못했어요.</div>';
        return;
    }

    images.forEach((img, i) => {
        const card = document.createElement('div');
        card.className = 'tie-img-card';
        card.dataset.index = i;

        const displayUrl = currentImageCache[img.url] || img.url;

        const thumb = document.createElement('div');
        thumb.className = 'tie-thumb';
        thumb.style.backgroundImage = `url("${displayUrl}")`;

        const overlay = document.createElement('div');
        overlay.className = 'tie-card-overlay';
        overlay.innerHTML = '<span>클릭해서 교체</span>';
        thumb.appendChild(overlay);

        const info = document.createElement('div');
        info.className = 'tie-card-info';
        info.innerHTML = `
            <div class="tie-card-label">${img.label}</div>
            <div class="tie-card-sel">${img.selector.slice(0, 36)}${img.selector.length > 36 ? '…' : ''}</div>
        `;

        card.appendChild(thumb);
        card.appendChild(info);

        card.addEventListener('click', () => pickFile(img, card, thumb));
        grid.appendChild(card);
    });
}

function pickFile(entry, card, thumb) {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = async () => {
        const file = input.files[0];
        if (!file) return;

        card.classList.add('tie-loading');
        thumb.style.opacity = '0.5';

        try {
            const dataUrl = await processAndCompressImage(file);
            const charName = getCharDisplayName();

            currentImageCache[entry.url] = dataUrl;
            await saveImagesToDB(currentUid, currentImageCache);

            applyImageOverrides();

            thumb.style.backgroundImage = `url("${dataUrl}")`;
            thumb.style.opacity = '';
            card.classList.remove('tie-loading');
            card.classList.add('tie-done');
            setStatus(`✅ 교체 완료! (${charName} 봇 전용 저장)`, 'ok');

        } catch (err) {
            card.classList.remove('tie-loading');
            thumb.style.opacity = '';
            setStatus(err.message, 'error');
        }
    };
    input.click();
}

function setStatus(msg, type) {
    const el = document.getElementById('tie-panel-status');
    if (!el) return;
    el.textContent = msg;
    el.style.color = type === 'error' ? '#e74c3c' : '#27AE60';
}

function closePanel() {
    panelOpen = false;
    const p = document.getElementById('tie-panel');
    const b = document.getElementById('tie-backdrop');
    if (p) p.remove();
    if (b) b.remove();
}

// ── 플로팅 버튼 생성 ────────
function createToggleButton() {
    let old = document.getElementById('tie-toggle-btn');
    if (old) old.remove();

    if (!isExtensionEnabled || !isShowButton) return;

    const btn = document.createElement('div');
    btn.id = 'tie-toggle-btn';
    btn.innerHTML = '📷';
    btn.title = '테마 이미지 교체';
    btn.addEventListener('click', () => panelOpen ? closePanel() : openPanel());
    document.body.appendChild(btn);
}

// ── 설정 탭에 UI 스위치 주입 ────────
function setupExtensionUI() {
    const extSettingsHtml = `
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>🖼️ 테마 이미지 매니저</b>
                <div class="inline-drawer-icon fa-solid fa-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content" style="padding: 15px 10px;">
                <label class="checkbox_label" style="display: flex; align-items: center; cursor: pointer; margin-bottom: 5px;">
                    <input type="checkbox" id="tie_enable_toggle" ${isExtensionEnabled ? 'checked' : ''}>
                    <span style="margin-left: 8px;"><b>테마 이미지 변경 효과 켜기</b></span>
                </label>
                <p style="font-size: 0.85em; color: var(--sm-text-secondary); margin: 0 0 15px 28px; line-height: 1.4;">
                    체크 해제 시 즉시 기능이 완전히 꺼지며, 원본 테마의 이미지로 돌아갑니다.
                </p>
                <label class="checkbox_label" style="display: flex; align-items: center; cursor: pointer; margin-bottom: 5px;">
                    <input type="checkbox" id="tie_btn_toggle" ${isShowButton ? 'checked' : ''}>
                    <span style="margin-left: 8px;"><b>카메라 버튼(📷) 화면에 띄우기</b></span>
                </label>
                <p style="font-size: 0.85em; color: var(--sm-text-secondary); margin: 0 0 5px 28px; line-height: 1.4;">
                    버튼만 숨길 수 있습니다. (변경된 이미지는 유지됨)
                </p>
            </div>
        </div>
    `;

    $('#extensions_settings').append(extSettingsHtml);

    $('#tie_enable_toggle').on('change', async function() {
        isExtensionEnabled = $(this).is(':checked');
        localStorage.setItem('tie_is_enabled', isExtensionEnabled);

        if (isExtensionEnabled) {
            createToggleButton();
            await refreshCacheAndApply();
        } else {
            closePanel();
            const btn = document.getElementById('tie-toggle-btn');
            if (btn) btn.remove();
            if (headObserver) headObserver.disconnect();
            const oldStyle = document.getElementById('tie-override-css');
            if (oldStyle) oldStyle.textContent = '';
        }
    });

    $('#tie_btn_toggle').on('change', function() {
        isShowButton = $(this).is(':checked');
        localStorage.setItem('tie_show_button', isShowButton);

        if (isShowButton && isExtensionEnabled) {
            createToggleButton();
        } else {
            closePanel();
            const btn = document.getElementById('tie-toggle-btn');
            if (btn) btn.remove();
        }
    });
}

function waitForST(cb, n = 0) {
    if (n > 60) return;
    if (document.body && document.getElementById('send_but')) { cb(); return; }
    setTimeout(() => waitForST(cb, n + 1), 500);
}

waitForST(() => {
    setupExtensionUI();

    refreshCacheAndApply().then(() => {
        if (isExtensionEnabled && isShowButton) createToggleButton();
    });

    // 캐릭터 변경 감지 (1초마다 검사)
    let lastCheckedUid = getCharUID();
    setInterval(() => {
        const newUid = getCharUID();
        if (newUid !== lastCheckedUid) {
            console.log('[Theme Image Manager] 캐릭터 스위칭 감지! UID:', newUid);
            lastCheckedUid = newUid;
            if (isExtensionEnabled) {
                refreshCacheAndApply().then(() => {
                    if (panelOpen) {
                        const headSpan = document.getElementById('tie-dynamic-header');
                        if (headSpan) headSpan.textContent = getCharDisplayName();
                        renderImageGrid();
                    }
                });
            }
        }
    }, 1000);

    console.log('[테마 이미지 편집기 v3.3] 두 버전 장점 통합 - 완전체');
});

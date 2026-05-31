import { getContext } from "../../../extensions.js";

const STORAGE_KEY = 'tie_persistent_v5_uid';
let panelOpen = false;
let headObserver = null;

// ── 캐릭터 고유 ID(UID) 가져오기 ────────
// 이름이 같아도 파일이 다르면 UID가 다르므로 완벽하게 구분됩니다.
function getCharUID() {
    const context = getContext();
    if (context && context.characterId) {
        return 'UID_' + context.characterId;
    }
    // 그룹 채팅일 경우
    if (context && context.groupId) {
        return 'GROUP_' + context.groupId;
    }
    return 'DEFAULT_COMMON';
}

// ── 캐릭터 이름 가져오기 (UI 표시용) ────────
function getCharDisplayName() {
    const context = getContext();
    if (context && context.name2) return context.name2;
    if (context && context.groupId) return '그룹채팅';
    return '기본(공통)';
}

// ── CSS 소스 찾기 ────────
function findCSSSource() {
    const pu = window.power_user && window.power_user.custom_css;
    if (pu && pu.length > 100) return { css: pu, type: 'power_user' };

    const sheets = document.styleSheets;
    for (let i = 0; i < sheets.length; i++) {
        const sheet = sheets[i];
        if (sheet.ownerNode && sheet.ownerNode.tagName === 'STYLE') {
            const txt = sheet.ownerNode.textContent || '';
            if (txt.includes('--sm-bg') || txt.includes('fontsapi.zeoseven') ||
                (txt.includes('mes_block') && txt.includes('background-image'))) {
                return { css: txt, type: 'style_tag', node: sheet.ownerNode };
            }
        }
    }

    let best = null, bestLen = 500;
    const allStyles = document.querySelectorAll('style');
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

// ── 실시간 이미지 덮어쓰기 레이어 ────────
const IMG_RE = /url\(\s*['"]?((?:https?:\/\/(?!fontsapi|cdn\.jsdelivr|fonts\.g)[^'")\s]+)|(?:data:image\/[^'")\s]+))['"]?\s*\)/gi;

function applyImageOverrides() {
    if (headObserver) headObserver.disconnect();

    const src = findCSSSource();
    if (!src) {
        const oldStyle = document.getElementById('tie-override-css');
        if (oldStyle) oldStyle.remove();
        startObservingHead();
        return;
    }

    const charUid = getCharUID(); // UID 기준!
    const allData = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    const replacements = allData[charUid] || {}; // 이 봇을 위한 전용 이미지들

    let css = src.css;
    let clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
    const blockRe = /([^{}]+)\{([^{}]*)\}/g;
    let m;
    let overrideCss = '';

    while ((m = blockRe.exec(clean)) !== null) {
        const rawSel = m[1].trim();
        const body = m[2];
        let matchFound = false;
        let newBody = body;

        IMG_RE.lastIndex = 0;
        let um;
        while ((um = IMG_RE.exec(body)) !== null) {
            const url = um[1];
            if (replacements[url]) {
                const escapedUrl = url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                newBody = newBody.replace(new RegExp(escapedUrl, 'g'), replacements[url]);
                matchFound = true;
            }
        }

        if (matchFound) {
            overrideCss += rawSel + ' {' + newBody + '} \n';
        }
    }

    let s = document.getElementById('tie-override-css');
    if (!s) {
        s = document.createElement('style');
        s.id = 'tie-override-css';
        document.head.appendChild(s);
    }
    if (s.textContent !== overrideCss) {
        s.textContent = overrideCss;
    }

    startObservingHead();
}

function startObservingHead() {
    if (!headObserver) {
        headObserver = new MutationObserver(applyImageOverrides);
    }
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
        IMG_RE.lastIndex = 0;
        let um;
        while ((um = IMG_RE.exec(body)) !== null) {
            const url = um[1];
            if (seen[url]) {
                seen[url].count++;
            } else {
                const label = guessLabel(rawSel);
                const entry = { url: url, selector: rawSel, label: label, count: 1 };
                seen[url] = entry;
                list.push(entry);
            }
        }
    }
    return list;
}

function guessLabel(sel) {
    if (sel.includes('is_user') && sel.includes('mes_text')) return '유저 배너 이미지';
    if (sel.includes('mes_text')) return '캐릭터 배너 이미지';
    if (sel.includes('is_user') && sel.includes('mes_block')) return '유저 폴라로이드';
    if (sel.includes('mes_block')) return '캐릭터 폴라로이드';
    if (sel.includes('is_user') && sel.includes('ch_name')) return '유저 헤더 카드';
    if (sel.includes('ch_name')) return '캐릭터 헤더 카드';
    return '기타 테마 이미지';
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
          <span>🖼️ 테마 이미지 (대상: <span id="tie-dynamic-header" style="color: #D9AAB7; font-weight: bold;">${charName}</span>)</span>
          <button id="tie-panel-close" title="닫기">&times;</button>
        </div>
        <div id="tie-panel-desc">이 봇에게만 적용될 이미지를 설정합니다.</div>
        <div id="tie-img-grid"></div>
        <div id="tie-panel-status"></div>
    `;
    document.body.appendChild(panel);

    document.getElementById('tie-panel-close').addEventListener('click', closePanel);
    renderImageGrid();
}

function renderImageGrid() {
    const grid = document.getElementById('tie-img-grid');
    if (!grid) return;
    grid.innerHTML = '';

    const images = scanImages();
    
    // 여기서 UID로 데이터를 가져옵니다.
    const charUid = getCharUID();
    const allData = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    const replacements = allData[charUid] || {};

    if (!images.length) {
        grid.innerHTML = '<div style="padding:20px;text-align:center;opacity:0.5;font-size:13px">테마 CSS에서 이미지를 찾지 못했어요. (원본 복구가 필요할 수 있습니다)</div>';
        return;
    }

    images.forEach((img, i) => {
        const card = document.createElement('div');
        card.className = 'tie-img-card';
        card.dataset.index = i;

        const displayUrl = replacements[img.url] || img.url;

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
    input.onchange = () => {
        const file = input.files[0];
        if (!file) return;

        card.classList.add('tie-loading');
        thumb.style.opacity = '0.5';

        const reader = new FileReader();
        reader.onload = (ev) => {
            const dataUrl = ev.target.result;
            
            // UID와 이름을 동시에 가져옴
            const charUid = getCharUID();
            const charName = getCharDisplayName();

            // 스토리(UID)별로 이미지를 분리해서 저장!
            const allData = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
            if (!allData[charUid]) allData[charUid] = {};
            allData[charUid][entry.url] = dataUrl;
            localStorage.setItem(STORAGE_KEY, JSON.stringify(allData));

            applyImageOverrides();
            
            thumb.style.backgroundImage = `url("${dataUrl}")`;
            thumb.style.opacity = '';
            card.classList.remove('tie-loading');
            card.classList.add('tie-done');
            setStatus(`✅ 교체 완료! (${charName} 봇 전용 저장)`, 'ok');
        };
        reader.onerror = () => {
            card.classList.remove('tie-loading');
            thumb.style.opacity = '';
            setStatus('❌ 파일 읽기 오류', 'error');
        };
        reader.readAsDataURL(file);
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

function createToggleButton() {
    let old = document.getElementById('tie-toggle-btn');
    if (old) old.remove();

    const btn = document.createElement('div');
    btn.id = 'tie-toggle-btn';
    btn.innerHTML = '📷';
    btn.title = '테마 이미지 교체';
    btn.addEventListener('click', () => panelOpen ? closePanel() : openPanel());
    document.body.appendChild(btn);
}

function waitForST(cb, n = 0) {
    if (n > 60) return;
    if (document.body && document.getElementById('send_but')) { cb(); return; }
    setTimeout(() => waitForST(cb, n + 1), 500);
}

waitForST(() => {
    createToggleButton();
    
    // 실리태번의 채팅 이동 이벤트를 감지
    if (window.eventSource) {
        window.eventSource.on('chatChanged', () => {
            setTimeout(() => { // 봇 정보가 업데이트될 시간을 아주 짧게 부여
                applyImageOverrides();
                if (panelOpen) {
                    const headSpan = document.getElementById('tie-dynamic-header');
                    if (headSpan) headSpan.textContent = getCharDisplayName();
                    renderImageGrid();
                }
            }, 300);
        });
    }
    
    setTimeout(applyImageOverrides, 1000); 
    console.log('[테마 이미지 편집기 v2.5] UID 기반 캐릭터 독립 저장 시스템 활성화');
});
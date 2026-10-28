// ==UserScript==
// @name         YouTube Stream Background Auditor & Sorter
// @namespace    local.yt.dimmer
// @version      45.0
// @description  Accurately dims streams over cutoff, leaves fresh streams under cutoff bright, removes duplicates, and sorts fresh streams to top.
// @match        *://*.youtube.com/*
// @match        https://*.youtube.com/*
// @match        https://youtube.com/*
// @run-at       document-end
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    // ==========================================
    // USER CONFIGURATION
    // ==========================================
    const DEFAULT_CONFIG = {
        maxHours: 2,             // Cutoff: streams older than 2h 0m are removed/dimmed
        maxMinutes: 0,
        dimOpacity: '0.25',      // Opacity for dimmed active player/cards
        dimBrightness: '0.25',   // Brightness for dimmed active player/cards
        dimGrayscale: '0.85',    // Desaturation
        removeOldVideos: true,   // true = completely hides old videos from search & recommended
        sortFreshToTop: true     // true = sorts streams started "?? minutes ago" to top
    };

    const savedHours = localStorage.getItem('yt_audit_max_hours');
    const savedMins = localStorage.getItem('yt_audit_max_mins');
    const CONFIG = {
        ...DEFAULT_CONFIG,
        maxHours: savedHours !== null ? parseInt(savedHours, 10) : DEFAULT_CONFIG.maxHours,
        maxMinutes: savedMins !== null ? parseInt(savedMins, 10) : DEFAULT_CONFIG.maxMinutes
    };

    function getMaxAllowedMinutes() {
        return (CONFIG.maxHours * 60) + CONFIG.maxMinutes;
    }

    const CYCLICAL_REGEX = /(?:24\/7|24-7|24\s*H(?:OURS?)?|\bLOOP(?:ING)?\b|\bREPLAY\b|\bRERUN\b|\bCOUNTDOWN\b|\bPRE-?RECORDED\b|\bNON-?STOP\b|\bCONTINUOUS\b|\bRESTREAM\b|\bAUTOMATED\b|\bPLAYLIST\b)/i;

    const auditCache = new Map();
    const pendingFetches = new Set();
    const loggedEntries = new Set();

    let isMinimized = false;
    let userOverrodeWatchPlayer = false;

    function createEl(tag, styles = {}, text = '') {
        const el = document.createElement(tag);
        if (styles && Object.keys(styles).length) Object.assign(el.style, styles);
        if (text) el.textContent = text;
        return el;
    }

    // 1. Universal Age Parser
    function parseAgeInMinutes(text) {
        if (!text) return null;

        // "Started streaming 9 hours ago", "Streamed 9 hours ago"
        const hourMatch = text.match(/(?:started streaming|streamed)?\s*(\d+)\s*hours?\s*ago/i);
        if (hourMatch) return parseInt(hourMatch[1], 10) * 60;

        // "Started streaming 90 minutes ago", "Started streaming 41 minutes ago"
        const minMatch = text.match(/(?:started streaming|streamed)?\s*(\d+)\s*(?:minute|min)s?\s*ago/i);
        if (minMatch) return parseInt(minMatch[1], 10);

        // "Streamed 2 days ago", "Started streaming 3 days ago"
        const dayMatch = text.match(/(?:started streaming|streamed)?\s*(\d+)\s*days?\s*ago/i);
        if (dayMatch) return parseInt(dayMatch[1], 10) * 24 * 60;

        // "Streamed 3 weeks ago"
        const weekMatch = text.match(/(?:started streaming|streamed)?\s*(\d+)\s*weeks?\s*ago/i);
        if (weekMatch) return parseInt(weekMatch[1], 10) * 7 * 24 * 60;

        // "Streamed 1 year ago"
        const yearMatch = text.match(/(?:started streaming|streamed)?\s*(\d+)\s*years?\s*ago/i);
        if (yearMatch) return parseInt(yearMatch[1], 10) * 365 * 24 * 60;

        // "Started streaming on Oct 25, 2026"
        const dateMatch = text.match(/(?:started streaming on|streamed on|streamed live on)\s+([A-Za-z]+\s+\d{1,2}(?:,\s*\d{4})?)/i);
        if (dateMatch) {
            let dateStr = dateMatch[1];
            if (!dateStr.includes(',')) dateStr += `, ${new Date().getFullYear()}`;
            const parsed = Date.parse(dateStr);
            if (!isNaN(parsed)) {
                const diffMs = Date.now() - parsed;
                if (diffMs > 0) return Math.floor(diffMs / (1000 * 60));
            }
        }
        return null;
    }

    function parseViewers(text) {
        if (!text) return null;
        const m = text.match(/([\d,.]+)\s*([kKmM]?)\s*(?:watching|viewers|वाचिंग)/i);
        if (!m) return null;
        let n = parseFloat(m[1].replace(/,/g, ''));
        const unit = (m[2] || '').toUpperCase();
        if (unit === 'K') n *= 1000;
        if (unit === 'M') n *= 1000000;
        return Math.round(n);
    }

    // 2. Background Watch Page Inspector
    function inspectWatchPageInBackground(videoId) {
        if (!videoId || auditCache.has(videoId) || pendingFetches.has(videoId)) return;
        pendingFetches.add(videoId);

        fetch(`https://www.youtube.com/watch?v=${videoId}`)
            .then(res => res.text())
            .then(html => {
                let ageMinutes = null;
                let description = '';
                let isOld = false;
                let reason = '';

                const startMatch = html.match(/"startTimestamp":"([^"]+)"/) || html.match(/itemprop="startDate" content="([^"]+)"/);
                if (startMatch && startMatch[1]) {
                    const startTime = Date.parse(startMatch[1]);
                    if (!isNaN(startTime)) {
                        ageMinutes = Math.floor((Date.now() - startTime) / (1000 * 60));
                    }
                }

                if (ageMinutes === null) {
                    ageMinutes = parseAgeInMinutes(html);
                }

                const descMatch = html.match(/"shortDescription":"((?:[^"\\]|\\.)*)"/);
                if (descMatch) {
                    try {
                        description = JSON.parse(`"${descMatch[1]}"`);
                    } catch (e) {
                        description = descMatch[1];
                    }
                }

                const maxAllowedMins = getMaxAllowedMinutes();

                if (ageMinutes !== null && ageMinutes > maxAllowedMins) {
                    isOld = true;
                    reason = `Started ${(ageMinutes / 60).toFixed(1)}h ago (> ${CONFIG.maxHours}h)`;
                } else if (CYCLICAL_REGEX.test(description)) {
                    isOld = true;
                    const m = description.match(CYCLICAL_REGEX);
                    reason = `Description keyword: "${m ? m[0] : '24/7'}"`;
                }

                auditCache.set(videoId, { ageMinutes, isOld, reason, description });
                auditEverything();
            })
            .catch(() => {
                auditCache.set(videoId, { ageMinutes: null, isOld: false, reason: 'Fetch failed' });
            })
            .finally(() => {
                pendingFetches.delete(videoId);
            });
    }

    // 3. Mount Single Audit Console Window (Clean Deduplication)
    function ensureConsole() {
        if (!document.body) return;

        // Clean up any stray duplicates caused by YouTube SPA transitions
        const existingBoxes = document.querySelectorAll('#yt-stream-audit-box');
        if (existingBoxes.length > 1) {
            for (let i = 1; i < existingBoxes.length; i++) {
                existingBoxes[i].remove();
            }
        }
        if (existingBoxes.length > 0) return;

        const box = createEl('div');
        box.id = 'yt-stream-audit-box';
        box.style.cssText = `
            position: fixed !important;
            top: 70px !important;
            right: 20px !important;
            width: 360px !important;
            max-height: 520px !important;
            background: #111111 !important;
            border: 2px solid #22c55e !important;
            border-radius: 10px !important;
            z-index: 2147483647 !important;
            box-shadow: 0 12px 40px rgba(0,0,0,0.95) !important;
            display: flex !important;
            flex-direction: column !important;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif !important;
            color: #ffffff !important;
            overflow: hidden !important;
            user-select: none !important;
        `;

        const header = createEl('div', {
            background: '#1a1a1a',
            padding: '10px 14px',
            borderBottom: '1px solid #333',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            cursor: 'grab'
        });

        const title = createEl('div', {
            fontWeight: 'bold',
            fontSize: '13px',
            display: 'flex',
            alignItems: 'center',
            gap: '8px'
        });

        const liveDot = createEl('span', {
            width: '8px',
            height: '8px',
            borderRadius: '50%',
            background: '#22c55e',
            display: 'inline-block'
        });

        const titleText = createEl('span', {}, 'Stream Auditor');
        title.appendChild(liveDot);
        title.appendChild(titleText);

        const actions = createEl('div', { display: 'flex', gap: '6px' });
        const cfgBtn = createEl('button', {
            background: '#2d2d2d',
            color: '#fff',
            border: 'none',
            padding: '2px 8px',
            borderRadius: '4px',
            cursor: 'pointer',
            fontSize: '11px'
        }, `Cutoff: ${CONFIG.maxHours}h`);

        const toggleBtn = createEl('button', {
            background: '#2d2d2d',
            color: '#fff',
            border: 'none',
            padding: '2px 8px',
            borderRadius: '4px',
            cursor: 'pointer',
            fontSize: '12px'
        }, '—');

        actions.appendChild(cfgBtn);
        actions.appendChild(toggleBtn);
        header.appendChild(title);
        header.appendChild(actions);

        const stats = createEl('div', {
            background: '#141414',
            padding: '6px 14px',
            borderBottom: '1px solid #222',
            display: 'flex',
            justifyContent: 'space-between',
            fontSize: '11px'
        });

        const liveStat = createEl('span', { color: '#22c55e', fontWeight: 'bold' }, 'Live: 0');
        liveStat.id = 'yt-stat-live';

        const remStat = createEl('span', { color: '#ef4444', fontWeight: 'bold' }, 'Removed Old: 0');
        remStat.id = 'yt-stat-removed';

        stats.appendChild(liveStat);
        stats.appendChild(remStat);

        const feed = createEl('div', {
            flex: '1',
            overflowY: 'auto',
            padding: '10px',
            background: '#0d0d0d',
            maxHeight: '400px',
            display: 'flex',
            flexDirection: 'column',
            gap: '6px'
        });
        feed.id = 'yt-audit-feed';

        box.appendChild(header);
        box.appendChild(stats);
        box.appendChild(feed);
        document.body.appendChild(box);

        cfgBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const inputHours = prompt('Enter Max Allowed Stream Age in HOURS:', CONFIG.maxHours);
            if (inputHours === null) return;
            const h = parseInt(inputHours, 10);
            if (!isNaN(h) && h >= 0) {
                CONFIG.maxHours = h;
                localStorage.setItem('yt_audit_max_hours', h);
                cfgBtn.textContent = `Cutoff: ${h}h`;
                userOverrodeWatchPlayer = false;

                auditCache.forEach((item) => {
                    if (item.ageMinutes !== null) {
                        item.isOld = item.ageMinutes > getMaxAllowedMinutes() || CYCLICAL_REGEX.test(item.description || '');
                    }
                });
                auditEverything();
            }
        });

        toggleBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            isMinimized = !isMinimized;
            feed.style.display = isMinimized ? 'none' : 'flex';
            stats.style.display = isMinimized ? 'none' : 'flex';
            box.style.maxHeight = isMinimized ? '44px' : '520px';
            toggleBtn.textContent = isMinimized ? '□' : '—';
        });

        let isDragging = false, startX, startY, initX, initY;
        header.addEventListener('mousedown', (e) => {
            if (e.target.tagName === 'BUTTON') return;
            isDragging = true;
            header.style.cursor = 'grabbing';
            const rect = box.getBoundingClientRect();
            startX = e.clientX;
            startY = e.clientY;
            initX = rect.left;
            initY = rect.top;
            box.style.right = 'auto';
        });

        window.addEventListener('mousemove', (e) => {
            if (!isDragging) return;
            box.style.left = `${initX + (e.clientX - startX)}px`;
            box.style.top = `${initY + (e.clientY - startY)}px`;
        });

        window.addEventListener('mouseup', () => {
            isDragging = false;
            header.style.cursor = 'grab';
        });
    }

    function logToConsole(title, url, viewers, isRemoved, label) {
        const feed = document.getElementById('yt-audit-feed');
        if (!feed || loggedEntries.has(url)) return;
        loggedEntries.add(url);

        const row = createEl('div', {
            padding: '6px 8px',
            background: isRemoved ? 'rgba(239, 68, 68, 0.1)' : 'rgba(34, 197, 94, 0.1)',
            borderRadius: '4px',
            fontSize: '11px',
            display: 'flex',
            flexDirection: 'column',
            gap: '2px'
        });

        const top = createEl('div', {
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center'
        });

        const badge = createEl('span', {
            fontSize: '10px',
            fontWeight: 'bold',
            color: isRemoved ? '#ef4444' : '#22c55e'
        }, isRemoved ? 'REMOVED / DIMMED' : 'GENUINE LIVE');

        const vText = createEl('span', { color: '#888', fontSize: '10px' }, viewers || '');
        top.appendChild(badge);
        top.appendChild(vText);

        const link = createEl('a', {
            color: '#eee',
            textDecoration: 'none',
            fontWeight: '500',
            fontSize: '11px',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis'
        }, title);
        link.href = url;
        link.target = '_blank';

        const sub = createEl('div', {
            fontSize: '10px',
            color: isRemoved ? '#fca5a5' : '#86efac'
        }, label);

        row.appendChild(top);
        row.appendChild(link);
        row.appendChild(sub);
        feed.insertBefore(row, feed.firstChild);
    }

    // 4. Watch Page Active Player Dimmer & Warning Banner
    function auditWatchPagePlayer() {
        if (location.pathname !== '/watch') return;

        const player = document.querySelector('#movie_player, .html5-video-player');
        const video = document.querySelector('video.html5-main-video, #movie_player video');
        const infoBlock = document.querySelector('ytd-watch-metadata, #info-contents, #description-inner, #above-the-fold');
        const infoText = infoBlock ? (infoBlock.innerText || infoBlock.textContent || '') : '';

        const isLive = /watching now|watching/i.test(infoText) || document.querySelector('.ytp-live, .badge-style-type-live-now') !== null;
        if (!isLive) return;

        const ageMinutes = parseAgeInMinutes(infoText);
        const maxAllowedMins = getMaxAllowedMinutes();
        const hasLoop = CYCLICAL_REGEX.test(infoText);
        const viewers = parseViewers(infoText);

        // Watch player ONLY dims if it genuinely exceeds cutoff or has loop keywords (NOT because of viewer count!)
        const isOverCutoff = (ageMinutes !== null && ageMinutes > maxAllowedMins);
        const shouldDim = !userOverrodeWatchPlayer && (isOverCutoff || hasLoop);

        let banner = document.getElementById('yt-watch-dim-banner');

        if (shouldDim) {
            if (player) {
                player.style.setProperty('filter', `grayscale(${CONFIG.dimGrayscale}) brightness(${CONFIG.dimBrightness})`, 'important');
                player.style.setProperty('opacity', CONFIG.dimOpacity, 'important');
                player.style.setProperty('transition', 'filter 0.3s ease, opacity 0.3s ease', 'important');
            }
            if (video) {
                video.style.setProperty('filter', `grayscale(${CONFIG.dimGrayscale}) brightness(${CONFIG.dimBrightness})`, 'important');
            }

            if (!banner && player) {
                banner = createEl('div');
                banner.id = 'yt-watch-dim-banner';
                banner.style.cssText = `
                    position: absolute !important;
                    top: 15px !important;
                    left: 50% !important;
                    transform: translateX(-50%) !important;
                    background: rgba(18, 18, 18, 0.95) !important;
                    border: 2px solid #ef4444 !important;
                    color: #fff !important;
                    padding: 8px 16px !important;
                    border-radius: 8px !important;
                    font-size: 13px !important;
                    font-weight: bold !important;
                    z-index: 2147483646 !important;
                    display: flex !important;
                    align-items: center !important;
                    gap: 12px !important;
                    box-shadow: 0 8px 24px rgba(0,0,0,0.9) !important;
                `;

                const hoursRan = ageMinutes ? (ageMinutes / 60).toFixed(1) : `${CONFIG.maxHours}+`;
                const msg = createEl('span', {}, `⚠️ Stream Started ${hoursRan}h ago (Exceeds ${CONFIG.maxHours}h Cutoff)`);
                const undimBtn = createEl('button', {
                    background: '#2563eb',
                    color: '#fff',
                    border: 'none',
                    padding: '4px 10px',
                    borderRadius: '4px',
                    cursor: 'pointer',
                    fontSize: '11px',
                    fontWeight: 'bold'
                }, 'Un-dim');

                undimBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    userOverrodeWatchPlayer = true;
                    if (player) {
                        player.style.removeProperty('filter');
                        player.style.removeProperty('opacity');
                    }
                    if (video) video.style.removeProperty('filter');
                    banner.remove();
                });

                banner.appendChild(msg);
                banner.appendChild(undimBtn);
                player.parentElement.appendChild(banner);
            }

            const currentTitle = document.querySelector('h1.ytd-watch-metadata, #title h1')?.textContent?.trim() || 'Current Live Stream';
            logToConsole(currentTitle, location.href, viewers ? `${viewers.toLocaleString()} watching` : '', true, `Started ${(ageMinutes / 60).toFixed(1)}h ago (> ${CONFIG.maxHours}h)`);

        } else if (player && !shouldDim) {
            // Fresh stream under cutoff: Keep 100% bright, NO banner
            player.style.removeProperty('filter');
            player.style.removeProperty('opacity');
            if (video) video.style.removeProperty('filter');
            if (banner) banner.remove();
        }
    }

    // 5. Search Results & Recommended Videos Audit
    function auditSearchAndCards() {
        const cards = Array.from(document.querySelectorAll([
            'ytd-video-renderer',
            'ytd-rich-item-renderer',
            'yt-lockup-view-model',
            'ytd-compact-video-renderer'
        ].join(', ')));

        let liveCount = 0;
        let removedCount = 0;
        const maxAllowedMinutes = getMaxAllowedMinutes();

        cards.forEach((card, idx) => {
            const text = (card.innerText || card.textContent || '');

            const viewers = parseViewers(text);
            const hasWatching = viewers !== null;
            const hasLiveBadge = card.querySelector('[overlay-style="LIVE"], .badge-style-type-live-now, .badge-shape-wiz--thumbnail-live') !== null;
            const isPastBroadcastVOD = /\bstreamed\s+\d+\s*(?:year|month|week|day|hour|min)s?\s*ago/i.test(text) || /\bstreamed\s+on\b/i.test(text);

            const isCandidate = hasWatching || hasLiveBadge || location.pathname === '/results';
            if (!isCandidate) return;

            const linkEl = card.querySelector('a#video-title, a#video-title-link, a#thumbnail, a[href*="/watch"]');
            const href = linkEl && linkEl.href ? linkEl.href.split('&')[0] : `item-${idx}`;
            let videoId = null;
            if (linkEl && linkEl.href) {
                const matchId = linkEl.href.match(/[?&]v=([^&]+)/);
                if (matchId) videoId = matchId[1];
            }

            const titleEl = card.querySelector('#video-title, #video-title-link, h3, #title, .yt-core-attributed-string');
            const title = titleEl ? titleEl.textContent.trim() : `Stream ${idx + 1}`;

            let ageMinutes = parseAgeInMinutes(text);
            let isOld = false;
            let statusReason = '';

            if (isPastBroadcastVOD) {
                isOld = true;
                statusReason = 'Past broadcast';
            } else if (ageMinutes !== null && ageMinutes > maxAllowedMinutes) {
                isOld = true;
                statusReason = `Started ${(ageMinutes / 60).toFixed(1)}h ago (> ${CONFIG.maxHours}h)`;
            } else if (CYCLICAL_REGEX.test(text)) {
                isOld = true;
                statusReason = 'Cyclical loop keyword';
            }

            // Background inspection
            if (videoId) {
                if (auditCache.has(videoId)) {
                    const cached = auditCache.get(videoId);
                    if (cached.isOld) {
                        isOld = true;
                        statusReason = cached.reason;
                    }
                    if (ageMinutes === null && cached.ageMinutes !== null) {
                        ageMinutes = cached.ageMinutes;
                        if (ageMinutes > maxAllowedMinutes) {
                            isOld = true;
                            statusReason = `Started ${(ageMinutes / 60).toFixed(1)}h ago (> ${CONFIG.maxHours}h)`;
                        }
                    }
                } else if (!isOld && ageMinutes === null) {
                    inspectWatchPageInBackground(videoId);
                }
            }

            if (!hasWatching && !hasLiveBadge && !isOld) {
                isOld = true;
                statusReason = 'Not an active live stream';
            }

            if (isOld) {
                removedCount++;
                if (CONFIG.removeOldVideos) {
                    card.style.setProperty('display', 'none', 'important');
                }
                logToConsole(title, href, viewers ? `${viewers.toLocaleString()} watching` : '', true, statusReason);
            } else {
                liveCount++;
                card.style.removeProperty('display');

                if (CONFIG.sortFreshToTop) {
                    const sortOrder = ageMinutes !== null ? ageMinutes : 999;
                    card.style.setProperty('order', sortOrder, 'important');
                    const parent = card.parentElement;
                    if (parent && (parent.id === 'contents' || parent.tagName.toLowerCase().includes('section'))) {
                        parent.style.setProperty('display', 'flex', 'important');
                        parent.style.setProperty('flex-direction', 'column', 'important');
                    }
                }

                const timeLabel = ageMinutes !== null ? `Started ${ageMinutes}m ago` : 'Fresh Live';
                logToConsole(title, href, viewers ? `${viewers.toLocaleString()} watching` : 'LIVE', false, timeLabel);
            }
        });

        const lStat = document.getElementById('yt-stat-live');
        const rStat = document.getElementById('yt-stat-removed');
        if (lStat) lStat.textContent = `Live: ${liveCount}`;
        if (rStat) rStat.textContent = `Removed Old: ${removedCount}`;
    }

    function auditEverything() {
        ensureConsole();
        auditWatchPagePlayer();
        auditSearchAndCards();
    }

    window.addEventListener('yt-navigate-finish', () => {
        userOverrodeWatchPlayer = false;
        loggedEntries.clear();
        const feed = document.getElementById('yt-audit-feed');
        if (feed) feed.replaceChildren();
        const banner = document.getElementById('yt-watch-dim-banner');
        if (banner) banner.remove();
    });

    setInterval(auditEverything, 500);
})();

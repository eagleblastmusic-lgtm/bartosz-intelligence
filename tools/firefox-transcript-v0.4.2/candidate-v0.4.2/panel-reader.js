/* exported readTranscriptPanel, buildTranscriptExport */
'use strict';

// Self-contained: Firefox serializes this function into the active watch tab.
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- Called by popup.js and serialized by browser.scripting.
async function readTranscriptPanel(expectedVideoId, settings = {}) {
  const rowsSelector =
    'ytd-transcript-segment-renderer, transcript-segment-view-model, .ytwTranscriptSegmentViewModelHost, [class*="TranscriptSegmentViewModelHost"]';
  const panelsSelector =
    'ytd-engagement-panel-section-list-renderer[target-id*="transcript" i], ytd-transcript-renderer, ytd-transcript-segment-list-renderer, [class*="TranscriptSegmentListViewModelHost"]';
  const timeoutMs = Math.max(1, Math.min(30000, settings.timeoutMs ?? 8000));
  const pollMs = Math.max(1, Math.min(500, settings.pollMs ?? 120));
  const scrollTimeoutMs = Math.max(
    1,
    Math.min(60000, settings.scrollTimeoutMs ?? 15000),
  );
  const maxScrollSteps = Math.max(
    1,
    Math.min(1000, settings.maxScrollSteps ?? 180),
  );
  const info = {
    domRows: 0,
    scrolled: false,
    scrollSteps: 0,
    scrollObservations: 0,
    recycledNodes: 0,
    collisions: [],
    allTimed: false,
  };
  let navigationStarted = false;
  let restoreScroll = null;
  const navigation = () => {
    navigationStarted = true;
  };
  const error = (code, message) => {
    throw Object.assign(new Error(message), { code });
  };
  const currentVideoId = () =>
    new URL(location.href).searchParams.get('v') || '';
  const assertVideo = () => {
    if (
      navigationStarted ||
      !expectedVideoId ||
      currentVideoId() !== expectedVideoId
    ) {
      error(
        'VIDEO_CHANGED',
        'Zmieniono film podczas odczytu. Otwórz właściwy panel i ponów odczyt.',
      );
    }
    // The initial player response can be stale after SPA; use only the live player here.
    let liveId = '';
    try {
      liveId =
        document.querySelector('#movie_player')?.getPlayerResponse?.()
          ?.videoDetails?.videoId || '';
    } catch {}
    if (liveId && liveId !== expectedVideoId)
      error('VIDEO_CHANGED', 'Odtwarzacz wskazuje inny film.');
  };
  const pause = async (ms = pollMs) => {
    assertVideo();
    await new Promise((resolve) => setTimeout(resolve, ms));
    assertVideo();
  };
  const isRendered = (element) => {
    if (!element?.isConnected) return false;
    for (let node = element; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (
        node.hidden ||
        node.getAttribute('aria-hidden') === 'true' ||
        node.getAttribute('visibility') ===
          'ENGAGEMENT_PANEL_VISIBILITY_HIDDEN' ||
        style.display === 'none' ||
        /hidden|collapse/.test(style.visibility) ||
        style.contentVisibility === 'hidden' ||
        Number(style.opacity) === 0
      )
        return false;
    }
    return [...element.getClientRects()].some(
      (rect) => rect.width > 0 && rect.height > 0,
    );
  };
  const rowNodes = (panel) =>
    [...panel.querySelectorAll(rowsSelector)].filter((node) => {
      const parentRow = node.parentElement?.closest(rowsSelector);
      return (!parentRow || !panel.contains(parentRow)) && isRendered(node);
    });
  const field = (row, selectors) => {
    for (const selector of selectors) {
      for (const node of row.querySelectorAll(selector)) {
        if (isRendered(node) && node.textContent?.trim()) return node;
      }
    }
    return null;
  };
  const parseSeconds = (label) => {
    if (!/^(?:\d+:[0-5]\d|\d+:[0-5]\d:[0-5]\d)$/.test(label)) return null;
    const seconds = label
      .split(':')
      .map(Number)
      .reduce((value, part) => value * 60 + part, 0);
    return Number.isSafeInteger(seconds) ? seconds : null;
  };
  const parseRow = (node) => {
    const legacy = node.matches('ytd-transcript-segment-renderer');
    const time = field(
      node,
      legacy
        ? [
            '.segment-timestamp',
            '#timestamp',
            '.ytwTranscriptSegmentViewModelTimestamp',
          ]
        : [
            '.ytwTranscriptSegmentViewModelTimestamp',
            '.segment-timestamp',
            '#timestamp',
            '[class*="TranscriptSegmentViewModelTimestamp"]',
          ],
    );
    const text = field(
      node,
      legacy
        ? ['.segment-text', 'yt-formatted-string.segment-text', '#segment-text']
        : [
            '.ytwTranscriptSegmentViewModelText',
            '.segment-text',
            '#segment-text',
            'span.ytAttributedStringHost[role="text"]',
            'span.yt-core-attributed-string[role="text"]',
          ],
    );
    const timestamp = time?.textContent?.trim() || '';
    const start = parseSeconds(timestamp);
    if (!text || !timestamp || start === null) return null;
    // Do not normalize, translate, trim or flatten the text content.
    return { timestamp, start, duration: null, text: text.textContent };
  };
  function getActiveTranscriptPanel() {
    const matched = [...document.querySelectorAll(panelsSelector)];
    const rendered = matched.filter(isRendered);
    // Nested transcript/list wrappers describe the same source; prefer its outer root.
    const roots = rendered.filter(
      (node) =>
        !rendered.some((other) => other !== node && other.contains(node)),
    );
    const candidates = roots.map((panel) => ({
      panel,
      expanded:
        panel
          .closest('ytd-engagement-panel-section-list-renderer')
          ?.getAttribute('visibility') ===
        'ENGAGEMENT_PANEL_VISIBILITY_EXPANDED',
      hasContent: rowNodes(panel).some((row) => parseRow(row)),
    }));
    const expanded = candidates.filter((candidate) => candidate.expanded);
    const pool = expanded.length ? expanded : candidates;
    const loaded = pool.filter((candidate) => candidate.hasContent);
    const choices = loaded.length ? loaded : pool;
    if (choices.length > 1)
      error(
        'PANEL_AMBIGUOUS',
        'Więcej niż jeden aktywny panel. Zamknij pozostałe panele.',
      );
    const chosen = choices[0];
    if (!chosen) return null;
    return {
      ...chosen,
      matchedContainers: matched.length,
      renderedContainers: rendered.length,
      containerIndex: matched.indexOf(chosen.panel),
    };
  }
  const assertPanel = (panel) => {
    assertVideo();
    if (!isRendered(panel) || getActiveTranscriptPanel()?.panel !== panel) {
      error(
        'PANEL_CHANGED',
        'Panel został ukryty, zamknięty lub zastąpiony podczas odczytu.',
      );
    }
  };
  const readRows = async (panel) => {
    assertPanel(panel);
    const nodes = rowNodes(panel);
    if (nodes.length > 20000)
      error(
        'ROW_LIMIT',
        'Przekroczono limit 20000 wierszy; wynik nie został obcięty ani zapisany.',
      );
    const rows = [];
    let invalid = 0;
    for (let i = 0; i < nodes.length; i++) {
      if (i > 0 && i % 200 === 0) {
        await pause(0);
        assertPanel(panel);
      }
      const segment = parseRow(nodes[i]);
      const position = nodes[i].getAttribute('aria-posinset');
      const sourceIndex = /^[1-9]\d*$/.test(position || '')
        ? Number(position) - 1
        : null;
      if (!segment) invalid++;
      else rows.push({ node: nodes[i], segment, sourceIndex });
    }
    assertPanel(panel);
    return { rows, invalid, count: nodes.length };
  };
  const signature = (row) =>
    JSON.stringify([row.segment.timestamp, row.segment.text]);
  const loading = (panel) =>
    [
      ...panel.querySelectorAll(
        'tp-yt-paper-spinner, yt-content-loading-renderer',
      ),
    ].some(isRendered);
  const findScroller = (panel, firstRow) => {
    for (
      let node = firstRow?.parentElement;
      node && panel.contains(node);
      node = node.parentElement
    ) {
      if (
        /auto|scroll/.test(getComputedStyle(node).overflowY) &&
        node.clientHeight > 0 &&
        node.scrollHeight > node.clientHeight + 2
      )
        return node;
    }
    return null;
  };
  const languageMetadata = (panel) => {
    const selected = [
      ...panel.querySelectorAll(
        'option:checked[data-language-code], [aria-selected="true"][data-language-code]',
      ),
    ].find(
      (node) =>
        isRendered(node) ||
        (node.matches('option:checked') && isRendered(node.parentElement)),
    );
    const code = selected?.getAttribute('data-language-code') || '';
    const explicit = /^[a-z]{2,3}(?:-[a-zA-Z0-9]{2,8})*$/.test(code);
    const label =
      selected?.textContent?.trim() ||
      [
        ...panel.querySelectorAll(
          '#footer #label-text, ytd-transcript-footer-renderer #label-text',
        ),
      ]
        .find(isRendered)
        ?.textContent?.trim() ||
      '';
    const translation = selected?.getAttribute('data-translation-status');
    return {
      language: explicit ? code : 'unknown',
      displayedLanguage: label || 'unknown (brak jawnej etykiety ścieżki)',
      languageEvidence: explicit
        ? 'selected-track-data-language-code'
        : label
          ? 'display-label-only'
          : 'unavailable',
      translationStatus: ['original', 'translated', 'auto-translated'].includes(
        translation,
      )
        ? translation
        : 'unknown',
    };
  };
  window.addEventListener('yt-navigate-start', navigation);
  try {
    assertVideo();
    const deadline = performance.now() + timeoutMs;
    let selected = null;
    let initial = null;
    let sawPanel = false;
    let sawRows = false;
    let sawLoading = false;
    while (true) {
      assertVideo();
      selected = getActiveTranscriptPanel();
      if (selected) {
        sawPanel = true;
        sawLoading ||= loading(selected.panel);
        initial = await readRows(selected.panel);
        assertVideo();
        sawRows ||= initial.count > 0;
        if (
          initial.rows.length &&
          initial.invalid === 0 &&
          !loading(selected.panel)
        )
          break;
      }
      if (performance.now() >= deadline) {
        error(
          !sawPanel
            ? 'PANEL_NOT_OPEN'
            : sawRows || sawLoading
              ? 'PANEL_TIMEOUT'
              : 'PANEL_EMPTY',
          'Nie uzyskano niepustych wierszy z tekstem i poprawnymi timestampami w limicie czasu.',
        );
      }
      await pause();
    }
    const panel = selected.panel;
    const metadata = languageMetadata(panel);
    info.panelSelection = {
      containerIndex: selected.containerIndex,
      matchedContainers: selected.matchedContainers,
      renderedContainers: selected.renderedContainers,
      expanded: selected.expanded,
    };
    info.domRows = initial.count;
    const declaredSizes = [
      ...new Set(
        initial.rows
          .map((row) => row.node.getAttribute('aria-setsize'))
          .filter((value) => /^[1-9]\d*$/.test(value || ''))
          .map(Number),
      ),
    ];
    const declaredTotal = declaredSizes.length === 1 ? declaredSizes[0] : null;
    const positioned = initial.rows.every((row) => row.sourceIndex !== null);
    const declaredRangePresent =
      declaredTotal === initial.rows.length &&
      positioned &&
      initial.rows.every((row, i) => row.sourceIndex === i);
    const continuation = [
      ...panel.querySelectorAll('ytd-continuation-item-renderer'),
    ].some(isRendered);
    const modern = initial.rows.some(
      (row) => !row.node.matches('ytd-transcript-segment-renderer'),
    );
    const scroller = findScroller(panel, initial.rows[0].node);
    const scan =
      settings.scrollMode === 'scan' ||
      (!declaredRangePresent &&
        (positioned ||
          modern ||
          continuation ||
          declaredTotal > initial.rows.length));
    let collected = initial.rows;
    let boundary = 'all-current-rendered-rows; no scroll probe';
    if (scan && !scroller && declaredTotal > collected.length)
      error(
        'INCOMPLETE_DOM',
        'Deklarowana lista jest większa niż dostępny DOM; brak kontenera przewijania.',
      );
    if (scan && scroller) {
      info.scrolled = true;
      const oldTop = scroller.scrollTop;
      restoreScroll = () => {
        if (
          !navigationStarted &&
          currentVideoId() === expectedVideoId &&
          isRendered(panel)
        )
          scroller.scrollTop = oldTop;
      };
      scroller.scrollTop = 0;
      info.scrollSteps++;
      // Scroll events and virtual renderers update on an animation frame, not a microtask.
      await pause(Math.max(40, pollMs));
      assertPanel(panel);
      collected = [];
      const indexedRows = new Map();
      const seenNodes = new WeakMap();
      let indexed = null;
      let stableBottom = 0;
      let previousState = '';
      const scrollDeadline = performance.now() + scrollTimeoutMs;
      let reachedBoundary = false;
      for (let step = 0; step < maxScrollSteps; step++) {
        assertPanel(panel);
        const batch = await readRows(panel);
        assertVideo();
        if (batch.invalid || !batch.rows.length)
          error(
            'INVALID_ROW',
            'Podczas przewijania pojawił się pusty lub nieprawidłowy wiersz.',
          );
        info.domRows = Math.max(info.domRows, batch.count);
        info.scrollObservations++;
        if (indexed === null)
          indexed = batch.rows.every((row) => row.sourceIndex !== null);
        for (const row of batch.rows) {
          const key = signature(row);
          if (seenNodes.has(row.node) && seenNodes.get(row.node) !== key)
            info.recycledNodes++;
          seenNodes.set(row.node, key);
        }
        if (indexed) {
          if (
            new Set(batch.rows.map((row) => row.sourceIndex)).size !==
            batch.rows.length
          ) {
            info.collisions.push({ reason: 'duplicate-index-in-window' });
            error(
              'ROW_IDENTITY_COLLISION',
              'W jednym oknie występują powtórzone indeksy ARIA.',
            );
          }
          for (const row of batch.rows) {
            if (row.sourceIndex === null)
              error(
                'ROW_IDENTITY_COLLISION',
                'Wirtualizowana lista utraciła indeksy ARIA.',
              );
            const previous = indexedRows.get(row.sourceIndex);
            if (previous && signature(previous) !== signature(row)) {
              info.collisions.push({
                sourceIndex: row.sourceIndex,
                reason: 'same-index-different-content',
              });
              error(
                'ROW_IDENTITY_COLLISION',
                'Ten sam indeks wskazuje różne fragmenty.',
              );
            }
            indexedRows.set(row.sourceIndex, row);
          }
          collected = [...indexedRows.values()].sort(
            (a, b) => a.sourceIndex - b.sourceIndex,
          );
        } else if (!collected.length) collected = batch.rows;
        else {
          let overlap = 0;
          for (
            let n = Math.min(collected.length, batch.rows.length);
            n > 0;
            n--
          ) {
            if (
              batch.rows
                .slice(0, n)
                .every(
                  (row, i) =>
                    signature(row) ===
                    signature(collected[collected.length - n + i]),
                )
            ) {
              overlap = n;
              break;
            }
          }
          if (!overlap)
            error(
              'ROW_SEQUENCE_GAP',
              'Brak wspólnej granicy kolejnych okien DOM; nie można bezpiecznie połączyć treści.',
            );
          for (let i = 0; i < overlap; i++) {
            const old = collected[collected.length - overlap + i];
            const row = batch.rows[i];
            const key = signature(row);
            if (
              (old.node !== row.node || info.recycledNodes > 0) &&
              (collected.filter((entry) => signature(entry) === key).length >
                1 ||
                batch.rows.filter((entry) => signature(entry) === key).length >
                  1)
            ) {
              info.collisions.push({
                reason: 'ambiguous-repeated-window-boundary',
              });
              error(
                'ROW_IDENTITY_COLLISION',
                'Powtórzona granica bez stabilnego indeksu jest niejednoznaczna.',
              );
            }
          }
          collected.push(...batch.rows.slice(overlap));
        }
        if (collected.length > 20000)
          error('ROW_LIMIT', 'Przekroczono limit 20000 wierszy.');
        const bottom =
          scroller.scrollTop + scroller.clientHeight >=
          scroller.scrollHeight - 2;
        const state = JSON.stringify([
          scroller.scrollHeight,
          collected.length,
          batch.rows.map(signature),
        ]);
        stableBottom =
          bottom && !loading(panel) && state === previousState
            ? stableBottom + 1
            : 0;
        previousState = state;
        if (stableBottom >= 3) {
          reachedBoundary = true;
          break;
        }
        if (performance.now() >= scrollDeadline)
          error(
            'SCROLL_TIMEOUT',
            'Przekroczono czas zbierania; nie zapisano wyniku częściowego.',
          );
        const next = Math.min(
          scroller.scrollHeight - scroller.clientHeight,
          scroller.scrollTop +
            Math.max(1, Math.floor(scroller.clientHeight * 0.6)),
        );
        if (next !== scroller.scrollTop) {
          scroller.scrollTop = next;
          info.scrollSteps++;
        }
        await pause(Math.max(40, pollMs));
        assertPanel(panel);
      }
      if (!reachedBoundary)
        error(
          'SCROLL_LIMIT',
          'Osiągnięto limit obserwacji bez potwierdzenia dolnej granicy DOM.',
        );
      if (indexed && !collected.every((row, i) => row.sourceIndex === i))
        error(
          'INCOMPLETE_DOM',
          'Brak ciągłego zakresu indeksów od początku listy.',
        );
      if (declaredTotal !== null && collected.length !== declaredTotal)
        error(
          'INCOMPLETE_DOM',
          'Liczba zebranych wierszy nie zgadza się z aria-setsize.',
        );
      boundary = indexed
        ? 'scroll-bottom stable for 3 polls; contiguous ARIA indexes'
        : 'scroll-bottom stable for 3 polls; overlapping ordered DOM windows';
    }
    assertPanel(panel);
    if (JSON.stringify(metadata) !== JSON.stringify(languageMetadata(panel)))
      error('PANEL_CHANGED', 'Zmieniono wybór ścieżki podczas odczytu.');
    const segments = collected.map((row, index) => ({ index, ...row.segment }));
    if (
      !segments.length ||
      segments.some((row) => !row.text.trim() || !Number.isFinite(row.start))
    )
      error('INVALID_ROW', 'Niekompletna zawartość wierszy.');
    if (
      !segments.every((row, i) => i === 0 || segments[i - 1].start <= row.start)
    )
      error(
        'INVALID_TIMESTAMPS',
        'Początki wierszy nie są uporządkowane; nie sortujemy treści.',
      );
    info.allTimed = true;
    assertVideo();
    return {
      ok: true,
      videoId: expectedVideoId,
      method: 'youtube-transcript-panel',
      ...metadata,
      capturedAt: new Date().toISOString(),
      segments,
      info,
      timing: {
        precision: 'seconds',
        source: 'displayed DOM labels',
        durationSource: 'unavailable',
      },
      coverage: {
        status: 'unverified',
        collectedRows: segments.length,
        declaredTotal,
        endBoundary: boundary,
        independentSourceVerified: false,
      },
      limitations: [
        'COMPLETENESS_NOT_INDEPENDENTLY_VERIFIED',
        'DOM_TIMESTAMP_SECONDS_ONLY',
        'SOURCE_DURATIONS_UNKNOWN',
        ...(metadata.language === 'unknown'
          ? ['LANGUAGE_CODE_UNVERIFIED']
          : []),
        ...(metadata.translationStatus === 'unknown'
          ? ['TRANSLATION_STATUS_UNKNOWN']
          : []),
      ],
    };
  } catch (failure) {
    return {
      ok: false,
      code: failure.code || 'PANEL_READ_FAILED',
      message: failure.message || 'Błąd odczytu panelu.',
      info,
    };
  } finally {
    restoreScroll?.();
    window.removeEventListener('yt-navigate-start', navigation);
  }
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars -- Public popup export formatter, also exercised directly in integration tests.
function buildTranscriptExport(data, format) {
  if (!['json', 'txt'].includes(format))
    throw new Error('INVALID_EXPORT_FORMAT');
  if (
    !data?.ok ||
    !/^[a-zA-Z0-9_-]{11}$/.test(data.videoId || '') ||
    !data.segments?.length
  )
    throw new Error('INVALID_EXPORT');
  const panel = data.method === 'youtube-transcript-panel';
  const segments = data.segments.map((row, index) => {
    if (
      typeof row.text !== 'string' ||
      !row.text.trim() ||
      !Number.isFinite(row.start) ||
      row.start < 0 ||
      (panel &&
        (!/^(?:\d+:[0-5]\d|\d+:[0-5]\d:[0-5]\d)$/.test(row.timestamp || '') ||
          row.timestamp
            .split(':')
            .map(Number)
            .reduce((value, part) => value * 60 + part, 0) !== row.start ||
          row.duration !== null))
    )
      throw new Error('INVALID_EXPORT_ROW');
    return {
      index,
      timestamp: row.timestamp || `${row.start}s`,
      start: row.start,
      duration: panel ? null : row.duration,
      text: row.text,
    };
  });
  const payload = {
    schemaVersion: 'bartosz-transcript/0.4.2',
    video_id: data.videoId,
    method: data.method || 'youtube-caption-track',
    language: data.language || 'unknown',
    displayedLanguage: data.displayedLanguage || 'unknown',
    translationStatus: data.translationStatus || 'unknown',
    languageEvidence: data.languageEvidence || 'caption-track-metadata',
    capturedAt: data.capturedAt || null,
    timing: data.timing || {
      precision: 'source',
      source: 'caption track',
      durationSource: 'caption track',
    },
    coverage: data.coverage || {
      status: 'unverified',
      independentSourceVerified: false,
    },
    limitations: data.limitations || [
      'COMPLETENESS_NOT_INDEPENDENTLY_VERIFIED',
    ],
    info: data.info || null,
    segments,
  };
  const content =
    format === 'json'
      ? JSON.stringify(payload, null, 2)
      : [
          '# Bartosz Transcript Probe 0.4.2',
          ...[
            'video_id',
            'method',
            'language',
            'displayedLanguage',
            'translationStatus',
            'languageEvidence',
            'timing',
            'coverage',
            'limitations',
          ].map((key) => `# ${key}: ${JSON.stringify(payload[key])}`),
          '',
          '--- TRANSCRIPT ---',
          segments.map((row) => `[${row.timestamp}] ${row.text}`).join('\n'),
        ].join('\n');
  const language = /^[a-zA-Z0-9-]+$/.test(payload.language)
    ? payload.language
    : 'unknown';
  return {
    filename: `${data.videoId}.${language}.${format}`,
    content,
    payload,
  };
}

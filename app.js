/**
 * Hamilton County Election Commission - Election Night Results Dashboard Controller
 * Fully compliant with HTML Development Playbook (DNN CMS, Mobile & WCAG 2.1 AA)
 */

window.ElectionApp = (function() {
  'use strict';

  // Application State
  let electionData = null;
  let activePartyFilter = 'ALL';
  let searchQuery = '';
  let isDarkMode = false;
  let isHighContrast = false;

  // Modal State
  let currentModalContest = null;
  let modalFilter = 'ALL';
  let modalSearch = '';

  const MAX_PRECINCT_CAP = 92;
  const AUTO_REFRESH_INTERVAL_MS = 60000; // 1 minute auto-refresh
  let autoRefreshTimer = null;

  function isPrecinctPageEnabled() {
    const rawData = window.ELECTION_DATA;
    if (!rawData || !rawData.config) return true;
    const val = rawData.config.enablePrecinctResults;
    if (val === false || val === 'false' || val === 0 || val === '0') {
      return false;
    }
    return true;
  }

  // Apply Config Visibility & Access Control
  function applyConfigVisibility() {
    const enablePrecinct = isPrecinctPageEnabled();

    // Hide/show precinct navigation links across all pages
    const precinctNavs = document.querySelectorAll('a[href="precincts.html"]');
    precinctNavs.forEach(nav => {
      nav.style.display = enablePrecinct ? '' : 'none';
    });

    // Access control guard if user directly visits precincts.html while disabled
    const path = (window.location.pathname || '').toLowerCase();
    const isPrecinctPage = path.endsWith('precincts.html') || path.endsWith('precincts') || path.includes('/precincts');
    if (!enablePrecinct && isPrecinctPage) {
      const mainContainer = document.getElementById('main-content');
      if (mainContainer) {
        mainContainer.innerHTML = `
          <div style="max-width:650px; margin:60px auto; text-align:center; padding:40px 24px; background:var(--neutral-light); border:1px solid var(--border); border-radius:12px; box-shadow:0 4px 12px rgba(0,0,0,0.05);">
            <div style="font-size:48px; margin-bottom:16px;">&#x1F5F3;&#xFE0F;</div>
            <h2 style="color:var(--primary); font-size:22px; font-weight:800; margin-bottom:12px;">Precinct Results Currently Disabled</h2>
            <p style="color:var(--neutral-muted); font-size:15px; line-height:1.6; margin-bottom:24px;">
              Precinct-level results are disabled during active Election Night reporting.<br>
              Official precinct breakdowns are published within 1 to 2 business days following Election Day.
            </p>
            <a href="index.html" class="nav-btn active" style="display:inline-block; padding:10px 24px; font-size:14px; text-decoration:none;">Return to Summary Results</a>
          </div>
        `;
      }
    }
  }

  function getCandidateParty(cand, contest) {
    if (!cand) return '';
    if (cand.party) return cand.party;
    if (contest && contest.title) {
      const tUpper = contest.title.toUpperCase();
      if (tUpper.startsWith('REP') || /\bREP\b/.test(tUpper)) return 'REP';
      if (tUpper.startsWith('DEM') || /\bDEM\b/.test(tUpper)) return 'DEM';
    }
    return '';
  }

  // Initialize application
  function init() {
    if (!window.ELECTION_DATA) {
      console.warn('Election data payload missing at start. Attempting dynamic load of ./data.js...');
      loadDataJsAndInit();
      return;
    }

    electionData = window.ELECTION_DATA;

    applyConfigVisibility();
    renderNavbarMetadata();
    renderDashboard();

    // Attach search listener
    const searchInput = document.getElementById('contest-search');
    if (searchInput) {
      searchInput.addEventListener('input', function(e) {
        searchQuery = e.target.value.trim().toLowerCase();
        renderContests();
      });
    }

    // Attach scroll listener for Back-to-Top button
    window.addEventListener('scroll', handleScrollState);

    // Attach ESC key listener for modal closure
    document.addEventListener('keydown', function(e) {
      if (e.key === 'Escape') {
        closePrecinctModal();
      }
    });

    // Start 1-minute auto-refresh timer
    startAutoRefreshTimer();

    // Location & Scroll position preservation after rendering
    setTimeout(restoreSavedLocation, 150);
  }

  let activeDataVersion = null;

  function isValidPayload(payload) {
    return payload && (payload.latest || payload.metadata) && (payload.latest ? Array.isArray(payload.latest.contests) : Array.isArray(payload.contests));
  }

  function resolvePrecinctStatus(contest, masterPrecincts) {
    if (contest.precinctsStatus && contest.precinctsStatus.length > 0) {
      return contest.precinctsStatus;
    }
    if (contest.precinctsStatusIndexed && Array.isArray(masterPrecincts)) {
      return contest.precinctsStatusIndexed.map(pair => ({
        name: masterPrecincts[pair[0]] || `Precinct ${pair[0]}`,
        reported: pair[1] === 1
      }));
    }
    return [];
  }

  function loadDataJsAndInit() {
    fetch(`./summary.json?t=${Date.now()}`)
      .then(res => res.ok ? res.json() : null)
      .then(summaryData => {
        if (isValidPayload(summaryData)) {
          window.ELECTION_DATA = summaryData;
          electionData = summaryData;
          activeDataVersion = summaryData.metadata ? summaryData.metadata.dataVersion : null;
          init();
          return;
        }
        throw new Error('summary.json invalid or missing');
      })
      .catch(() => {
        const script = document.createElement('script');
        script.src = `./data.js?t=${Date.now()}`;
        script.onload = function() {
          if (isValidPayload(window.ELECTION_DATA)) {
            activeDataVersion = (window.ELECTION_DATA.metadata || {}).dataVersion || null;
            init();
          } else {
            console.warn('ELECTION_DATA payload incomplete or missing. Retrying...');
          }
          if (script.parentNode) script.parentNode.removeChild(script);
        };
        script.onerror = function() {
          console.error('Failed to load ./data.js over network.');
          if (script.parentNode) script.parentNode.removeChild(script);
        };
        document.head.appendChild(script);
      });
  }

  function startAutoRefreshTimer() {
    if (autoRefreshTimer) clearInterval(autoRefreshTimer);
    autoRefreshTimer = setInterval(refreshDataSilently, AUTO_REFRESH_INTERVAL_MS);
  }

  function refreshDataSilently() {
    fetch(`./summary.json?t=${Date.now()}`)
      .then(res => res.ok ? res.json() : null)
      .then(summaryData => {
        if (isValidPayload(summaryData)) {
          const newVersion = summaryData.metadata ? summaryData.metadata.dataVersion : null;
          if (newVersion && newVersion === activeDataVersion) {
            // Data has not changed since previous poll; skip redundant DOM re-rendering
            return;
          }
          activeDataVersion = newVersion;
          window.ELECTION_DATA = summaryData;
          electionData = summaryData;
          applyConfigVisibility();
          renderNavbarMetadata();
          renderDashboard();
          renderReportingTable();
        }
      })
      .catch(() => {
        const newScript = document.createElement('script');
        newScript.src = `./data.js?t=${Date.now()}`;
        newScript.onload = function() {
          if (isValidPayload(window.ELECTION_DATA)) {
            const newVersion = (window.ELECTION_DATA.metadata || {}).dataVersion || null;
            if (newVersion && newVersion === activeDataVersion) {
              if (newScript.parentNode) newScript.parentNode.removeChild(newScript);
              return;
            }
            activeDataVersion = newVersion;
            electionData = window.ELECTION_DATA;
            applyConfigVisibility();
            renderNavbarMetadata();
            renderDashboard();
            renderReportingTable();
          }
          if (newScript.parentNode) newScript.parentNode.removeChild(newScript);
        };
        document.head.appendChild(newScript);
      });
  }

  function renderNavbarMetadata() {
    const meta = electionData.metadata || {};
    const subTitleEl = document.getElementById('navbar-subtitle');
    if (subTitleEl) {
      const county = meta.county || 'Hamilton';
      const date = meta.electionDate || '';
      subTitleEl.textContent = `${county} County, TN - ${date}`;
    }
  }

  function setPartyFilter(party) {
    activePartyFilter = party;
    const tabBtns = document.querySelectorAll('.tab-btn');
    tabBtns.forEach(btn => {
      if (btn.getAttribute('data-party') === party) {
        btn.classList.add('active');
        btn.setAttribute('aria-selected', 'true');
      } else {
        btn.classList.remove('active');
        btn.setAttribute('aria-selected', 'false');
      }
    });
    renderContests();
  }

  function toggleDarkMode() {
    isDarkMode = !isDarkMode;
    if (isDarkMode && isHighContrast) {
      isHighContrast = false;
      document.body.classList.remove('high-contrast');
    }
    document.body.classList.toggle('dark-mode', isDarkMode);

    const darkBtn = document.getElementById('dark-mode-toggle');
    if (darkBtn) {
      darkBtn.setAttribute('aria-pressed', isDarkMode ? 'true' : 'false');
      darkBtn.innerHTML = isDarkMode ? '&#x2600;&#xFE0F; Light Mode' : '&#x1F319; Dark Mode';
    }

    if (slideshowActive) {
      renderCurrentSlide();
      if (!isPaused) startSlideTimer(true);
    }
  }

  function toggleHighContrast() {
    isHighContrast = !isHighContrast;
    if (isHighContrast && isDarkMode) {
      isDarkMode = false;
      document.body.classList.remove('dark-mode');
    }
    document.body.classList.toggle('high-contrast', isHighContrast);

    const contrastBtn = document.getElementById('contrast-toggle');
    if (contrastBtn) {
      contrastBtn.setAttribute('aria-pressed', isHighContrast ? 'true' : 'false');
      contrastBtn.innerHTML = isHighContrast ? '&#x2600;&#xFE0F; Standard Contrast' : '&#x1F317; High Contrast';
    }

    if (slideshowActive) {
      renderCurrentSlide();
      if (!isPaused) startSlideTimer(true);
    }
  }

  function refreshResults() {
    sessionStorage.setItem('scrollPosY', window.scrollY);
    const watched = sessionStorage.getItem('watchedContest') || (window.location.hash ? window.location.hash.substring(1) : '');
    if (watched) {
      sessionStorage.setItem('watchedContest', watched);
    }
    window.location.reload();
  }

  function getCurrentDataset() {
    return electionData.latest || electionData;
  }

  function renderDashboard() {
    const data = getCurrentDataset();
    if (!data) return;

    // Render Hero Turnout Metrics
    const heroTitle = document.getElementById('hero-title');
    const heroDate = document.getElementById('hero-date');
    const statusText = document.getElementById('status-text');
    const statVoters = document.getElementById('stat-voters');
    const statBallots = document.getElementById('stat-ballots');
    const statTurnout = document.getElementById('stat-turnout');
    const statReporting = document.getElementById('stat-reporting');
    const statEarlyVal = document.getElementById('stat-early-val');
    const statEarlySub = document.getElementById('stat-early-sub');
    const turnoutFill = document.getElementById('turnout-fill');
    const reportingFill = document.getElementById('reporting-fill');

    const overallRepCapped = Math.min(data.overallPrecinctsReporting || 0, MAX_PRECINCT_CAP);
    const overallTotCapped = Math.min(data.overallPrecinctsTotal || MAX_PRECINCT_CAP, MAX_PRECINCT_CAP);
    const reportingPct = overallTotCapped > 0 ? (overallRepCapped / overallTotCapped * 100) : 0;

    const statBallotsRep = document.getElementById('stat-ballots-rep');
    const statBallotsDem = document.getElementById('stat-ballots-dem');
    const statBallotsGen = document.getElementById('stat-ballots-gen');

    if (heroTitle) heroTitle.textContent = `${data.county} County ${data.electionTitle}`;
    if (heroDate) heroDate.textContent = data.electionDate;
    if (statusText) statusText.textContent = data.statusLabel || 'UNOFFICIAL RESULTS';
    if (statVoters) statVoters.textContent = data.totalVoters.toLocaleString();
    if (statBallots) statBallots.textContent = data.totalBallots.toLocaleString();
    if (statBallotsRep) statBallotsRep.textContent = (data.ballotsRep || 0).toLocaleString();
    if (statBallotsDem) statBallotsDem.textContent = (data.ballotsDem || 0).toLocaleString();
    if (statBallotsGen) statBallotsGen.textContent = (data.ballotsGen || 0).toLocaleString();
    if (statTurnout) statTurnout.textContent = `${data.turnoutPercent.toFixed(2)}%`;
    if (statReporting) statReporting.textContent = `${overallRepCapped} of ${overallTotCapped} Precincts`;

    if (statEarlyVal) {
      const hasBallots = (data.totalBallots || 0) > 0;
      const earlyRep = hasBallots && ((data.earlyVotingReporting !== undefined) ? data.earlyVotingReporting : (data.hasEarlyUpload ? 1 : 0)) ? 1 : 0;
      const earlyTot = data.earlyVotingTotal || 1;
      const earlyBadge = earlyRep > 0 ? '&#x2705;' : '&#x23F3;';
      statEarlyVal.innerHTML = `${earlyBadge} Early &amp; Absentee: ${earlyRep} of ${earlyTot} (${earlyRep > 0 ? 'Complete' : 'Pending'})`;
    }
    if (turnoutFill) turnoutFill.style.width = `${Math.min(data.turnoutPercent, 100)}%`;
    if (reportingFill) reportingFill.style.width = `${Math.min(reportingPct, 100)}%`;

    renderContests();
    renderReportingTable();
    populateJumpMenu();
  }

  function populateJumpMenu() {
    const jumpSelect = document.getElementById('contest-jump-menu');
    if (!jumpSelect) return;

    const data = getCurrentDataset();
    if (!data || !data.contests) return;

    let optionsHtml = '<option value="">&#x1F4CC; Jump to Contest...</option>';
    data.contests.forEach(contest => {
      const slug = slugify(contest.title);
      optionsHtml += `<option value="${slug}">${escapeHtml(contest.title)}</option>`;
    });

    jumpSelect.innerHTML = optionsHtml;
    jumpSelect.selectedIndex = 0;
  }

  function jumpToContest(slug) {
    if (!slug) return;
    const targetEl = document.getElementById(`contest-card-${slug}`);
    if (targetEl) {
      targetEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
      window.location.hash = `#${slug}`;
      sessionStorage.setItem('watchedContest', slug);
    }
    const jumpSelect = document.getElementById('contest-jump-menu');
    if (jumpSelect) {
      setTimeout(() => {
        jumpSelect.selectedIndex = 0;
      }, 300);
    }
  }

  function scrollToTop() {
    window.scrollTo({ top: 0, behavior: 'smooth' });
    if (window.location.hash) {
      history.pushState('', document.title, window.location.pathname + window.location.search);
    }
    sessionStorage.removeItem('watchedContest');
  }

  function handleScrollState() {
    const topBtn = document.getElementById('back-to-top');
    if (topBtn) {
      if (window.scrollY > 300) {
        topBtn.classList.add('visible');
      } else {
        topBtn.classList.remove('visible');
      }
    }
    sessionStorage.setItem('scrollPosY', window.scrollY);
  }

  function restoreSavedLocation() {
    let slug = window.location.hash ? window.location.hash.substring(1) : '';
    if (!slug) {
      slug = sessionStorage.getItem('watchedContest') || '';
    }

    if (slug) {
      const targetEl = document.getElementById(`contest-card-${slug}`);
      if (targetEl) {
        targetEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
        return;
      }
    }

    const savedY = sessionStorage.getItem('scrollPosY');
    if (savedY && !isNaN(savedY) && parseInt(savedY, 10) > 100) {
      window.scrollTo({ top: parseInt(savedY, 10), behavior: 'smooth' });
    }
  }

  function renderContests() {
    const data = getCurrentDataset();
    const container = document.getElementById('contests-container');
    if (!container || !data || !data.contests) return;

    const filteredContests = data.contests.filter(contest => {
      if (searchQuery) {
        const matchesTitle = contest.title.toLowerCase().includes(searchQuery);
        const matchesCandidate = contest.candidates.some(c => c.name.toLowerCase().includes(searchQuery));
        if (!matchesTitle && !matchesCandidate) return false;
      }

      if (activePartyFilter !== 'ALL') {
        if (activePartyFilter === 'REP') {
          const hasRepInTitle = /\bREP\b/i.test(contest.title);
          const hasRepCand = contest.candidates.some(c => c.party === 'REP');
          return hasRepInTitle || hasRepCand;
        } else if (activePartyFilter === 'DEM') {
          const hasDemInTitle = /\bDEM\b/i.test(contest.title);
          const hasDemCand = contest.candidates.some(c => c.party === 'DEM');
          return hasDemInTitle || hasDemCand;
        } else if (activePartyFilter === 'IND') {
          const titleUpper = contest.title.toUpperCase();
          const hasDemOrRepInTitle = /\b(DEM|REP)\b/.test(titleUpper);
          const hasIndOrNonPartisanCand = contest.candidates.some(c => c.party === 'IND' || !c.party);
          return !hasDemOrRepInTitle && hasIndOrNonPartisanCand;
        }
      }
      return true;
    });

    if (filteredContests.length === 0) {
      container.innerHTML = `
        <div style="background:var(--surface); border:1px solid var(--border); padding:40px; text-align:center; border-radius:var(--radius-md); font-weight:600; color:var(--neutral-muted);">
          No matching contests found.
        </div>
      `;
      return;
    }

    let html = '';
    filteredContests.forEach(contest => {
      const cTitleEsc = escapeHtml(contest.title);
      const cSlug = slugify(contest.title);
      const cRepCapped = Math.min(contest.precinctsReporting || 0, MAX_PRECINCT_CAP);
      const cTotCapped = Math.min(contest.precinctsTotal || 0, MAX_PRECINCT_CAP);

      html += `
        <article id="contest-card-${cSlug}" class="contest-card" aria-labelledby="contest-title-${cSlug}">
          <header class="contest-header">
            <div>
              <h2 id="contest-title-${cSlug}" class="contest-title">${cTitleEsc}</h2>
              <div class="contest-meta" style="margin-top:4px;">
                <span>${escapeHtml(contest.voteFor)}</span>
                <span>&bull;</span>
                <span>Total Votes: ${contest.totalVotes.toLocaleString()}</span>
              </div>
            </div>
            <button type="button" class="reporting-btn" onclick="ElectionApp.openPrecinctModal('${escapeJsString(contest.title)}')" aria-label="View Precinct Reporting Status for ${cTitleEsc}">
              &#x1F5F3;&#xFE0F; ${cRepCapped} of ${cTotCapped} Election Day Precincts Reporting &#x25BE;
            </button>
          </header>
          <div class="contest-body">
            <table class="candidates-table" role="table" aria-label="Candidates for ${cTitleEsc}">
              <tbody role="rowgroup">
      `;

      contest.candidates.forEach(cand => {
        const cParty = getCandidateParty(cand, contest);
        const partyClass = cParty === 'REP' ? 'party-rep' : cParty === 'DEM' ? 'party-dem' : 'party-ind';
        const fillClass = cParty === 'REP' ? 'fill-rep' : cParty === 'DEM' ? 'fill-dem' : 'fill-ind';

        html += `
          <tr class="candidate-row" role="row">
            <td class="cand-name-cell" role="cell">
              <span>${escapeHtml(cand.name)}</span>
              ${cParty ? `<span class="party-pill ${partyClass}">${escapeHtml(cParty)}</span>` : ''}
              ${cand.isLeading && contest.totalVotes > 0 ? '<span class="leading-tag">&#x2714;&#xFE0F; LEADING</span>' : ''}
            </td>
            <td class="cand-bar-cell" role="cell">
              <div class="progress-track" aria-hidden="true">
                <div class="progress-fill ${fillClass}" style="width: ${Math.min(cand.percentage, 100)}%;"></div>
              </div>
            </td>
            <td class="cand-votes-cell" role="cell">
              <span class="vote-count">${cand.votes.toLocaleString()}</span>
              <span class="vote-percent">(${cand.percentage.toFixed(1)}%)</span>
            </td>
          </tr>
        `;
      });

      html += `
              </tbody>
            </table>
          </div>
        </article>
      `;
    });

    container.innerHTML = html;
  }

  function renderReportingTable() {
    const earlyTableBody = document.getElementById('early-reporting-table-body');
    const tableBody = document.getElementById('reporting-table-body');
    if (!tableBody && !earlyTableBody) return;

    const data = getCurrentDataset();
    if (!data || !data.contests) return;

    const hasBallots = (data.totalBallots || 0) > 0;
    const earlyRep = hasBallots && ((data.earlyVotingReporting !== undefined) ? data.earlyVotingReporting : (data.hasEarlyUpload ? 1 : 0)) ? 1 : 0;
    const earlyTot = data.earlyVotingTotal || 1;
    const earlyStatusBadge = earlyRep > 0 ? 
      '<span style="color:#16a34a; font-weight:700;">&#x2705; COMPLETE</span>' : 
      '<span style="color:var(--primary); font-weight:700;">&#x23F3; IN PROGRESS (0.0%)</span>';

    const earlyVotesCount = (data.earlyBallotsCast !== undefined) ? data.earlyBallotsCast : (earlyRep > 0 ? data.totalBallots : 0);

    if (earlyTableBody) {
      earlyTableBody.innerHTML = `
        <tr style="font-weight: 600;">
          <td style="font-weight:700; color:var(--primary);">
            &#x1F4EC; Early Voting/NH, Absentee &amp; UOCAVA
          </td>
          <td>Early Voting, Nursing Home, Absentee &amp; Military Ballots</td>
          <td>
            <span style="display:inline-flex; align-items:center; gap:6px; font-weight:700; padding:4px 10px; background:var(--surface); border:1px solid var(--border); border-radius:12px; font-size:13px;">
              &#x1F4EC; ${earlyRep} of ${earlyTot}
            </span>
          </td>
          <td>${earlyStatusBadge}</td>
          <td style="font-weight:700;">${earlyVotesCount.toLocaleString()}</td>
        </tr>
      `;
    }

    if (tableBody) {
      let html = '';

    data.contests.forEach(contest => {
      const cRepCapped = Math.min(contest.precinctsReporting || 0, MAX_PRECINCT_CAP);
      const cTotCapped = Math.min(contest.precinctsTotal || 0, MAX_PRECINCT_CAP);
      const pct = cTotCapped > 0 ? (cRepCapped / cTotCapped * 100).toFixed(1) : '0.0';

      const statusBadge = cRepCapped === cTotCapped && cTotCapped > 0 ? 
        '<span style="color:#16a34a; font-weight:700;">&#x2705; COMPLETE</span>' : 
        `<span style="color:var(--primary); font-weight:700;">&#x23F3; IN PROGRESS (${pct}%)</span>`;

      html += `
        <tr>
          <td style="font-weight:700;">${escapeHtml(contest.title)}</td>
          <td>${escapeHtml(contest.voteFor)}</td>
          <td>
            <button type="button" class="reporting-btn" onclick="ElectionApp.openPrecinctModal('${escapeJsString(contest.title)}')" aria-label="View Precinct Breakdown for ${escapeHtml(contest.title)}">
              &#x1F5F3;&#xFE0F; ${cRepCapped} of ${cTotCapped} &#x25BE;
            </button>
          </td>
          <td>${statusBadge}</td>
          <td style="font-weight:700;">${contest.totalVotes.toLocaleString()}</td>
        </tr>
      `;
    });

    tableBody.innerHTML = html;
    }
  }

  // Precinct Reporting Visual Modal Logic
  function openPrecinctModal(contestTitle) {
    const data = getCurrentDataset();
    if (!data || !data.contests) return;

    const contest = data.contests.find(c => c.title === contestTitle);
    if (!contest) return;

    currentModalContest = contest;
    modalFilter = 'ALL';
    modalSearch = '';

    const modalTitleEl = document.getElementById('modal-title');
    const modalSubtitleEl = document.getElementById('modal-subtitle');
    const modalSearchInput = document.getElementById('modal-search-input');

    const cRepCapped = Math.min(contest.precinctsReporting || 0, MAX_PRECINCT_CAP);
    const cTotCapped = Math.min(contest.precinctsTotal || 0, MAX_PRECINCT_CAP);

    if (modalTitleEl) modalTitleEl.textContent = `${contest.title} - Precinct Reporting Breakdown`;
    if (modalSubtitleEl) modalSubtitleEl.textContent = `${cRepCapped} of ${cTotCapped} Election Day Precincts Reported (${contest.voteFor})`;
    if (modalSearchInput) modalSearchInput.value = '';

    setModalFilter('ALL');
    renderModalPrecinctGrid();

    const backdrop = document.getElementById('precinct-modal');
    if (backdrop) {
      backdrop.classList.add('active');
      backdrop.setAttribute('aria-hidden', 'false');
    }
  }

  function closePrecinctModal() {
    const backdrop = document.getElementById('precinct-modal');
    if (backdrop) {
      backdrop.classList.remove('active');
      backdrop.setAttribute('aria-hidden', 'true');
    }
    currentModalContest = null;
  }

  function setModalFilter(filterType) {
    modalFilter = filterType;
    const filterBtns = document.querySelectorAll('.modal-filter-btn');
    filterBtns.forEach(btn => {
      if (btn.getAttribute('data-mfilter') === filterType) {
        btn.classList.add('active');
      } else {
        btn.classList.remove('active');
      }
    });
    renderModalPrecinctGrid();
  }

  function handleModalSearch(val) {
    modalSearch = val.trim().toLowerCase();
    renderModalPrecinctGrid();
  }

  function renderModalPrecinctGrid() {
    const gridContainer = document.getElementById('modal-precinct-grid');
    if (!gridContainer || !currentModalContest) return;

    const masterPrecincts = (electionData && electionData.latest ? electionData.latest.masterPrecincts : null) || (electionData ? electionData.masterPrecincts : null);
    const pList = resolvePrecinctStatus(currentModalContest, masterPrecincts);

    const filteredList = pList.filter(p => {
      if (modalSearch && !p.name.toLowerCase().includes(modalSearch)) {
        return false;
      }
      if (modalFilter === 'REPORTED' && !p.reported) return false;
      if (modalFilter === 'PENDING' && p.reported) return false;
      return true;
    });

    if (filteredList.length === 0) {
      gridContainer.innerHTML = `
        <div style="grid-column: 1 / -1; padding: 30px; text-align: center; color: var(--neutral-muted); font-weight: 600;">
          No precincts match filter criteria.
        </div>
      `;
      return;
    }

    let html = '';
    filteredList.forEach(p => {
      const chipClass = p.reported ? 'reported' : 'pending';
      const icon = p.reported ? '&#x2705;' : '&#x23F3;';
      const statusLabel = p.reported ? 'Reported' : 'Pending';

      html += `
        <div class="precinct-chip ${chipClass}">
          <span>${escapeHtml(p.name)}</span>
          <span style="font-size:11px; font-weight:700;">${icon} ${statusLabel}</span>
        </div>
      `;
    });

    gridContainer.innerHTML = html;
  }

  function exportCSV() {
    const data = getCurrentDataset();
    if (!data || !data.contests) return;

    let csvRows = [];
    csvRows.push(['Election', 'County', 'Contest', 'Vote For', 'Election Day Precincts Reporting', 'Total Precincts', 'Candidate', 'Party', 'Votes', 'Percentage']);

    data.contests.forEach(contest => {
      if (searchQuery) {
        const matchesTitle = contest.title.toLowerCase().includes(searchQuery);
        const matchesCandidate = contest.candidates.some(c => c.name.toLowerCase().includes(searchQuery));
        if (!matchesTitle && !matchesCandidate) return;
      }
      if (activePartyFilter !== 'ALL') {
        if (activePartyFilter === 'REP') {
          const hasRepInTitle = /\bREP\b/i.test(contest.title);
          const hasRepCand = contest.candidates.some(c => c.party === 'REP');
          if (!hasRepInTitle && !hasRepCand) return;
        } else if (activePartyFilter === 'DEM') {
          const hasDemInTitle = /\bDEM\b/i.test(contest.title);
          const hasDemCand = contest.candidates.some(c => c.party === 'DEM');
          if (!hasDemInTitle && !hasDemCand) return;
        } else if (activePartyFilter === 'IND') {
          const titleUpper = contest.title.toUpperCase();
          const hasDemOrRepInTitle = /\b(DEM|REP)\b/.test(titleUpper);
          const hasIndOrNonPartisanCand = contest.candidates.some(c => c.party === 'IND' || !c.party);
          if (hasDemOrRepInTitle || !hasIndOrNonPartisanCand) return;
        }
      }

      const cRepCapped = Math.min(contest.precinctsReporting || 0, MAX_PRECINCT_CAP);
      const cTotCapped = Math.min(contest.precinctsTotal || 0, MAX_PRECINCT_CAP);

      contest.candidates.forEach(cand => {
        csvRows.push([
          formatCsvCell(data.electionTitle),
          formatCsvCell(data.county),
          formatCsvCell(contest.title),
          formatCsvCell(contest.voteFor),
          cRepCapped,
          cTotCapped,
          formatCsvCell(cand.name),
          formatCsvCell(getCandidateParty(cand, contest)),
          cand.votes,
          `${cand.percentage.toFixed(2)}%`
        ]);
      });
    });

    const csvContent = csvRows.map(e => e.join(',')).join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.setAttribute('href', url);
    link.setAttribute('download', `Hamilton_Election_Summary_Results.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }

  function slugify(text) {
    return text.toString().toLowerCase().replace(/\s+/g, '-').replace(/[^\w\-]+/g, '').replace(/\-\-+/g, '-');
  }

  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function escapeJsString(str) {
    if (!str) return '';
    return String(str).replace(/'/g, "\\'").replace(/"/g, '\\"');
  }

  function formatCsvCell(val) {
    if (val === null || val === undefined) return '""';
    const str = String(val).replace(/"/g, '""');
    return `"${str}"`;
  }

  // Slideshow Presentation Engine State
  let slideshowActive = false;
  let currentSlideIndex = 0;
  let slideIntervalMs = 8000;
  let isPaused = false;
  let slideTimer = null;
  let slideProgressTimer = null;

  function initSlideshow() {
    slideshowActive = true;
    currentSlideIndex = 0;
    renderTicker();
    populateSlideJumpMenu();
    renderCurrentSlide();
    startSlideTimer();
  }

  function formatCompactDate(dateStr) {
    if (!dateStr) return '';
    const d = new Date(dateStr);
    if (!isNaN(d.getTime())) {
      return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`;
    }
    return dateStr;
  }

  function renderTicker() {
    const data = getCurrentDataset();
    if (!data) return;

    const tStatus = document.getElementById('ticker-status');
    const tDate = document.getElementById('ticker-date');
    const tVoters = document.getElementById('ticker-voters');
    const tBallots = document.getElementById('ticker-ballots');
    const tTurnout = document.getElementById('ticker-turnout');
    const tEarly = document.getElementById('ticker-early');
    const tReporting = document.getElementById('ticker-reporting');

    const overallRepCapped = Math.min(data.overallPrecinctsReporting || 0, MAX_PRECINCT_CAP);
    const overallTotCapped = Math.min(data.overallPrecinctsTotal || MAX_PRECINCT_CAP, MAX_PRECINCT_CAP);
    const hasBallots = (data.totalBallots || 0) > 0;
    const earlyRep = hasBallots && ((data.earlyVotingReporting !== undefined) ? data.earlyVotingReporting : (data.hasEarlyUpload ? 1 : 0)) ? 1 : 0;
    const earlyTot = data.earlyVotingTotal || 1;

    if (tStatus) tStatus.innerHTML = `&#x25CF; ${escapeHtml(data.statusLabel || 'UNOFFICIAL RESULTS')}`;
    if (tDate) tDate.textContent = formatCompactDate(data.electionDate) || data.electionDate || '';
    if (tVoters) tVoters.textContent = data.totalVoters ? data.totalVoters.toLocaleString() : '0';
    if (tBallots) tBallots.textContent = data.totalBallots ? data.totalBallots.toLocaleString() : '0';
    if (tTurnout) tTurnout.textContent = `${data.turnoutPercent.toFixed(2)}%`;
    if (tEarly) tEarly.textContent = `${earlyRep} of ${earlyTot} (${earlyRep > 0 ? 'Reported' : 'Pending'})`;
    if (tReporting) tReporting.textContent = `${overallRepCapped} of ${overallTotCapped} Precincts`;
  }

  const CANDIDATES_PER_SLIDE = 6;

  function getSlideList() {
    const data = getCurrentDataset();
    if (!data || !data.contests) return [];

    const slides = [{ type: 'summary' }];

    data.contests.forEach(contest => {
      const cands = contest.candidates || [];
      if (cands.length <= CANDIDATES_PER_SLIDE) {
        slides.push({
          type: 'contest',
          contest: contest,
          candidates: cands,
          pageNum: 1,
          totalPages: 1
        });
      } else {
        const totalPages = Math.ceil(cands.length / CANDIDATES_PER_SLIDE);
        for (let p = 0; p < totalPages; p++) {
          const chunk = cands.slice(p * CANDIDATES_PER_SLIDE, (p + 1) * CANDIDATES_PER_SLIDE);
          slides.push({
            type: 'contest',
            contest: contest,
            candidates: chunk,
            pageNum: p + 1,
            totalPages: totalPages
          });
        }
      }
    });

    return slides;
  }

  function populateSlideJumpMenu() {
    const menu = document.getElementById('slide-jump-menu');
    if (!menu) return;

    const slides = getSlideList();
    let html = '';
    slides.forEach((s, idx) => {
      if (s.type === 'summary') {
        html += `<option value="${idx}">Slide ${idx + 1}: Election Summary</option>`;
      } else {
        const pageLabel = s.totalPages > 1 ? ` (${s.pageNum}/${s.totalPages})` : '';
        html += `<option value="${idx}">Slide ${idx + 1}: ${escapeHtml(s.contest.title)}${pageLabel}</option>`;
      }
    });

    menu.innerHTML = html;
  }

  function reloadDataFresh() {
    // Re-fetch window.ELECTION_DATA dynamically to pick up any updated data.js content
    if (window.ELECTION_DATA) {
      electionData = window.ELECTION_DATA;
      renderTicker();
    }
  }

  function renderCurrentSlide() {
    reloadDataFresh();

    const viewport = document.getElementById('slide-viewport');
    if (!viewport) return;

    const slides = getSlideList();
    const totalSlides = slides.length;
    if (totalSlides === 0) return;

    if (currentSlideIndex < 0) currentSlideIndex = 0;
    if (currentSlideIndex >= totalSlides) currentSlideIndex = 0;

    const menu = document.getElementById('slide-jump-menu');
    if (menu) menu.value = currentSlideIndex;

    const currentSlideObj = slides[currentSlideIndex];
    if (!currentSlideObj) return;

    // Slide 0: Overall Election Summary
    if (currentSlideObj.type === 'summary') {
      const data = getCurrentDataset();
      const overallRepCapped = Math.min(data.overallPrecinctsReporting || 0, MAX_PRECINCT_CAP);
      const overallTotCapped = Math.min(data.overallPrecinctsTotal || MAX_PRECINCT_CAP, MAX_PRECINCT_CAP);
      const hasBallots = (data.totalBallots || 0) > 0;
      const earlyRep = hasBallots && ((data.earlyVotingReporting !== undefined) ? data.earlyVotingReporting : (data.hasEarlyUpload ? 1 : 0)) ? 1 : 0;
      const earlyTot = data.earlyVotingTotal || 1;

      const repPct = data.totalBallots ? ((data.ballotsRep || 0) / data.totalBallots * 100) : 0;
      const demPct = data.totalBallots ? ((data.ballotsDem || 0) / data.totalBallots * 100) : 0;
      const genPct = data.totalBallots ? ((data.ballotsGen || 0) / data.totalBallots * 100) : 0;

      viewport.innerHTML = `
        <article class="slide-card">
          <header class="slide-header">
            <div>
              <h1 class="slide-title">${escapeHtml(data.county)} County ${escapeHtml(data.electionTitle)}</h1>
              <div style="font-size: clamp(14px, 1.2vw, 18px); color:var(--neutral-muted); margin-top:4px;">Overall Election Night Progress Overview</div>
            </div>
            <div class="slide-meta">&#x1F4CA; Slide 1 of ${totalSlides} &bull; Summary</div>
          </header>

          <div class="slide-content-grid">
            <!-- Left Column: Visual Turnout & Precinct Gauges -->
            <div>
              <div class="visual-stat-card">
                <div class="visual-stat-title">&#x1F5F3;&#xFE0F; Overall Voter Turnout</div>
                <div class="visual-stat-value">${data.turnoutPercent.toFixed(2)}%</div>
                <div style="font-weight:700; color:var(--neutral-muted); font-size:clamp(12px, 1.4vh, 18px);">
                  ${data.totalBallots.toLocaleString()} Ballots Cast / ${data.totalVoters.toLocaleString()} Registered Voters
                </div>
                <div class="proj-track" style="margin-top:6px;">
                  <div class="proj-fill" style="width: ${Math.min(data.turnoutPercent, 100)}%; background: linear-gradient(90deg, #1e3a8a, #2563eb);"></div>
                </div>
              </div>

              <div class="visual-stat-card">
                <div class="visual-stat-title">&#x1F4EC; Reporting Completion</div>
                <div style="display:flex; justify-content:space-between; align-items:center; margin-top:4px;">
                  <span style="font-weight:700;">Election Day Precincts:</span>
                  <span style="font-weight:800; color:#16a34a;">${overallRepCapped} of ${overallTotCapped} (${((overallRepCapped / (overallTotCapped || 1)) * 100).toFixed(1)}%)</span>
                </div>
                <div class="proj-track">
                  <div class="proj-fill" style="width: ${(overallRepCapped / (overallTotCapped || 1)) * 100}%; background:#16a34a;"></div>
                </div>
                <div style="font-weight:700; color:var(--neutral-muted); font-size:clamp(12px, 1.4vh, 18px); margin-top:8px;">
                  ${earlyRep > 0 ? '&#x2705; Early Voting &amp; Absentee: Complete' : '&#x23F3; Early Voting &amp; Absentee: Pending'}
                </div>
              </div>
            </div>

            <!-- Right Column: Party Ballot Distribution Visual Stack & Cards -->
            <div>
              <div class="visual-stat-card">
                <div class="visual-stat-title">&#x1F4CA; Ballots Cast Distribution</div>
                <div class="visual-stacked-bar">
                  <div class="visual-stacked-segment" style="width: ${repPct}%; background:#dc2626;" title="Republican: ${repPct.toFixed(1)}%"></div>
                  <div class="visual-stacked-segment" style="width: ${demPct}%; background:#2563eb;" title="Democrat: ${demPct.toFixed(1)}%"></div>
                  <div class="visual-stacked-segment" style="width: ${genPct}%; background:#6b7280;" title="General Only: ${genPct.toFixed(1)}%"></div>
                </div>

                <div style="display:flex; flex-direction:column; gap:8px; margin-top:12px;">
                  <div style="display:flex; justify-content:space-between; align-items:center; padding:8px 12px; background:#fef2f2; border:1px solid #fecaca; border-radius:8px;">
                    <span style="font-weight:700; color:#991b1b;">Republican Primary</span>
                    <span style="font-weight:800; color:#991b1b;">${(data.ballotsRep || 0).toLocaleString()} (${repPct.toFixed(1)}%)</span>
                  </div>
                  <div style="display:flex; justify-content:space-between; align-items:center; padding:8px 12px; background:#eff6ff; border:1px solid #bfdbfe; border-radius:8px;">
                    <span style="font-weight:700; color:#1e40af;">Democrat Primary</span>
                    <span style="font-weight:800; color:#1e40af;">${(data.ballotsDem || 0).toLocaleString()} (${demPct.toFixed(1)}%)</span>
                  </div>
                  <div style="display:flex; justify-content:space-between; align-items:center; padding:8px 12px; background:#f3f4f6; border:1px solid #e5e7eb; border-radius:8px;">
                    <span style="font-weight:700; color:#374151;">General Election Only</span>
                    <span style="font-weight:800; color:#374151;">${(data.ballotsGen || 0).toLocaleString()} (${genPct.toFixed(1)}%)</span>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <!-- Slide 1 Bottom Anchored Notices -->
          <footer class="slide-footer-notices">
            <div class="disclaimer-banner">
              <span>&#x2139;&#xFE0F;</span>
              <span><strong>Reporting Notice:</strong> Reaching 100% Election Day precincts reporting generally takes about 3 hours after polls close.</span>
            </div>
            <div class="disclaimer-banner">
              <span>&#x2139;&#xFE0F;</span>
              <span><strong>Results Notice:</strong> Precinct-level results are made available within 1 to 2 business days after Election Day.</span>
            </div>
          </footer>
        </article>
      `;
      return;
    }

    // Contest Slides (No duplicate text tables, replaced with visual analytics graphics)
    const contest = currentSlideObj.contest;
    const candidates = currentSlideObj.candidates;
    const pageNum = currentSlideObj.pageNum;
    const totalPages = currentSlideObj.totalPages;

    const cTitleEsc = escapeHtml(contest.title);
    const cRepCapped = Math.min(contest.precinctsReporting || 0, MAX_PRECINCT_CAP);
    const cTotCapped = Math.min(contest.precinctsTotal || 0, MAX_PRECINCT_CAP);

    let chartBarsHtml = '';
    const sortedCands = [...(contest.candidates || [])].sort((a, b) => b.votes - a.votes);

    candidates.forEach(cand => {
      const cParty = getCandidateParty(cand, contest);
      const partyClass = cParty === 'REP' ? 'party-rep' : cParty === 'DEM' ? 'party-dem' : 'party-ind';
      const fillColor = cParty === 'REP' ? 'var(--party-rep)' : cParty === 'DEM' ? 'var(--party-dem)' : 'var(--party-ind)';

      chartBarsHtml += `
        <div class="proj-cand-bar-item">
          <div class="proj-cand-header">
            <span>
              ${escapeHtml(cand.name)}
              ${cParty ? `<span class="party-pill ${partyClass}">${escapeHtml(cParty)}</span>` : ''}
              ${cand.isLeading && contest.totalVotes > 0 ? '<span class="leading-tag">&#x2714;&#xFE0F; LEADING</span>' : ''}
            </span>
            <span>${cand.votes.toLocaleString()} (${cand.percentage.toFixed(1)}%)</span>
          </div>
          <div class="proj-track">
            <div class="proj-fill" style="width: ${Math.min(cand.percentage, 100)}%; background: ${fillColor};"></div>
          </div>
        </div>
      `;
    });

    // Build Right-Side Visual Analytics Card
    let rightPanelAnalyticsHtml = '';
    if (sortedCands.length >= 2 && sortedCands[0].votes > 0) {
      const leadCand = sortedCands[0];
      const runnerUp = sortedCands[1];
      const leadMarginVotes = leadCand.votes - runnerUp.votes;
      const leadMarginPct = leadCand.percentage - runnerUp.percentage;

      rightPanelAnalyticsHtml += `
        <div class="visual-stat-card">
          <div class="visual-stat-title">&#x1F3C6; Lead Margin</div>
          <div class="visual-stat-value" style="color:#16a34a;">+ ${leadMarginVotes.toLocaleString()} votes</div>
          <div style="font-weight:700; color:var(--neutral-muted); font-size:clamp(12px, 1.4vh, 18px);">
            ${escapeHtml(leadCand.name)} leads by +${leadMarginPct.toFixed(1)}%
          </div>
        </div>
      `;
    }

    // Contest Precinct Reporting Visual Card
    const precPct = cTotCapped > 0 ? (cRepCapped / cTotCapped * 100) : 0;
    rightPanelAnalyticsHtml += `
      <div class="visual-stat-card">
        <div class="visual-stat-title">&#x1F5F3;&#xFE0F; Contest Precinct Progress</div>
        <div class="visual-stat-value">${cRepCapped} of ${cTotCapped}</div>
        <div style="font-weight:700; color:var(--neutral-muted); font-size:clamp(12px, 1.4vh, 18px);">
          ${precPct.toFixed(1)}% Precincts Reporting
        </div>
        <div class="proj-track" style="margin-top:6px;">
          <div class="proj-fill" style="width: ${precPct}%; background: #16a34a;"></div>
        </div>
      </div>
    `;

    viewport.innerHTML = `
      <article class="slide-card">
        <header class="slide-header">
          <div>
            <h1 class="slide-title">${cTitleEsc}${totalPages > 1 ? `<span style="font-size:0.7em; color:var(--neutral-muted); margin-left:10px;">(Page ${pageNum} of ${totalPages})</span>` : ''}</h1>
            <div style="font-size: clamp(14px, 1.2vw, 18px); color:var(--neutral-muted); margin-top:4px;">
              <span>${escapeHtml(contest.voteFor)}</span> &bull; 
              <span>Total Votes: ${contest.totalVotes.toLocaleString()}</span>
            </div>
          </div>
          <div class="slide-meta">
            &#x1F4CA; Slide ${currentSlideIndex + 1} of ${totalSlides} &bull; &#x1F5F3;&#xFE0F; ${cRepCapped} of ${cTotCapped} ED Precincts
          </div>
        </header>

        <div class="slide-content-grid">
          <div class="proj-chart-list">
            ${chartBarsHtml}
          </div>

          <div>
            ${rightPanelAnalyticsHtml}
          </div>
        </div>
      </article>
    `;
  }

  let slideElapsedMs = 0;
  let slideStartTime = 0;

  function startSlideTimer(resume) {
    stopSlideTimer();
    if (isPaused || !slideshowActive) return;

    if (resume && slideElapsedMs > 0) {
      slideStartTime = Date.now() - slideElapsedMs;
    } else {
      slideElapsedMs = 0;
      slideStartTime = Date.now();
    }

    const timerBar = document.getElementById('slide-timer-bar');

    slideProgressTimer = setInterval(() => {
      if (isPaused || !slideshowActive) return;
      slideElapsedMs = Date.now() - slideStartTime;
      const pct = Math.min((slideElapsedMs / slideIntervalMs) * 100, 100);
      if (timerBar) timerBar.style.width = `${pct}%`;

      if (slideElapsedMs >= slideIntervalMs) {
        slideElapsedMs = 0;
        nextSlide();
      }
    }, 100);
  }

  function stopSlideTimer() {
    if (slideProgressTimer) {
      clearInterval(slideProgressTimer);
      slideProgressTimer = null;
    }
    const timerBar = document.getElementById('slide-timer-bar');
    if (timerBar) timerBar.style.width = '0%';
  }

  function nextSlide() {
    const slides = getSlideList();
    const totalSlides = slides.length || 1;
    currentSlideIndex = (currentSlideIndex + 1) % totalSlides;
    renderCurrentSlide();
    startSlideTimer();
  }

  function prevSlide() {
    const slides = getSlideList();
    const totalSlides = slides.length || 1;
    currentSlideIndex = (currentSlideIndex - 1 + totalSlides) % totalSlides;
    renderCurrentSlide();
    startSlideTimer();
  }

  function jumpToSlide(idx) {
    currentSlideIndex = parseInt(idx, 10) || 0;
    renderCurrentSlide();
    startSlideTimer();
  }

  function togglePause() {
    isPaused = !isPaused;
    const btn = document.getElementById('btn-playpause');
    if (btn) {
      btn.innerHTML = isPaused ? '&#x25B6;&#xFE0F; Play' : '&#x23F8;&#xFE0F; Pause';
      btn.classList.toggle('active', !isPaused);
    }
    if (isPaused) {
      stopSlideTimer();
    } else {
      startSlideTimer();
    }
  }

  function setSlideSpeed(speedVal) {
    slideIntervalMs = parseInt(speedVal, 10) || 8000;
    startSlideTimer();
  }

  function toggleFullscreen() {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(err => {
        console.error('Fullscreen request failed:', err);
      });
    } else {
      if (document.exitFullscreen) {
        document.exitFullscreen();
      }
    }
  }

  function getVoteForNum(voteForText) {
    if (!voteForText) return 1;
    const match = voteForText.match(/(?:VOTE\s+(?:FOR\s+)?(?:UP\s+TO\s+)?|SELECT\s+)(\d+)/i) || voteForText.match(/(\d+)/);
    if (match) {
      const num = parseInt(match[1], 10);
      return isNaN(num) || num < 1 ? 1 : num;
    }
    return 1;
  }

  // Precinct Page Controller State
  let selectedPrecinct = '';
  let precinctViewMode = 'BY_PRECINCT';
  let precinctPartyFilter = 'ALL';
  let precinctSearchQuery = '';
  let selectedContestForPrecinctView = '';

  function savePrecinctStateToURL() {
    try {
      const params = new URLSearchParams();
      if (selectedPrecinct) params.set('precinct', selectedPrecinct);
      if (precinctViewMode) params.set('mode', precinctViewMode);
      if (precinctPartyFilter) params.set('party', precinctPartyFilter);
      if (selectedContestForPrecinctView) params.set('contest', selectedContestForPrecinctView);
      if (precinctSearchQuery) params.set('search', precinctSearchQuery);

      const newUrl = window.location.pathname + '?' + params.toString() + window.location.hash;
      history.replaceState(null, '', newUrl);

      sessionStorage.setItem('precinct_page_state', JSON.stringify({
        precinct: selectedPrecinct,
        mode: precinctViewMode,
        party: precinctPartyFilter,
        contest: selectedContestForPrecinctView,
        search: precinctSearchQuery
      }));
    } catch (e) {}
  }

  function restorePrecinctStateFromURL() {
    try {
      const params = new URLSearchParams(window.location.search);
      let state = {};

      if (params.has('precinct') || params.has('mode') || params.has('party') || params.has('contest') || params.has('search')) {
        state = {
          precinct: params.get('precinct') || '',
          mode: params.get('mode') || 'BY_PRECINCT',
          party: params.get('party') || 'ALL',
          contest: params.get('contest') || '',
          search: params.get('search') || ''
        };
      } else {
        const saved = sessionStorage.getItem('precinct_page_state');
        if (saved) state = JSON.parse(saved);
      }

      if (state.precinct) selectedPrecinct = state.precinct;
      if (state.mode) precinctViewMode = state.mode;
      if (state.party) precinctPartyFilter = state.party;
      if (state.contest) selectedContestForPrecinctView = state.contest;
      if (state.search) precinctSearchQuery = state.search;
    } catch (e) {}
  }

  function initPrecinctPage() {
    if (!window.ELECTION_DATA) {
      console.warn('Election data payload missing at start of Precinct page. Attempting dynamic load...');
      loadDataJsAndInitPrecinct();
      return;
    }
    electionData = window.ELECTION_DATA;
    applyConfigVisibility();
    if (!isPrecinctPageEnabled()) return;

    renderNavbarMetadata();
    setupPrecinctPageControls();
    renderPrecinctPage();
  }

  function loadDataJsAndInitPrecinct() {
    fetch(`./precincts.json?t=${Date.now()}`)
      .then(res => res.ok ? res.json() : null)
      .then(pData => {
        if (pData && (pData.precinctStats || pData.contests)) {
          window.ELECTION_DATA = { metadata: pData.metadata, config: pData.config, latest: pData };
          electionData = window.ELECTION_DATA;
          applyConfigVisibility();
          if (!isPrecinctPageEnabled()) return;
          renderNavbarMetadata();
          setupPrecinctPageControls();
          renderPrecinctPage();
          return;
        }
        throw new Error('precincts.json invalid');
      })
      .catch(() => {
        const script = document.createElement('script');
        script.src = `./data.js?t=${Date.now()}`;
        script.onload = function() {
          if (isValidPayload(window.ELECTION_DATA)) {
            electionData = window.ELECTION_DATA;
            applyConfigVisibility();
            if (!isPrecinctPageEnabled()) return;

            renderNavbarMetadata();
            setupPrecinctPageControls();
            renderPrecinctPage();
          }
          if (script.parentNode) script.parentNode.removeChild(script);
        };
        script.onerror = function() {
          console.error('Failed to load ./data.js over network.');
          if (script.parentNode) script.parentNode.removeChild(script);
        };
        document.head.appendChild(script);
      });
  }

  function loadDataJsAndInitReporting() {
    fetch(`./reporting.json?t=${Date.now()}`)
      .then(res => res.ok ? res.json() : null)
      .then(repData => {
        if (repData && repData.latest && Array.isArray(repData.latest.contests)) {
          window.ELECTION_DATA = repData;
          electionData = repData;
          applyConfigVisibility();
          renderNavbarMetadata();
          renderReportingTable();
          return;
        }
        throw new Error('reporting.json invalid');
      })
      .catch(() => {
        loadDataJsAndInit();
      });
  }

  function setupPrecinctPageControls() {
    if (!electionData || !electionData.latest) return;
    const latest = electionData.latest;
    const pStats = latest.precinctStats || {};
    const masterPrecincts = latest.masterPrecincts || electionData.masterPrecincts || [];
    
    const pSet = new Set(Object.keys(pStats));
    if (Array.isArray(masterPrecincts)) {
      masterPrecincts.forEach(p => pSet.add(p));
    }
    (latest.contests || []).forEach(c => {
      resolvePrecinctStatus(c, masterPrecincts).forEach(p => pSet.add(p.name));
    });
    const precinctList = Array.from(pSet).sort();

    restorePrecinctStateFromURL();

    const pSelect = document.getElementById('precinct-select');
    if (pSelect) {
      pSelect.innerHTML = '';
      if (precinctList.length > 0) {
        if (!selectedPrecinct || !precinctList.includes(selectedPrecinct)) {
          selectedPrecinct = precinctList[0];
        }
        precinctList.forEach(p => {
          const opt = document.createElement('option');
          opt.value = p;
          opt.textContent = p;
          if (p === selectedPrecinct) opt.selected = true;
          pSelect.appendChild(opt);
        });
      } else {
        pSelect.innerHTML = '<option value="">No Precinct Data Available</option>';
      }
    }

    const cSelect = document.getElementById('contest-precinct-select');
    if (cSelect) {
      cSelect.innerHTML = '<option value="">Select Contest...</option>';
      (latest.contests || []).forEach((c, idx) => {
        const opt = document.createElement('option');
        opt.value = c.title;
        opt.textContent = c.title;
        if (idx === 0 && !selectedContestForPrecinctView) selectedContestForPrecinctView = c.title;
        if (c.title === selectedContestForPrecinctView) opt.selected = true;
        cSelect.appendChild(opt);
      });
    }

    const searchInput = document.getElementById('precinct-search');
    if (searchInput) {
      if (precinctSearchQuery) searchInput.value = precinctSearchQuery;
      searchInput.addEventListener('input', function(e) {
        precinctSearchQuery = e.target.value.trim().toLowerCase();
        savePrecinctStateToURL();
        renderPrecinctPage();
      });
    }

    // Restore UI tabs state
    setPrecinctViewMode(precinctViewMode);
    setPrecinctPartyFilter(precinctPartyFilter);
  }

  function selectPrecinct(pName) {
    selectedPrecinct = pName;
    savePrecinctStateToURL();
    renderPrecinctPage();
  }

  function selectContestForPrecinctView(cTitle) {
    selectedContestForPrecinctView = cTitle;
    savePrecinctStateToURL();
    renderPrecinctPage();
  }

  function setPrecinctViewMode(mode) {
    precinctViewMode = mode;
    const pBtn = document.getElementById('view-mode-precinct-btn');
    const cBtn = document.getElementById('view-mode-contest-btn');
    const cWrapper = document.getElementById('contest-select-wrapper');
    if (pBtn && cBtn) {
      pBtn.classList.toggle('active', mode === 'BY_PRECINCT');
      pBtn.setAttribute('aria-selected', mode === 'BY_PRECINCT');
      cBtn.classList.toggle('active', mode === 'BY_CONTEST');
      cBtn.setAttribute('aria-selected', mode === 'BY_CONTEST');
    }
    if (cWrapper) {
      cWrapper.style.display = (mode === 'BY_CONTEST') ? 'block' : 'none';
    }
    savePrecinctStateToURL();
    renderPrecinctPage();
  }

  function setPrecinctPartyFilter(party) {
    precinctPartyFilter = party;
    document.querySelectorAll('[data-precinct-party]').forEach(btn => {
      const isMatch = btn.getAttribute('data-precinct-party') === party;
      btn.classList.toggle('active', isMatch);
      btn.setAttribute('aria-selected', isMatch);
    });
    savePrecinctStateToURL();
    renderPrecinctPage();
  }

  function renderPrecinctPage() {
    if (!electionData || !electionData.latest) return;
    const latest = electionData.latest;

    renderPrecinctHeaderMetrics();

    const container = document.getElementById('precinct-results-container');
    if (!container) return;

    if (precinctViewMode === 'BY_PRECINCT') {
      renderByPrecinctView(container, latest);
    } else {
      renderByContestPrecinctView(container, latest);
    }
  }

  function renderPrecinctHeaderMetrics() {
    if (!electionData || !electionData.latest) return;
    const pStats = (electionData.latest.precinctStats || {})[selectedPrecinct] || {};
    
    let reportedCount = 0;
    let totalContests = 0;
    (electionData.latest.contests || []).forEach(c => {
      const pStatus = (c.precinctsStatus || []).find(p => p.name === selectedPrecinct);
      if (pStatus) {
        totalContests++;
        if (pStatus.reported) reportedCount++;
      }
    });
    const isReported = reportedCount > 0;

    const ind = document.getElementById('precinct-status-indicator');
    if (ind) {
      ind.innerHTML = isReported 
        ? '<span style="color:var(--success);">&#x2705; REPORTED</span>' 
        : '<span style="color:var(--warning);">&#x23F3; PENDING / NOT REPORTED</span>';
    }

    const voters = pStats.voters || 0;
    const ballots = pStats.ballots || 0;
    const turnout = pStats.turnoutPercent !== undefined ? pStats.turnoutPercent : (voters > 0 ? (ballots/voters*100).toFixed(2) : '0.00');

    const vElem = document.getElementById('precinct-stat-voters');
    if (vElem) vElem.textContent = voters.toLocaleString();

    const bElem = document.getElementById('precinct-stat-ballots');
    if (bElem) bElem.textContent = ballots.toLocaleString();

    const repElem = document.getElementById('precinct-stat-ballots-rep');
    if (repElem) repElem.textContent = (pStats.rep || 0).toLocaleString();

    const demElem = document.getElementById('precinct-stat-ballots-dem');
    if (demElem) demElem.textContent = (pStats.dem || 0).toLocaleString();

    const genElem = document.getElementById('precinct-stat-ballots-gen');
    if (genElem) genElem.textContent = (pStats.gen || 0).toLocaleString();

    const tElem = document.getElementById('precinct-stat-turnout');
    if (tElem) tElem.textContent = `${turnout}%`;

    const tFill = document.getElementById('precinct-turnout-fill');
    if (tFill) tFill.style.width = `${Math.min(100, parseFloat(turnout))}%`;
  }

  function renderByPrecinctView(container, latest) {
    container.innerHTML = '';
    const contests = latest.contests || [];

    const filtered = contests.filter(c => {
      // 1. Precinct eligibility filter: contest MUST belong to selectedPrecinct
      const belongsToPrecinct = (c.precinctsStatus || []).some(p => p.name === selectedPrecinct);
      if (!belongsToPrecinct) return false;

      // 2. Party filter
      const pUpper = c.title.toUpperCase();
      if (precinctPartyFilter === 'REP' && !pUpper.startsWith('REP')) return false;
      if (precinctPartyFilter === 'DEM' && !pUpper.startsWith('DEM')) return false;
      if (precinctPartyFilter === 'IND' && (pUpper.startsWith('REP') || pUpper.startsWith('DEM'))) return false;

      // 3. Search query
      if (precinctSearchQuery) {
        const titleMatch = c.title.toLowerCase().includes(precinctSearchQuery);
        const candMatch = (c.candidates || []).some(cand => cand.name.toLowerCase().includes(precinctSearchQuery));
        if (!titleMatch && !candMatch) return false;
      }
      return true;
    });

    if (filtered.length === 0) {
      container.innerHTML = '<div class="no-results-card" style="grid-column: 1 / -1; padding: 48px; text-align: center; background: var(--surface); border-radius: 12px; border: 1px solid var(--border); box-shadow: var(--shadow-sm); font-size:16px; font-weight:600; color:var(--neutral-muted);">No contests available for ' + escapeHtml(selectedPrecinct) + ' matching filter criteria</div>';
      return;
    }

    filtered.forEach(c => {
      const card = document.createElement('article');
      card.className = 'contest-card';
      card.style.cssText = 'background: var(--surface); border-radius: 12px; border: 1px solid var(--border); box-shadow: var(--shadow-sm); padding: 24px 28px; margin-bottom: 24px; overflow: hidden;';

      const pStatus = (c.precinctsStatus || []).find(p => p.name === selectedPrecinct);
      const isReported = pStatus ? pStatus.reported : false;

      let precinctTotalVotes = 0;
      const candsWithPV = (c.candidates || []).map(cand => {
        const pv = (cand.precinctVotes || {})[selectedPrecinct] || 0;
        precinctTotalVotes += pv;
        return {
          name: cand.name,
          party: getCandidateParty(cand, c),
          votes: pv,
          totalVotes: cand.votes,
          totalPercentage: cand.percentage
        };
      });

      const vfNum = getVoteForNum(c.voteFor);
      const sortedPV = candsWithPV.map(cand => cand.votes).sort((a, b) => b - a);
      const positivePV = sortedPV.filter(v => v > 0);
      const cutoffPV = positivePV.length > 0 ? positivePV[Math.min(vfNum, positivePV.length) - 1] : null;

      let candsHtml = '';
      candsWithPV.forEach(cand => {
        const pct = precinctTotalVotes > 0 ? ((cand.votes / precinctTotalVotes) * 100).toFixed(2) : '0.00';
        const isLead = isReported && cutoffPV !== null && cand.votes >= cutoffPV && cand.votes > 0;
        const partyClass = cand.party === 'REP' ? 'party-rep' : (cand.party === 'DEM' ? 'party-dem' : 'party-ind');

        candsHtml += `
          <div class="candidate-row ${isLead ? 'leading-row' : ''}" style="padding: 14px 18px; border-radius: 10px; border: 1px solid var(--border); background: var(--neutral-light); margin-bottom: 10px;">
            <div class="candidate-info" style="display:flex; align-items:center; justify-content:space-between; gap:12px; flex-wrap:wrap;">
              <div style="display:flex; align-items:center; gap:10px; flex-wrap:wrap;">
                <span class="candidate-name" style="font-weight:700; font-size:16px; color:var(--neutral-dark);">${escapeHtml(cand.name)}</span>
                ${cand.party ? `<span class="party-pill ${partyClass}" style="font-size:12px; font-weight:700; padding:3px 8px; border-radius:4px;">${escapeHtml(cand.party)}</span>` : ''}
              </div>
              ${isLead ? '<span class="status-pill status-reported" style="font-size:12px; padding:3px 8px; font-weight:700;">&#x2714; LEADING IN PRECINCT</span>' : ''}
            </div>
            <div class="candidate-stats" style="display:flex; justify-content:space-between; margin-top:8px; font-size:15px;">
              <span class="vote-count" style="font-weight:700; color:var(--primary);">${cand.votes.toLocaleString()} votes</span>
              <span class="vote-percent" style="font-weight:600; color:var(--neutral-muted);">${pct}%</span>
            </div>
            <div class="progress-bar-bg" style="height:10px; background:var(--border); border-radius:5px; margin-top:6px; overflow:hidden;">
              <div class="progress-bar-fill" style="width: ${Math.min(100, parseFloat(pct))}%; height:100%; background:var(--primary); border-radius:5px; transition:width 0.3s ease;"></div>
            </div>
          </div>
        `;
      });

      card.innerHTML = `
        <header class="contest-header" style="border-bottom:1px solid var(--border); padding-bottom:16px; margin-bottom:20px; display:flex; justify-content:space-between; align-items:flex-start; gap:16px;">
          <div>
            <h2 class="contest-title" style="font-size:20px; font-weight:800; color:var(--neutral-dark); margin:0;">${escapeHtml(c.title)}</h2>
            <div class="contest-subtitle" style="font-size:14px; font-weight:600; color:var(--neutral-muted); margin-top:4px;">${escapeHtml(c.voteFor)}</div>
          </div>
          <span class="status-pill ${isReported ? 'status-reported' : 'status-pending'}" style="font-size:13px; padding:4px 10px; font-weight:700;">
            ${isReported ? '&#x2705; REPORTED' : '&#x23F3; PENDING'}
          </span>
        </header>
        <div class="candidates-list" style="display:flex; flex-direction:column; gap:8px;">
          ${candsHtml}
        </div>
        <footer class="contest-footer" style="margin-top:20px; padding-top:14px; border-top:1px dashed var(--border); display:flex; justify-content:space-between; font-size:14px; color:var(--neutral-muted);">
          <span>Precinct Total Votes: <strong style="color:var(--neutral-dark); font-weight:700;">${precinctTotalVotes.toLocaleString()}</strong></span>
          <span>Countywide Contest Total: <strong style="color:var(--neutral-dark); font-weight:700;">${c.totalVotes.toLocaleString()}</strong></span>
        </footer>
      `;
      container.appendChild(card);
    });
  }

  function renderByContestPrecinctView(container, latest) {
    container.innerHTML = '';
    const contests = latest.contests || [];
    let contest = contests.find(c => c.title === selectedContestForPrecinctView);
    if (!contest && contests.length > 0) {
      contest = contests[0];
      selectedContestForPrecinctView = contest.title;
    }

    if (!contest) {
      container.innerHTML = '<div class="no-results-card" style="grid-column: 1 / -1;">No contest selected</div>';
      return;
    }

    const cands = contest.candidates || [];
    const pStatuses = contest.precinctsStatus || [];
    const vfNum = getVoteForNum(contest.voteFor);

    const filteredPrecincts = pStatuses.filter(p => {
      if (precinctSearchQuery) {
        return p.name.toLowerCase().includes(precinctSearchQuery);
      }
      return true;
    });

    let tableRowsHtml = '';
    filteredPrecincts.forEach(p => {
      let pTotal = 0;
      const candVotes = cands.map(cand => {
        const v = (cand.precinctVotes || {})[p.name] || 0;
        pTotal += v;
        return v;
      });

      const sortedPV = candVotes.slice().sort((a, b) => b - a);
      const positivePV = sortedPV.filter(v => v > 0);
      const cutoffPV = positivePV.length > 0 ? positivePV[Math.min(vfNum, positivePV.length) - 1] : null;

      let candCellsHtml = '';
      candVotes.forEach((v, idx) => {
        const isLead = p.reported && cutoffPV !== null && v >= cutoffPV && v > 0;
        candCellsHtml += `
          <td style="text-align:right; font-weight:${isLead ? '700' : '400'}; color:${isLead ? 'var(--primary)' : 'inherit'}; padding:12px 16px;">
            ${v.toLocaleString()} ${isLead ? '&#x2714;' : ''}
          </td>
        `;
      });

      tableRowsHtml += `
        <tr style="border-bottom:1px solid var(--border);">
          <td style="font-weight:600; text-align:left; padding:12px 16px;">${escapeHtml(p.name)}</td>
          <td style="text-align:center; padding:12px 16px;">
            <span class="status-pill ${p.reported ? 'status-reported' : 'status-pending'}" style="font-size:11px; padding:3px 8px;">
              ${p.reported ? 'REPORTED' : 'PENDING'}
            </span>
          </td>
          <td style="text-align:right; font-weight:700; padding:12px 16px;">${pTotal.toLocaleString()}</td>
          ${candCellsHtml}
        </tr>
      `;
    });

    let candHeadersHtml = '';
    cands.forEach(cand => {
      candHeadersHtml += `<th style="text-align:right; padding:12px 16px;">${escapeHtml(cand.name)}</th>`;
    });

    const wrapper = document.createElement('div');
    wrapper.style.gridColumn = '1 / -1';
    wrapper.className = 'table-card';
    wrapper.style.background = 'var(--surface)';
    wrapper.style.borderRadius = '12px';
    wrapper.style.border = '1px solid var(--border)';
    wrapper.style.boxShadow = 'var(--shadow-sm)';
    wrapper.style.overflow = 'hidden';
    wrapper.innerHTML = `
      <header style="padding:20px 24px; border-bottom:1px solid var(--border); display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:12px; background:var(--neutral-light);">
        <div>
          <h2 style="font-size:22px; font-weight:800; color:var(--neutral-dark); margin:0;">${escapeHtml(contest.title)}</h2>
          <div style="font-size:14px; font-weight:600; color:var(--neutral-muted); margin-top:4px;">${escapeHtml(contest.voteFor)} &bull; ${contest.precinctsReporting} of ${contest.precinctsTotal} Precincts Reporting</div>
        </div>
      </header>
      <div style="overflow-x:auto; padding:8px 0;">
        <table class="reporting-table" style="width:100%; border-collapse:collapse;">
          <thead>
            <tr style="background:var(--neutral-light); border-bottom:2px solid var(--border);">
              <th style="text-align:left; padding:12px 16px;">Precinct</th>
              <th style="text-align:center; padding:12px 16px;">Status</th>
              <th style="text-align:right; padding:12px 16px;">Total Votes</th>
              ${candHeadersHtml}
            </tr>
          </thead>
          <tbody>
            ${tableRowsHtml}
          </tbody>
        </table>
      </div>
    `;
    container.appendChild(wrapper);
  }

  function exportPrecinctCSV(mode) {
    if (!electionData || !electionData.latest) return;
    const latest = electionData.latest;
    const contests = latest.contests || [];
    const pStats = latest.precinctStats || {};

    let filename = '';
    let csvContent = 'Precinct,Contest,Candidate,Party,Precinct Votes,County Total Votes\n';

    if (mode === 'FILTERED' && precinctViewMode === 'BY_PRECINCT') {
      const cleanPrecinct = selectedPrecinct.replace(/[^a-zA-Z0-9_-]/g, '_');
      filename = `Hamilton_County_${cleanPrecinct}_Results_${Date.now()}.csv`;

      const filtered = contests.filter(c => {
        const belongsToPrecinct = (c.precinctsStatus || []).some(p => p.name === selectedPrecinct);
        if (!belongsToPrecinct) return false;

        const pUpper = c.title.toUpperCase();
        if (precinctPartyFilter === 'REP' && !pUpper.startsWith('REP')) return false;
        if (precinctPartyFilter === 'DEM' && !pUpper.startsWith('DEM')) return false;
        if (precinctPartyFilter === 'IND' && (pUpper.startsWith('REP') || pUpper.startsWith('DEM'))) return false;

        if (precinctSearchQuery) {
          const titleMatch = c.title.toLowerCase().includes(precinctSearchQuery);
          const candMatch = (c.candidates || []).some(cand => cand.name.toLowerCase().includes(precinctSearchQuery));
          if (!titleMatch && !candMatch) return false;
        }
        return true;
      });

      filtered.forEach(c => {
        (c.candidates || []).forEach(cand => {
          const v = (cand.precinctVotes || {})[selectedPrecinct] || 0;
          const cParty = getCandidateParty(cand, c);
          csvContent += `"${selectedPrecinct}","${c.title}","${cand.name}","${cParty}",${v},${cand.votes}\n`;
        });
      });

    } else if (mode === 'FILTERED' && precinctViewMode === 'BY_CONTEST') {
      let contest = contests.find(c => c.title === selectedContestForPrecinctView) || contests[0];
      const cleanContest = contest.title.replace(/[^a-zA-Z0-9_-]/g, '_');
      filename = `Hamilton_County_${cleanContest}_Precincts_${Date.now()}.csv`;

      const pStatuses = contest.precinctsStatus || [];
      const filteredPrecincts = pStatuses.filter(p => {
        if (precinctSearchQuery) return p.name.toLowerCase().includes(precinctSearchQuery);
        return true;
      });

      filteredPrecincts.forEach(p => {
        (contest.candidates || []).forEach(cand => {
          const v = (cand.precinctVotes || {})[p.name] || 0;
          const cParty = getCandidateParty(cand, contest);
          csvContent += `"${p.name}","${contest.title}","${cand.name}","${cParty}",${v},${cand.votes}\n`;
        });
      });

    } else {
      // mode === 'ALL' or fallback
      filename = `Hamilton_County_All_Precincts_Results_${Date.now()}.csv`;
      const pSet = new Set(Object.keys(pStats));
      contests.forEach(c => {
        (c.precinctsStatus || []).forEach(p => pSet.add(p.name));
      });
      const allPrecincts = Array.from(pSet).sort();

      allPrecincts.forEach(pName => {
        contests.forEach(c => {
          const belongs = (c.precinctsStatus || []).some(p => p.name === pName);
          if (belongs) {
            // Apply party filter if active
            const pUpper = c.title.toUpperCase();
            if (precinctPartyFilter === 'REP' && !pUpper.startsWith('REP')) return;
            if (precinctPartyFilter === 'DEM' && !pUpper.startsWith('DEM')) return;
            if (precinctPartyFilter === 'IND' && (pUpper.startsWith('REP') || pUpper.startsWith('DEM'))) return;

            (c.candidates || []).forEach(cand => {
              const v = (cand.precinctVotes || {})[pName] || 0;
              const cParty = getCandidateParty(cand, c);
              csvContent += `"${pName}","${c.title}","${cand.name}","${cParty}",${v},${cand.votes}\n`;
            });
          }
        });
      });
    }

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = filename;
    link.click();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  return {
    setPartyFilter: setPartyFilter,
    toggleDarkMode: toggleDarkMode,
    toggleHighContrast: toggleHighContrast,
    refreshResults: refreshResults,
    jumpToContest: jumpToContest,
    scrollToTop: scrollToTop,
    openPrecinctModal: openPrecinctModal,
    closePrecinctModal: closePrecinctModal,
    setModalFilter: setModalFilter,
    handleModalSearch: handleModalSearch,
    exportCSV: exportCSV,

    // Precinct Page Exports
    initPrecinctPage: initPrecinctPage,
    selectPrecinct: selectPrecinct,
    selectContestForPrecinctView: selectContestForPrecinctView,
    setPrecinctViewMode: setPrecinctViewMode,
    setPrecinctPartyFilter: setPrecinctPartyFilter,
    exportPrecinctCSV: exportPrecinctCSV,

    // Slideshow Engine Exports
    initSlideshow: initSlideshow,
    nextSlide: nextSlide,
    prevSlide: prevSlide,
    jumpToSlide: jumpToSlide,
    togglePause: togglePause,
    setSlideSpeed: setSlideSpeed,
    toggleFullscreen: toggleFullscreen
  };
})();



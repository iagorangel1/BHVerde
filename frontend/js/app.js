(async () => {
  'use strict';

  const BH_CENTER = [-19.9191, -43.9386];
  const API_BASE = window.BHVERDE_API_BASE || 'http://localhost:3000/api/v1';
  let runtimeConfig = {};
  try {
    const response = await fetch(`${API_BASE}/config`, { signal: AbortSignal.timeout(2500) });
    if (response.ok) runtimeConfig = await response.json();
  } catch { /* Keep the app shell usable while the API is unavailable. */ }
  let accessToken = null;
  let session = null;
  let apiCounts = { tree: 0, planting: 0, care: 0 };
  let loadController = null;
  let loadSequence = 0;
  const CATEGORY = {
    tree: { label: 'Árvore existente', className: 'tree', iconFile: 'arvore-existente-pin.png' },
    planting: { label: 'Plantio', className: 'planting', iconFile: 'plantio-pin.png' },
    care: { label: 'Poda / Remoção', className: 'care', iconFile: 'poda-remocao-pin.png' }
  };

  const $ = (selector) => document.querySelector(selector);
  const map = L.map('map', {
    zoomControl: false,
    scrollWheelZoom: true,
    minZoom: 3,
    maxZoom: 19
  }).setView(BH_CENTER, 13);
  const clusterOptions = {
    maxClusterRadius: 58,
    disableClusteringAtZoom: 17,
    showCoverageOnHover: false,
    spiderfyOnMaxZoom: true,
    chunkedLoading: true,
    iconCreateFunction(cluster) {
      const count = cluster.getChildCount();
      const size = count < 10 ? 'small' : count < 100 ? 'medium' : 'large';
      return L.divIcon({ html: `<span>${count.toLocaleString('pt-BR')}</span>`, className: `bh-cluster bh-cluster-${size}`, iconSize: L.point(42, 42) });
    }
  };
  const markersLayer = typeof L.markerClusterGroup === 'function' ? L.markerClusterGroup(clusterOptions).addTo(map) : L.layerGroup().addTo(map);
  const mapKey = encodeURIComponent(runtimeConfig.mapTilerKey || '');
  const streetLayer = L.tileLayer(`https://api.maptiler.com/maps/streets-v2/{z}/{x}/{y}.png?key=${mapKey}`, {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://www.maptiler.com/">MapTiler</a>'
  }).addTo(map);
  const lightLayer = L.tileLayer(`https://api.maptiler.com/maps/basic-v2-light/{z}/{x}/{y}.png?key=${mapKey}`, {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap contributors &copy; MapTiler'
  });
  const darkLayer = L.tileLayer(`https://api.maptiler.com/maps/streets-v2-dark/{z}/{x}/{y}.png?key=${mapKey}`, {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap contributors &copy; MapTiler'
  });
  let activeTileLayer = streetLayer;
  let mapTileErrorNotified = false;
  const notifyTileError = () => {
    if (mapTileErrorNotified) return;
    mapTileErrorNotified = true;
    showToast(runtimeConfig.mapTilerKey
      ? 'MapTiler não carregou. Verifique a chave, suas restrições e a conexão.'
      : 'Configure MAPTILER_KEY em backend/.env para carregar os tiles.');
  };
  streetLayer.on('tileerror', notifyTileError);
  lightLayer.on('tileerror', notifyTileError);
  darkLayer.on('tileerror', notifyTileError);
  try {
    const savedTheme = localStorage.getItem('bhverde-map-theme');
    const savedLayer = savedTheme === 'dark' ? darkLayer : savedTheme === 'light' ? lightLayer : streetLayer;
    if (savedLayer !== streetLayer) {
      map.removeLayer(streetLayer);
      savedLayer.addTo(map);
      activeTileLayer = savedLayer;
    }
    document.documentElement.classList.toggle('theme-dark', savedTheme === 'dark');
  } catch { /* Storage may be unavailable. */ }

  function updateThemeToggle() {
    const isDark = activeTileLayer === darkLayer;
    const button = $('#layers-button');
    button.innerHTML = isDark
      ? '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M4.93 4.93l1.42 1.42m11.3 11.3 1.42 1.42M2 12h2m16 0h2M4.93 19.07l1.42-1.42m11.3-11.3 1.42-1.42"/></svg>'
      : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20.2 15.4A8.4 8.4 0 0 1 8.6 3.8 8.5 8.5 0 1 0 20.2 15.4Z"/></svg>';
    button.setAttribute('aria-label', isDark ? 'Ativar modo claro' : 'Ativar modo escuro');
    button.title = isDark ? 'Ativar modo claro' : 'Ativar modo escuro';
  }
  updateThemeToggle();

  let contributions = [];
  let contributionMarkers = [];
  let selectedCategory = 'tree';
  let selectedPoint = null;
  let selectedAddress = '';
  let reverseAddressSequence = 0;
  let selectedPhotos = [];
  let draftMarker = null;
  let addressConfirmationPending = false;
  let manualLocationRestore = null;
  let toastTimeout;
  let currentFilter = 'all';
  let currentView = 'mapa';
  let legendCollapsed = false;
  let authMode = 'login';

  async function finishGoogleLogin() {
    const params = new URLSearchParams(window.location.search);
    if (params.get('google_oauth') !== 'success' && params.get('google_oauth') !== 'error') return;
    const status = params.get('google_oauth');
    const code = params.get('code');
    const message = params.get('message');
    history.replaceState(null, '', `${window.location.pathname}${window.location.hash}`);
    if (status === 'error') {
      showToast(message || 'Não foi possível entrar com Google.');
      return;
    }
    try {
      const result = await apiRequest('/auth/google/exchange', { method: 'POST', body: JSON.stringify({ code }) });
      accessToken = result.token;
      session = result.user;
      renderProfile();
      showToast('Login Google realizado.');
    } catch (error) {
      showToast(error.message);
    }
  }

  const modal = $('#modal-backdrop');
  const form = $('#contribution-form');
  const error = $('#form-error');
  const profileLayer = $('#profile-layer');
  const profileTemplate = $('#profile-view-template');
  const markerSheet = $('#marker-sheet');

  profileLayer.append(profileTemplate.content.cloneNode(true));

  async function apiRequest(path, options = {}) {
    const headers = { Accept: 'application/json', ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}), ...options.headers };
    const response = await fetch(`${API_BASE}${path}`, { ...options, headers });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `API error ${response.status}`);
    return payload;
  }

  async function loadContributions() {
    const sequence = ++loadSequence;
    loadController?.abort();
    loadController = new AbortController();
    const bounds = map.getBounds();
    const bbox = [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()].join(',');
    try {
      const params = new URLSearchParams({ bbox, limit: '2000' });
      const result = await apiRequest(`/contributions?${params}`, { signal: loadController.signal });
      if (sequence !== loadSequence) return;
      contributions = result.items;
      apiCounts = { tree: 0, planting: 0, care: 0, ...Object.fromEntries(result.counts.map((entry) => [entry.category, Number(entry.count)])) };
      renderMarkers();
      if (currentView === 'explorar' && !profileLayer.hidden) renderExplore();
      if (result.truncated) showToast('Muitos registros nesta área. Aumente o zoom para ver mais.');
    } catch (error) {
      if (error.name !== 'AbortError' && sequence === loadSequence) {
        const detail = error instanceof TypeError
          ? `API indisponível em ${API_BASE}. Inicie o backend com npm run dev na raiz do projeto.`
          : error.message;
        showToast(`Não foi possível carregar contribuições: ${detail}`);
      }
    }
  }

  function markerIcon(category, draft = false, zoom = map.getZoom()) {
    const config = CATEGORY[category] || CATEGORY.tree;
    const size = zoom >= 19
      ? { width: 44, height: 56 }
      : zoom >= 18
        ? { width: 38, height: 48 }
        : { width: 30, height: 38 };
    const extra = draft ? ' draft-marker' : '';
    return L.divIcon({
      className: 'marker-icon-transparent',
      html: `<img class="tree-marker ${config.className}${extra}" style="--marker-width:${size.width}px;--marker-height:${size.height}px" src="./assets/icons/${config.iconFile}?v=pin-top-curve" alt="${config.label}">`,
      iconSize: [size.width, size.height],
      iconAnchor: [size.width / 2, size.height - 1],
      popupAnchor: [0, -21]
    });
  }

  function updateMarkerSizes() {
    const zoom = map.getZoom();
    contributionMarkers.forEach((marker) => {
      const wasSelected = marker.getElement()?.querySelector('.tree-marker')?.classList.contains('is-selected');
      marker.setIcon(markerIcon(marker._bhCategory, false, zoom));
      if (wasSelected) marker.getElement()?.querySelector('.tree-marker')?.classList.add('is-selected');
    });
    if (draftMarker) draftMarker.setIcon(markerIcon(selectedCategory, true, zoom));
  }

  function renderMarkers() {
    closeMarkerSheet();
    markersLayer.clearLayers();
    contributionMarkers = [];
    const query = $('#search-input').value.trim().toLocaleLowerCase('pt-BR');
    const filtered = contributions.filter((item) => {
      const matchesCategory = currentFilter === 'all' || item.category === currentFilter;
      const haystack = `${CATEGORY[item.category].label} ${item.address || ''} ${item.description || ''} ${item.contributor || ''}`.toLocaleLowerCase('pt-BR');
      return matchesCategory && (!query || haystack.includes(query));
    });

    filtered.forEach((item) => {
      const marker = L.marker([Number(item.lat), Number(item.lng)], { icon: markerIcon(item.category), title: CATEGORY[item.category].label });
      marker._bhCategory = item.category;
      marker.on('click', () => openMarkerSheet(item, marker));
      marker.addTo(markersLayer);
      contributionMarkers.push(marker);
    });

    $('#count-tree').textContent = Number(apiCounts.tree || 0).toLocaleString('pt-BR');
    $('#count-planting').textContent = Number(apiCounts.planting || 0).toLocaleString('pt-BR');
    $('#count-care').textContent = Number(apiCounts.care || 0).toLocaleString('pt-BR');
  }

  function openMarkerSheet(item, marker) {
    document.querySelectorAll('.tree-marker.is-selected').forEach((node) => node.classList.remove('is-selected'));
    marker.getElement()?.querySelector('.tree-marker')?.classList.add('is-selected');
    const config = CATEGORY[item.category];
    $('#marker-sheet-category').textContent = config.label;
    $('#marker-sheet-title').textContent = config.label;
    $('#marker-sheet-id').textContent = `${item.category === 'tree' ? 'ID da árvore' : 'ID do registro'}: ${item.id}`;
    $('#marker-sheet-address').textContent = item.address || `${Number(item.lat).toFixed(5)}, ${Number(item.lng).toFixed(5)}`;
    $('#marker-sheet-description').textContent = item.description || 'Contribuição registrada pela comunidade.';
    $('#marker-sheet-photos').innerHTML = Array.isArray(item.photos)
      ? item.photos.map((photo) => `<img src="${escapeHtml(photo.dataUrl)}" alt="Foto da contribuição" loading="lazy">`).join('')
      : '';
    $('#marker-sheet-meta').textContent = `${formatDate(item.createdAt)}${item.contributor ? ` · por ${item.contributor}` : ''}`;
    $('#delete-contribution').hidden = !item.isOwner;
    $('#delete-contribution').dataset.contributionId = item.isOwner ? item.id : '';
    markerSheet.hidden = false;
  }

  $('#delete-contribution').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    const id = button.dataset.contributionId;
    if (!id || !window.confirm('Excluir esta contribuição? Esta ação não pode ser desfeita.')) return;
    button.disabled = true;
    try {
      await apiRequest(`/contributions/${encodeURIComponent(id)}`, { method: 'DELETE' });
      closeMarkerSheet();
      await loadContributions();
      showToast('Sua contribuição foi excluída.');
    } catch (requestError) {
      showToast(requestError.message || 'Não foi possível excluir a contribuição.');
    } finally {
      button.disabled = false;
    }
  });

  function closeMarkerSheet() {
    markerSheet.hidden = true;
    $('#delete-contribution').hidden = true;
    $('#delete-contribution').dataset.contributionId = '';
    document.querySelectorAll('.tree-marker.is-selected').forEach((node) => node.classList.remove('is-selected'));
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (character) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[character]);
  }

  function formatDate(value) {
    if (!value) return 'Agora';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? 'Agora' : new Intl.DateTimeFormat('pt-BR', { dateStyle: 'medium' }).format(date);
  }

  function showToast(message) {
    const toast = $('#toast');
    toast.textContent = message;
    toast.classList.add('visible');
    clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => toast.classList.remove('visible'), 2600);
  }

  function renderExplore() {
    const persistentNav = document.querySelector('.bottom-nav');
    profileLayer.hidden = false;
    document.querySelector('.topbar').hidden = true;
    document.querySelector('.search-box').hidden = true;
    document.querySelector('.map-tools').hidden = true;
    document.querySelector('.legend-card').hidden = true;
    $('#legend-restore').hidden = true;
    $('#add-button').hidden = true;
    $('.map-attribution').hidden = true;
    persistentNav.hidden = true;
    persistentNav.style.zIndex = '700';

    const recent = [...contributions]
      .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))
      .slice(0, 30);
    const categories = [
      ['tree', 'Árvores existentes', apiCounts.tree],
      ['planting', 'Plantios', apiCounts.planting],
      ['care', 'Poda / remoção', apiCounts.care]
    ];
    const records = recent.length ? recent.map((item) => {
      const category = CATEGORY[item.category] || CATEGORY.tree;
      const iconClass = item.category === 'planting' ? 'sprite-planting' : item.category === 'care' ? 'sprite-care' : 'sprite-tree';
      const description = item.description?.trim() || 'Registro compartilhado pela comunidade.';
      const contributor = item.contributor?.trim() || 'Pessoa da comunidade';
      const location = item.address?.trim() || `${Number(item.lat).toFixed(4)}, ${Number(item.lng).toFixed(4)}`;
      return `<article class="community-post"><div class="community-post-heading"><span class="legend-icon ${iconClass}" aria-hidden="true"></span><div><strong>${escapeHtml(category.label)}</strong><small>${escapeHtml(contributor)} · ${escapeHtml(formatDate(item.createdAt))}</small></div></div><p>${escapeHtml(description)}</p><div class="community-post-location"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 10c0 5-8 12-8 12S4 15 4 10a8 8 0 1 1 16 0Z"/><circle cx="12" cy="10" r="2.5"/></svg>${escapeHtml(location)}</div></article>`;
    }).join('') : '<div class="community-empty"><strong>Sem registros nesta área ainda</strong><span>Volte ao mapa e compartilhe a primeira contribuição.</span></div>';

    profileLayer.replaceChildren();
    profileLayer.insertAdjacentHTML('afterbegin', `<section class="explore-feed" aria-labelledby="explore-title"><header class="explore-hero"><p class="eyebrow">BH VERDE · COMUNIDADE</p><h1 id="explore-title">Explore a comunidade</h1><p>Informações e registros recentes na área atual do mapa.</p></header><section class="explore-summary" aria-label="Resumo das contribuições"><div class="explore-total"><strong>${contributions.length.toLocaleString('pt-BR')}</strong><span>registros carregados</span></div>${categories.map(([key, label, count]) => `<div class="explore-category"><span class="explore-category-dot ${key}"></span><span>${label}</span><strong>${Number(count || 0).toLocaleString('pt-BR')}</strong></div>`).join('')}</section><section class="community-feed" aria-labelledby="community-feed-title"><div class="community-feed-title"><h2 id="community-feed-title">Registros da comunidade</h2><span>Mais recentes</span></div>${records}</section></section>`);
    profileLayer.append(persistentNav);
    persistentNav.hidden = false;
  }

  function renderProfile() {
    const persistentNav = document.querySelector('.bottom-nav');
    profileLayer.hidden = false;
    document.querySelector('.topbar').hidden = true;
    document.querySelector('.search-box').hidden = true;
    document.querySelector('.map-tools').hidden = true;
    document.querySelector('.legend-card').hidden = true;
    $('#legend-restore').hidden = true;
    $('#add-button').hidden = true;
    $('.map-attribution').hidden = true;
    $('.bottom-nav').hidden = true;
    $('.bottom-nav').style.zIndex = '700';
    profileLayer.replaceChildren(profileTemplate.content.cloneNode(true));
    profileLayer.append(persistentNav);
    const currentSession = session;
    const profileContent = $('#profile-content');
    if (currentSession) {
      $('#profile-avatar').textContent = (currentSession.name || '🌱').trim().charAt(0).toLocaleUpperCase('pt-BR') || '🌱';
      $('#profile-title').textContent = currentSession.name;
      $('#profile-intro').textContent = currentSession.email;
      profileContent.innerHTML = `<button class="profile-back" type="button" data-profile-back><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 18-6-6 6-6"/></svg>Voltar ao mapa</button><div class="auth-card signed-card"><h2>Olá, ${escapeHtml(currentSession.name)}!</h2><p>Obrigado por ajudar a cuidar das árvores de BH.</p><div class="profile-stats"><div class="profile-stat"><strong id="profile-mine-count">—</strong><span>suas contribuições</span></div><div class="profile-stat"><strong id="profile-total-count">${contributions.length}</strong><span>registros carregados</span></div></div><button class="signout-button" type="button" data-signout>Sair da conta</button><p class="auth-footnote">A sessão é mantida apenas até fechar ou recarregar esta página.</p></div>`;
      apiRequest('/auth/me').then((result) => {
        const count = $('#profile-mine-count');
        if (count && !profileLayer.hidden) count.textContent = Number(result.contributions).toLocaleString('pt-BR');
      }).catch((requestError) => showToast(requestError.message));
    } else {
      $('#profile-title').textContent = authMode === 'login' ? 'Bem-vinda(o) de volta' : 'Criar sua conta';
      $('#profile-intro').textContent = 'Acesse para identificar e acompanhar suas contribuições.';
      profileContent.innerHTML = `<button class="profile-back" type="button" data-profile-back><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 18-6-6 6-6"/></svg>Voltar ao mapa</button><div class="auth-card"><div class="auth-tabs" role="tablist"><button class="auth-tab ${authMode === 'login' ? 'active' : ''}" type="button" data-auth-mode="login" role="tab" aria-selected="${authMode === 'login'}">Entrar</button><button class="auth-tab ${authMode === 'signup' ? 'active' : ''}" type="button" data-auth-mode="signup" role="tab" aria-selected="${authMode === 'signup'}">Criar conta</button></div><form class="auth-form" id="auth-form">${authMode === 'signup' ? '<label class="auth-field">Nome<input name="name" type="text" autocomplete="name" maxlength="60" required placeholder="Seu nome"></label>' : ''}<label class="auth-field">E-mail<input name="email" type="email" autocomplete="email" required placeholder="voce@exemplo.com"></label><label class="auth-field">Senha<input name="password" type="password" autocomplete="${authMode === 'signup' ? 'new-password' : 'current-password'}" minlength="8" required placeholder="Pelo menos 8 caracteres"></label><div class="profile-error" id="auth-error" role="alert" hidden></div><button class="auth-submit" type="submit">${authMode === 'signup' ? 'Criar conta' : 'Entrar'}</button></form><div class="auth-divider">ou continue com</div><button class="google-button" type="button" data-google><span class="google-g" aria-hidden="true">G</span>Continuar com Google</button><p class="auth-footnote">Acesse com sua conta Google para acompanhar suas contribuições.</p></div>`;
    }
    profileLayer.querySelectorAll('[data-profile-back]').forEach((button) => button.addEventListener('click', closeProfile));
    profileLayer.querySelector('[data-signout]')?.addEventListener('click', () => {
      accessToken = null;
      session = null;
      authMode = 'login';
      renderProfile();
      showToast('Você saiu da sua conta.');
    });
    profileLayer.querySelectorAll('[data-auth-mode]').forEach((button) => button.addEventListener('click', () => {
      authMode = button.dataset.authMode;
      renderProfile();
    }));
    profileLayer.querySelector('[data-google]')?.addEventListener('click', () => { window.location.href = `${API_BASE}/auth/google`; });
    profileLayer.querySelector('#auth-form')?.addEventListener('submit', handleAuthSubmit);
  }

  async function handleAuthSubmit(event) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const name = String(formData.get('name') || '').trim();
    const email = String(formData.get('email') || '').trim().toLocaleLowerCase('pt-BR');
    const password = String(formData.get('password') || '');
    const errorNode = $('#auth-error');
    if (!email || password.length < 8 || (authMode === 'signup' && !name)) {
      errorNode.textContent = 'Informe os dados solicitados. A senha precisa ter pelo menos 8 caracteres.';
      errorNode.hidden = false;
      return;
    }
    try {
      const result = await apiRequest(`/auth/${authMode === 'signup' ? 'register' : 'login'}`, {
        method: 'POST', body: JSON.stringify(authMode === 'signup' ? { name, email, password } : { email, password })
      });
      accessToken = result.token;
      session = result.user;
    } catch (requestError) {
      errorNode.textContent = requestError.message;
      errorNode.hidden = false;
      return;
    }
    renderProfile();
    showToast(authMode === 'signup' ? 'Conta criada.' : 'Login realizado.');
  }

  function closeProfile() {
    profileLayer.hidden = true;
    document.querySelector('.topbar').hidden = false;
    document.querySelector('.search-box').hidden = false;
    document.querySelector('.map-tools').hidden = false;
    document.querySelector('.legend-card').hidden = legendCollapsed;
    $('#legend-restore').hidden = !legendCollapsed;
    $('#add-button').hidden = false;
    $('.map-attribution').hidden = false;
    document.querySelector('.map-stage').append($('.bottom-nav'));
    $('.bottom-nav').hidden = false;
    $('.bottom-nav').style.zIndex = '';
    currentView = 'mapa';
    document.querySelectorAll('.nav-item').forEach((item) => {
      const active = item.dataset.view === 'mapa';
      item.classList.toggle('active', active);
      if (active) item.setAttribute('aria-current', 'page');
      else item.removeAttribute('aria-current');
    });
    document.querySelector('.bottom-nav')?.style.setProperty('--nav-index', '0');
    loadContributions();
    setTimeout(() => map.invalidateSize(), 0);
  }

  function openSheet() {
    selectedPoint = null;
    selectedAddress = '';
    selectedPhotos = [];
    $('#tree-photos').value = '';
    renderPhotoPreviews();
    if (draftMarker) map.removeLayer(draftMarker);
    draftMarker = null;
    $('#location-status').textContent = 'Ainda não selecionada';
    $('#address-input').value = '';
    $('#form-hint').textContent = 'Usamos o GPS do dispositivo. Se preferir, informe um endereço de Belo Horizonte.';
    $('#form-error').hidden = true;
    modal.hidden = false;
    document.body.style.overflow = 'hidden';
    setTimeout(() => map.invalidateSize(), 220);
    $('#description').focus({ preventScroll: true });
  }

  let sheetClosing = false;
  function closeSheet() {
    if (modal.hidden || sheetClosing) return;
    sheetClosing = true;
    const sheet = modal.querySelector('.sheet');
    sheet.style.animation = 'none';
    modal.style.animation = 'none';
    void modal.offsetHeight;
    sheet.style.transition = 'transform 520ms cubic-bezier(.32,.72,.18,1), opacity 520ms ease';
    modal.style.transition = 'background-color 460ms ease, backdrop-filter 460ms ease';
    sheet.style.transform = 'translateY(100%)';
    sheet.style.opacity = '0';
    modal.style.backgroundColor = 'rgba(16,31,21,0)';
    modal.style.backdropFilter = 'blur(0)';
    window.setTimeout(() => {
      modal.hidden = true;
      document.body.style.overflow = '';
      if (draftMarker) map.removeLayer(draftMarker);
      draftMarker = null;
      selectedPoint = null;
      sheet.style.animation = '';
      sheet.style.transition = '';
      sheet.style.transform = '';
      sheet.style.opacity = '';
      modal.style.animation = '';
      modal.style.transition = '';
      modal.style.backgroundColor = '';
      modal.style.backdropFilter = '';
      sheetClosing = false;
      setTimeout(() => map.invalidateSize(), 220);
    }, 460);
  }

  function selectCategory(category) {
    selectedCategory = category;
    document.querySelectorAll('.category-card').forEach((button) => {
      const isSelected = button.dataset.category === category;
      button.classList.toggle('selected', isSelected);
      button.setAttribute('aria-pressed', String(isSelected));
    });
    if (selectedPoint) {
      draftMarker.setIcon(markerIcon(selectedCategory, true));
    }
  }

  const mapStage = $('.map-stage');
  const mapLocationConfirm = $('#map-location-confirm');
  L.DomEvent.disableClickPropagation(mapLocationConfirm);
  L.DomEvent.disableScrollPropagation(mapLocationConfirm);
  function returnToContributionForm() {
    addressConfirmationPending = false;
    manualLocationRestore = null;
    mapStage.classList.remove('location-confirming');
    mapLocationConfirm.hidden = true;
    modal.hidden = false;
    document.body.style.overflow = 'hidden';
    setTimeout(() => map.invalidateSize(), 220);
  }

  const legendCard = $('#legend-card');
  const legendRestore = $('#legend-restore');
  function setLegendCollapsed(collapsed) {
    legendCollapsed = collapsed;
    legendCard.hidden = collapsed;
    legendRestore.hidden = !collapsed;
    legendCard.setAttribute('aria-expanded', String(!collapsed));
    legendRestore.setAttribute('aria-expanded', String(!collapsed));
  }
  legendCard.addEventListener('click', () => setLegendCollapsed(true));
  legendCard.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      setLegendCollapsed(true);
    }
  });
  legendRestore.addEventListener('click', () => setLegendCollapsed(false));

  $('#add-button').addEventListener('click', openSheet);
  $('#confirm-address-location').addEventListener('click', () => {
    if (!selectedPoint) return;
    returnToContributionForm();
    $('#form-hint').textContent = 'Localização confirmada no mapa. Você pode ajustar usando GPS ou outro endereço.';
    showToast('Localização confirmada.');
  });
  $('#cancel-address-location').addEventListener('click', () => {
    const previous = manualLocationRestore;
    manualLocationRestore = null;
    if (previous?.point) {
      setSelectedLocation(previous.point, previous.address, { fly: true });
      $('#address-input').value = previous.input;
    } else {
      reverseAddressSequence += 1;
      if (draftMarker) map.removeLayer(draftMarker);
      draftMarker = null;
      selectedPoint = null;
      selectedAddress = '';
      $('#location-status').textContent = 'Ainda não selecionada';
      $('#address-input').value = previous?.input || '';
      $('#form-hint').textContent = 'Escolha um local pelo GPS, endereço ou toque no mapa.';
    }
    returnToContributionForm();
  });
  modal.addEventListener('click', (event) => { if (event.target === modal) closeSheet(); });
  const sheetHandle = $('.sheet-handle');
  let sheetDragStartY = null;
  let sheetDragOffset = 0;
  sheetHandle.addEventListener('pointerdown', (event) => {
    if (modal.hidden || !event.isPrimary) return;
    sheetDragStartY = event.clientY;
    sheetDragOffset = 0;
    sheetHandle.setPointerCapture(event.pointerId);
    modal.querySelector('.sheet').style.transition = 'none';
    event.preventDefault();
  });
  sheetHandle.addEventListener('pointermove', (event) => {
    if (sheetDragStartY === null) return;
    sheetDragOffset = Math.max(0, event.clientY - sheetDragStartY);
    const sheet = modal.querySelector('.sheet');
    sheet.style.transform = `translateY(${sheetDragOffset}px)`;
    sheet.style.opacity = String(Math.max(0.45, 1 - sheetDragOffset / 260));
  });
  const finishSheetDrag = () => {
    if (sheetDragStartY === null) return;
    const sheet = modal.querySelector('.sheet');
    const shouldClose = sheetDragOffset > 80;
    sheetDragStartY = null;
    sheetDragOffset = 0;
    if (shouldClose) {
      closeSheet();
    } else {
      sheet.style.transition = 'transform 360ms cubic-bezier(.22,.8,.24,1), opacity 360ms ease';
      sheet.style.transform = 'translateY(0)';
      sheet.style.opacity = '1';
      window.setTimeout(() => { sheet.style.transition = ''; sheet.style.opacity = ''; }, 360);
    }
  };
  sheetHandle.addEventListener('pointerup', finishSheetDrag);
  sheetHandle.addEventListener('pointercancel', finishSheetDrag);
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (addressConfirmationPending) returnToContributionForm();
    else if (!modal.hidden) closeSheet();
  });

  $('#category-grid').addEventListener('click', (event) => {
    const button = event.target.closest('[data-category]');
    if (button) selectCategory(button.dataset.category);
  });

  function setSelectedLocation(point, address, { fly = true } = {}) {
    reverseAddressSequence += 1;
    selectedPoint = L.latLng(point.lat, point.lng);
    selectedAddress = address || '';
    $('#location-status').textContent = selectedAddress || `${point.lat.toFixed(5)}, ${point.lng.toFixed(5)}`;
    $('#form-hint').textContent = 'Localização selecionada. Você pode alterar usando GPS ou outro endereço.';
    $('#form-error').hidden = true;
    if (fly) map.flyTo([point.lat, point.lng], Math.max(map.getZoom(), 16), { duration: .8 });
    if (draftMarker) draftMarker.setLatLng(selectedPoint).setIcon(markerIcon(selectedCategory, true));
    else draftMarker = L.marker(selectedPoint, { icon: markerIcon(selectedCategory, true), zIndexOffset: 1000 }).addTo(map);
  }

  async function autofillAddressFromPoint(point, inputValueAtStart = $('#address-input').value) {
    const requestId = ++reverseAddressSequence;
    try {
      const params = new URLSearchParams({
        format: 'jsonv2', lat: String(point.lat), lon: String(point.lng), zoom: '18', addressdetails: '1'
      });
      const response = await fetch(`https://nominatim.openstreetmap.org/reverse?${params}`, { headers: { Accept: 'application/json' } });
      if (!response.ok) return;
      const result = await response.json();
      if (requestId !== reverseAddressSequence || !selectedPoint
        || Math.abs(selectedPoint.lat - point.lat) > 0.000001
        || Math.abs(selectedPoint.lng - point.lng) > 0.000001) return;
      const parts = result.address || {};
      const road = parts.road || parts.pedestrian || parts.footway || parts.residential || parts.path;
      const street = road ? `${road}${parts.house_number ? `, ${parts.house_number}` : ''}` : '';
      const neighborhood = parts.suburb || parts.neighbourhood || parts.quarter || parts.city_district;
      const city = parts.city || parts.town || parts.village || parts.municipality;
      const formatted = [street, neighborhood, city].filter(Boolean).join(', ') || result.display_name || '';
      if (!formatted) return;
      selectedAddress = formatted;
      $('#location-status').textContent = formatted;
      if ($('#address-input').value === inputValueAtStart) $('#address-input').value = formatted;
      $('#form-hint').textContent = addressConfirmationPending
        ? 'Endereço preenchido pelo ponto. Você também pode ajustar tocando no mapa.'
        : 'Endereço preenchido a partir da localização selecionada.';
    } catch { /* Keep the selected coordinates when reverse geocoding is unavailable. */ }
  }

  $('#use-location').addEventListener('click', () => {
    if (!navigator.geolocation) {
      $('#form-hint').textContent = 'Geolocalização indisponível. Digite um endereço para continuar.';
      return;
    }
    $('#location-status').textContent = 'Obtendo localização…';
    navigator.geolocation.getCurrentPosition((position) => {
      const point = { lat: position.coords.latitude, lng: position.coords.longitude };
      setSelectedLocation(point, '');
      autofillAddressFromPoint(point);
      showToast('Localização atual selecionada.');
    }, (geoError) => {
      $('#location-status').textContent = 'Não foi possível obter o GPS';
      $('#form-hint').textContent = geoError.code === 1
        ? 'Permita o acesso à localização no navegador ou digite o endereço manualmente.'
        : 'Confira o sinal de localização ou digite o endereço manualmente.';
    }, { enableHighAccuracy: true, timeout: 12000, maximumAge: 0 });
  });

  $('#find-address').addEventListener('click', async () => {
    const address = $('#address-input').value.trim();
    if (!address) {
      const point = selectedPoint
        ? { lat: selectedPoint.lat, lng: selectedPoint.lng }
        : map.getCenter();
      manualLocationRestore = {
        point: selectedPoint ? { lat: selectedPoint.lat, lng: selectedPoint.lng } : null,
        address: selectedAddress,
        input: selectedAddress || ''
      };
      setSelectedLocation(point, '');
      addressConfirmationPending = true;
      modal.hidden = true;
      document.body.style.overflow = '';
      mapStage.classList.add('location-confirming');
      mapLocationConfirm.hidden = false;
      autofillAddressFromPoint(point);
      setTimeout(() => map.invalidateSize(), 220);
      return;
    }
    if (address.length < 5) {
      $('#form-hint').textContent = 'Digite uma rua e, se souber, número ou bairro.';
      return;
    }
    const button = $('#find-address');
    button.disabled = true;
    button.textContent = 'Buscando…';
    try {
      const params = new URLSearchParams({
        format: 'jsonv2', limit: '1', countrycodes: 'br', q: `${address}, Belo Horizonte, Minas Gerais, Brasil`
      });
      const response = await fetch(`https://nominatim.openstreetmap.org/search?${params}`, { headers: { Accept: 'application/json' } });
      if (!response.ok) throw new Error('search');
      const results = await response.json();
      if (!results.length) {
        $('#location-status').textContent = 'Endereço não encontrado';
        $('#form-hint').textContent = 'Tente incluir o bairro ou número. Você também pode usar o GPS atual.';
        return;
      }
      const result = results[0];
      manualLocationRestore = {
        point: selectedPoint ? { lat: selectedPoint.lat, lng: selectedPoint.lng } : null,
        address: selectedAddress,
        input: selectedAddress || address
      };
      setSelectedLocation({ lat: Number(result.lat), lng: Number(result.lon) }, result.display_name);
      addressConfirmationPending = true;
      modal.hidden = true;
      document.body.style.overflow = '';
      mapStage.classList.add('location-confirming');
      mapLocationConfirm.hidden = false;
      setTimeout(() => map.invalidateSize(), 220);
    } catch {
      $('#location-status').textContent = 'Busca indisponível';
      $('#form-hint').textContent = 'Não foi possível localizar o endereço agora. Tente o GPS ou tente novamente.';
    } finally {
      button.disabled = false;
      button.textContent = 'Localizar endereço';
    }
  });

  $('#tree-photos').addEventListener('change', (event) => {
    selectedPhotos = Array.from(event.target.files || []).slice(0, 3);
    if (event.target.files.length > 3) showToast('Foram selecionadas apenas as três primeiras fotos.');
    if (selectedPhotos.some((file) => file.type !== 'image/jpeg' || file.size > 12 * 1024 * 1024)) {
      selectedPhotos = selectedPhotos.filter((file) => file.type === 'image/jpeg' && file.size <= 12 * 1024 * 1024).slice(0, 3);
      showToast('Use imagens JPG/JPEG de até 12 MB cada.');
    }
    renderPhotoPreviews();
  });

  function renderPhotoPreviews() {
    const container = $('#photo-previews');
    if (!container) return;
    container.replaceChildren(...selectedPhotos.map((file) => {
      const image = document.createElement('img');
      image.alt = `Prévia: ${file.name}`;
      image.src = URL.createObjectURL(file);
      image.onload = () => URL.revokeObjectURL(image.src);
      return image;
    }));
  }

  function compressPhoto(file) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      const url = URL.createObjectURL(file);
      image.onload = () => {
        const scale = Math.min(1, 1200 / Math.max(image.naturalWidth, image.naturalHeight));
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(image.naturalWidth * scale);
        canvas.height = Math.round(image.naturalHeight * scale);
        const context = canvas.getContext('2d');
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        URL.revokeObjectURL(url);
        resolve({ name: file.name, dataUrl: canvas.toDataURL('image/jpeg', .76) });
      };
      image.onerror = () => { URL.revokeObjectURL(url); reject(new Error('photo')); };
      image.src = url;
    });
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!selectedPoint) {
      error.textContent = 'Use sua localização atual ou encontre um endereço para continuar.';
      error.hidden = false;
      return;
    }
    let photos;
    try {
      photos = await Promise.all(selectedPhotos.map(compressPhoto));
    } catch {
      error.textContent = 'Não foi possível processar uma das fotos. Escolha as imagens novamente.';
      error.hidden = false;
      return;
    }
    const payload = {
      category: selectedCategory,
      lat: selectedPoint.lat,
      lng: selectedPoint.lng,
      address: selectedAddress,
      photos,
      description: $('#description').value.trim(),
      contributor: session?.name || null
    };
    try {
      await apiRequest('/contributions', { method: 'POST', body: JSON.stringify(payload) });
    } catch (requestError) {
      error.textContent = requestError.message;
      error.hidden = false;
      return;
    }
    await loadContributions();
    closeSheet();
    form.reset();
    selectedPhotos = [];
    renderPhotoPreviews();
    selectCategory('tree');
    showToast('Contribuição registrada.');
  });

  $('#search-input').addEventListener('input', (event) => {
    $('#clear-search').hidden = !event.target.value;
    renderMarkers();
  });
  $('#search-input').addEventListener('keydown', async (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    const query = event.currentTarget.value.trim();
    if (query.length < 2) return;
    const normalizedQuery = query.toLocaleLowerCase('pt-BR');
    const matches = contributions.filter((item) => {
      const category = CATEGORY[item.category]?.label || '';
      const haystack = `${category} ${item.address || ''} ${item.description || ''} ${item.contributor || ''}`.toLocaleLowerCase('pt-BR');
      const matchesCategory = currentFilter === 'all' || item.category === currentFilter;
      return matchesCategory && haystack.includes(normalizedQuery);
    });
    if (matches.length) {
      if (matches.length === 1) {
        map.flyTo([Number(matches[0].lat), Number(matches[0].lng)], Math.max(map.getZoom(), 17), { duration: .8 });
      } else {
        const bounds = L.latLngBounds(matches.map((item) => [Number(item.lat), Number(item.lng)]));
        map.flyToBounds(bounds, { maxZoom: 17, padding: [48, 48], duration: .8 });
      }
      return;
    }
    try {
      const params = new URLSearchParams({
        format: 'jsonv2', limit: '1', countrycodes: 'br',
        q: `${query}, Belo Horizonte, Minas Gerais, Brasil`
      });
      const response = await fetch(`https://nominatim.openstreetmap.org/search?${params}`, { headers: { Accept: 'application/json' } });
      if (!response.ok) throw new Error('search');
      const results = await response.json();
      if ($('#search-input').value.trim() !== query) return;
      if (!results.length) {
        showToast('Bairro ou contribuição não encontrado.');
        return;
      }
      const place = results[0];
      map.flyTo([Number(place.lat), Number(place.lon)], Math.max(map.getZoom(), 15), { duration: .9 });
    } catch {
      if ($('#search-input').value.trim() === query) showToast('Não foi possível buscar agora. Tente novamente.');
    }
  });
  finishGoogleLogin();
  $('#clear-search').addEventListener('click', () => {
    $('#search-input').value = '';
    $('#clear-search').hidden = true;
    renderMarkers();
  });

  $('#layers-button').addEventListener('click', () => {
    const isDark = activeTileLayer !== darkLayer;
    map.removeLayer(activeTileLayer);
    activeTileLayer = isDark ? darkLayer : lightLayer;
    activeTileLayer.addTo(map);
    document.documentElement.classList.toggle('theme-dark', isDark);
    updateThemeToggle();
    try { localStorage.setItem('bhverde-map-theme', isDark ? 'dark' : 'light'); } catch { /* Storage may be unavailable. */ }
  });
  $('#marker-sheet-close').addEventListener('click', closeMarkerSheet);
  map.on('click', (event) => {
    if (addressConfirmationPending) {
      const point = { lat: event.latlng.lat, lng: event.latlng.lng };
      setSelectedLocation(point, '', { fly: false });
      autofillAddressFromPoint(point);
      $('#form-hint').textContent = 'Ponto ajustado. Confirme para voltar ao formulário.';
      return;
    }
    if (!event.originalEvent?.target?.closest('.leaflet-marker-icon')) closeMarkerSheet();
  });

  let mapLoadTimer;
  map.on('zoomend', updateMarkerSizes);
  map.on('moveend', () => {
    clearTimeout(mapLoadTimer);
    mapLoadTimer = setTimeout(loadContributions, 180);
  });

  $('#locate-button').addEventListener('click', () => {
    if (!navigator.geolocation) {
      showToast('Este navegador não oferece localização.');
      return;
    }
    showToast('Obtendo sua localização…');
    navigator.geolocation.getCurrentPosition((position) => {
      const point = [position.coords.latitude, position.coords.longitude];
      map.flyTo(point, 16, { duration: .7 });
    }, () => showToast('Não foi possível acessar sua localização. Verifique a permissão do navegador.'), { enableHighAccuracy: true, timeout: 10000 });
  });

  const bottomNav = document.querySelector('.bottom-nav');
  const navItems = Array.from(bottomNav.querySelectorAll('.nav-item'));
  bottomNav.style.setProperty('--nav-count', navItems.length);
  bottomNav.style.setProperty('--nav-index', Math.max(0, navItems.findIndex((item) => item.classList.contains('active'))));
  navItems.forEach((button, index) => {
    button.addEventListener('click', () => {
      const previousButton = navItems.find((item) => item.classList.contains('active'));
      bottomNav.style.setProperty('--nav-index', index);
      const view = button.dataset.view;
      const profileWasOpen = !profileLayer.hidden;
      currentView = view;
      document.querySelectorAll('.nav-item').forEach((item) => {
        const active = item === button;
        item.classList.toggle('active', active);
        if (active) item.setAttribute('aria-current', 'page');
        else item.removeAttribute('aria-current');
      });
      if (previousButton && previousButton !== button) {
        previousButton.classList.remove('nav-enter', 'nav-leave');
        button.classList.remove('nav-enter', 'nav-leave');
        void button.offsetWidth;
        previousButton.classList.add('nav-leave');
        button.classList.add('nav-enter');
        window.setTimeout(() => {
          previousButton.classList.remove('nav-leave');
          button.classList.remove('nav-enter');
        }, 1400);
      }
      if (view === 'mapa') {
        if (profileWasOpen) closeProfile();
        currentView = view;
        currentFilter = 'all';
      } else if (view === 'explorar') {
        currentView = view;
        currentFilter = 'all';
        renderExplore();
      } else {
        renderProfile();
      }
      renderMarkers();
    });
  });

  renderMarkers();
  loadContributions();
  setTimeout(() => map.invalidateSize(), 0);
  if (!runtimeConfig.mapTilerKey) showToast('Configure MAPTILER_KEY no backend/.env para carregar o mapa.');
})().catch((error) => {
  console.error('BH Verde failed to initialize', error);
  const toast = document.querySelector('#toast');
  if (toast) { toast.textContent = `Falha ao iniciar o mapa: ${error.message || error}.`; toast.classList.add('visible'); }
});

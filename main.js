'use strict';

const DEFAULT_SETTINGS = {
	endpoint: 'https://mcp.scys.com/shengcai-web/mcp',
	interests: 'AI,AI编程,Agent,MCP,独立开发,出海,小红书',
	saveFolder: '生财副业/02 每日情报',
	hotPageSize: 15,
	showBody: true,
	sailIncludeFinished: false,
	partyProvince: '湖北省',
	partyCity: '武汉市',
	partyDistrict: '',
	partyOnlyFuture: true,
	tokenRankEndpoint: 'https://scys.com/tokenrank/api/subapp/leaderboard',
};

const { Plugin, Notice, ItemView, WorkspaceLeaf, Modal, Setting, PluginSettingTab, TFile, Platform } = require('obsidian');

const VIEW_TYPE_SCYS = 'scys-radar-view';

function tsToDate(ts) {
	if (!ts) return '';
	const d = new Date(Number(ts) < 1e12 ? Number(ts) * 1000 : Number(ts));
	return d.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function esc(s) {
	return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function stripMd(s, n = 120) {
	const t = String(s || '')
		.replace(/!\[[^\]]*\]\([^)]*\)/g, '')
		.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
		.replace(/[#>*`~\-]{1,3}/g, ' ')
		.replace(/&[a-z]+;/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
	return t.length > n ? t.slice(0, n) + '…' : t;
}

function formatTokens(value) {
	const n = Number(value) || 0;
	return n >= 1e8 ? (n / 1e8).toFixed(2) + ' 亿' : n >= 1e4 ? (n / 1e4).toFixed(1) + ' 万' : n.toLocaleString('zh-CN');
}

class ScysOAuth {
	constructor(endpoint, log) {
		this.endpoint = endpoint;
		this.log = log || (() => {});
		this.clientId = null;
		this.accessToken = null;
		this.refreshToken = null;
		this.expiresAt = 0;
		this.redirectUri = 'http://127.0.0.1:17419/callback';
	}

	load(d) {
		if (!d) return;
		this.clientId = d.clientId || null;
		this.accessToken = d.accessToken || null;
		this.refreshToken = d.refreshToken || null;
		this.expiresAt = d.expiresAt || 0;
	}

	toJSON() {
		return { clientId: this.clientId, accessToken: this.accessToken, refreshToken: this.refreshToken, expiresAt: this.expiresAt };
	}

	get hasAuth() {
		return !!this.refreshToken;
	}

	async meta() {
		if (this._meta) return this._meta;
		const base = new URL(this.endpoint).origin;
		const prot = await requestUrlSafe({ url: base + '/.well-known/oauth-protected-resource' });
		const issuer = (prot.authorization_servers || [])[0] || base;
		const r = await requestUrlSafe({ url: issuer.replace(/\/$/, '') + '/.well-known/oauth-authorization-server' });
		this._meta = { issuer, auth: r.authorization_endpoint, token: r.token_endpoint, reg: r.registration_endpoint };
		return this._meta;
	}

	async ensureClientId(meta) {
		if (this.clientId) return this.clientId;
		const r = await requestUrlSafe({
			url: meta.reg,
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ client_name: 'Obsidian Scys Radar', redirect_uris: [this.redirectUri] }),
		});
		this.clientId = r.client_id;
		return this.clientId;
	}

	async authorizeInteractive(onEvent) {
		const meta = await this.meta();
		await this.ensureClientId(meta);
		const state = rand();
		const verifier = rand(64);
		const challenge = await pkceS256(verifier);
		this._pendingVerifier = verifier;
		const url = new URL(meta.auth);
		url.searchParams.set('response_type', 'code');
		url.searchParams.set('client_id', this.clientId);
		url.searchParams.set('redirect_uri', this.redirectUri);
		url.searchParams.set('scope', 'mcp');
		url.searchParams.set('state', state);
		url.searchParams.set('code_challenge', challenge);
		url.searchParams.set('code_challenge_method', 'S256');
		url.searchParams.set('resource', this.endpoint);
		const waitPromise = waitForLoopbackCode(this.redirectUri, state, 300, onEvent);
		window.open(url.href, '_blank');
		return { waitPromise, authorizeUrl: url.href };
	}

	async completeAuthWithCode(pastedUrlOrCode) {
		let code = null;
		const raw = String(pastedUrlOrCode || '').trim();
		if (raw.includes('code=')) {
			const u = new URL(raw);
			code = u.searchParams.get('code');
		} else {
			code = raw;
		}
		if (!code) throw new Error('没有解析到 code');
		const verifier = this._pendingVerifier;
		if (!verifier) throw new Error('没有进行中的授权会话，请先点「授权登录」');
		return this.exchangeCode(code, verifier);
	}

	async exchangeCode(code, verifier) {
		const meta = await this.meta();
		const r = await requestUrlSafe({
			url: meta.token,
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({
				grant_type: 'authorization_code',
				code,
				client_id: this.clientId,
				redirect_uri: this.redirectUri,
				code_verifier: verifier,
				resource: this.endpoint,
			}).toString(),
		});
		this.setTokens(r);
		return r;
	}

	setTokens(r) {
		this.accessToken = r.access_token;
		this.refreshToken = r.refresh_token || this.refreshToken;
		this.expiresAt = Date.now() + (Number(r.expires_in) || 3600) * 1000 - 60000;
	}

	async validToken() {
		if (this.accessToken && Date.now() < this.expiresAt) return this.accessToken;
		if (!this.refreshToken) return null;
		try {
			const meta = await this.meta();
			const r = await requestUrlSafe({
				url: meta.token,
				method: 'POST',
				headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
				body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: this.refreshToken, client_id: this.clientId, resource: this.endpoint }).toString(),
			});
			this.setTokens(r);
			return this.accessToken;
		} catch (e) {
			this.log('refresh failed: ' + e.message);
			this.accessToken = null;
			return null;
		}
	}
}

async function requestUrlSafe(opts) {
	const { requestUrl } = require('obsidian');
	const res = await requestUrl({ ...opts, throw: false });
	if (res.status >= 400) throw new Error('HTTP ' + res.status + ' ' + String(res.text || '').slice(0, 200));
	return res.json;
}

async function requestUrlJson(opts) {
	const { requestUrl } = require('obsidian');
	const res = await requestUrl({ ...opts, throw: false });
	if (res.json) return res.json;
	try { return JSON.parse(res.text || '{}'); } catch { return { status: res.status, message: String(res.text || '') }; }
}

function rand(n = 32) {
	let s = '';
	const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
	const bytes = new Uint8Array(n || 32);
	(window.crypto || window.msCrypto).getRandomValues(bytes);
	for (const b of bytes) s += chars[b % chars.length];
	return s;
}

async function pkceS256(verifier) {
	const data = new TextEncoder().encode(verifier);
	const hash = await window.crypto.subtle.digest('SHA-256', data);
	return b64url(new Uint8Array(hash));
}

function b64url(bytes) {
	let s = '';
	for (const b of bytes) s += String.fromCharCode(b);
	return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function waitForLoopbackCode(redirectUri, state, timeoutSec, onEvent) {
	return new Promise((resolve, reject) => {
		const u = new URL(redirectUri);
		const server = require('http').createServer((req, res) => {
			const q = new URL(req.url, 'http://x').searchParams;
			const hasCode = !!q.get('code');
			const stateOk = q.get('state') === state;
			const hasError = q.get('error');
			if (onEvent) onEvent('收到回调: ' + req.url.slice(0, 120));
			if (req.url.startsWith('/favicon')) {
				res.writeHead(204);
				res.end();
				return;
			}
			const ok = req.url.startsWith('/callback') && hasCode && stateOk;
			res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
			res.end(ok || hasError
				? '<html><body style="font-family:system-ui;text-align:center;padding:60px"><h2>✅ 授权完成</h2><p>请回到 Obsidian 继续操作</p><script>setTimeout(()=>window.close(),1500)</script></body></html>'
				: '<html><body style="font-family:system-ui;text-align:center;padding:60px"><h2>⚠️ 回调参数不完整</h2><p>请回到 Obsidian，改用「手动粘贴授权链接」完成。</p></body></html>');
			if (!req.url.startsWith('/callback')) return;
			if (hasError) {
				cleanup();
				reject(new Error('授权被拒绝: ' + (q.get('error_description') || hasError)));
			} else if (hasCode && stateOk) {
				cleanup();
				resolve(q.get('code'));
			} else if (onEvent) {
				onEvent('回调参数不匹配（code=' + hasCode + ', state匹配=' + stateOk + '），继续等待');
			}
		});
		const timer = setTimeout(() => {
			cleanup();
			reject(new Error('授权超时（' + timeoutSec + ' 秒），未等到回调'));
		}, timeoutSec * 1000);
		function cleanup() {
			clearTimeout(timer);
			server.close();
		}
		server.on('error', (e) => {
			cleanup();
			reject(new Error('本地回调服务启动失败：' + e.message + '（端口被占用？）'));
		});
		server.listen(Number(u.port), u.hostname);
	});
}

class McpClient {
	constructor(oauth, log) {
		this.oauth = oauth;
		this.log = log || (() => {});
		this.sessionId = null;
		this.toolDefs = [];
	}

	async rpc(method, params, isInit = false) {
		const token = await this.oauth.validToken();
		if (!token && !isInit) throw new Error('未授权或 token 已失效');
		const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
		if (token) headers.Authorization = 'Bearer ' + token;
		if (this.sessionId && !isInit) headers['mcp-session-id'] = this.sessionId;
		const res = await requestUrlSafeRaw({ url: this.oauth.endpoint, method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: Math.floor(Math.random() * 1e9), method, params }) });
		if (res.status === 401) {
			this.sessionId = null;
			throw new Error('登录已过期，请重新授权');
		}
		const sid = res.headers['mcp-session-id'];
		if (sid) this.sessionId = sid;
		const json = parseMcpBody(res.text);
		if (json && json.error) throw new Error(json.error.message || 'MCP error');
		return json && json.result;
	}

	async init() {
		const r = await this.rpc('initialize', {
			protocolVersion: '2025-03-26',
			capabilities: {},
			clientInfo: { name: 'obsidian-scys-radar', version: '0.1.0' },
		}, true);
		await this.rpc('notifications/initialized', {}, true).catch(() => {});
		return r;
	}

	async listTools() {
		const r = await this.rpc('tools/list', {});
		this.toolDefs = (r && r.tools) || [];
		return this.toolDefs;
	}

	async callTool(name, args) {
		const r = await this.rpc('tools/call', { name, arguments: args });
		if (!r) return null;
		if (r.isError) throw new Error('工具执行失败');
		const c = (r.content || [])[0];
		if (!c) return null;
		if (c.type === 'text') {
			try {
				return JSON.parse(c.text);
			} catch {
				return c.text;
			}
		}
		return c;
	}
}

async function requestUrlSafeRaw(opts) {
	const { requestUrl } = require('obsidian');
	const res = await requestUrl({ ...opts, throw: false });
	return { status: res.status, headers: res.headers, text: res.text };
}

function parseMcpBody(text) {
	if (!text) return null;
	const t = text.trim();
	if (t.startsWith('{')) {
		try {
			return JSON.parse(t);
		} catch {
			return null;
		}
	}
	if (t.startsWith('event:') || t.startsWith('data:')) {
		for (const line of t.split('\n')) {
			if (line.startsWith('data:')) {
				try {
					return JSON.parse(line.slice(5).trim());
				} catch {}
			}
		}
	}
	return null;
}

class ScysRadarView extends ItemView {
	constructor(leaf, plugin) {
		super(leaf);
		this.plugin = plugin;
		this.tab = 'hot';
		this.sub = null;
		this.searchQuery = null;
		this.items = [];
		this.loading = false;
		this.onlyInterest = false;
		this.navs = [
			{ key: 'hot', label: '🔥 热门', load: () => this.plugin.fetchHot() },
			{ key: 'good', label: '💎 精华', load: () => this.plugin.fetchGood() },
			{ key: 'sail', label: '⛵ 航海', load: () => this.plugin.fetchSail() },
			{
				key: 'party', label: '📍 聚会',
				subs: [
					{ key: 'local', label: '本地', load: () => this.plugin.fetchParties('local') },
					{ key: 'all', label: '全国', load: () => this.plugin.fetchParties('all') },
				],
			},
			{
				key: 'proj', label: '🧭 项目',
				subs: [
					{ key: 'lib', label: '项目库', load: () => this.plugin.fetchProjectLib() },
					{ key: 'fxb', label: '风向标', load: () => this.plugin.fetchFxb() },
					{ key: 'hit', label: '中标', load: () => this.plugin.fetchSelectedFxb() },
					{ key: 'super', label: '超级标的', load: () => this.plugin.fetchSuper() },
				],
			},
			{ key: 'token', label: '📊 Token 榜', load: () => this.plugin.fetchTokenRank() },
			{ key: 'board', label: '🏅 榜单', load: () => this.plugin.fetchContentBoards() },
		];
	}

	getViewType() {
		return VIEW_TYPE_SCYS;
	}
	getDisplayText() {
		return '生财雷达';
	}
	getIcon() {
		return 'radar';
	}

	async onOpen() {
		this.render();
		if (this.plugin.client) this.loadTab('hot');
	}

	async onClose() {
		super.onClose();
	}

	render() {
		const root = this.contentEl;
		root.empty();
		root.addClass('scys-root');
		const auth = this.plugin.oauth;
		if (!auth.hasAuth) {
			this.renderAuth(root);
			return;
		}
		this.renderMain(root);
	}

	renderAuth(root) {
		const box = root.createDiv({ cls: 'scys-auth' });
		box.createEl('h3', { text: '生财雷达' });
		box.createEl('p', { text: '连接生财有术 MCP，浏览热门、精华、风向标与航海动态。' });
		const btn = box.createEl('button', { text: '授权登录生财账号', cls: 'mod-cta' });
		const status = box.createDiv({ cls: 'scys-auth-status' });
		const pasteBox = root.createDiv({ cls: 'scys-auth' });
		pasteBox.createEl('p', { cls: 'scys-hint', text: '如果浏览器授权后一直没跳回来：回到 Chrome，把地址栏里 127.0.0.1 开头的完整网址复制到下面，点完成即可。' });
		const input = pasteBox.createEl('input', { cls: 'scys-paste-input', attr: { placeholder: '粘贴 http://127.0.0.1:17419/callback?code=... 完整地址或 code 值', type: 'text' } });
		const doneBtn = pasteBox.createEl('button', { text: '完成授权', cls: 'scys-mini-btn' });
		doneBtn.onclick = async () => {
			doneBtn.disabled = true;
			try {
				await this.plugin.oauth.completeAuthWithCode(input.value);
				await this.plugin.saveSettings();
				await this.plugin.ensureClient();
				new Notice('✅ 生财授权成功');
				this.render();
				this.loadTab('hot');
			} catch (e) {
				new Notice('授权失败：' + e.message, 8000);
			} finally {
				doneBtn.disabled = false;
			}
		};
		btn.onclick = async () => {
			btn.disabled = true;
			btn.setText('授权中…（浏览器完成后再回来）');
			status.setText('已打开浏览器，等待授权回调…');
			try {
				await this.plugin.login((msg) => status.setText(msg));
				new Notice('✅ 生财授权成功');
				this.render();
				this.loadTab('hot');
			} catch (e) {
				new Notice('授权失败：' + e.message, 10000);
				status.setText('失败：' + e.message);
				btn.disabled = false;
				btn.setText('重试授权登录');
			}
		};
	}

	renderMain(root) {
		const searchRow = root.createDiv({ cls: 'scys-searchrow' });
		const input = searchRow.createEl('input', {
			cls: 'scys-search-input',
			attr: { type: 'search', placeholder: '搜索生财正文… 回车即用 MCP 检索' },
		});
		const runSearch = () => this.doSearch(input.value);
		input.onkeydown = (e) => {
			if (e.key === 'Enter') runSearch();
		};
		const goBtn = searchRow.createEl('button', { text: '🔍 搜索', cls: 'scys-mini-btn' });
		goBtn.onclick = runSearch;
		const askBtn = searchRow.createEl('button', { text: '🙋 问亦仁', cls: 'scys-mini-btn', attr: { title: '向亦仁的 AI 分身提问，回答生成约需 1-2 分钟' } });
		askBtn.onclick = () => this.plugin.openAskYiRen(input.value);

		const bar = root.createDiv({ cls: 'scys-toolbar' });
		for (const n of this.navs) {
			const b = bar.createEl('button', { text: n.label, cls: this.tab === n.key ? 'scys-tab scys-tab-active' : 'scys-tab' });
			b.onclick = () => this.loadTab(n.key);
		}
		this.subBarEl = root.createDiv({ cls: 'scys-subtoolbar' });
		this.renderSubBar();

		const row2 = root.createDiv({ cls: 'scys-toolbar scys-toolbar-2' });
		const spacer = row2.createDiv({ cls: 'scys-spacer' });
		const onlyBtn = row2.createEl('button', { text: '🎯 只看感兴趣', cls: 'scys-mini-btn', attr: { title: '按兴趣关键词过滤' } });
		if (this.onlyInterest) onlyBtn.addClass('is-on');
		onlyBtn.onclick = () => {
			this.onlyInterest = !this.onlyInterest;
			onlyBtn.toggleClass('is-on', this.onlyInterest);
			this.renderList();
		};
		const refreshBtn = row2.createEl('button', { text: '刷新', cls: 'scys-mini-btn' });
		refreshBtn.onclick = () => {
			if (this.tab === 'search' && this.searchQuery) this.doSearch(this.searchQuery);
			else this.loadTab(this.tab, this.sub);
		};
		const cfgBtn = row2.createEl('button', { text: '⚙️', cls: 'scys-mini-btn' });
		cfgBtn.onclick = () => this.plugin.openSettings();
		const shareBtn = row2.createEl('button', { text: '分享 Token', cls: 'scys-mini-btn' });
		shareBtn.onclick = () => this.plugin.shareMyToken();

		this.listEl = root.createDiv({ cls: 'scys-list' });
		this.statusEl = root.createDiv({ cls: 'scys-status' });
	}

	renderSubBar() {
		const el = this.subBarEl;
		if (!el) return;
		el.empty();
		const nav = this.navs.find((n) => n.key === this.tab);
		if (!nav || !nav.subs) {
			el.addClass('scys-hidden');
			return;
		}
		el.removeClass('scys-hidden');
		for (const s of nav.subs) {
			const b = el.createEl('button', { text: s.label, cls: this.sub === s.key ? 'scys-subtab scys-subtab-active' : 'scys-subtab' });
			b.onclick = () => this.loadTab(this.tab, s.key);
		}
	}

	async doSearch(q) {
		const kw = String(q || '').trim();
		if (!kw) {
			new Notice('请输入搜索关键词', 4000);
			return;
		}
		this.tab = 'search';
		this.sub = null;
		this.searchQuery = kw;
		this.contentEl.querySelectorAll('button.scys-tab').forEach((b) => b.removeClass('scys-tab-active'));
		this.renderSubBar();
		this.renderList('正在检索「' + kw + '」…');
		try {
			this.items = (await this.plugin.fetchSearch(kw)) || [];
		} catch (e) {
			new Notice('搜索失败：' + e.message, 6000);
			this.renderList('搜索失败：' + e.message);
			return;
		}
		if (!this.items.length) this.renderList('没有搜到「' + kw + '」相关内容，换个词试试');
		else this.renderList();
	}

	async loadTab(key, sub) {
		const nav = this.navs.find((n) => n.key === key);
		if (!nav) return;
		this.tab = key;
		this.searchQuery = null;
		this.sub = sub || (nav.subs ? nav.subs[0].key : null);
		this.items = [];
		this.contentEl.querySelectorAll('button.scys-tab').forEach((b) => {
			const isActive = b.textContent === nav.label;
			b.toggleClass('scys-tab-active', isActive);
		});
		this.renderSubBar();
		const loader = (nav.subs || []).find((s) => s.key === this.sub) || nav;
		this.renderList('加载中…');
		this.loading = true;
		try {
			this.items = (await loader.load()) || [];
		} catch (e) {
			new Notice('加载失败：' + e.message, 6000);
			this.renderList('加载失败：' + e.message);
			return;
		} finally {
			this.loading = false;
		}
		this.renderList();
	}

	matchInterests(text) {
		const kws = (this.plugin.settings.interests || '').split(/[,，\s]+/).filter(Boolean);
		const hits = kws.filter((k) => text.toLowerCase().includes(k.toLowerCase()));
		return hits;
	}

	emptyText() {
		if (this.tab === 'sail') return '暂无进行中的航海 · 可在设置里打开「航海显示已结束」翻往期';
		if (this.tab === 'party') {
			return this.sub === 'local'
				? '本地暂无聚会 · 可在设置里改城市，或切到「全国」看看'
				: '暂无聚会';
		}
		if (this.tab === 'proj') return '暂无项目内容';
		if (this.tab === 'board') return '暂无榜单数据';
		return '暂无内容（或被兴趣过滤掉了）';
	}

	renderList(emptyMsg) {
		if (!this.listEl) return;
		const el = this.listEl;
		el.empty();
		let items = this.items;
		if (this.onlyInterest) {
			items = items.filter((it) => this.matchInterests(it.title + ' ' + (it.summary || '')).length > 0);
		}
		if (emptyMsg) {
			el.createDiv({ cls: 'scys-empty', text: emptyMsg });
			return;
		}
		if (!items.length) {
			el.createDiv({ cls: 'scys-empty', text: this.emptyText() });
			return;
		}
		for (const it of items) {
			const card = el.createDiv({ cls: 'scys-card' + (it.isDigested ? ' scys-card-digest' : '') });
			const head = card.createDiv({ cls: 'scys-card-head' });
			if (it.kind === 'rank') {
				head.createSpan({ cls: 'scys-badge scys-badge-rank', text: '第 ' + it.rank + ' 名' });
				head.createSpan({ cls: 'scys-stats', text: '⚡ ' + formatTokens(it.tokens) + ' Token' });
			} else if (it.kind === 'board') {
				head.createSpan({ cls: 'scys-badge scys-badge-board', text: it.typeLabel || '榜单' });
				head.createSpan({ cls: 'scys-date', text: it.dateText || '' });
				const stats = [];
				if (it.anchorCount) stats.push('⚓ ' + it.anchorCount);
				if (it.likes) stats.push('👍 ' + it.likes);
				if (stats.length) head.createSpan({ cls: 'scys-stats', text: stats.join(' · ') });
			} else if (it.kind === 'sail') {
				head.createSpan({ cls: 'scys-badge scys-badge-sail', text: it.typeLabel || '航海' });
				head.createSpan({ cls: 'scys-date', text: it.dateText || '' });
			} else if (it.kind === 'party') {
				head.createSpan({ cls: 'scys-badge scys-badge-party', text: it.typeLabel || '聚会' });
				head.createSpan({ cls: 'scys-date', text: it.dateText || '' });
				if (it.place) head.createSpan({ cls: 'scys-place', text: '📍 ' + it.place });
				const pstats = [it.costText, it.remainText].filter(Boolean);
				if (pstats.length) head.createSpan({ cls: 'scys-stats', text: pstats.join(' · ') });
			} else if (it.kind === 'project') {
				head.createSpan({ cls: 'scys-badge scys-badge-proj', text: it.isSuper ? '超级标的' : '项目' });
				if (it.incomeText) head.createSpan({ cls: 'scys-income', text: it.incomeText });
				const jstats = [it.costText, it.timeText, it.caseText].filter(Boolean);
				if (jstats.length) head.createSpan({ cls: 'scys-stats', text: jstats.join(' · ') });
			} else {
				if (it.isDigested) head.createSpan({ cls: 'scys-badge scys-badge-digest', text: '精华' });
				head.createSpan({ cls: 'scys-date', text: it.dateText || '' });
				const stats = [];
				if (it.likes) stats.push('👍 ' + it.likes);
				if (it.reads) stats.push('👁 ' + it.reads);
				if (stats.length) head.createSpan({ cls: 'scys-stats', text: stats.join(' · ') });
			}
			const title = card.createDiv({ cls: 'scys-title' });
			this.fillHighlighted(title, it.title);
			if (this.plugin.settings.showBody && it.summary) {
				const body = card.createDiv({ cls: 'scys-body' });
				this.fillHighlighted(body, stripMd(it.summary, 100));
			}
			const foot = card.createDiv({ cls: 'scys-card-foot' });
			if (it.author) foot.createSpan({ cls: 'scys-author', text: it.author });
			const spacer = foot.createSpan({ cls: 'scys-spacer' });
			if (it.url) {
				const openBtn = foot.createEl('button', { text: '浏览器打开', cls: 'scys-mini-btn' });
				openBtn.onclick = () => window.open(it.url, '_blank');
			}
			if (it.entityId) {
				const detailBtn = foot.createEl('button', { text: '详情', cls: 'scys-mini-btn' });
				detailBtn.onclick = () => this.plugin.openDetail(it);
			}
			if (it.kind !== 'rank' && it.kind !== 'board') {
				const saveBtn = foot.createEl('button', { text: '⭐ 收藏为笔记', cls: 'scys-mini-btn scys-save-btn' });
				saveBtn.onclick = () => this.plugin.saveAsNote(it);
			}
			card.onclick = (e) => {
				if (e.target.tagName === 'BUTTON') return;
				if ((it.kind === 'rank' || it.kind === 'board') && it.url) window.open(it.url, '_blank');
				else this.plugin.openDetail(it);
			};
		}
		if (this.statusEl) {
			this.statusEl.setText(`共 ${items.length} 条 · 更新于 ${new Date().toLocaleTimeString('zh-CN')}`);
		}
	}

	fillHighlighted(el, text) {
		const kws = (this.plugin.settings.interests || '').split(/[,，\s]+/).filter(Boolean).map((k) => k.toLowerCase());
		const lower = String(text || '').toLowerCase();
		const marks = [];
		for (const k of kws) {
			let idx = 0;
			while (k) {
				const i = lower.indexOf(k, idx);
				if (i < 0) break;
				marks.push([i, i + k.length]);
				idx = i + k.length;
			}
		}
		if (!marks.length) {
			el.setText(text || '');
			return;
		}
		marks.sort((a, b) => a[0] - b[0]);
		const merged = [marks[0]];
		for (const m of marks.slice(1)) {
			const last = merged[merged.length - 1];
			if (m[0] <= last[1]) last[1] = Math.max(last[1], m[1]);
			else merged.push(m);
		}
		let pos = 0;
		for (const [s, e] of merged) {
			if (s > pos) el.appendText(text.slice(pos, s));
			el.createSpan({ cls: 'scys-hl', text: text.slice(s, e) });
			pos = e;
		}
		if (pos < String(text).length) el.appendText(text.slice(pos));
	}
}

class TopicDetailModal extends Modal {
	constructor(app, plugin, item) {
		super(app);
		this.plugin = plugin;
		this.item = item;
	}

	async onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('scys-detail');
		contentEl.createEl('h3', { text: this.item.title || '帖子详情' });
		contentEl.createDiv({ cls: 'scys-detail-loading', text: '加载中…' });
		try {
			const d = await this.plugin.fetchDetail(this.item);
			contentEl.querySelector('.scys-detail-loading')?.remove();
			this.renderDetail(d);
		} catch (e) {
			contentEl.querySelector('.scys-detail-loading')?.remove();
			contentEl.createDiv({ cls: 'scys-detail-loading', text: '加载失败：' + e.message });
		}
	}

	renderDetail(d) {
		const { contentEl } = this;
		if (d.stats) contentEl.createDiv({ cls: 'scys-detail-stats', text: d.stats });
		const meta = contentEl.createDiv({ cls: 'scys-detail-meta' });
		if (d.author) meta.createSpan({ text: '👤 ' + d.author });
		if (d.date) meta.createSpan({ text: '🕒 ' + d.date });
		if (d.likes != null) meta.createSpan({ text: '👍 ' + d.likes });
		if (d.reads != null) meta.createSpan({ text: '👁 ' + d.reads });
		const bodyEl = contentEl.createDiv({ cls: 'scys-detail-body' });
		bodyEl.appendText(String(d.content || ''));
		contentEl.addClass('scys-detail-plain');
		const foot = contentEl.createDiv({ cls: 'scys-detail-foot' });
		const mdBtn = foot.createEl('button', { text: '📝 渲染为 Markdown', cls: 'scys-mini-btn' });
		mdBtn.onclick = async () => {
			mdBtn.disabled = true;
			try {
				await window.MarkdownRenderer.render(this.app, String(d.content || ''), bodyEl, d.url || '', this.plugin);
				bodyEl.removeClass('scys-detail-plain');
				mdBtn.remove();
			} catch (e) {
				mdBtn.disabled = false;
			}
		};
		const saveBtn = foot.createEl('button', { text: '⭐ 收藏为笔记', cls: 'scys-mini-btn scys-save-btn' });
		saveBtn.onclick = () => {
			this.plugin.saveAsNote(this.item, d);
			this.close();
		};
	}
}

class ScysSearchModal extends Modal {
	constructor(app, plugin) {
		super(app);
		this.plugin = plugin;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('scys-detail');
		contentEl.createEl('h3', { text: '搜索生财有术' });
		const input = contentEl.createEl('input', { cls: 'scys-search-input', attr: { type: 'search', placeholder: '关键词…回车即调 MCP 检索' } });
		const submit = () => {
			const kw = String(input.value || '').trim();
			if (!kw) return;
			this.close();
			this.plugin.activateView();
			setTimeout(() => {
				const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_SCYS);
				if (leaves.length && leaves[0].view instanceof ScysRadarView) leaves[0].view.doSearch(kw);
			}, 150);
		};
		input.onkeydown = (e) => {
			if (e.key === 'Enter') submit();
		};
		const btn = contentEl.createEl('button', { text: '搜索', cls: 'mod-cta' });
		btn.onclick = submit;
		setTimeout(() => input.focus(), 50);
	}
}

class AskYiRenModal extends Modal {
	constructor(app, plugin, initial) {
		super(app);
		this.plugin = plugin;
		this.initial = initial || '';
		this.timer = null;
	}

	onClose() {
		if (this.timer) clearInterval(this.timer);
		this.timer = null;
		this.contentEl.empty();
	}

	async onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('scys-detail');
		contentEl.createEl('h3', { text: '问亦仁' });
		contentEl.createDiv({ cls: 'scys-hint', text: 'AI 亦仁会用亦仁的公开回答与文章作答，生成通常需要 1-2 分钟，请保持窗口打开。' });
		const ta = contentEl.createEl('textarea', {
			cls: 'scys-ask-input',
			attr: { placeholder: '例如：一个人做 AI 工具，当下最值得押注的方向是什么？' },
		});
		if (this.initial) ta.value = this.initial;
		const actions = contentEl.createDiv({ cls: 'scys-ask-actions' });
		const askBtn = actions.createEl('button', { text: '提问', cls: 'mod-cta' });
		const statusEl = contentEl.createDiv({ cls: 'scys-ask-status' });
		const ansEl = contentEl.createDiv({ cls: 'scys-ask-answer' });
		let busy = false;
		const stop = () => {
			if (this.timer) clearInterval(this.timer);
			this.timer = null;
		};

		askBtn.onclick = async () => {
			if (busy) return;
			const question = String(ta.value || '').trim();
			if (!question) {
				new Notice('请输入你的问题', 4000);
				return;
			}
			busy = true;
			askBtn.disabled = true;
			stop();
			ansEl.empty();
			statusEl.setText('已提交给 AI 亦仁，正在生成…');
			try {
				const c = await this.plugin.readyClient();
				const st = await c.callTool('startAiYiRenChat', { userQuestion: question });
				const sid = st && (st.userAiChatSessionId || st.sessionId);
				if (!sid) {
					statusEl.setText('未能开启会话：' + JSON.stringify(st || {}).slice(0, 200));
					busy = false;
					askBtn.disabled = false;
					return;
				}
				let tries = 0;
				this.timer = setInterval(async () => {
					tries += 1;
					if (tries > 100) {
						stop();
						statusEl.setText('等待超时（5 分钟），请重试或到生财 App 查看');
						busy = false;
						askBtn.disabled = false;
						return;
					}
					try {
						const r = await c.callTool('queryAiYiRenChat', { userAiChatSessionId: sid });
						const it = ((r && r.items) || [])[0];
						const ans = it && it.generateAnswer;
						if (ans) {
							stop();
							await this.renderAnswer(ansEl, question, ans, it);
							statusEl.setText('已生成于 ' + new Date().toLocaleTimeString('zh-CN'));
							busy = false;
							askBtn.disabled = false;
						} else if (tries % 5 === 0) {
							statusEl.setText('还在生成…（已等待 ' + tries * 3 + ' 秒）');
						}
					} catch (e) {
						if (tries % 5 === 0) statusEl.setText('仍在等待回答…（' + e.message + '）');
					}
				}, 3000);
			} catch (e) {
				statusEl.setText('提问失败：' + e.message);
				busy = false;
				askBtn.disabled = false;
			}
		};
	}

	async renderAnswer(el, question, answer, item) {
		el.empty();
		el.createEl('h4', { text: 'Q：' + question });
		const bodyEl = el.createDiv({ cls: 'scys-ask-body' });
		try {
			await window.MarkdownRenderer.render(this.app, String(answer || ''), bodyEl, '', this.plugin);
		} catch (e) {
			bodyEl.setText(String(answer || ''));
		}
		const refs = ((item && item.relationEntitySet) || []).slice(0, 8);
		if (refs.length) {
			const box = el.createDiv({ cls: 'scys-refs' });
			box.createEl('h5', { text: '参考原帖' });
			for (const r of refs) {
				const a = box.createEl('a', { text: r.entityTitle || '(无标题)', href: r.titleUrl || '#' });
				a.setAttr('target', '_blank');
				a.setAttr('rel', 'noopener');
				box.createEl('br');
			}
		}
		const foot = el.createDiv({ cls: 'scys-ask-foot' });
		const saveBtn = foot.createEl('button', { text: '⭐ 存为笔记', cls: 'scys-mini-btn scys-save-btn' });
		saveBtn.onclick = () => {
			this.plugin.saveAsNote(
				{ kind: 'yiren', entityId: null, url: '', title: '问亦仁：' + String(question || '').slice(0, 40), author: 'AI 亦仁', dateText: '', summary: '' },
				{ title: '问亦仁：' + question, author: 'AI 亦仁', date: '', content: answer, url: '' }
			);
		};
	}
}

class ScysRadarSettingTab extends PluginSettingTab {
	constructor(app, plugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display() {
		const { containerEl } = this;
		containerEl.empty();
		new Setting(containerEl).setName('MCP 端点').setDesc('生财 MCP 服务地址，一般无需修改').addText((t) =>
			t.setValue(this.plugin.settings.endpoint).onChange(async (v) => {
				this.plugin.settings.endpoint = v.trim();
				await this.plugin.saveSettings();
			})
		);
		new Setting(containerEl).setName('兴趣关键词').setDesc('逗号分隔，命中的标题/摘要会高亮，配合「只看感兴趣」过滤').addTextArea((t) =>
			t.setValue(this.plugin.settings.interests).onChange(async (v) => {
				this.plugin.settings.interests = v;
				await this.plugin.saveSettings();
			})
		);
		new Setting(containerEl).setName('收藏保存目录').setDesc('收藏的笔记保存到该文件夹').addText((t) =>
			t.setValue(this.plugin.settings.saveFolder).onChange(async (v) => {
				this.plugin.settings.saveFolder = v;
				await this.plugin.saveSettings();
			})
		);
		new Setting(containerEl).setName('列表显示摘要').setDesc('关闭后只显示标题，更紧凑').addToggle((t) =>
			t.setValue(this.plugin.settings.showBody).onChange(async (v) => {
				this.plugin.settings.showBody = v;
				await this.plugin.saveSettings();
			})
		);
		new Setting(containerEl).setName('热门帖拉取条数').setDesc('5-30').addText((t) =>
			t.setValue(String(this.plugin.settings.hotPageSize)).onChange(async (v) => {
				const n = parseInt(v, 10);
				if (n >= 5 && n <= 30) {
					this.plugin.settings.hotPageSize = n;
					await this.plugin.saveSettings();
				}
			})
		);
		new Setting(containerEl).setName('航海显示已结束').setDesc('默认只看「即将开放 / 报名中 / 进行中」；打开后可翻阅全部历史航海（约 380 条、37 期），便于回溯往期选题').addToggle((t) =>
			t.setValue(!!this.plugin.settings.sailIncludeFinished).onChange(async (v) => {
				this.plugin.settings.sailIncludeFinished = v;
				await this.plugin.saveSettings();
			})
		);
		new Setting(containerEl).setName('本地聚会 · 省').setDesc('「聚会 → 本地」按此精确匹配，需与生财里的写法一致，如「广东省」').addText((t) =>
			t.setValue(this.plugin.settings.partyProvince || '').onChange(async (v) => {
				this.plugin.settings.partyProvince = v.trim();
				await this.plugin.saveSettings();
			})
		);
		new Setting(containerEl).setName('本地聚会 · 市').setDesc('如「武汉市」').addText((t) =>
			t.setValue(this.plugin.settings.partyCity || '').onChange(async (v) => {
				this.plugin.settings.partyCity = v.trim();
				await this.plugin.saveSettings();
			})
		);
		new Setting(containerEl).setName('本地聚会 · 区（可选）').setDesc('留空则匹配全市，例如写「南山区」只盯着一个区').addText((t) =>
			t.setValue(this.plugin.settings.partyDistrict || '').onChange(async (v) => {
				this.plugin.settings.partyDistrict = v.trim();
				await this.plugin.saveSettings();
			})
		);
		new Setting(containerEl).setName('聚会只看还没开始的').setDesc('关闭后可看到已经办完的聚会').addToggle((t) =>
			t.setValue(!!this.plugin.settings.partyOnlyFuture).onChange(async (v) => {
				this.plugin.settings.partyOnlyFuture = v;
				await this.plugin.saveSettings();
			})
		);
		new Setting(containerEl)
			.setName('账号与授权')
			.setDesc(this.plugin.oauth.hasAuth ? '已授权，可重新授权或断开' : '未授权')
			.addButton((b) =>
				b.setButtonText(this.plugin.oauth.hasAuth ? '重新授权' : '去授权').onClick(async () => {
					try {
						await this.plugin.login();
						new Notice('✅ 授权成功');
						this.display();
					} catch (e) {
						new Notice('授权失败：' + e.message, 8000);
					}
				})
			)
			.addButton((b) =>
				b.setButtonText('断开连接').setDisabled(!this.plugin.oauth.hasAuth).onClick(async () => {
					this.plugin.oauth.accessToken = null;
					this.plugin.oauth.refreshToken = null;
					this.plugin.oauth.clientId = null;
					this.plugin.oauth.expiresAt = 0;
					await this.plugin.saveSettings();
					new Notice('已断开');
					this.display();
				})
			);
	}
}

class ScysRadarPlugin extends Plugin {
	shareMyToken() {
		const url = this.tokenProfile && this.tokenProfile.shareUrl;
		if (!url) {
			new Notice('请先打开「Token 榜」加载你的官方排名，再分享。');
			return;
		}
		window.open(url, '_blank');
	}
	async onload() {
		try {
			await this.loadSettings();
			this.oauth = new ScysOAuth(this.settings.endpoint, (m) => this.log('oauth: ' + m));
			this.oauth.load(this.settings.oauth);
			this.client = null;
			if (this.oauth.hasAuth) {
				this.ensureClient().catch((e) => this.log('init client failed: ' + (e && e.stack || e)));
			}

			this.registerView(VIEW_TYPE_SCYS, (leaf) => new ScysRadarView(leaf, this));
			this.addRibbonIcon('radar', '生财雷达', () => this.activateView().catch((e) => this.fatal('activateView', e)));
			this.addCommand({ id: 'open-scys-radar', name: '打开生财雷达', callback: () => this.activateView().catch((e) => this.fatal('activateView', e)) });
			this.addCommand({ id: 'scys-refresh-hot', name: '刷新热门榜', callback: () => this.refreshFromAnywhere() });
			this.addCommand({ id: 'scys-search', name: '搜索生财正文', callback: () => this.openSearchPrompt() });
			this.addCommand({ id: 'scys-ask-yiren', name: '问亦仁（AI 分身）', callback: () => this.openAskYiRen('') });
			this.addSettingTab(new ScysRadarSettingTab(this.app, this));
			this.log('loaded OK v' + this.manifest.version);
		} catch (e) {
			this.fatal('onload', e);
			throw e;
		}
	}

	log(msg) {
		console.log('[scys-radar] ' + msg);
		try {
			const fs = require('fs');
			fs.appendFileSync(require('path').join(this.manifest.dir, 'plugin.log'), new Date().toISOString() + ' ' + msg + '\n');
		} catch {}
	}

	fatal(where, e) {
		const msg = (e && e.stack) || String(e);
		this.log('FATAL at ' + where + ': ' + msg);
		try {
			new Notice('生财雷达错误（' + where + '）：' + String(e && e.message || e).slice(0, 200), 10000);
		} catch {}
	}

	onunload() {}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData({ ...this.settings, oauth: this.oauth ? this.oauth.toJSON() : this.settings.oauth });
	}

	async activateView() {
		const { workspace } = this.app;
		const leaves = workspace.getLeavesOfType(VIEW_TYPE_SCYS);
		let leaf;
		if (leaves.length) {
			leaf = leaves[0];
		} else {
			leaf = workspace.getRightLeaf(false);
			await leaf.setViewState({ type: VIEW_TYPE_SCYS, active: true });
		}
		workspace.revealLeaf(leaf);
	}

	refreshFromAnywhere() {
		this.activateView();
		const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_SCYS);
		if (leaves.length && leaves[0].view instanceof ScysRadarView) leaves[0].view.loadTab(leaves[0].view.tab);
	}

	async login(onEvent) {
		const { waitPromise, authorizeUrl } = await this.oauth.authorizeInteractive(onEvent);
		this._lastAuthorizeUrl = authorizeUrl;
		const r = await waitPromise;
		await this.oauth.exchangeCode(r, this.oauth._pendingVerifier);
		await this.saveSettings();
		await this.ensureClient();
	}

	async ensureClient() {
		if (!this.client) {
			this.client = new McpClient(this.oauth);
		}
		await this.client.init();
		return this.client;
	}

	async readyClient() {
		if (!this.oauth.hasAuth) throw new Error('请先授权登录');
		if (!this.client) await this.ensureClient();
		if (!this.client.sessionId) await this.client.init();
		return this.client;
	}

	async fetchHot() {
		const c = await this.readyClient();
		const dayAgo = Math.floor(Date.now() / 1000) - 86400 * 7;
		const r = await c.callTool('searchTopic', { isHot: true, gmtCreateStart: dayAgo, displayMode: 1, pageIndex: 1, pageSize: Math.min(this.settings.hotPageSize, 30) });
		const items = (r && r.items) || [];
		return items.map((x) => {
			const t = (x && x.topicDTO) || {};
			return {
				kind: 'topic', entityId: t.entityId, url: x.detailUrl, title: t.showTitle || '(无标题)',
				summary: t.articleContent || '', author: ((x.topicUserDTO || {}).name) || '', isDigested: !!t.isDigested,
				likes: t.likeCount, reads: t.readingCount, dateText: tsToDate(t.gmtCreate), raw: t,
			};
		});
	}

	async fetchGood() {
		const c = await this.readyClient();
		const r = await c.callTool('searchTopic', { isDigested: true, displayMode: 1, pageIndex: 1, pageSize: Math.min(this.settings.hotPageSize, 30) });
		const items = (r && r.items) || [];
		return items.map((x) => {
			const t = (x && x.topicDTO) || {};
			return {
				kind: 'topic', entityId: t.entityId, url: x.detailUrl, title: t.showTitle || '(无标题)',
				summary: t.articleContent || '', author: ((x.topicUserDTO || {}).name) || '', isDigested: true,
				likes: t.likeCount, reads: t.readingCount, dateText: tsToDate(t.gmtCreate), raw: t,
			};
		});
	}

	async fetchFxb() {
		const c = await this.readyClient();
		const r = await c.callTool('contentSearch', { pageScene: 'fxb', displayMode: 1, pageIndex: 1, pageSize: 15 });
		const items = (r && r.topicDetailDTO && r.topicDetailDTO.items) || [];
		return items.map((x) => {
			const t = (x && x.topicDTO) || {};
			return {
				kind: 'topic', entityId: t.entityId, url: 'https://scys.com/articleDetail/' + (t.entityType || 'xq_topic') + '/' + t.entityId,
				title: t.showTitle || '(无标题)', summary: t.articleContent || '', author: ((x.topicUserDTO || {}).name) || '',
				isDigested: !!t.isDigested, likes: t.likeCount, reads: t.readingCount, dateText: tsToDate(t.gmtCreate), raw: t,
			};
		});
	}

	async fetchSail() {
		const c = await this.readyClient();
		const order = { 1: 0, 2: 1, 3: 2, 4: 3 };
		// activityList 的 status 是单值过滤：1即将开放 2报名中 3进行中 4已结束。
		// 不传 status 时，首页返回的几乎全是已结束的历史航海（占了 380 条里的绝大多数），
		// 若只在本地 filter 掉 status=4，结果就是 0 条 —— 这正是「航海是空的」的根因。
		// 因此必须让服务端按 status 过滤，逐个状态取（串行，避免同一 MCP session 并发）。
		const wantFinished = !!this.settings.sailIncludeFinished;
		const statuses = wantFinished ? [1, 2, 3, 4] : [1, 2, 3];
		const list = [];
		for (const st of statuses) {
			try {
				const r = await c.callTool('activityList', { status: st, pageIndex: 1, pageSize: st === 4 ? 30 : 15 });
				for (const a of (r && r.items) || []) {
					if (!list.some((x) => x.id === a.id)) list.push(a);
				}
			} catch (e) {
				this.log('fetchSail status=' + st + ' 失败: ' + e.message);
			}
		}
		const items = list.filter((a) => statuses.includes(a.status));
		return items
			.sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9) || (b.gmtSail || 0) - (a.gmtSail || 0))
			.map((a) => ({
				kind: 'sail', entityId: null, url: 'https://scys.com/activity', title: a.name,
				typeLabel: a.type + ' · ' + (a.statusDesc || ''), summary: (a.target || '') + (a.platformList && a.platformList.length ? '（' + a.platformList.join('/') + '）' : ''),
				author: a.label || '', isDigested: false,
				likes: null, reads: null,
				dateText: a.status === 2 ? '报名截止 ' + tsToDate(a.gmtEnrollEnd) : a.status === 3 ? '航行中（起航 ' + tsToDate(a.gmtSail) + '）' : '即将开放 ' + tsToDate(a.gmtStart),
				raw: a,
			}));
	}

	mapTopic(x) {
		const t = (x && x.topicDTO) || {};
		return {
			kind: 'topic', entityId: t.entityId, url: x.detailUrl, title: t.showTitle || '(无标题)',
			summary: t.articleContent || '', author: ((x.topicUserDTO || {}).name) || '', isDigested: !!t.isDigested,
			likes: t.likeCount, reads: t.readingCount, dateText: tsToDate(t.gmtCreate), raw: t,
		};
	}

	async fetchSearch(kw) {
		const c = await this.readyClient();
		const r = await c.callTool('searchTopic', { keyword: kw, displayMode: 1, pageIndex: 1, pageSize: Math.min(this.settings.hotPageSize, 30) });
		return ((r && r.items) || []).map((x) => this.mapTopic(x));
	}

	async fetchSuper() {
		// 「超级标的」= 亦仁发布的【超级标 XX】系列，对应官方标签 menuId 2634453
		const c = await this.readyClient();
		const r = await c.callTool('searchTopic', { includeMenuIdList: ['2634453'], displayMode: 1, pageIndex: 1, pageSize: 30 });
		return ((r && r.items) || []).map((x) => this.mapTopic(x));
	}

	async fetchSelectedFxb() {
		const c = await this.readyClient();
		const r = await c.callTool('contentSearch', { pageScene: 'fxb', displayMode: 1, pageIndex: 1, pageSize: 30 });
		return ((r && r.topicDetailDTO && r.topicDetailDTO.items) || [])
			.filter((x) => x.isSelected || x.isBid || (x.topicDTO && (x.topicDTO.isSelected || x.topicDTO.isBid || x.topicDTO.isChosen)))
			.map((x) => this.mapTopic(x));
	}

	async fetchTokenRank() {
		const accessToken = await this.oauth.validToken();
		const headers = accessToken ? { Authorization: 'Bearer ' + accessToken } : {};
		const base = this.settings.tokenRankEndpoint;
		const [mine, r] = await Promise.all([
			requestUrlJson({ url: 'https://scys.com/tokenrank/api/subapp/me-lab?range=7d', headers }),
			requestUrlJson({ url: base + '?range=7d&board=total&metric=total&limit=30', headers }),
		]);
		if (mine && mine.status === -401) throw new Error('Token 排行榜尚未识别当前生财账户，请在官网完成 Token 排行榜登录后重试。');
		if (!mine || mine.status !== 0 || !r || r.status !== 0) throw new Error((mine && mine.message) || (r && r.message) || 'Token 榜单暂时不可用');
		const me = mine.user || mine.profile || mine;
		const myRank = r.myRank || mine.rank || {};
		const userId = me.userId || me.id || mine.userId;
		const myItem = {
			kind: 'rank', rank: myRank.rank || '—', tokens: myRank.score || (mine.kpi && mine.kpi.total) || mine.total || 0,
			title: (me.name || mine.name || '我') + '（我）', summary: '当前已登录账户 · ' + (myRank.rank ? '近 7 天第 ' + myRank.rank + ' 名' : '暂未进入榜单'), author: '',
			url: userId ? 'https://scys.com/tokenrank/u/' + userId + '?range=7d' : 'https://scys.com/tokenrank/',
		};
		this.tokenProfile = { shareUrl: myItem.url, userId };
		const entries = (r.entries || []).filter((x) => !userId || x.userId !== userId).map((x) => ({ kind: 'rank', rank: x.rank, tokens: x.score, title: x.name || '匿名用户', summary: '主力工具：' + Object.keys(x.byTool || {}).join(' / ') + (x.primaryModel ? ' · ' + x.primaryModel : ''), author: '', url: 'https://scys.com/tokenrank/u/' + x.userId }));
		return [myItem].concat(entries);
	}

	async fetchContentBoards() {
		const [fxb, hot] = await Promise.all([this.fetchFxb(), this.fetchHot()]);
		const anchor = (x) => Number((x.raw && (x.raw.anchorCount || x.raw.anchorNum || x.raw.voteCount)) || 0);
		const weekStart = Date.now() - 7 * 86400000;
		const createdAt = (x) => { const n = Number(x.raw && x.raw.gmtCreate) || 0; return n < 1e12 ? n * 1000 : n; };
		const weekly = fxb.filter((x) => createdAt(x) >= weekStart).sort((a, b) => anchor(b) - anchor(a)).slice(0, 10).map((x) => ({ ...x, kind: 'board', typeLabel: '锚点榜 · 周榜', anchorCount: anchor(x) }));
		const total = fxb.slice().sort((a, b) => anchor(b) - anchor(a)).slice(0, 10).map((x) => ({ ...x, kind: 'board', typeLabel: '总投锚榜', anchorCount: anchor(x) }));
		const likes = hot.slice().sort((a, b) => Number(b.likes || 0) - Number(a.likes || 0)).slice(0, 10).map((x) => ({ ...x, kind: 'board', typeLabel: '文章点赞榜' }));
		return weekly.concat(total, likes);
	}

	async fetchParties(scope) {
		const c = await this.readyClient();
		const args = { pageIndex: 1, pageSize: 30, partyStatuses: ['APPROVED'] };
		if (scope === 'local') {
			const province = String(this.settings.partyProvince || '').trim();
			const city = String(this.settings.partyCity || '').trim();
			const district = String(this.settings.partyDistrict || '').trim();
			if (!city && !province) throw new Error('请先在插件设置里填写「聚会所在省份 / 城市」');
			if (province) args.province = province;
			if (city) args.city = city;
			if (district) args.district = district;
		}
		if (this.settings.partyOnlyFuture) args.startTimeFrom = Math.floor(Date.now() / 1000);
		const r = await c.callTool('searchParties', args);
		const items = (r && r.items) || [];
		return items
			.sort((a, b) => (a.startTime || 0) - (b.startTime || 0))
			.map((p) => {
				const place = [p.province === p.city ? null : p.province, p.city, p.district].filter(Boolean).join(' · ');
				const cost = p.avgCost == null ? '' : Number(p.avgCost) > 0 ? '¥' + p.avgCost : '免费';
				const remain = p.full ? '已报满' : p.remainStock != null ? '余 ' + p.remainStock + ' 位' : '';
				return {
					kind: 'party', entityId: p.partyId, url: p.url || 'https://scys.com/meeting/detail?id=' + p.partyId,
					title: p.name || '(无标题)', summary: stripMd(p.description || '', 140),
					typeLabel: p.typeText || '聚会', place, costText: cost, remainText: remain,
					dateText: tsToDate(p.startTime) + (p.submitEnd ? ' · 报名截止 ' + tsToDate(p.submitEnd) : ''),
					isDigested: !!p.isDigested, author: '', likes: null, reads: null, raw: p,
				};
			});
	}

	async fetchProjectLib() {
		const c = await this.readyClient();
		const r = await c.callTool('projectLibList', { sortType: 'latest', pageIndex: 1, pageSize: 30 });
		const items = (r && r.items) || [];
		return items.map((p) => {
			const tags = [].concat(p.platformMenus || [], p.monetizeMenus || [], p.crowdMenus || []).map((m) => m && m.name).filter(Boolean);
			const income = p.incomeMin != null && p.incomeMax != null ? '¥' + p.incomeMin + '~' + p.incomeMax + ' / 月' : '';
			const parts = [p.summary || '', p.highlightText ? '（' + p.highlightText + '）' : '', tags.length ? tags.join(' / ') : ''].filter(Boolean).join(' · ');
			return {
				kind: 'project', entityId: String(p.id), url: 'https://scys.com/projectLib/detail?id=' + p.id,
				title: p.name || '(未命名项目)', summary: parts, incomeText: income,
				costText: p.estimatedCost == null ? '' : Number(p.estimatedCost) > 0 ? '启动 ¥' + p.estimatedCost : '零成本起步',
				timeText: p.dailyMinutes ? '每天约 ' + Math.round((p.dailyMinutes / 60) * 10) / 10 + ' 小时' : '',
				caseText: p.caseCount ? p.caseCount + ' 个实操案例' : '',
				isSuper: !!p.isSuper, author: '', likes: p.likeCount, reads: null,
				dateText: tsToDate(p.gmtPublish), isDigested: false, raw: p,
			};
		});
	}

	async openAskYiRen(initial) {
		new AskYiRenModal(this.app, this, initial || '').open();
	}

	openSearchPrompt() {
		new ScysSearchModal(this.app, this).open();
	}

	openSettings() {
		try {
			const setting = this.app.setting;
			setting.open();
			setting.openTabById(this.manifest.id);
		} catch (e) {
			new Notice('请到 设置 → 第三方插件 → Scys Radar 里修改', 6000);
		}
	}

	async fetchDetail(item) {
		const c = await this.readyClient();
		if (item.kind === 'party') {
			try {
				const r = await c.callTool('getPartyDetail', { partyId: String(item.entityId) });
				const p = (r && (r.partyDTO || r.party || r)) || {};
				return {
					title: p.name || item.title, author: (((r && (r.hostUserDTO || r.host)) || {}).name) || '',
					date: item.dateText, likes: null, reads: null,
					content: String(p.description || p.detailDesc || item.summary || ''),
					url: p.url || item.url,
				};
			} catch (e) {
				const p = (item.raw || {});
				return { title: item.title, author: '', date: item.dateText, likes: null, reads: null, content: String(p.description || item.summary || ''), url: item.url };
			}
		}
		if (item.kind === 'project') {
			const p = item.raw || {};
			const tags = [].concat(p.platformMenus || [], p.monetizeMenus || [], p.crowdMenus || []).map((m) => m && m.name).filter(Boolean);
			const lines = [
				p.summary || '',
				p.highlightText ? '亮点：' + p.highlightText : '',
				tags.length ? '标签：' + tags.join(' / ') : '',
				p.incomeMin != null ? '月收入区间：¥' + p.incomeMin + ' ~ ¥' + p.incomeMax : '',
				p.estimatedCost != null ? '启动资金：¥' + p.estimatedCost : '',
				p.dailyMinutes ? '每天投入：' + p.dailyMinutes + ' 分钟' : '',
				p.caseCount ? '实操案例：' + p.caseCount + ' 个' : '',
				p.resourceCount ? '学习资源：' + p.resourceCount + ' 份' : '',
			].filter(Boolean).join('\n\n');
			return { title: p.name || item.title, author: '', date: item.dateText, likes: p.likeCount, reads: null, content: lines, url: item.url };
		}
		const r = await c.callTool('topicDetail', { entityType: item.raw.entityType || 'xq_topic', entityId: item.entityId });
		const t = (r && (r.topicDTO || r)) || {};
		return {
			title: t.showTitle || item.title,
			author: ((r.topicUserDTO || {}).name) || item.author,
			date: tsToDate(t.gmtCreate),
			likes: t.likeCount != null ? t.likeCount : item.likes,
			reads: t.readingCount != null ? t.readingCount : item.reads,
			content: t.articleContentContainFeishuDoc || t.articleContent || item.summary || '',
			url: (r && r.detailUrl) || item.url,
		};
	}

	async openDetail(item) {
		new TopicDetailModal(this.app, this, item).open();
	}

	async saveAsNote(item, detail) {
		try {
			const folder = this.settings.saveFolder;
			if (!(await this.app.vault.adapter.exists(folder))) {
				await this.app.vault.createFolder(folder).catch(() => {});
			}
			const title = (item.title || '未命名').replace(/[\\/:*?"<>|]/g, '_').slice(0, 80);
			const path = folder + '/' + title + '.md';
			let d = detail;
			if (!d) {
				try {
					d = await this.fetchDetail(item);
				} catch {
					d = null;
				}
			}
			const hits = ((this.app.workspace.getLeavesOfType(VIEW_TYPE_SCYS)[0] || {}).view instanceof ScysRadarView && this.app.workspace.getLeavesOfType(VIEW_TYPE_SCYS)[0].view.matchInterests(item.title + ' ' + (item.summary || ''))) || [];
			const fm = ['---', 'title: ' + JSON.stringify(item.title || ''), 'source: ' + (item.url || ''), 'author: ' + JSON.stringify(item.author || ''), 'date_saved: ' + new Date().toISOString().slice(0, 10), 'type: scys-' + (item.kind === 'sail' ? 'sail' : 'topic'), item.isDigested ? 'digest: true' : '', hits && hits.length ? 'interest_tags: [' + hits.join(', ') + ']' : '', '---'].filter(Boolean).join('\n');
			let body = '';
			if (d && d.content) {
				body = '# ' + (d.title || item.title) + '\n\n' + d.content + '\n\n---\n> 👤 ' + (d.author || '') + ' · 🕒 ' + (d.date || '') + ' · [原帖链接](' + (d.url || item.url || '') + ')\n';
			} else if (item.kind === 'sail') {
				body = '# ' + item.title + '\n\n' + (item.summary || '') + '\n\n> ' + (item.dateText || '') + ' · ' + (item.typeLabel || '') + '\n';
			} else {
				body = '# ' + item.title + '\n\n' + (item.summary || '') + '\n\n> [原帖链接](' + (item.url || '') + ')\n';
			}
			if (item.kind === 'sail') {
				body += '\n[[生财副业/05 行动看板|→ 送到行动看板]]\n';
			} else {
				body += '\n[[04 待读队列|→ 加入待读]]\n';
			}
			if (await this.app.vault.adapter.exists(path)) {
				new Notice('已存在同名笔记：' + title);
				return;
			}
			const f = await this.app.vault.create(path, fm + '\n\n' + body);
			new Notice('⭐ 已收藏：' + title);
			this.app.workspace.getLeaf(true).openFile(f);
		} catch (e) {
			new Notice('收藏失败：' + e.message, 6000);
		}
	}
}

module.exports = ScysRadarPlugin;

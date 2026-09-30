'use strict';

const DEFAULT_SETTINGS = {
	endpoint: 'https://mcp.scys.com/shengcai-web/mcp',
	interests: 'AI,AI编程,Agent,MCP,独立开发,出海,小红书',
	saveFolder: '生财副业/02 每日情报',
	hotPageSize: 15,
	showBody: true,
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
		this.items = [];
		this.loading = false;
		this.onlyInterest = false;
		this.navs = [
			{ key: 'hot', label: '🔥 热门', load: () => this.plugin.fetchHot() },
			{ key: 'good', label: '💎 精华', load: () => this.plugin.fetchGood() },
			{ key: 'fxb', label: '🧭 风向标', load: () => this.plugin.fetchFxb() },
			{ key: 'sail', label: '⛵ 航海', load: () => this.plugin.fetchSail() },
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
		const bar = root.createDiv({ cls: 'scys-toolbar' });
		for (const n of this.navs) {
			const b = bar.createEl('button', { text: n.label, cls: this.tab === n.key ? 'scys-tab scys-tab-active' : 'scys-tab' });
			b.onclick = () => this.loadTab(n.key);
		}
		const spacer = bar.createDiv({ cls: 'scys-spacer' });
		const onlyBtn = bar.createEl('button', { text: '🎯 只看感兴趣', cls: 'scys-mini-btn', attr: { title: '按兴趣关键词过滤' } });
		onlyBtn.onclick = () => {
			this.onlyInterest = !this.onlyInterest;
			onlyBtn.toggleClass('is-on', this.onlyInterest);
			this.renderList();
		};
		const refreshBtn = bar.createEl('button', { text: '刷新', cls: 'scys-mini-btn' });
		refreshBtn.onclick = () => this.loadTab(this.tab);
		const cfgBtn = bar.createEl('button', { text: '⚙️', cls: 'scys-mini-btn' });
		cfgBtn.onclick = () => this.plugin.openSettings();

		this.listEl = root.createDiv({ cls: 'scys-list' });
		this.statusEl = root.createDiv({ cls: 'scys-status' });
	}

	async loadTab(key) {
		this.tab = key;
		this.items = [];
		const nav = this.navs.find((n) => n.key === key);
		this.contentEl.querySelectorAll('button.scys-tab').forEach((b) => {
			const isActive = b.textContent === nav.label;
			b.toggleClass('scys-tab-active', isActive);
		});
		this.renderList('加载中…');
		this.loading = true;
		try {
			this.items = (await nav.load()) || [];
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
			el.createDiv({ cls: 'scys-empty', text: this.tab === 'sail' ? '暂无相关航海' : '暂无内容（或被兴趣过滤掉了）' });
			return;
		}
		for (const it of items) {
			const card = el.createDiv({ cls: 'scys-card' + (it.isDigested ? ' scys-card-digest' : '') });
			const head = card.createDiv({ cls: 'scys-card-head' });
			if (it.kind === 'sail') {
				head.createSpan({ cls: 'scys-badge scys-badge-sail', text: it.typeLabel || '航海' });
				head.createSpan({ cls: 'scys-date', text: it.dateText || '' });
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
			const saveBtn = foot.createEl('button', { text: '⭐ 收藏为笔记', cls: 'scys-mini-btn scys-save-btn' });
			saveBtn.onclick = () => this.plugin.saveAsNote(it);
			card.onclick = (e) => {
				if (e.target.tagName === 'BUTTON') return;
				this.plugin.openDetail(it);
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
					await this.plugin.saveSettings();
					new Notice('已断开');
					this.display();
				})
			);
	}
}

class ScysRadarPlugin extends Plugin {
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
			this.addSettingTab(new ScysRadarSettingTab(this.app, this));
			this.log('loaded OK v0.1.0');
			this.saveData({ bootedAt: new Date().toISOString(), version: "0.1.0" }).catch(function(){});
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
		const r = await c.callTool('activityList', { pageIndex: 1, pageSize: 30 });
		const items = (r && r.items) || [];
		const order = { 1: 0, 2: 1, 3: 2, 4: 3 };
		return items
			.filter((a) => [1, 2, 3].includes(a.status))
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

	async fetchDetail(item) {
		const c = await this.readyClient();
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

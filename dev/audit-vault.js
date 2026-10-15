/* 只读体检：扫描真实仓库，输出外部引用清单（不写任何文件）
 *
 * 用法：node audit-vault.js "<Obsidian 仓库路径>" ["<监控文件夹路径>"]
 *   也可用环境变量 ELM_VAULT / ELM_MONITORED 传入。
 *   监控文件夹可选；不传时所有外部链接都会显示为「范围外」。
 */
'use strict';

const fs = require('fs');
const nodePath = require('path');
const Module = require('module');

global.window = {
	setTimeout: (fn, ms) => setTimeout(fn, ms),
	clearTimeout: (id) => clearTimeout(id),
	setInterval: (fn, ms) => setInterval(fn, ms),
	clearInterval: (id) => clearInterval(id),
};

class TFile {
	constructor(p) {
		this.path = p;
		this.name = p.split('/').pop();
		const i = this.name.lastIndexOf('.');
		this.extension = i > 0 ? this.name.slice(i + 1) : '';
	}
}
class Plugin {
	constructor(app, m) { this.app = app; this.manifest = m; this._data = null; }
	async loadData() { return this._data; }
	async saveData(d) { this._data = d; }
	registerView() { } addRibbonIcon() { } addCommand() { } addSettingTab() { }
	registerEvent() { } registerInterval() { } register() { }
	addStatusBarItem() { return { setText() { }, addClass() { }, toggleClass() { }, remove() { } }; }
}
class X { constructor() { } }
class Notice { constructor(m) { } }

const mock = {
	Plugin, PluginSettingTab: X, Setting: X, ItemView: X, Modal: X, Notice, TFile,
	MarkdownView: X, normalizePath: (p) => String(p).replace(/\\/g, '/'),
};
const orig = Module._load;
Module._load = function (r) {
	if (r === 'obsidian') return mock;
	if (r === 'electron') throw new Error('no electron');
	return orig.apply(this, arguments);
};

const VAULT = (process.argv[2] || process.env.ELM_VAULT || '').trim();
if (!VAULT) {
	console.error('用法：node audit-vault.js "<你的 Obsidian 仓库路径>" ["<监控文件夹路径>"]');
	console.error('例如：node audit-vault.js "D:\\\\Notes\\\\my-vault" "D:\\\\资料"');
	process.exit(1);
}
if (!fs.existsSync(VAULT)) {
	console.error('仓库路径不存在：' + VAULT);
	process.exit(1);
}
/** 可选的监控文件夹：只用来在输出里区分「范围内 / 范围外」 */
const MONITORED = (process.argv[3] || process.env.ELM_MONITORED || '').trim();

/** 被测插件：仓库布局取上一级，本地工程布局取工程源码 */
const PLUGIN_MAIN = (() => {
	const beside = nodePath.join(__dirname, '..', 'main.js');
	if (fs.existsSync(beside)) return beside;
	return 'D:/proj0827/urlmonitor/obsidian-external-link-manager/main.js';
})();
const abs = (p) => nodePath.join(VAULT, p);

function listMd(dir, out, depth) {
	if (depth > 12) return out;
	let ents = [];
	try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return out; }
	for (const e of ents) {
		if (e.isDirectory()) {
			if (e.name === '.obsidian' || e.name === '.trash' || e.name === '.git') continue;
			listMd(nodePath.join(dir, e.name), out, depth + 1);
		} else if (e.name.endsWith('.md')) {
			out.push(nodePath.relative(VAULT, nodePath.join(dir, e.name)).replace(/\\/g, '/'));
		}
	}
	return out;
}

const app = {
	vault: {
		adapter: { getBasePath: () => VAULT },
		getMarkdownFiles: () => listMd(VAULT, [], 0).map((p) => new TFile(p)),
		cachedRead: async (f) => fs.readFileSync(abs(f.path), 'utf8'),
		read: async (f) => fs.readFileSync(abs(f.path), 'utf8'),
		modify: async () => { throw new Error('只读模式'); },
		create: async () => { throw new Error('只读模式'); },
		getAbstractFileByPath: (p) => (fs.existsSync(abs(p)) ? new TFile(p) : null),
		process: async () => { throw new Error('只读模式'); },
		on: () => ({ close() { } }),
	},
	workspace: {
		onLayoutReady: () => { }, on: () => ({ close() { } }),
		getLeavesOfType: () => [], getActiveViewOfType: () => null,
		getLeaf: () => ({ openFile: async () => { } }),
	},
	setting: { open() { }, openTabById() { } },
};

(async () => {
	const P = require(PLUGIN_MAIN);
	const p = new P(app, { id: 'external-link-manager' });
	p._data = {
		settings: {
			showStatusBar: false, writeChangeLog: false,
			alsoSearchUserProfile: false,   // 体检时跳过遍历用户目录，加快速度
			monitoredFolders: MONITORED
				? [{ path: MONITORED, label: 'cli', recursive: true, enabled: true }]
				: [],
		},
	};
	await p.onload();

	const files = app.vault.getMarkdownFiles();
	console.log('仓库：' + VAULT);
	console.log('Markdown 文件数：' + files.length);

	const t0 = Date.now();
	await p.scanAll({});
	console.log(`扫描耗时：${Date.now() - t0} ms`);
	console.log('识别到的外部引用：' + p.records.length + ' 条\n');

	const byStatus = {};
	for (const r of p.records) byStatus[r.status] = (byStatus[r.status] || 0) + 1;
	console.log('状态分布：' + JSON.stringify(byStatus) + '\n');

	const rows = p.records.slice().sort((a, b) => a.notePath.localeCompare(b.notePath));
	for (const r of rows.slice(0, 60)) {
		const flag = r.status === 'ok' ? 'OK ' : '!! ';
		console.log(`${flag}${r.notePath}:${r.line}`);
		console.log(`     [${r.linkText}] -> ${r.absolutePath}  (${r.status})`);
		if (r.reason) console.log(`     说明：${r.reason}`);
		for (const c of (r.candidateInfo || [])) {
			console.log(`       ${c.score.toFixed(2)}  ${c.path}   ← ${c.reason}`);
		}
	}
	if (rows.length > 60) console.log(`\n… 其余 ${rows.length - 60} 条省略`);
})();

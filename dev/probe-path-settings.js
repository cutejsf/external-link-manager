/* 一次性探针：验证「路径处理」里各项在当前平台上到底有没有被读到
   用法：node probe-path-settings.js */
const Module = require('module');
const nodePath = require('path');
const os = require('os');

const origLoad = Module._load;
class Plugin {
	constructor(app, manifest) { this.app = app; this.manifest = manifest; this._data = null; }
	async loadData() { return this._data; }
	async saveData(d) { this._data = d; }
	registerView() { }
	addRibbonIcon() { return { onclick: null }; }
	addCommand() { }
	addSettingTab() { }
	registerEvent() { }
	registerInterval(id) { return id; }
	register() { }
	addStatusBarItem() { return { setText() { }, addClass() { }, toggleClass() { }, remove() { } }; }
}
class PluginSettingTab { constructor(app, plugin) { this.app = app; this.plugin = plugin; } }
class Setting {
	constructor(el) { this.el = el; }
	setName() { return this; } setDesc() { return this; } setHeading() { return this; }
	addText() { return this; } addTextArea() { return this; } addToggle() { return this; }
	addDropdown() { return this; } addButton() { return this; } addExtraButton() { return this; }
	addSlider() { return this; }
}
class ItemView { constructor(leaf) { this.leaf = leaf; this.contentEl = { empty() { }, addClass() { } }; } }
class Modal { constructor(app) { this.app = app; this.contentEl = { empty() { }, createEl() { return { createEl() { }, createDiv() { return { createEl() { }, createEl() { } }; } }; }, createDiv() { return { createEl() { }, createDiv() { } }; } }; } }
class Notice { constructor(msg) { } }
class TFile { }
class MarkdownView { }
Module._load = function (request) {
	if (request === 'obsidian') {
		return { Plugin, PluginSettingTab, Setting, ItemView, Modal, Notice, TFile, MarkdownView, normalizePath: (p) => p };
	}
	return origLoad.apply(this, arguments);
};

const vaultDir = nodePath.join(os.tmpdir(), 'elm-probe-vault');
const app = {
	vault: {
		getAbstractFileByPath: () => null,
		adapter: { getBasePath: () => vaultDir },
		on: () => ({ }),
		getMarkdownFiles: () => [],
	},
	workspace: { on: () => ({ }), onLayoutReady: (f) => { }, getLeavesOfType: () => [], getActiveViewOfType: () => null },
	setting: { open() { }, openTabById() { } },
};

/* 被测插件：仓库布局取上一级 main.js，本地工程布局回退到工程源码 */
const PLUGIN_MAIN = (() => {
	const beside = nodePath.join(__dirname, '..', 'main.js');
	return require('fs').existsSync(beside) ? beside : 'D:/proj0827/urlmonitor/obsidian-external-link-manager/main.js';
})();
const PluginClass = require(PLUGIN_MAIN);

(async () => {
	const p = new PluginClass(app, { id: 'external-link-manager' });
	p._data = { settings: { showStatusBar: false, writeChangeLog: false } };
	await p.loadSettings();

	console.log('平台：' + process.platform + '（isWin 分支：' + (process.platform === 'win32') + '）');
	console.log('');

	const probes = [
		'/home/alice/docs/a.txt',
		'/Users/alice/docs/a.txt',
		'/mnt/d/data/a.txt',
		'/Volumes/disk/a.txt',
		'/笔记/abc.md',            // 库内绝对链接的样子
	];

	console.log('--- 1) 默认设置（posixRoots 全配、treatAllPosixAbsolute = false）---');
	console.log('posixRoots = ' + JSON.stringify(p.settings.posixRoots));
	for (const t of probes) {
		console.log('  ' + (p.shouldTreatAsExternal(t) ? '算外部' : '不算外部') + '   ' + t);
	}

	console.log('');
	console.log('--- 2) 把 posixRoots 清空 ---');
	p.settings.posixRoots = [];
	for (const t of probes) {
		console.log('  ' + (p.shouldTreatAsExternal(t) ? '算外部' : '不算外部') + '   ' + t);
	}
	console.log('  （若与上面完全一致 → posixRoots 在本平台没被读取）');

	console.log('');
	console.log('--- 3) treatAllPosixAbsolute = true ---');
	p.settings.posixRoots = ['/home/', '/Users/', '/mnt/', '/media/', '/Volumes/', '/opt/', '/srv/', '/root/'];
	p.settings.treatAllPosixAbsolute = true;
	for (const t of probes) {
		console.log('  ' + (p.shouldTreatAsExternal(t) ? '算外部' : '不算外部') + '   ' + t);
	}

	console.log('');
	console.log('--- 4) 用户名重映射 remapUserProfile ---');
	p.settings.remapUserProfile = true;
	console.log('  os.homedir() = ' + os.homedir());
	const me = os.userInfo().username || 'me';
	for (const t of [`C:\\Users\\${me}\\Desktop\\a.txt`, 'C:\\Users\\someoneelse\\Desktop\\a.txt',
		'D:\\other\\a.txt', `/home/${me}/a.txt`]) {
		const r = p.remapUserProfile(t);
		console.log('  ' + t + '  →  ' + (r === null ? '(不重映射)' : r));
	}
	p.settings.remapUserProfile = false;
	console.log('  关掉开关后：' + JSON.stringify(p.remapUserProfile(`C:\\Users\\${me}\\a.txt`)));

	console.log('');
	console.log('--- 5) 盘符映射 driveRemap ---');
	p.settings.driveRemap = '';
	console.log('  未配置时 remapDrive("D:\\\\x\\\\a.txt") = ' + JSON.stringify(p.remapDrive('D:\\x\\a.txt')));
	p.settings.driveRemap = 'D:=E:';
	console.log('  配 D:=E: 时 remapDrive("D:\\\\x\\\\a.txt") = ' + JSON.stringify(p.remapDrive('D:\\x\\a.txt')));
	p.settings.driveRemap = 'D: -> F:';
	console.log('  配 "D: -> F:" 时 remapDrive("D:\\\\x\\\\a.txt") = ' + JSON.stringify(p.remapDrive('D:\\x\\a.txt')));

	process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });

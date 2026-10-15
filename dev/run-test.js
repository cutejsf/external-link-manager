/* 无头测试：用 mock obsidian + 真实文件系统验证核心链路 */
'use strict';

const fs = require('fs');
const nodePath = require('path');
const os = require('os');
const Module = require('module');

/* ---------- 全局垫片 ---------- */
global.window = {
	setTimeout: (fn, ms) => setTimeout(fn, ms),
	clearTimeout: (id) => clearTimeout(id),
	setInterval: (fn, ms) => setInterval(fn, ms),
	clearInterval: (id) => clearInterval(id),
};

/* ---------- mock obsidian ---------- */
class TFile {
	constructor(p) {
		this.path = p;
		this.name = p.split('/').pop();
		const i = this.name.lastIndexOf('.');
		this.extension = i > 0 ? this.name.slice(i + 1) : '';
		this.basename = i > 0 ? this.name.slice(0, i) : this.name;
	}
}
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
class Notice { constructor(msg) { NOTICES.push(msg); } }
const NOTICES = [];
const MarkdownView = class { };

const mockObsidian = {
	Plugin, PluginSettingTab, Setting, ItemView, Modal, Notice, TFile, MarkdownView,
	normalizePath: (p) => String(p).replace(/\\/g, '/').replace(/^\/+|\/+$/g, ''),
};

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
	if (request === 'obsidian') return mockObsidian;
	if (request === 'electron') throw new Error('no electron');
	return origLoad.apply(this, arguments);
};

/* ---------- 临时环境 ---------- */
const root = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'elm-test-'));
const vaultDir = nodePath.join(root, 'vault');
const extDir = nodePath.join(root, 'external');
fs.mkdirSync(vaultDir, { recursive: true });
fs.mkdirSync(nodePath.join(extDir, 'sub'), { recursive: true });

const NOTE = 'note.md';
const EXT_NAME = 'elmtest-启动参数-8f3a21.txt';
const EXT_FILE = nodePath.join(extDir, EXT_NAME);
fs.writeFileSync(EXT_FILE, 'hello');

const LINK_TARGET = EXT_FILE.replace(/\//g, '\\');
const initial =
	'# 测试笔记\n\n' +
	'记住口诀："看状态 → 找标记 → 改代码"\n' +
	'[aaaa](' + LINK_TARGET + ')\n' +
	'[dead](D:\\不存在的目录\\ghost.txt)\n';
fs.writeFileSync(nodePath.join(vaultDir, NOTE), initial, 'utf8');

/* ---------- mock app ---------- */
const abs = (p) => nodePath.join(vaultDir, p);
const app = {
	vault: {
		adapter: { getBasePath: () => vaultDir },
		getMarkdownFiles: () => fs.readdirSync(vaultDir).filter((f) => f.endsWith('.md')).map((f) => new TFile(f)),
		cachedRead: async (f) => fs.readFileSync(abs(f.path), 'utf8'),
		read: async (f) => fs.readFileSync(abs(f.path), 'utf8'),
		modify: async (f, data) => { fs.writeFileSync(abs(f.path), data, 'utf8'); },
		create: async (p, data) => { const full = abs(p); fs.mkdirSync(nodePath.dirname(full), { recursive: true }); fs.writeFileSync(full, data, 'utf8'); return new TFile(p); },
		getAbstractFileByPath: (p) => (fs.existsSync(abs(p)) ? new TFile(p) : null),
		process: async (f, fn) => {
			const d = fs.readFileSync(abs(f.path), 'utf8');
			const nd = fn(d);
			if (nd !== d) fs.writeFileSync(abs(f.path), nd, 'utf8');
		},
		on: () => ({ close() { } }),
	},
	workspace: {
		onLayoutReady: () => { },
		on: () => ({ close() { } }),
		getLeavesOfType: () => [],
		getActiveViewOfType: () => null,
		getLeaf: () => ({ openFile: async () => { } }),
	},
	setting: { open() { }, openTabById() { } },
};

/* ---------- 跑测试 ---------- */
let pass = 0, fail = 0, skipped = 0;
function check(name, cond, extra) {
	if (cond) { pass++; console.log('  ✓ ' + name); }
	else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}
/** 某个能力在被测插件里不存在时，整段跳过（用于拿新测试文件验证老备份） */
function hasFeature(obj, ...names) { return names.every((n) => typeof obj[n] === 'function'); }
function skipSection(title, missing) {
	console.log('\n' + title + '  —— 跳过：被测插件没有 ' + missing + '（应该是更早的版本）');
	skipped++;
}

(async () => {
	// 默认测同仓库的插件本体；想验证某个备份（回退点）就设 ELM_PLUGIN=<那个 main.js 的路径>
	// 说明：仓库里脚本位于 dev/ 下，插件本体在上一级；本地工程里脚本在 _dev-test/ 下，
	//       本体在 obsidian-external-link-manager/ 下 —— 两种布局都自动识别。
	const pluginMain = process.env.ELM_PLUGIN || (() => {
		const beside = nodePath.join(__dirname, '..', 'main.js');
		if (fs.existsSync(beside)) return beside;
		return 'D:/proj0827/urlmonitor/obsidian-external-link-manager/main.js';
	})();
	console.log('被测插件：' + pluginMain);
	const PluginClass = require(pluginMain);
	const p = new PluginClass(app, { id: 'external-link-manager' });
	p._data = { settings: { showStatusBar: false, writeChangeLog: false } };
	await p.onload();
	p.settings.monitoredFolders = [{ path: extDir, label: 'test', recursive: true, enabled: true }];

	console.log('\n[1] 扫描：识别外部链接');
	await p.scanAll({});
	check('识别到 2 条外部链接', p.records.length === 2, '实际 ' + p.records.length);
	const r1 = p.records.find((r) => r.rawTarget.indexOf('elmtest') >= 0);
	check('存在的那条状态为 ok', r1 && r1.status === 'ok', r1 && r1.status);
	check('解析出正确 basename', r1 && r1.basename === EXT_NAME, r1 && r1.basename);
	check('识别为监控范围内', r1 && r1.monitored === true);
	const r2 = p.records.find((r) => r.rawTarget.indexOf('ghost.txt') >= 0);
	check('不存在的那条状态为 missing', r2 && r2.status === 'missing', r2 && r2.status);

	console.log('\n[2] 外部文件被移动 → 自动修复');
	const newExt = nodePath.join(extDir, 'sub', EXT_NAME);
	fs.renameSync(EXT_FILE, newExt);
	p.index = null;
	await p.scanAll({});
	const r1b = p.records.find((r) => r.rawTarget.indexOf('elmtest') >= 0);
	check('状态变为 fixable', r1b && r1b.status === 'fixable', r1b && r1b.status);
	check('候选指向新位置', r1b && r1b.candidates[0] === newExt, r1b && JSON.stringify(r1b.candidates));

	const fixed = await p.fixAllFixable({ force: true, silent: true });
	check('修复了 1 条', fixed === 1, String(fixed));
	const after = fs.readFileSync(abs(NOTE), 'utf8');
	check('笔记中的链接已改写为新路径', after.indexOf(newExt.replace(/\//g, '\\')) >= 0, after.split('\n').find((l) => l.indexOf('aaaa') >= 0));
	check('笔记其它内容未被破坏', after.indexOf('看状态 → 找标记 → 改代码') >= 0);
	check('第二行链接（丢失的）未被误改', after.indexOf('D:\\不存在的目录\\ghost.txt') >= 0);
	check('变更历史已记录', (p.settings.recentChanges || []).length >= 1);

	console.log('\n[3] 用户名变更重映射（纯函数）');
	const remapped = p.remapUserProfile('C:\\Users\\someoneelse\\Desktop\\a.txt');
	const home = os.homedir();
	check('C:\\Users\\旧名 → 当前用户目录', remapped === nodePath.join(home, 'Desktop', 'a.txt'), String(remapped));
	check('已是当前用户名时不重映射', p.remapUserProfile(nodePath.join(home, 'x.txt')) === null);

	console.log('\n[4] 手动编辑映射（改链接文本 + 改路径）');
	const r1c = p.records.find((r) => r.rawTarget.indexOf('elmtest') >= 0);
	const target2 = nodePath.join(extDir, 'sub', 'renamed.txt');
	fs.renameSync(newExt, target2);
	await p.applyEdit(r1c, '启动参数', target2, '手动改名');
	const after2 = fs.readFileSync(abs(NOTE), 'utf8');
	check('链接文本已改为「启动参数」', after2.indexOf('[启动参数](') >= 0, after2.split('\n').find((l) => l.indexOf('启动参数') >= 0));
	check('目标路径已更新', after2.indexOf('renamed.txt') >= 0);

	console.log('\n[5] 新增映射');
	await p.addLink(NOTE, '外部文档', target2);
	const after3 = fs.readFileSync(abs(NOTE), 'utf8');
	check('新链接已追加到笔记', after3.indexOf('[外部文档](') >= 0);
	await p.scanAll({});
	check('扫描后记录数增加', p.records.length === 3, String(p.records.length));

	console.log('\n[6] 删除映射（整条链接一起删掉）');
	const del = p.records.find((r) => r.linkText === '外部文档');
	const okDel = await p.removeLink(del);
	const after4 = fs.readFileSync(abs(NOTE), 'utf8');
	check('removeLink 返回成功', okDel === true);
	check('链接标记已从笔记移除', after4.indexOf('[外部文档](') < 0);
	check('显示文字也一起删掉（不留纯文本残渣）', after4.indexOf('外部文档') < 0, JSON.stringify(after4.slice(-80)));

	console.log('\n[7] 忽略 / 取消忽略');
	const r2b = p.records.find((r) => r.rawTarget.indexOf('ghost.txt') >= 0);
	p.toggleIgnore(r2b);
	await p.scanAll({});
	const r2c = p.records.find((r) => r.rawTarget.indexOf('ghost.txt') >= 0);
	check('被忽略后状态为 ignored', r2c && r2c.status === 'ignored', r2c && r2c.status);
	p.toggleIgnore(r2c);
	await p.scanAll({});
	const r2d = p.records.find((r) => r.rawTarget.indexOf('ghost.txt') >= 0);
	check('取消忽略后恢复 missing', r2d && r2d.status === 'missing', r2d && r2d.status);

	console.log('\n[8] 路径风格保持');
	fs.writeFileSync(abs('style.md'), '[f](<C:\\a b\\c.txt>)\n', 'utf8');
	await p.scanAll({});
	const rs = p.records.find((r) => r.notePath === 'style.md');
	check('含空格的 <...> 写法被正确解析', rs && rs.rawTarget === 'C:\\a b\\c.txt', rs && rs.rawTarget);
	check('wrapped 标记为 true', rs && rs.wrapped === true);

	console.log('\n[9] 库内绝对路径不误判');
	const inVault = nodePath.join(vaultDir, 'note.md').replace(/\//g, '\\');
	fs.writeFileSync(abs('inside.md'), '[x](/some/vault/path.md)\n[y](' + inVault + ')\n', 'utf8');
	await p.scanAll({});
	check('库内路径未被当作外部引用', !p.records.some((r) => r.notePath === 'inside.md'), JSON.stringify(p.records.filter((r) => r.notePath === 'inside.md')));
	check('http 链接未被当作外部引用', p.extractExternalLinks('x.md', '[a](https://example.com/a.txt)').length === 0);

	console.log('\n[10] 引号写法不兼容（引号会被当成路径的一部分，属错误写法）');
	const qdir = nodePath.join(extDir, 'file2');
	fs.mkdirSync(qdir, { recursive: true });
	const qfile = nodePath.join(qdir, 'quoted.txt');
	fs.writeFileSync(qfile, 'q');
	fs.writeFileSync(abs('quote.md'),
		'[aa1](' + qfile + ')\n' +
		'[aa2]("' + qfile + '")\n' +
		"[aa3]('" + qfile + "')\n" +
		'[aa4](<' + qfile + '>)\n', 'utf8');
	await p.scanAll({});
	const qrecs = p.records.filter((r) => r.notePath === 'quote.md');
	check('只识别裸路径 + 尖括号两条，引号写法被忽略',
		qrecs.length === 2, qrecs.length + ' 条: ' + JSON.stringify(qrecs.map((r) => r.linkText)));
	check('识别到的是 aa1 和 aa4',
		qrecs.some((r) => r.linkText === 'aa1') && qrecs.some((r) => r.linkText === 'aa4'),
		JSON.stringify(qrecs.map((r) => r.linkText)));
	check('尖括号写法解析出的路径不含尖括号',
		qrecs.find((r) => r.linkText === 'aa4').absolutePath === qfile,
		qrecs.find((r) => r.linkText === 'aa4').absolutePath);

	// 移动目标 → 修复后应保持各自原有写法
	const qdir2 = nodePath.join(extDir, 'file2b');
	fs.mkdirSync(qdir2, { recursive: true });
	const qfile2 = nodePath.join(qdir2, 'quoted.txt');
	fs.renameSync(qfile, qfile2);
	p.settings.indexCache = {};
	await p.scanAll({});
	await p.fixAllFixable({ force: true, silent: true });
	const qAfter = fs.readFileSync(abs('quote.md'), 'utf8');
	check('尖括号写法在修复后仍保持尖括号', qAfter.indexOf('[aa4](<' + qfile2 + '>)') >= 0, qAfter.split('\n').find((l) => l.indexOf('aa4') >= 0));
	check('裸路径写法在修复后仍是裸路径', qAfter.indexOf('[aa1](' + qfile2 + ')') >= 0, qAfter.split('\n').find((l) => l.indexOf('aa1') >= 0));
	check('被忽略的引号那两行原样未动',
		qAfter.indexOf('[aa2]("' + qfile + '")') >= 0 && qAfter.indexOf("[aa3]('" + qfile + "')") >= 0,
		JSON.stringify(qAfter));

	console.log('\n[11] 删除整条链接');
	fs.writeFileSync(abs('del1.md'), '前一行\n\n[整行链接](' + qfile2 + ')\n\n后一行\n', 'utf8');
	await p.scanAll({});
	const d1 = p.records.find((r) => r.notePath === 'del1.md');
	await p.removeLink(d1);
	const d1After = fs.readFileSync(abs('del1.md'), 'utf8');
	check('独占一行的链接：整行被删掉', d1After.indexOf('整行链接') < 0 && d1After.indexOf(qfile2) < 0, JSON.stringify(d1After));
	check('前后内容保持不变', d1After.indexOf('前一行') >= 0 && d1After.indexOf('后一行') >= 0);
	check('没有产生多余空行', d1After === '前一行\n\n后一行\n', JSON.stringify(d1After));

	fs.writeFileSync(abs('del2.md'), '文字A [行内链接](' + qfile2 + ') 文字B\n', 'utf8');
	await p.scanAll({});
	const d2 = p.records.find((r) => r.notePath === 'del2.md');
	await p.removeLink(d2);
	const d2After = fs.readFileSync(abs('del2.md'), 'utf8');
	check('行内链接：只摘掉链接，保留同行文字', d2After === '文字A 文字B\n', JSON.stringify(d2After));

	//   v1.1.2  UTF-16 LE + BOM + tab 分列（首行是表头，无 sep 指令）
	//   v1.1.1  UTF-16 LE + BOM + 逗号分隔（表头直接首行，不加 sep 指令）
	//   v1.2.2  UTF-16 LE + BOM + 首行 `sep=<tab>` + tab 分隔
	//   v1.2.3  UTF-16 LE + BOM + 首行 `sep=,` + 英文逗号分隔
	//   v1.0.0  UTF-8 + BOM + 逗号分隔（无 sep 行）
	const HEAD_COMMA = '状态,笔记,行号,链接文本,目标路径,类型,范围,命中监控文件夹,推荐候选,说明';
	const HEAD_TAB = HEAD_COMMA.split(',').join('\t');
	console.log('\n[12] CSV 编码及直接分列（UTF-16 LE + Tab；兼容历史版本）');
	await p.exportCsv();
	const csvName = fs.readdirSync(vaultDir).find((f) => f.startsWith('外部引用报告') && f.endsWith('.csv'));
	check('CSV 文件已生成', !!csvName, String(csvName));
	if (csvName) {
		const buf = fs.readFileSync(nodePath.join(vaultDir, csvName));
		const isUtf16 = buf[0] === 0xff && buf[1] === 0xfe;
		const isUtf8 = buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
		check('文件带 BOM（UTF-16 LE 或 UTF-8）', isUtf16 || isUtf8,
			[buf[0], buf[1], buf[2]].map((b) => b.toString(16)).join(' '));
		const txt = (isUtf16 ? buf.toString('utf16le') : buf.toString('utf8')).replace(/^\ufeff/, '');
		const lines = txt.split('\r\n');
		if (lines[0] === 'sep=,' || lines[0] === 'sep=\t') {
			check('识别历史 Excel sep 指令', true, JSON.stringify(lines[0]));
			const expectHead = lines[0] === 'sep=,' ? HEAD_COMMA : HEAD_TAB;
			check('sep 指令后的表头正确', lines[1] === expectHead, JSON.stringify(lines[1]));
			check('数据行存在', lines.length >= 3, String(lines.length));
		} else if (lines[0] === HEAD_TAB) {
			check('表头直接在首行，无额外 sep= 行', true, JSON.stringify(lines[0]));
			check('表头按 Tab 分成 10 列', lines[0].split('\t').length === 10, String(lines[0].split('\t').length));
			check('数据行存在且按 Tab 分列', lines.length >= 2 && lines[1].split('\t').length === 10, lines[1] && String(lines[1].split('\t').length));
			check('新导出使用 UTF-16 LE BOM（Excel/WPS 中文编码）', isUtf16, [buf[0], buf[1]].map((b) => b.toString(16)).join(' '));
		} else {
			check('旧版逗号表头中文正常（不是乱码）', lines[0] === HEAD_COMMA, JSON.stringify(lines[0]));
			check('旧版数据行存在', lines.length >= 2, String(lines.length));
			if (isUtf16 && lines[0] === HEAD_COMMA) {
				check('旧版 UTF-16 表头无额外 sep 指令', true, JSON.stringify(lines[0]));
				check('旧版字段仍含英文逗号', lines[1].indexOf(',') >= 0, JSON.stringify(lines[1]));
			}
		}
		check('使用 CRLF 换行', txt.indexOf('\r\n') > 0);
	}

	console.log('\n[13] 改名匹配（file1 → file11 这类）');
	const oldDir = nodePath.join(extDir, 'olddir');
	fs.mkdirSync(oldDir, { recursive: true });
	fs.writeFileSync(abs('rename.md'), '[r1](' + oldDir + ')\n', 'utf8');
	await p.scanAll({});
	const r0 = p.records.find((r) => r.notePath === 'rename.md');
	check('改名前的文件夹链接为正常', r0 && r0.status === 'ok', r0 && r0.status);
	check('类型识别为文件夹', r0 && r0.kind === 'folder', r0 && r0.kind);

	const newDir = nodePath.join(extDir, 'olddir2');
	fs.renameSync(oldDir, newDir);
	p.settings.indexCache = {};
	await p.scanAll({});
	const r1r = p.records.find((r) => r.notePath === 'rename.md');
	check('改名后状态为可修复', r1r && r1r.status === 'fixable', r1r && r1r.status);
	check('候选指向改名后的文件夹', r1r && r1r.candidates[0] === newDir, r1r && JSON.stringify(r1r.candidates));
	check('说明里写明是疑似改名', r1r && /疑似改名/.test(r1r.reason), r1r && r1r.reason);
	await p.fixAllFixable({ force: true, silent: true });
	const rAfter = fs.readFileSync(abs('rename.md'), 'utf8');
	check('链接已更新到新文件夹名', rAfter.indexOf(newDir) >= 0, JSON.stringify(rAfter));

	// 名称差太远的不能被误判
	const farDir = nodePath.join(extDir, 'completely-unrelated-name');
	fs.mkdirSync(farDir, { recursive: true });
	fs.writeFileSync(abs('nomatch.md'), '[n1](' + nodePath.join(extDir, 'zzz-nothing-like-it') + ')\n', 'utf8');
	await p.scanAll({});
	const nm = p.records.find((r) => r.notePath === 'nomatch.md');
	check('名称不相似时不会硬凑候选', nm && nm.status === 'missing', nm && nm.status + ' / ' + (nm && nm.reason));

	console.log('\n[14] 内容指纹：文件被改名（名字完全对不上）也能认出来');
	const dirA = nodePath.join(extDir, 'rename-a');
	fs.mkdirSync(dirA, { recursive: true });
	const fileA = nodePath.join(dirA, '报告.txt');
	fs.writeFileSync(fileA, 'UNIQUE-CONTENT-FOR-ELM-TEST-14\n'.repeat(20));
	fs.writeFileSync(abs('fp1.md'), '[f1](' + fileA + ')\n', 'utf8');
	await p.scanAll({});
	const f1 = p.records.find((r) => r.notePath === 'fp1.md');
	check('首次扫描状态为正常', f1 && f1.status === 'ok', f1 && f1.status);
	check('已为该文件记录内容指纹',
		!!(p.settings.fileIndex || {})[fileA.toLowerCase()], JSON.stringify(Object.keys(p.settings.fileIndex || {})));

	// 改名成完全不相干的名字（首字符都变了 → 名称相似度帮不上忙）
	const fileA2 = nodePath.join(dirA, 'zzz-新名字-完全无关.dat');
	fs.renameSync(fileA, fileA2);
	await p.scanAll({});
	const f1b = p.records.find((r) => r.notePath === 'fp1.md');
	check('改名后状态为可修复', f1b && f1b.status === 'fixable', f1b && f1b.status);
	check('候选正是改名后的文件', f1b && f1b.candidates[0] === fileA2, f1b && JSON.stringify(f1b.candidates));
	check('理由写明是指纹一致', f1b && /指纹/.test(f1b.reason), f1b && f1b.reason);
	check('置信度为 1.0', f1b && f1b.candidateInfo[0].score === 1, f1b && JSON.stringify(f1b.candidateInfo));
	await p.fixAllFixable({ force: true, silent: true });
	const fpAfter = fs.readFileSync(abs('fp1.md'), 'utf8');
	check('笔记里的链接已改到新名字', fpAfter.indexOf(fileA2) >= 0, JSON.stringify(fpAfter));

	console.log('\n[15] 无指纹时靠名称相似识别文件改名');
	const dirB = nodePath.join(extDir, 'rename-b');
	fs.mkdirSync(dirB, { recursive: true });
	const fileB = nodePath.join(dirB, 'abc123.txt');
	fs.writeFileSync(fileB, 'b');
	const fileB2 = nodePath.join(dirB, 'abc1234.txt');
	fs.renameSync(fileB, fileB2);   // 先改名，插件从未见过旧名字
	p.settings.fileIndex = {};
	fs.writeFileSync(abs('fp2.md'), '[f2](' + fileB + ')\n', 'utf8');
	await p.scanAll({});
	const f2 = p.records.find((r) => r.notePath === 'fp2.md');
	check('靠名称相似找到改名后的文件', f2 && f2.status === 'fixable', f2 && f2.status);
	check('候选指向 abc1234.txt', f2 && f2.candidates[0] === fileB2, f2 && JSON.stringify(f2.candidates));
	check('理由写明名称相似', f2 && /名称相似/.test(f2.reason), f2 && f2.reason);

	console.log('\n[16] 推荐列表数据结构');
	check('candidateInfo 与 candidates 长度一致',
		f2 && f2.candidateInfo.length === f2.candidates.length,
		f2 && JSON.stringify(f2.candidateInfo));
	check('每条候选都有 path/score/reason',
		f2 && f2.candidateInfo.every((c) => c.path && typeof c.score === 'number' && c.reason),
		f2 && JSON.stringify(f2.candidateInfo));
	check('候选按置信度降序',
		f2 && f2.candidateInfo.every((c, i, a) => i === 0 || a[i - 1].score >= c.score));

	console.log('\n[17] 内容指纹不会被无关文件误匹配');
	const dirC = nodePath.join(extDir, 'rename-c');
	fs.mkdirSync(dirC, { recursive: true });
	const fileC = nodePath.join(dirC, 'same-size.txt');
	fs.writeFileSync(fileC, 'A'.repeat(100));
	fs.writeFileSync(abs('fp3.md'), '[f3](' + fileC + ')\n', 'utf8');
	await p.scanAll({});
	const f3 = p.records.find((r) => r.notePath === 'fp3.md');
	check('指纹已记录', !!(p.settings.fileIndex || {})[fileC.toLowerCase()]);
	// 同名同大小但内容不同 → 不应该被当成候选
	fs.renameSync(fileC, nodePath.join(dirC, 'moved-away.txt'));
	fs.writeFileSync(fileC, 'B'.repeat(100));
	await p.scanAll({});
	const f3b = p.records.find((r) => r.notePath === 'fp3.md');
	check('同名但内容不同，不会被指纹误判为同一个文件',
		f3b && !(f3b.candidateInfo || []).some((c) => /指纹/.test(c.reason) && c.path === fileC),
		f3b && JSON.stringify(f3b.candidateInfo));

	console.log('\n[18] 范围只有「监控文件夹」（额外搜索目录已移除）');
	check('搜索范围里不含用户主目录',
		p.getSearchRoots().every((r) => r.toLowerCase() !== os.homedir().toLowerCase()),
		JSON.stringify(p.getSearchRoots()));
	check('主目录下的路径不算在搜索范围内',
		p.isInSearchScope(nodePath.join(os.homedir(), 'Desktop', 'x.txt')) === false);
	check('监控文件夹内的路径算在搜索范围内', p.isInSearchScope(extDir) === true);

	const outsideDir = nodePath.join(root, 'outside');   // 与 extDir 同级，但没有被监控
	fs.mkdirSync(outsideDir, { recursive: true });
	const sharedName = 'elmtest-scope-9c21.txt';
	const outsideFile = nodePath.join(outsideDir, sharedName);
	fs.writeFileSync(outsideFile, 'scope-check-content');
	const insideFile = nodePath.join(extDir, 'sub', sharedName);
	fs.writeFileSync(insideFile, 'scope-check-content');   // 同名 + 同内容，指纹也会命中
	// 链接指向一个不存在的路径，逼插件去搜索
	fs.writeFileSync(abs('scope.md'),
		'[s](' + nodePath.join(extDir, 'sub2', sharedName) + ')\n', 'utf8');
	await p.scanAll({});
	const rsScope = p.records.find((r) => r.notePath === 'scope.md');
	check('范围外的同名同内容文件没有出现在推荐里',
		rsScope && !(rsScope.candidateInfo || []).some((c) => c.path.toLowerCase().startsWith(outsideDir.toLowerCase())),
		rsScope && JSON.stringify(rsScope.candidateInfo));
	check('候选全部落在监控文件夹内',
		rsScope && (rsScope.candidateInfo || []).length > 0 &&
		rsScope.candidateInfo.every((c) => c.path.toLowerCase().startsWith(extDir.toLowerCase())),
		rsScope && JSON.stringify(rsScope.candidateInfo));
	check('范围内那份被找到', rsScope && rsScope.candidates.includes(insideFile), rsScope && JSON.stringify(rsScope.candidates));

	// 只有一个范围：监控文件夹。「额外搜索目录」已按用户要求整体移除。
	check('设置里不再有 extraSearchRoots', !('extraSearchRoots' in p.settings), Object.keys(p.settings).join(','));
	check('搜索范围 = 监控文件夹，没有任何额外目录',
		p.getSearchRoots().length === 1 && p.getSearchRoots()[0] === extDir,
		JSON.stringify(p.getSearchRoots()));
	check('监控文件夹外的路径不在搜索范围内', p.isInSearchScope(outsideFile) === false);
	check('监控文件夹外的路径不算「范围内」', p.isUnderMonitored(outsideFile) === false);
	check('监控文件夹里的路径算「范围内」', p.isUnderMonitored(insideFile) === true);
	check('命中的监控文件夹能被识别出来', (p.matchedMonitoredFolder(insideFile) || {}).path === extDir,
		JSON.stringify(p.matchedMonitoredFolder(insideFile)));
	check('监控文件夹外的路径没有命中任何监控文件夹', p.matchedMonitoredFolder(outsideFile) === null);
	// 「范围外」的定义：扫描仓库时，笔记里有外部链接，但目标不在任何监控文件夹内
	fs.writeFileSync(abs('scope2.md'), '[s](' + outsideFile + ')\n', 'utf8');
	await p.scanAll({});
	const rsOut = p.records.find((r) => r.notePath === 'scope2.md');
	check('笔记里指向监控文件夹外的链接被标成「范围外」', rsOut && rsOut.monitored === false,
		rsOut && String(rsOut.monitored));
	check('指向监控文件夹内的链接被标成「范围内」',
		(p.records.find((r) => r.notePath === 'scope.md') || {}).monitored === true);
	check('范围外的链接不会去监控文件夹外找候选',
		rsOut && (rsOut.candidateInfo || []).every((c) => c.path.toLowerCase().startsWith(extDir.toLowerCase())),
		rsOut && JSON.stringify(rsOut.candidateInfo));

	console.log('\n[19] 旧版遗留的目录缓存被清理');
	const p2 = new PluginClass(app, { id: 'external-link-manager' });
	p2._data = {
		settings: {
			showStatusBar: false, writeChangeLog: false,
			alsoSearchUserProfile: true,
			extraSearchRoots: ['C:\\legacy-extra', 'D:\\legacy-extra2'],
			indexCache: { '@dirs': ['C:\\a', 'C:\\b'], 'x.txt': new Array(200).fill('C:\\x\\x.txt') },
		},
	};
	await p2.loadSettings();
	check('@dirs 已被删除', !('@dirs' in p2.settings.indexCache), JSON.stringify(Object.keys(p2.settings.indexCache)));
	check('超长缓存被截断到 50', (p2.settings.indexCache['x.txt'] || []).length === 50,
		String((p2.settings.indexCache['x.txt'] || []).length));
	check('alsoSearchUserProfile 已被移除', !('alsoSearchUserProfile' in p2.settings));
	check('extraSearchRoots 已被移除', !('extraSearchRoots' in p2.settings),
		JSON.stringify(Object.keys(p2.settings)));

	console.log('\n[20] 外部变动走轻量核对：不重读任何笔记');
	let reads = 0;
	const origCachedRead = app.vault.cachedRead;
	app.vault.cachedRead = async (f) => { reads++; return origCachedRead(f); };
	// 把文件挪到链接指向的位置（模拟「用户在外部把文件放回来了」）
	const linkTarget = nodePath.join(extDir, 'sub2', sharedName);
	fs.mkdirSync(nodePath.join(extDir, 'sub2'), { recursive: true });
	fs.renameSync(insideFile, linkTarget);
	reads = 0;
	await p.recheckExternal({ folders: [extDir], changed: sharedName });
	check('核对过程没有重新读取任何笔记', reads === 0, '实际读取 ' + reads + ' 次');
	const rsScope2 = p.records.find((r) => r.notePath === 'scope.md');
	check('核对后状态变为正常', rsScope2 && rsScope2.status === 'ok', rsScope2 && rsScope2.status);
	check('陈旧的候选已被清空', rsScope2 && (rsScope2.candidateInfo || []).length === 0,
		rsScope2 && JSON.stringify(rsScope2.candidateInfo));
	app.vault.cachedRead = origCachedRead;

	console.log('\n[21] 无锁事件队列：watcher 只入队，一批合并成一次核对');
	p.extQueue = [];
	let drained = 0;
	const origRecheck = p.recheckExternal.bind(p);
	p.recheckExternal = async (o) => { drained++; return origRecheck(o); };
	// 模拟 20 次 watcher 回调（回调本身只 push，不做任何文件操作）
	for (let i = 0; i < 20; i++) p.extQueue.push({ folder: extDir, name: 'e' + i + '.txt', at: Date.now() });
	check('20 条事件都进了队列（没被丢弃）', p.extQueue.length === 20, String(p.extQueue.length));
	await p.drainExternal();
	check('一批事件合并成 1 次核对', drained === 1, String(drained));
	check('队列已排空', p.extQueue.length === 0, String(p.extQueue.length));
	// 处理期间又来的事件不会被吞掉
	drained = 0;
	const slow = p.recheckExternal;
	p.recheckExternal = async (o) => { drained++; await new Promise((r) => setTimeout(r, 30)); return slow(o); };
	const p1 = p.drainExternal();
	p.extQueue.push({ folder: extDir, name: 'late.txt', at: Date.now() });
	await p1;
	await p.drainExternal();
	check('处理中新增的事件也会被处理（不丢）', drained === 2, String(drained));
	p.recheckExternal = origRecheck;

	console.log('\n[22] 限流落盘：短时间多次请求只写一次');
	await p.flushSettings();   // 先把前面攒着的落盘清掉，避免干扰计数
	let writes = 0;
	const origSave = p.saveSettings.bind(p);
	p.saveSettings = async () => { writes++; return origSave(); };
	p.saveSettingsSoon(50);
	p.saveSettingsSoon(50);
	p.saveSettingsSoon(50);
	await new Promise((r) => setTimeout(r, 150));
	check('3 次落盘请求被合并为 1 次', writes === 1, String(writes));
	p.saveSettings = origSave;

	console.log('\n[23] 变动核对不会扩散到其它监控文件夹');
	const extDir2 = nodePath.join(root, 'external2');
	fs.mkdirSync(nodePath.join(extDir2, 'sub'), { recursive: true });
	const twinName = 'elmtest-twin-77aa.txt';
	const twinIn2 = nodePath.join(extDir2, 'sub', twinName);
	fs.writeFileSync(twinIn2, 'twin-content');
	fs.writeFileSync(abs('twin.md'), '[t](' + nodePath.join(extDir, 'gone', twinName) + ')\n', 'utf8');
	p.settings.monitoredFolders = [
		{ path: extDir, label: 'a', recursive: true, enabled: true },
		{ path: extDir2, label: 'b', recursive: true, enabled: true },
	];
	await p.scanAll({});
	const twinRec = p.records.find((r) => r.notePath === 'twin.md');
	check('全量扫描时能找到另一个监控目录里的同名文件',
		twinRec && twinRec.candidates.includes(twinIn2), twinRec && JSON.stringify(twinRec.candidates));
	// 现在只有 extDir 发生变动 —— 核对时不应该去翻 extDir2
	await p.recheckExternal({ folders: [extDir] });
	const twinRec2 = p.records.find((r) => r.notePath === 'twin.md');
	check('变动核对时不会扩散到另一个监控目录',
		twinRec2 && !twinRec2.candidates.includes(twinIn2), twinRec2 && JSON.stringify(twinRec2.candidates));

	console.log('\n[24] 自动检测只标「待确认」，绝不自动改笔记');
	const autoDir = nodePath.join(root, 'auto');
	fs.mkdirSync(nodePath.join(autoDir, 'sub'), { recursive: true });
	const autoName = 'elmtest-auto-31bd.txt';
	const autoFile = nodePath.join(autoDir, 'sub', autoName);
	fs.writeFileSync(autoFile, 'auto-content-唯一内容');
	fs.writeFileSync(abs('auto.md'), '[a](' + autoFile + ')\n', 'utf8');
	p.settings.monitoredFolders = [{ path: autoDir, label: 'auto', recursive: true, enabled: true }];
	p.settings.requireConfirmBeforeAutoFix = true;
	p.settings.autoFixOnExternalChange = true;
	await p.scanAll({ fix: true });
	let autoRec = p.records.find((r) => r.notePath === 'auto.md');
	check('首次扫描状态为正常', autoRec && autoRec.status === 'ok', autoRec && autoRec.status);

	// 外部把文件改名（内容没变 → 靠指纹能认出来）
	const autoMoved = nodePath.join(autoDir, 'sub', 'elmtest-auto-31bd-改过名.txt');
	fs.renameSync(autoFile, autoMoved);
	const noteBefore = fs.readFileSync(abs('auto.md'), 'utf8');
	await p.recheckExternal({ folders: [autoDir] });
	autoRec = p.records.find((r) => r.notePath === 'auto.md');
	check('外部改名后状态为「待确认」', autoRec && autoRec.status === 'pending', autoRec && autoRec.status);
	check('笔记内容一个字都没被自动改动',
		fs.readFileSync(abs('auto.md'), 'utf8') === noteBefore, fs.readFileSync(abs('auto.md'), 'utf8').trim());
	check('待确认项里带着推荐位置',
		autoRec && autoRec.candidateInfo.length && autoRec.candidateInfo[0].path === autoMoved,
		autoRec && JSON.stringify(autoRec.candidateInfo));
	check('countPending 能数出来', p.countPending() >= 1, String(p.countPending()));

	// 用户点「确认」
	const confirmed = await p.confirmPending({ silent: true });
	check('确认后写回笔记', confirmed === 1, String(confirmed));
	check('笔记里的链接已指向改名后的文件',
		fs.readFileSync(abs('auto.md'), 'utf8').indexOf('elmtest-auto-31bd-改过名.txt') >= 0,
		fs.readFileSync(abs('auto.md'), 'utf8').trim());
	check('确认后不再有待确认项', p.countPending() === 0, String(p.countPending()));

	console.log('\n[25] 关掉「需要确认」后恢复自动改写');
	p.settings.requireConfirmBeforeAutoFix = false;
	const bName = 'elmtest-b-55ee.txt';
	const bFile = nodePath.join(autoDir, 'sub', bName);
	fs.writeFileSync(bFile, 'b-content-唯一内容');
	fs.writeFileSync(abs('b.md'), '[b](' + bFile + ')\n', 'utf8');
	await p.scanAll({ fix: true });
	const bMoved = nodePath.join(autoDir, 'sub', 'elmtest-b-55ee-改过名.txt');
	fs.renameSync(bFile, bMoved);
	await p.recheckExternal({ folders: [autoDir] });
	check('关闭确认后自动改写直接生效',
		fs.readFileSync(abs('b.md'), 'utf8').indexOf('elmtest-b-55ee-改过名.txt') >= 0,
		fs.readFileSync(abs('b.md'), 'utf8').trim());

	console.log('\n[26] 链接匹配规则可配置');
	// 用新测试文件去验证老备份时，老版本没有这套 API → 整段跳过而不是报失败
	ruleSection: {
	if (!hasFeature(p, 'getLinkRegex', 'resetLinkRegex', 'extractExternalLinks')) {
		skipSection('[26] 链接匹配规则可配置', 'getLinkRegex / resetLinkRegex');
		break ruleSection;
	}
	const ruleDir = nodePath.join(root, 'rule');
	fs.mkdirSync(ruleDir, { recursive: true });
	p.settings.monitoredFolders = [{ path: ruleDir, label: 'rule', recursive: true, enabled: true }];
	const rulePlain = nodePath.join(ruleDir, 'elmtest-rule-plain-7a1c.txt');
	const ruleEmbed = nodePath.join(ruleDir, 'elmtest-rule-embed-7a1c.png');
	fs.writeFileSync(rulePlain, 'plain');
	fs.writeFileSync(ruleEmbed, 'embed');
	fs.writeFileSync(abs('rule.md'),
		'[普通](' + rulePlain + ')\n![嵌入](' + ruleEmbed + ')\n', 'utf8');

	// 默认规则：两种都认
	check('默认规则已写入设置', typeof p.settings.linkPattern === 'string' && p.settings.linkPattern.length > 0,
		p.settings.linkPattern);
	await p.scanAll({});
	let ruleRecs = p.records.filter((r) => r.notePath === 'rule.md');
	check('默认规则认得 [文字](路径) 与 ![文字](路径)', ruleRecs.length === 2, String(ruleRecs.length));

	// 换成「只认嵌入」的规则（3 组：! / 文字 / 路径）
	p.settings.linkPattern = '(!)\\[([^\\]\\n]*)\\]\\(([^)\\n]+)\\)';
	p.settings.linkFlags = 'g';
	p.resetLinkRegex();
	await p.scanAll({});
	ruleRecs = p.records.filter((r) => r.notePath === 'rule.md');
	check('自定义规则真的生效：只认出嵌入那一条',
		ruleRecs.length === 1 && ruleRecs[0].isEmbed === true,
		JSON.stringify(ruleRecs.map((r) => [r.linkText, r.isEmbed])));
	check('自定义规则下目标路径解析正确',
		ruleRecs.length === 1 && ruleRecs[0].absolutePath === ruleEmbed,
		ruleRecs[0] && ruleRecs[0].absolutePath);

	// 命名捕获组：顺序调换也能正确取到 target
	p.settings.linkPattern = '\\((?<target>[^)\\n]+)\\)\\[(?<text>[^\\]\\n]*)\\]';
	p.resetLinkRegex();
	check('命名捕获组可以脱离「第 3 组」的位置约定',
		p.extractExternalLinks('x.md', '(' + rulePlain + ')[反着写]').length === 1,
		JSON.stringify(p.extractExternalLinks('x.md', '(' + rulePlain + ')[反着写]').map((r) => r.absolutePath)));
	check('命名捕获组取到的目标路径正确',
		(p.extractExternalLinks('x.md', '(' + rulePlain + ')[反着写]')[0] || {}).absolutePath === rulePlain);
	check('命名捕获组取到的链接文字正确',
		(p.extractExternalLinks('x.md', '(' + rulePlain + ')[反着写]')[0] || {}).linkText === '反着写');

	// 规则写坏了：不能崩，退回默认规则，并记下错误
	p.settings.linkPattern = '([a-z';
	p.resetLinkRegex();
	let brokeThrew = false;
	let brokeLinks = [];
	try { brokeLinks = p.extractExternalLinks('x.md', '[a](' + rulePlain + ')'); }
	catch (e) { brokeThrew = true; }
	check('规则编译失败不会抛异常', brokeThrew === false, brokeThrew ? '抛异常了' : '');
	check('规则失败时退回默认规则继续工作', brokeLinks.length === 1 && brokeLinks[0].absolutePath === rulePlain,
		JSON.stringify(brokeLinks.map((r) => r.absolutePath)));
	check('规则失败时会记下错误信息', !!p.linkPatternError, p.linkPatternError);

	// 病态规则（能匹配空串）不能死循环
	p.settings.linkPattern = '.*';
	p.resetLinkRegex();
	let hangGuard = 'done';
	const t0 = Date.now();
	try { p.extractExternalLinks('x.md', 'abc\ndef\n'); }
	catch (e) { hangGuard = 'threw:' + e.message; }
	check('匹配空串的规则不会死循环', hangGuard === 'done' && Date.now() - t0 < 3000,
		hangGuard + ' / ' + (Date.now() - t0) + 'ms');

	// 标志归一化：非法字符被剔除、g 自动补上
	p.settings.linkPattern = '(!?)\\[([^\\]\\n]*)\\]\\(([^)\\n]+)\\)';
	p.settings.linkFlags = 'xx';
	p.resetLinkRegex();
	check('标志里的非法字符被剔除、g 被自动补上', p.getLinkRegex().flags === 'g', p.getLinkRegex().flags);
	check('非法标志下仍能全局匹配（g 被补上）',
		p.extractExternalLinks('x.md', '[a](' + rulePlain + ')\n[b](' + ruleEmbed + ')\n').length === 2,
		String(p.extractExternalLinks('x.md', '[a](' + rulePlain + ')\n[b](' + ruleEmbed + ')\n').length));

	// 恢复默认
	p.settings.linkPattern = '(!?)\\[([^\\]\\n]*)\\]\\(([^)\\n]+)\\)';
	p.settings.linkFlags = 'g';
	p.resetLinkRegex();
	check('恢复默认后 linkPatternError 被清空', p.linkPatternError === '', p.linkPatternError);
	await p.scanAll({});
	ruleRecs = p.records.filter((r) => r.notePath === 'rule.md');
	check('恢复默认后又能认出两条', ruleRecs.length === 2, String(ruleRecs.length));
	} /* end ruleSection */

	console.log('\n[27] 指纹命中时，名称相似（模糊）匹配也照样参与');
	fuzzySection: {
	if (!('alwaysFuzzyMatch' in p.settings)) {
		skipSection('[27] 指纹命中时，模糊匹配也参与', 'alwaysFuzzyMatch 设置');
		break fuzzySection;
	}
	const fzDir = nodePath.join(root, 'fuzzy');
	fs.mkdirSync(fzDir, { recursive: true });
	p.settings.monitoredFolders = [{ path: fzDir, label: 'fuzzy', recursive: true, enabled: true }];
	p.settings.alwaysFuzzyMatch = true;
	p.settings.detectByContent = true;

	const FZ_CONTENT = 'elmtest-fuzzy-content-唯一-4f7b';
	const fzOrig = nodePath.join(fzDir, 'elmtest-fz-orig.txt');
	fs.writeFileSync(fzOrig, FZ_CONTENT);
	fs.writeFileSync(abs('fuzzy.md'), '[f](' + fzOrig + ')\n', 'utf8');
	await p.scanAll({});
	check('原文件指纹已记录', !!(p.settings.fileIndex || {})[fzOrig.toLowerCase()],
		String(Object.keys(p.settings.fileIndex || {}).length) + ' 条');

	// 场景：文件被改名**并且**内容也改了（指纹认不出它），
	//       同时目录里冒出一个「内容与原文件相同」的副本（指纹会命中这个副本）。
	const fzRenamed = nodePath.join(fzDir, 'elmtest-fz-orig1.txt');
	fs.renameSync(fzOrig, fzRenamed);
	fs.writeFileSync(fzRenamed, 'CHANGED-CONTENT-已经改过内容了');
	const fzCopy = nodePath.join(fzDir, 'elmtest-fz-copy.txt');
	fs.writeFileSync(fzCopy, FZ_CONTENT);

	await p.scanAll({});
	let fzRec = p.records.find((r) => r.notePath === 'fuzzy.md');
	check('指纹命中了那个内容相同的副本',
		fzRec && (fzRec.candidateInfo || []).some((c) => c.path === fzCopy && /指纹/.test(c.reason)),
		fzRec && JSON.stringify(fzRec.candidateInfo));
	check('指纹命中时，真正被改名的文件也出现在推荐列表里',
		fzRec && (fzRec.candidateInfo || []).some((c) => c.path === fzRenamed),
		fzRec && JSON.stringify(fzRec.candidateInfo));
	check('指纹候选（1.00）严格高于名称相似候选（≤ 0.99），不会并列',
		fzRec && (fzRec.candidateInfo || []).length >= 2 &&
		fzRec.candidateInfo[0].score === 1 &&
		fzRec.candidateInfo[0].score > fzRec.candidateInfo[1].score,
		fzRec && JSON.stringify(fzRec.candidateInfo.map((c) => [c.score, c.reason])));
	check('最高分唯一 → 仍然可以自动修复（没有被模糊候选拖成歧义）',
		fzRec && fzRec.status === 'fixable', fzRec && fzRec.status);

	// 关掉开关 → 回到「指纹命中就不跑名称相似」的省成本模式
	p.settings.alwaysFuzzyMatch = false;
	await p.scanAll({});
	fzRec = p.records.find((r) => r.notePath === 'fuzzy.md');
	check('关掉 alwaysFuzzyMatch 后名称相似候选不再出现',
		fzRec && !(fzRec.candidateInfo || []).some((c) => c.path === fzRenamed),
		fzRec && JSON.stringify(fzRec.candidateInfo));
	check('关掉后指纹候选仍然保留',
		fzRec && (fzRec.candidateInfo || []).some((c) => c.path === fzCopy),
		fzRec && JSON.stringify(fzRec.candidateInfo));

	// 再验证「关掉指纹」时模糊匹配照样能兜住（用户原问题的另一半）
	p.settings.alwaysFuzzyMatch = true;
	p.settings.detectByContent = false;
	await p.scanAll({});
	fzRec = p.records.find((r) => r.notePath === 'fuzzy.md');
	check('关掉指纹后，模糊匹配仍能找到被改名的文件',
		fzRec && (fzRec.candidateInfo || []).some((c) => c.path === fzRenamed),
		fzRec && JSON.stringify(fzRec.candidateInfo));
	check('关掉指纹后不会再有指纹候选',
		fzRec && !(fzRec.candidateInfo || []).some((c) => /指纹/.test(c.reason)),
		fzRec && JSON.stringify(fzRec.candidateInfo));
	p.settings.detectByContent = true;
	} /* end fuzzySection */

	dragSection: {
	const T = PluginClass.__test;
	if (!T || typeof T.pathsFromDrop !== 'function' || typeof T.attachPathDrop !== 'function') {
		skipSection('[28] 从系统拖文件/文件夹到路径输入框', '__test.pathsFromDrop / __test.attachPathDrop');
		break dragSection;
	}
	console.log('\n[28] 从系统拖文件/文件夹到路径输入框');

	// 1) 路径解析
	check('从 dataTransfer.files 里取到路径（老 Electron 的 file.path）',
		JSON.stringify(T.pathsFromDrop({ files: [{ path: 'D:\\资料\\报告.pdf' }] })) === JSON.stringify(['D:\\资料\\报告.pdf']),
		JSON.stringify(T.pathsFromDrop({ files: [{ path: 'D:\\资料\\报告.pdf' }] })));
	check('同一路径拖两次只算一次（去重）',
		T.pathsFromDrop({ files: [{ path: 'D:\\a.txt' }, { path: 'd:\\A.TXT' }] }).length === 1);
	check('files 为空时兜底解析 text/uri-list 的 file:// URL（Windows 盘符）',
		JSON.stringify(T.pathsFromDrop({
			files: [], getData: (t) => (t === 'text/uri-list' ? 'file:///D:/a/b%20c.txt' : ''),
		})) === JSON.stringify(['D:\\a\\b c.txt']),
		JSON.stringify(T.pathsFromDrop({
			files: [], getData: (t) => (t === 'text/uri-list' ? 'file:///D:/a/b%20c.txt' : ''),
		})));
	check('没有 dataTransfer 时返回空数组，不抛异常',
		Array.isArray(T.pathsFromDrop(null)) && T.pathsFromDrop(null).length === 0);
	check('拖进来但拿不到路径（如拖的是网页文字）时返回空数组',
		T.pathsFromDrop({ files: [], getData: () => '随便一段文字' }).length === 0);

	// 2) 挂到输入框上
	const mkInput = () => {
		const h = {};
		const el = {
			value: '', hot: false,
			addEventListener: (t, fn) => { (h[t] = h[t] || []).push(fn); },
			addClass: () => { el.hot = true; },
			removeClass: () => { el.hot = false; },
			fire: (t, ev) => (h[t] || []).forEach((fn) => fn(ev)),
			has: (t) => !!h[t],
		};
		return el;
	};
	const ev = (dt) => ({ preventDefault() { }, stopPropagation() { }, dataTransfer: dt });

	const inp = mkInput();
	let got = '';
	T.attachPathDrop(inp, { onPath: (p) => { got = p; } });
	check('注册了 dragover / drop 监听', inp.has('dragover') && inp.has('drop'));

	let prevented = false;
	inp.fire('dragover', { preventDefault: () => { prevented = true; }, stopPropagation: () => { }, dataTransfer: {} });
	check('dragover 里调用了 preventDefault（不调的话浏览器根本不派发 drop）', prevented);
	check('拖到输入框上时加高亮类', inp.hot === true);

	inp.fire('drop', ev({ files: [{ path: 'D:\\资料\\报告.pdf' }] }));
	check('drop 后路径填进输入框', inp.value === 'D:\\资料\\报告.pdf', inp.value);
	check('drop 后触发 onPath 回调（用于同步内部状态）', got === 'D:\\资料\\报告.pdf', got);
	check('drop 后取消高亮', inp.hot === false);

	inp.value = 'KEEP';
	const n0 = NOTICES.length;
	inp.fire('drop', ev({ files: [], getData: () => '' }));
	check('拿不到路径时不覆盖已有内容', inp.value === 'KEEP', inp.value);
	check('拿不到路径时给出提示', NOTICES.length > n0, NOTICES.slice(n0).join(' | '));

	inp.value = '';
	inp.fire('drop', ev({ files: [{ path: 'D:\\a.txt' }, { path: 'D:\\b.txt' }] }));
	check('一次拖多项时取第一个并提示', inp.value === 'D:\\a.txt' && /只取第一个/.test(NOTICES[NOTICES.length - 1] || ''),
		inp.value + ' | ' + NOTICES[NOTICES.length - 1]);

	// 3) folderOnly：监控文件夹这类只接受目录的位置
	const dropFile = nodePath.join(extDir, 'drop-test.txt');
	fs.writeFileSync(dropFile, 'x');
	const inp2 = mkInput();
	let got2 = '';
	T.attachPathDrop(inp2, { folderOnly: true, onPath: (p) => { got2 = p; } });
	inp2.fire('drop', ev({ files: [{ path: dropFile }] }));
	check('folderOnly：拖入文件时自动改用它所在的目录', got2 === extDir, got2);
	check('folderOnly：输入框里也是那个目录', inp2.value === extDir, inp2.value);

	const inp3 = mkInput();
	let got3 = '';
	T.attachPathDrop(inp3, { folderOnly: true, onPath: (p) => { got3 = p; } });
	inp3.fire('drop', ev({ files: [{ path: extDir }] }));
	check('folderOnly：拖入文件夹时原样使用', got3 === extDir, got3);
	} /* end dragSection */

	console.log(`\n结果：${pass} 通过 / ${fail} 失败` + (skipped ? ` / ${skipped} 段跳过` : ''));
	console.log('临时目录：' + root);
	process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

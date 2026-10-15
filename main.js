'use strict';

/* ==========================================================================
 * External Link Manager — Obsidian 外部引用（磁盘绝对路径）链接管理器
 *
 * 功能：
 *  1. 扫描全库 Markdown，识别指向仓库外部（C:\...、\\server\...、file:///...）的链接
 *  2. 外部文件被移动 / 用户名变更后，自动或手动把笔记里的链接改到新路径
 *  3. 可指定要监控的外部文件夹；外部文件变动时自动重新核对
 *  4. 「外部引用管理」面板：总览所有 笔记 ↔ 外部文件 的映射，可增 / 删 / 改，改动同步回笔记
 *
 * 说明：本文件为免编译插件（CommonJS），直接把整个文件夹放进
 *       <vault>/.obsidian/plugins/ 下即可。
 * ========================================================================== */

const OBS = require('obsidian');
const {
	Plugin,
	PluginSettingTab,
	Setting,
	ItemView,
	Notice,
	Modal,
	TFile,
	MarkdownView,
	normalizePath,
} = OBS;

let fs = null;
let nodePath = null;
let os = null;
let electron = null;
let crypto = null;

try { fs = require('fs'); } catch (e) { /* noop */ }
try { nodePath = require('path'); } catch (e) { /* noop */ }
try { os = require('os'); } catch (e) { /* noop */ }
try { electron = require('electron'); } catch (e) { /* noop */ }
try { crypto = require('crypto'); } catch (e) { /* noop */ }

const VIEW_TYPE = 'external-link-manager-view';
const SEP = '\u0000';

/* ============================== 小工具 ==================================== */

function pad2(n) { return String(n).padStart(2, '0'); }

function ts() {
	const d = new Date();
	return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ` +
		`${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function stamp() {
	const d = new Date();
	return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-` +
		`${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function isWin() { return process.platform === 'win32'; }

function joinPath(a, b) {
	if (nodePath) return nodePath.join(a, b);
	const sep = /[\\/]$/.test(a) ? '' : (isWin() ? '\\' : '/');
	return a + sep + b;
}

function safeBasename(p) {
	if (!p) return '';
	const s = String(p).replace(/[\\/]+$/, '');
	const i = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/'));
	return i >= 0 ? s.slice(i + 1) : s;
}

function safeDirname(p) {
	if (!p) return '';
	const s = String(p).replace(/[\\/]+$/, '');
	const i = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/'));
	return i > 0 ? s.slice(0, i) : '';
}

function segments(p) {
	return String(p).replace(/[\\/]+$/, '').split(/[\\/]+/).filter(Boolean);
}

function exists(p) {
	try { return !!p && fs.existsSync(p); } catch (e) { return false; }
}

function statType(p) {
	try {
		const st = fs.statSync(p);
		if (st.isDirectory()) return 'folder';
		if (st.isFile()) return 'file';
	} catch (e) { /* noop */ }
	return null;
}

function isDir(p) { return statType(p) === 'folder'; }

function lower(s) { return String(s || '').toLowerCase(); }

function uniqCI(list) {
	const seen = new Set();
	const out = [];
	for (const x of list) {
		const k = lower(x);
		if (seen.has(k)) continue;
		seen.add(k);
		out.push(x);
	}
	return out;
}

function isSubPath(parent, child) {
	if (!parent || !child) return false;
	const a = lower(String(parent).replace(/[\\/]+$/, ''));
	const b = lower(String(child));
	return b === a || b.startsWith(a + '\\') || b.startsWith(a + '/');
}

/** 路径是否落在任一给定根目录内。roots 由调用方预先算好，避免重复求值。 */
function isInRoots(p, roots) {
	if (!p || !roots || !roots.length) return false;
	for (const r of roots) if (isSubPath(r, p)) return true;
	return false;
}

const EXPORT_SEP = '\t';

function csvCell(v) {
	const s = String(v == null ? '' : v);
	// 本版本用 tab 分列：逗号是普通内容，不应触发引号包裹；仅转义引号、tab 与换行。
	return /["\t\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

/* ------------------------- 拖拽：系统文件 → 输入框 ------------------------ */

/**
 * 从 drop 事件的 dataTransfer 里取出真实的磁盘绝对路径。
 *
 * 兼容性要点：
 *  - Electron 32 起 File.path 被移除，必须优先用 webUtils.getPathForFile(file)；
 *  - 老版本 Electron 回退读 file.path；
 *  - 都拿不到时，兜底解析 text/uri-list / text/plain 里的 file:// URL。
 * 拖入文件夹时 dataTransfer.files 里同样会有一项，路径即文件夹本身。
 */
function pathsFromDrop(dt) {
	const out = [];
	const seen = new Set();
	if (!dt) return out;
	const push = (p) => {
		if (p == null) return;
		const v = String(p).trim();
		if (!v) return;
		const k = lower(v);
		if (seen.has(k)) return;
		seen.add(k);
		out.push(v);
	};

	try {
		const files = dt.files;
		if (files && files.length) {
			for (let i = 0; i < files.length; i++) {
				const f = files[i];
				let p = '';
				try {
					if (electron && electron.webUtils && typeof electron.webUtils.getPathForFile === 'function') {
						p = electron.webUtils.getPathForFile(f);
					}
				} catch (e) { /* noop */ }
				if (!p && f && f.path) p = f.path;
				push(p);
			}
		}
	} catch (e) { /* noop */ }

	// 兜底：某些来源（如浏览器拖链接）files 为空，但带 file:// URI
	if (!out.length && typeof dt.getData === 'function') {
		let raw = '';
		try { raw = dt.getData('text/uri-list') || dt.getData('text/plain') || ''; } catch (e) { raw = ''; }
		String(raw).split(/\r?\n/).forEach((line) => {
			const t = line.trim();
			if (!t || t.startsWith('#')) return;
			if (!/^file:\/{2,}/i.test(t)) return;
			let u = t.replace(/^file:\/{2,}/i, '');
			try { u = decodeURIComponent(u); } catch (e) { /* noop */ }
			if (/^[A-Za-z]:/.test(u)) push(u.replace(/\//g, '\\')); // file:///C:/a/b → C:\a\b
			else push('/' + u.replace(/^\/+/, ''));                 // file:///home/x → /home/x
		});
	}
	return out;
}

/** 取拖拽路径（多个时只取第一个），返回 { path, count } */
function firstDropPath(dt) {
	const arr = pathsFromDrop(dt);
	return { path: arr.length ? arr[0] : '', count: arr.length };
}

/**
 * 让一个输入框支持从系统资源管理器直接拖入文件/文件夹。
 *
 * opts:
 *   onPath(p)   —— 填入后的回调（同步内部状态、保存设置等）
 *   folderOnly  —— true 时只接受文件夹；拖入文件则自动改用其所在目录
 *   hint        —— 拖入失败时的提示前缀，可省略
 *
 * 说明：这里只监听输入框自身的拖拽事件，不碰 Obsidian 的编辑器拖拽逻辑；
 * dragover 必须 preventDefault，否则浏览器不会派发 drop。
 */
function attachPathDrop(inputEl, opts) {
	opts = opts || {};
	if (!inputEl || typeof inputEl.addEventListener !== 'function') return;
	const onPath = typeof opts.onPath === 'function' ? opts.onPath : () => { };
	const hot = (on) => {
		try {
			if (on) { if (inputEl.addClass) inputEl.addClass('elm-drop-hot'); }
			else if (inputEl.removeClass) inputEl.removeClass('elm-drop-hot');
		} catch (e) { /* noop */ }
	};

	inputEl.addEventListener('dragenter', (e) => { e.preventDefault(); e.stopPropagation(); hot(true); });
	inputEl.addEventListener('dragover', (e) => {
		e.preventDefault();
		e.stopPropagation();
		try { if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'; } catch (err) { /* noop */ }
		hot(true);
	});
	inputEl.addEventListener('dragleave', (e) => { e.stopPropagation(); hot(false); });
	inputEl.addEventListener('dragend', () => hot(false));

	inputEl.addEventListener('drop', (e) => {
		e.preventDefault();
		e.stopPropagation();
		hot(false);
		const r = firstDropPath(e.dataTransfer);
		if (!r.path) {
			new Notice('没识别到磁盘路径：请从「文件资源管理器 / 访达」里拖文件或文件夹进来');
			return;
		}
		let p = r.path;
		if (opts.folderOnly && !isDir(p)) {
			const parent = safeDirname(p);
			if (!parent || !isDir(parent)) {
				new Notice('这里只能填文件夹，但拖进来的是文件：' + safeBasename(p));
				return;
			}
			p = parent;
			new Notice('这里只能填文件夹，已自动改用它所在的目录：' + p);
		} else if (r.count > 1) {
			new Notice(`拖进来 ${r.count} 项，只取第一个：${safeBasename(p)}`);
		}
		inputEl.value = p;
		onPath(p);
	});
}

/* --------------------------- 路径 / 链接识别 ----------------------------- */

/** 把链接目标转成原生绝对路径 */
function toNativePath(raw) {
	if (raw == null) return '';
	let s = String(raw).trim();
	if (/^file:\/{2,}/i.test(s)) {
		s = s.replace(/^file:\/{2,}/i, '');
		try { s = decodeURIComponent(s); } catch (e) { /* noop */ }
		if (/^\/[A-Za-z]:/.test(s)) s = s.slice(1); // /C:/x -> C:/x
	}
	if (isWin()) s = s.replace(/\//g, '\\');
	return s;
}

/** 是否「看起来像」外部绝对路径（不含 http 等 scheme） */
function looksExternal(raw) {
	const s = String(raw || '').trim();
	if (!s) return false;
	if (/^file:\/{2,}/i.test(s)) return true;
	if (/^[A-Za-z]:[\\/]/.test(s)) return true;   // C:\  C:/
	if (/^\\\\[^\\]/.test(s)) return true;        // \\server\share
	if (/^\/(?!\/)/.test(s)) return true;         // /home/... （后面再按根目录过滤）
	return false;
}

function isVaultRelativeSlash(s) { return /^\/(?!\/)/.test(String(s || '').trim()); }

/**
 * 识别链接目标的包裹符号。
 * 只认 Markdown 规范的尖括号 <...>。
 *
 * 注意：Obsidian 有时会写出 [文本]("C:\路径") 这种带引号的形式，
 * 但那是**错误写法** —— 引号会被当成路径的一部分，Obsidian 自己点开也打不开。
 * 所以这里刻意不兼容：这类链接会被直接忽略，需要手工改成 <路径> 或裸路径。
 */
function detectWrapper(t) {
	if (!t || t.length < 3) return null;
	if (t.startsWith('<') && t.endsWith('>')) return 'angle';
	return null;
}

function wrapTarget(target, wrapper, wrapSpaces) {
	if (wrapper === 'angle') return '<' + target + '>';
	if (wrapSpaces && /\s/.test(target)) return '<' + target + '>';
	return target;
}

function buildMarkup(isEmbed, text, target, wrapper, wrapSpaces) {
	return (isEmbed ? '!' : '') + '[' + text + '](' +
		wrapTarget(target, wrapper, wrapSpaces) + ')';
}

/** 判断链接写法风格，修复时保持原风格 */
function detectStyle(raw) {
	const s = String(raw || '').trim();
	if (/^file:\/{2,}/i.test(s)) return 'fileUri';
	if (/^[A-Za-z]:[\\/]/.test(s)) return s.indexOf('\\') === -1 ? 'windowsForward' : 'windows';
	if (/^\\\\/.test(s)) return 'unc';
	return 'posix';
}

function formatTarget(absPath, style) {
	const p = String(absPath);
	if (style === 'fileUri') return 'file:///' + p.replace(/\\/g, '/').replace(/^\/+/, '');
	if (style === 'windowsForward') return p.replace(/\\/g, '/');
	if (style === 'windows' || style === 'unc') return p.replace(/\//g, '\\');
	return p.replace(/\\/g, '/');
}

/* --------------------------- 链接匹配规则（可配置） ------------------------ */

/** 默认规则：匹配 [文字](路径) 与 ![文字](路径) */
const DEFAULT_LINK_PATTERN = '(!?)\\[([^\\]\\n]*)\\]\\(([^)\\n]+)\\)';
const DEFAULT_LINK_FLAGS = 'g';

/** 允许的正则标志（不含 y / d，避免误用导致扫描行为诡异） */
const LINK_FLAG_CHARS = 'gimsu';

/** 归一化标志：只保留白名单字符、去重，并强制带 g（否则只能匹配第一处） */
function normalizeLinkFlags(s) {
	let out = '';
	for (const ch of String(s == null ? '' : s)) {
		if (LINK_FLAG_CHARS.indexOf(ch) >= 0 && out.indexOf(ch) < 0) out += ch;
	}
	if (out.indexOf('g') < 0) out += 'g';
	return out;
}

/** 编译用户规则；失败时返回 error 而不是抛异常 */
function compileLinkPattern(src, flags) {
	try {
		return { re: new RegExp(String(src == null ? '' : src), normalizeLinkFlags(flags)), error: '' };
	} catch (e) {
		return { re: null, error: String((e && e.message) || e || '未知错误') };
	}
}

/** 数一下规则里有几个捕获组（用于提示「第 3 组=目标路径」是否满足） */
function countCaptureGroups(src) {
	const s = String(src == null ? '' : src);
	let n = 0;
	for (let i = 0; i < s.length; i++) {
		const c = s[i];
		if (c === '\\') { i++; continue; }
		if (c === '[') {                       // 跳过字符类 [...]
			i++;
			while (i < s.length && s[i] !== ']') { if (s[i] === '\\') i++; i++; }
			continue;
		}
		if (c !== '(') continue;
		if (s[i + 1] !== '?') { n++; continue; }      // ( ... ) 普通捕获组
		if (s[i + 2] === '<' && /[A-Za-z_$]/.test(s[i + 3] || '')) n++; // (?<name>...) 命名组
		// (?: (?= (?! (?<= (?<! 都不计数
	}
	return n;
}

/** 规则的静态体检结果，给设置页用 */
function analyzeLinkPattern(src, flags) {
	const r = compileLinkPattern(src, flags);
	if (!r.re) return { ok: false, error: r.error, groups: 0, named: false, hasTarget: false };
	const named = /\(\?<[A-Za-z_$][\w$]*>/.test(String(src));
	const hasTargetNamed = /\(\?<target>/.test(String(src));
	const groups = countCaptureGroups(src);
	return {
		ok: true, error: '', groups, named,
		// 有 target 命名组，或者至少 3 个位置捕获组，才能拿到目标路径
		hasTarget: hasTargetNamed || groups >= 3,
	};
}

/**
 * 从一次 exec 的结果里取出 bang / text / target。
 * 优先用命名捕获组（(?<bang>)(?<text>)(?<target>)），顺序随意；
 * 没有命名组时退回位置组 1 / 2 / 3（与默认规则一致）。
 */
function resolveLinkGroups(m) {
	const g = m.groups || {};
	const pick = (name, idx) => (g[name] !== undefined && g[name] !== null) ? g[name] : m[idx];
	const bang = pick('bang', 1);
	const text = pick('text', 2);
	const target = pick('target', 3);
	return {
		bang: bang == null ? '' : String(bang),
		text: text == null ? '' : String(text),
		target: target == null ? null : String(target).trim(),
	};
}

/** 设置页「试一下」的默认示例 */
const DEFAULT_LINK_RULE_SAMPLE = [
	'[启动参数](C:\\Users\\me\\Desktop\\启动参数.txt)',
	'![截图](D:\\资料\\截图.png)',
	'[带空格的](<D:\\my docs\\a b.txt>)',
	'[库内笔记](笔记/abc.md)',
	'[网址](https://example.com)',
	'[错误写法]("D:\\bad\\quoted.txt")',
].join('\n');

/**
 * 用给定规则跑一遍示例文本，返回每一条命中。
 * 与 extractExternalLinks 共用 resolveLinkGroups，保证「试一下」和实际扫描口径一致。
 */
function runLinkRuleSample(src, flags, text, plugin) {
	const r = compileLinkPattern(src, flags);
	if (!r.re) return { error: r.error, hits: [] };
	const re = r.re;
	re.lastIndex = 0;
	const hits = [];
	let m;
	let guard = 0;
	while ((m = re.exec(String(text == null ? '' : text))) !== null) {
		if (!m[0]) { re.lastIndex++; if (re.lastIndex > String(text).length) break; continue; }
		if (++guard > 500) break;
		const g = resolveLinkGroups(m);
		let target = g.target;
		let external = null;
		if (target != null) {
			const w = detectWrapper(target);
			if (w) target = target.slice(1, -1).trim();
			external = plugin ? plugin.shouldTreatAsExternal(target) : true;
		}
		hits.push({ full: m[0], text: g.text, target, isEmbed: g.bang === '!', external });
	}
	return { error: '', hits };
}

/** 把试跑结果画到设置页 */
function renderRuleTest(host, src, flags, text, plugin) {
	host.empty();
	const res = runLinkRuleSample(src, flags, text, plugin);
	if (res.error) {
		host.createEl('div', { cls: 'elm-rule-bad', text: '规则无法编译：' + res.error });
		return;
	}
	if (!res.hits.length) {
		host.createEl('div', { cls: 'elm-hint', text: '没有匹配到任何链接。' });
		return;
	}
	const ul = host.createEl('ul', { cls: 'elm-rule-hits' });
	for (const h of res.hits) {
		const li = ul.createEl('li');
		li.createEl('code', { cls: 'elm-mono', text: h.full });
		if (h.target == null) {
			li.createEl('span', { cls: 'elm-rule-warn', text: '（取不到目标路径）' });
			continue;
		}
		li.createEl('span', {
			cls: h.external ? 'elm-rule-ok' : 'elm-hint',
			text: h.external ? '→ 外部：' : '→ 非外部（跳过）：',
		});
		li.createEl('code', { cls: 'elm-mono', text: h.target });
		if (h.isEmbed) li.createEl('span', { cls: 'elm-hint', text: '（嵌入）' });
	}
}

function lineOf(content, index) {
	let n = 1;
	for (let i = 0; i < index && i < content.length; i++) {
		if (content.charCodeAt(i) === 10) n++;
	}
	return n;
}

/* ============================ 默认设置 =================================== */

const DEFAULT_SKIP_DIRS = new Set([
	'node_modules', '.git', '.svn', '.hg', '$recycle.bin', 'system volume information',
	'.obsidian', '.trash', '.tmp', 'temp', 'windows', '$windows.~ws', 'recovery',
	'appdata', 'application data', 'anaconda3', 'miniconda3', '.cache', '.npm', '.gradle',
	'.m2', '.vscode', 'site-packages', '__pycache__', '.idea',
]);

const DEFAULT_SETTINGS = {
	// —— 监控范围 ——
	monitoredFolders: [],        // [{ path, label, recursive, enabled }]
	alsoSearchVault: false,      // 额外搜索仓库自身
	// 注意：早期版本有过两个会扩大范围的东西，都已移除：
	//   - alsoSearchUserProfile（默认 true）→ 把整个用户主目录纳入搜索，推荐列表里会冒出桌面/文档的同名文件
	//   - extraSearchRoots（「额外搜索目录」）→ 只搜索不监听，导致「搜索范围」和「监控范围」两套口径打架
	// 现在只有一个范围：monitoredFolders。搜索、监听、范围判定全部以它为准。

	// —— 扫描范围（仓库内）——
	includePaths: [],
	excludePaths: ['.trash'],

	// —— 链接识别规则（可配置）——
	// 用来从 Markdown 里抓出外部链接的正则。见 DEFAULT_LINK_PATTERN 上的说明。
	linkPattern: DEFAULT_LINK_PATTERN,
	linkFlags: DEFAULT_LINK_FLAGS,

	// —— 自动化 ——
	enableAutoFix: true,           // 总开关（关掉后插件只读不写）
	// 自动改写前是否必须由用户点确认。
	// 默认 true：任何「自动触发」（外部变动 / 打开笔记 / 笔记变动 / 定时扫描）
	// 都只把链接标记成「待确认」，绝不自己动笔记；只有你点确认才写。
	// 想恢复「高置信度自动改写」就把这个开关关掉。
	requireConfirmBeforeAutoFix: true,
	autoFixOnFileOpen: true,       // 打开笔记时检查并修复（高置信度唯一候选）
	autoFixOnExternalChange: true, // 外部文件变动时自动核对
	autoFixOnVaultChange: true,    // 仓库内笔记变动时刷新记录
	watchExternalFolders: true,    // 用 fs.watch 监控外部目录
	scanIntervalMinutes: 0,        // 0 = 关闭定时扫描
	// 外部目录「安静」多久之后才去核对链接。
	// 调大可以明显减少你在批量改文件时的卡顿（改文件期间不扫描，改完再扫一次）。
	externalChangeDelayMs: 3000,

	// —— 匹配策略 ——
	autoFixMinScore: 0.6,   // 唯一候选的最低相似度
	maxSearchDepth: 5,
	maxSearchFiles: 20000,

	// —— 内容指纹（识别「只改了名、内容没变」的文件）——
	detectByContent: true,
	hashAlgo: 'sha256',
	hashMaxSizeMB: 64,

	// —— 路径处理 ——
	remapUserProfile: true, // 用户名变更自动重映射
	driveRemap: '',         // 多行：D:=C:  或  D: -> E:
	posixRoots: ['/home/', '/Users/', '/mnt/', '/media/', '/Volumes/', '/opt/', '/srv/', '/root/'],
	treatAllPosixAbsolute: false,
	wrapPathsWithSpaces: true,

	// —— 记录 ——
	writeChangeLog: true,
	changeLogPath: '', // 留空 = 写到插件自己的目录下（跟随 manifest.dir，避免装两份时写错地方）
	showStatusBar: true,

	// —— 运行时数据 ——
	ignored: [],        // ["notePath\u0000rawTarget"]
	notes: {},          // { key: 备注 }
	recentChanges: [],  // [{at, note, text, from, to, reason}]
	indexCache: {},     // { 文件名小写: [磁盘路径] } —— 候选位置查找缓存
	fileIndex: {},      // { 磁盘路径小写: {path,size,mtimeMs,hash,at} } —— 内容指纹
	cache: { records: [], scannedAt: 0 },
};

/**
 * 名称相似度（0~1）。用于「改名」场景：file1 → file11、report.txt → report。
 * 前缀关系给高分，否则退化为编辑距离。
 */
function nameSimilarity(a, b) {
	if (!a || !b) return 0;
	if (a === b) return 1;
	const max = Math.max(a.length, b.length);
	const min = Math.min(a.length, b.length);
	if (a.startsWith(b) || b.startsWith(a)) return 0.75 + 0.25 * (min / max);
	if (Math.abs(a.length - b.length) > 6) return 0;
	return Math.max(0, 1 - levenshtein(a, b) / max);
}

/** 带长度上限的编辑距离，避免长路径拖慢 */
function levenshtein(a, b) {
	if (a.length > 64) a = a.slice(0, 64);
	if (b.length > 64) b = b.slice(0, 64);
	const m = a.length, n = b.length;
	if (!m) return n;
	if (!n) return m;
	let prev = new Array(n + 1);
	let cur = new Array(n + 1);
	for (let j = 0; j <= n; j++) prev[j] = j;
	for (let i = 1; i <= m; i++) {
		cur[0] = i;
		for (let j = 1; j <= n; j++) {
			const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
			cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
		}
		const t = prev; prev = cur; cur = t;
	}
	return prev[n];
}

/**
 * 计算文件内容指纹（流式，避免大文件一次性读入内存）。
 * 失败返回 null（权限不足、文件被占用等），调用方需自行降级。
 */
function fileHash(p, algo) {
	return new Promise((resolve) => {
		if (!crypto || !fs) return resolve(null);
		let h = null;
		try { h = crypto.createHash(algo || 'sha256'); } catch (e) { return resolve(null); }
		let stream = null;
		try { stream = fs.createReadStream(p); } catch (e) { return resolve(null); }
		let done = false;
		const finish = (v) => { if (!done) { done = true; resolve(v); } };
		stream.on('data', (d) => { try { h.update(d); } catch (e) { finish(null); } });
		stream.on('end', () => { try { finish(h.digest('hex')); } catch (e) { finish(null); } });
		stream.on('error', () => finish(null));
	});
}

/* ========================== 文件系统遍历 ================================= */

/**
 * 遍历文件数上限。
 * opts.auto 表示这是「外部文件变动后自动触发的核对」——这种场景用户可能正在
 * 批量复制/改名，必须把上限压小，宁可少找几个候选，也不能把磁盘占住。
 */
function walkCap(settings, opts) {
	const base = Number(settings && settings.maxSearchFiles) || 20000;
	if (opts && opts.auto) return Math.min(base, 5000);
	return base;
}

async function walkDir(root, opts, onFile, onDir) {
	const maxDepth = opts.maxDepth == null ? 6 : opts.maxDepth;
	const maxFiles = opts.maxFiles == null ? 20000 : opts.maxFiles;
	const skipDirs = opts.skipDirs || DEFAULT_SKIP_DIRS;
	const queue = [{ dir: root, depth: 0 }];
	let visited = 0;
	let lastYield = Date.now();
	while (queue.length) {
		const cur = queue.shift();
		if (cur.depth > maxDepth) continue;
		let entries;
		try {
			entries = await fs.promises.readdir(cur.dir, { withFileTypes: true });
		} catch (e) { continue; }
		for (const ent of entries) {
			const full = joinPath(cur.dir, ent.name);
			let isDirEnt = false;
			try { isDirEnt = ent.isDirectory(); } catch (e) { /* noop */ }
			if (isDirEnt) {
				if (skipDirs.has(lower(ent.name))) continue;
				try { if (onDir) onDir(full, ent.name); } catch (e) { /* noop */ }
				if (cur.depth + 1 <= maxDepth) queue.push({ dir: full, depth: cur.depth + 1 });
			} else {
				visited++;
				try { onFile(full, ent.name); } catch (e) { /* noop */ }
				if (visited >= maxFiles) return { truncated: true, visited };
			}
		}
		// 按时间片让出主线程：每个目录都 await 在 Windows 上极慢
		if (Date.now() - lastYield > 16) {
			lastYield = Date.now();
			await sleep(0);
		}
	}
	return { truncated: false, visited };
}

/* ============================== 插件主体 ================================== */

class ExternalLinkManagerPlugin extends Plugin {

	async onload() {
		await this.loadSettings();
		// 迁移过旧设置项就立刻落盘一次，避免旧键残留在 data.json 里反复触发迁移
		if (this.pendingSettingsMigration) {
			this.pendingSettingsMigration = false;
			await this.saveSettings();
		}

		this.records = [];            // 当前扫描结果
		this.recordMap = new Map();   // key -> record
		this.writing = new Set();     // 正在被插件写入的笔记（防止自触发）
		this.pendingTimers = new Map();
		this.watchers = [];
		this.statusEl = null;
		// 外部变动用「无锁事件队列」：watcher 回调只入队，drainExternal 一次性取走整批。
		// 没有任何互斥锁，也不会丢弃事件。
		this.extQueue = [];
		this._extTimer = null;        // 排空计时器
		this._scanRunning = false;    // 仅用于「扫描进行中再来一次」→ 排到后面补跑（不丢请求）
		this._scanAgain = false;
		this._saveTimer = null;       // 限流落盘的计时器

		// —— 视图 ——
		this.registerView(VIEW_TYPE, (leaf) => new ExternalLinkManagerView(leaf, this));

		// —— 功能区图标 ——
		this.addRibbonIcon('link-2', '外部引用管理', () => this.activateView());

		// —— 命令 ——
		this.addCommand({
			id: 'open-manager',
			name: '打开「外部引用管理」面板',
			callback: () => this.activateView(),
		});
		this.addCommand({
			id: 'scan-all',
			name: '扫描全库外部引用',
			callback: () => this.scanAll({ notify: true, refreshView: true }),
		});
		this.addCommand({
			id: 'scan-and-fix',
			name: '扫描并修复失效的外部引用',
			callback: () => this.scanAll({ fix: true, notify: true, refreshView: true }),
		});
		this.addCommand({
			id: 'confirm-pending',
			name: '确认全部「待确认」的外部引用更新',
			callback: async () => {
				if (!this.countPending()) { new Notice('没有待确认的项'); return; }
				await this.confirmPending({});
			},
		});
		this.addCommand({
			id: 'toggle-confirm-mode',
			name: '切换「自动改写前需要我确认」',
			callback: async () => {
				this.settings.requireConfirmBeforeAutoFix = !this.settings.requireConfirmBeforeAutoFix;
				if (this.settings.requireConfirmBeforeAutoFix) this.markPending();
				await this.saveSettings();
				this.refreshViews();
				new Notice(this.settings.requireConfirmBeforeAutoFix
					? '已开启：自动检测只标记「待确认」，不会自己改笔记'
					: '已关闭：高置信度唯一候选会自动改写');
			},
		});
		this.addCommand({
			id: 'check-current-note',
			name: '检查当前笔记的外部引用',
			checkCallback: (checking) => {
				const view = this.app.workspace.getActiveViewOfType(MarkdownView);
				if (!view) return false;
				if (!checking) this.scanFile(view.file, { fix: true, notify: true });
				return true;
			},
		});
		this.addCommand({
			id: 'insert-external-link',
			name: '插入外部文件/文件夹链接',
			editorCheckCallback: (checking, editor) => {
				if (!checking) this.openInsertModal(editor);
				return true;
			},
		});
		this.addCommand({
			id: 'clear-cache',
			name: '清空候选路径缓存（下次扫描重新查找外部文件位置）',
			callback: async () => {
				await this.clearCandidateCache();
				new Notice('候选路径缓存已清空');
			},
		});

		// —— 设置页 ——
		this.addSettingTab(new ExternalLinkManagerSettingTab(this.app, this));

		// —— 状态栏 ——
		if (this.settings.showStatusBar) this.setupStatusBar();

		// —— 仓库内文件变动 ——
		this.registerEvent(this.app.vault.on('modify', (f) => {
			if (!(f instanceof TFile) || f.extension !== 'md') return;
			if (this.writing.has(f.path)) return;
			this.schedule(`vault:${f.path}`, 800, async () => {
				await this.scanFile(f, { fix: this.settings.enableAutoFix && this.settings.autoFixOnVaultChange, silent: true });
				this.refreshViews();
			});
		}));
		this.registerEvent(this.app.vault.on('rename', (f) => {
			if (!(f instanceof TFile) || f.extension !== 'md') return;
			this.schedule('vault:rename', 500, () => this.scanAll({ silent: true, refreshView: true }));
		}));
		this.registerEvent(this.app.vault.on('delete', () => {
			this.schedule('vault:delete', 500, () => this.scanAll({ silent: true, refreshView: true }));
		}));

		// —— 打开笔记时检查 ——
		this.registerEvent(this.app.workspace.on('file-open', (file) => {
			if (!file || file.extension !== 'md') return;
			if (!this.settings.enableAutoFix || !this.settings.autoFixOnFileOpen) return;
			this.schedule(`open:${file.path}`, 600, () => this.scanFile(file, { fix: true, silent: true }));
		}));

		// —— 布局就绪后首扫 + 启动监控 ——
		this.app.workspace.onLayoutReady(async () => {
			this.loadCacheToView();
			this.setupWatchers();
			this.setupInterval();
			if (this.settings.cache && this.settings.cache.records && this.settings.cache.records.length) {
				this.records = this.settings.cache.records;
				this.reindexRecords();
			}
			this.scanAll({ silent: true, refreshView: true });
		});

		// —— 退出清理 ——
		this.register(() => {
			this.closeWatchers();
			for (const t of this.pendingTimers.values()) window.clearTimeout(t);
			this.pendingTimers.clear();
			if (this._extTimer) { window.clearTimeout(this._extTimer); this._extTimer = null; }
		});
	}

	onunload() {
		this.closeWatchers();
		// 清掉所有挂起的合并调度，避免卸载后还在跑
		for (const v of this.pendingTimers.values()) {
			const t = v && v.timer ? v.timer : v;
			if (t) window.clearTimeout(t);
		}
		this.pendingTimers.clear();
		if (this._extTimer) { window.clearTimeout(this._extTimer); this._extTimer = null; }
		if (this._saveTimer) { window.clearTimeout(this._saveTimer); this._saveTimer = null; }
		this.extQueue = [];
		// 限流落盘可能还攒着没写，这里补一次
		this.flushSettings();
	}

	/* ---------------------------- 设置读写 ---------------------------- */

	async loadSettings() {
		const data = (await this.loadData()) || {};
		// 注意：必须深拷贝默认值。否则嵌套对象（ignored / monitoredFolders / indexCache 等）
		// 会与模块级 DEFAULT_SETTINGS 共享引用，插件重载时残留上一次的状态。
		const defaults = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
		this.settings = Object.assign(defaults, data.settings || {});
		// 兼容/修正
		if (!Array.isArray(this.settings.monitoredFolders)) this.settings.monitoredFolders = [];
		if (!Array.isArray(this.settings.posixRoots)) this.settings.posixRoots = DEFAULT_SETTINGS.posixRoots;
		if (!Array.isArray(this.settings.ignored)) this.settings.ignored = [];
		if (!Array.isArray(this.settings.recentChanges)) this.settings.recentChanges = [];
		if (!this.settings.indexCache || typeof this.settings.indexCache !== 'object') this.settings.indexCache = {};
		if (!this.settings.fileIndex || typeof this.settings.fileIndex !== 'object') this.settings.fileIndex = {};
		if (!this.settings.notes || typeof this.settings.notes !== 'object') this.settings.notes = {};
		if (!this.settings.cache || typeof this.settings.cache !== 'object') this.settings.cache = { records: [], scannedAt: 0 };
		// 迁移：早期版本把日志路径硬编码成了某个固定的插件目录名，改成留空（跟随插件自身目录）
		if (this.settings.changeLogPath === '.obsidian/plugins/external-link-manager/change-log.md') {
			this.settings.changeLogPath = '';
		}
		// 迁移：移除 alsoSearchUserProfile。它默认 true，会把整个用户主目录纳入搜索，
		// 导致推荐列表里出现桌面/文档里碰巧同名的文件。
		if ('alsoSearchUserProfile' in this.settings) {
			delete this.settings.alsoSearchUserProfile;
			this.pendingSettingsMigration = true;
		}
		// 迁移：移除 extraSearchRoots（「额外搜索目录」）。
		// 它只参与搜索、不参与监听，导致「搜索范围」与「监控范围」两套口径不一致
		// （面板显示「范围外」，扫描时却又能从那里找到文件）。
		// 现在统一为：只有 monitoredFolders 里的目录算范围内、才会被搜索和监听。
		if ('extraSearchRoots' in this.settings) {
			delete this.settings.extraSearchRoots;
			this.pendingSettingsMigration = true;
		}
		// 链接识别规则：兜底成默认值。规则坏了不能让插件彻底不工作 ——
		// 编译失败时 getLinkRegex() 会退回默认规则，并把错误显示在设置页。
		if (typeof this.settings.linkPattern !== 'string' || !this.settings.linkPattern.trim()) {
			this.settings.linkPattern = DEFAULT_LINK_PATTERN;
		}
		if (typeof this.settings.linkFlags !== 'string') this.settings.linkFlags = DEFAULT_LINK_FLAGS;
		this.settings.linkFlags = normalizeLinkFlags(this.settings.linkFlags);
		// 迁移：清掉旧版遗留的目录缓存 "@dirs"。
		// 早期实现把遍历到的所有目录都缓存进去，用户主目录一搜就是几千条（实测 4636 条 / 约 400KB），
		// 既撑大 data.json，又让每次读缓存都要做上千次同步 fs.existsSync —— 这是「改文件卡顿」的主因之一。
		if (this.settings.indexCache && this.settings.indexCache['@dirs']) {
			delete this.settings.indexCache['@dirs'];
			this.pendingSettingsMigration = true;
		}
		// 兜底：indexCache 单条最多留 50 个路径，防止再次被灌成大数组
		for (const k of Object.keys(this.settings.indexCache || {})) {
			const v = this.settings.indexCache[k];
			if (Array.isArray(v) && v.length > 50) {
				this.settings.indexCache[k] = v.slice(0, 50);
				this.pendingSettingsMigration = true;
			}
		}
		// 响应延迟：夹到合理区间，避免被写成 0 导致疯狂扫描
		const d = Number(this.settings.externalChangeDelayMs);
		this.settings.externalChangeDelayMs = Number.isFinite(d) ? Math.min(60000, Math.max(500, d)) : 3000;
	}

	async saveSettings() {
		await this.saveData({ settings: this.settings });
	}

	/* ---------------------------- 定时器辅助 --------------------------- */

	schedule(key, delay, fn) {
		const old = this.pendingTimers.get(key);
		if (old) window.clearTimeout(old);
		const t = window.setTimeout(() => {
			this.pendingTimers.delete(key);
			Promise.resolve(fn()).catch((e) => console.error('[ExternalLinkManager]', e));
		}, delay);
		this.pendingTimers.set(key, t);
	}

	/**
	 * 限流落盘。scanAll 一次要写几百 KB 的 data.json，
	 * 如果每个外部变动都写一次，磁盘会被反复占用 —— 合并到最多每 5 秒一次。
	 */
	saveSettingsSoon(delay) {
		if (this._saveTimer) return;
		this._saveTimer = window.setTimeout(() => {
			this._saveTimer = null;
			this.saveSettings().catch((e) => console.error('[ExternalLinkManager]', e));
		}, delay == null ? 5000 : delay);
	}

	async flushSettings() {
		if (this._saveTimer) { window.clearTimeout(this._saveTimer); this._saveTimer = null; }
		try { await this.saveSettings(); } catch (e) { /* noop */ }
	}

	setupInterval() {
		const min = Number(this.settings.scanIntervalMinutes) || 0;
		if (this._intervalId) { window.clearInterval(this._intervalId); this._intervalId = null; }
		if (min > 0) {
			this._intervalId = window.setInterval(() => {
				this.scanAll({ silent: true, fix: this.settings.enableAutoFix, refreshView: true });
			}, min * 60 * 1000);
			this.registerInterval(this._intervalId);
		}
	}

	setupStatusBar() {
		if (this.statusEl) return;
		this.statusEl = this.addStatusBarItem();
		this.statusEl.addClass('elm-status');
		this.statusEl.onclick = () => this.activateView();
		this.updateStatusBar();
	}

	updateStatusBar() {
		if (!this.statusEl) return;
		const broken = this.records.filter((r) =>
			r.status === 'missing' || r.status === 'ambiguous' ||
			r.status === 'fixable' || r.status === 'pending').length;
		if (!this.records.length && !broken) {
			this.statusEl.setText('外部引用 —');
			return;
		}
		const pend = this.countPending();
		const text = broken > 0
			? (pend ? `外部引用 ⚠ ${broken}（${pend} 待确认）` : `外部引用 ⚠ ${broken}`)
			: `外部引用 ✓ ${this.records.length}`;
		this.statusEl.setText(text);
		this.statusEl.toggleClass('elm-status-warn', broken > 0);
	}

	/* ---------------------------- 视图相关 ---------------------------- */

	async activateView() {
		let leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
		if (!leaf) {
			leaf = this.app.workspace.getRightLeaf(false);
			await leaf.setViewState({ type: VIEW_TYPE, active: true });
		}
		this.app.workspace.revealLeaf(leaf);
		const v = leaf.view;
		if (v && v.render) v.render();
	}

	refreshViews() {
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
			if (leaf.view && leaf.view.render) leaf.view.render();
		}
		this.updateStatusBar();
	}

	loadCacheToView() { /* 保留占位：面板首次渲染会读取 this.records */ }

	/* --------------------------- 外部目录监控 -------------------------- */

	closeWatchers() {
		for (const w of this.watchers) {
			try { w.close(); } catch (e) { /* noop */ }
		}
		this.watchers = [];
	}

	setupWatchers() {
		this.closeWatchers();
		this.extQueue = [];
		if (this._extTimer) { window.clearTimeout(this._extTimer); this._extTimer = null; }
		if (!this.settings.watchExternalFolders) return;
		if (!fs || !fs.watch) return;
		for (const f of this.settings.monitoredFolders) {
			if (!f || f.enabled === false || !f.path) continue;
			if (!exists(f.path)) continue;
			// 回调里只做一件事：把事件塞进内存数组。
			// 不 stat、不 readdir、不 hash、不加锁、不打开任何文件 ——
			// 所以系统改文件名 / 复制文件时，这个回调的开销可以忽略不计。
			const onEvent = (evt, name) => {
				this.extQueue.push({ folder: f.path, name: name || '', at: Date.now() });
				// 队列本身也设个上限，万一有程序疯狂刷事件也不会把内存撑爆
				if (this.extQueue.length > 20000) this.extQueue.splice(0, this.extQueue.length - 20000);
				this.armExtDrain();
			};
			try {
				const w = fs.watch(f.path, { recursive: f.recursive !== false }, onEvent);
				this.watchers.push(w);
			} catch (e) {
				// 某些平台/网络盘不支持 recursive，退化为非递归
				try {
					const w2 = fs.watch(f.path, onEvent);
					this.watchers.push(w2);
				} catch (e2) { /* 放弃该目录的实时监控 */ }
			}
		}
	}

	externalDelay() {
		const d = Number(this.settings.externalChangeDelayMs);
		return Number.isFinite(d) ? Math.min(60000, Math.max(500, d)) : 3000;
	}

	/** 重新武装排空计时器：目录安静 externalDelay 毫秒后才真正开始处理 */
	armExtDrain() {
		if (this._extTimer) window.clearTimeout(this._extTimer);
		this._extTimer = window.setTimeout(() => {
			this._extTimer = null;
			this.drainExternal();
		}, this.externalDelay());
	}

	/**
	 * 排空事件队列。
	 *
	 * 这里刻意**不用任何锁 / 标志位**：
	 *   - 先用 splice 一次性把整批事件取走（JS 单线程，这个动作是原子的）；
	 *   - 处理期间新到的事件自然进入新队列，等这一轮结束再处理下一轮。
	 * 所以既不会丢事件，也不会互相阻塞，更不存在「正在扫描中，本次请求被丢弃」。
	 */
	async drainExternal() {
		const batch = this.extQueue.splice(0, this.extQueue.length);
		if (!batch.length) return;
		const folders = uniqCI(batch.map((b) => b.folder).filter(Boolean));
		const names = uniqCI(batch.map((b) => b.name).filter(Boolean));
		const label = names.length
			? names.slice(0, 3).join('、') + (names.length > 3 ? ` 等 ${names.length} 项` : '')
			: '';
		try {
			await this.recheckExternal({ folders, changed: label });
		} catch (e) {
			console.error('[ExternalLinkManager] drainExternal', e);
		}
		// 处理期间又来了新事件 → 再排一轮（不需要任何标志位来判断）
		if (this.extQueue.length) this.armExtDrain();
	}

	/**
	 * 外部目录变动后的轻量核对：复用已经解析好的 records，只重新判定「存在 / 候选」，
	 * 不重新读取任何笔记。这是「监控不拖慢外部文件读写」的核心。
	 */
	async recheckExternal(opts) {
		opts = opts || {};
		try {
			if (!this.records.length) {
				// 还没有扫描过，那还是得老老实实扫一遍
				await this.scanAll({ silent: true, fix: false, refreshView: true });
				return;
			}
			// evaluateAll 只依赖路径，不依赖笔记正文，所以可以安全地原地重算。
			// 关键：搜索范围只给「发生变动的那些文件夹」，不扩散到其它监控目录。
			const scope = (opts.folders || []).filter((x) => x && exists(x));
			await this.evaluateAll(this.records, null, { roots: scope.length ? scope : null, auto: true });
			this.reindexRecords();
			await this.afterEvaluate({ auto: true, source: 'external' });
			await this.refreshFingerprints(this.records);
			this.settings.cache = { records: this.records, scannedAt: Date.now() };
			this.saveSettingsSoon();
			this.updateStatusBar();
			this.refreshViews();
			if (opts.changed) this.notifyPending(`外部目录变动（${opts.changed}）`);
		} catch (e) {
			console.error('[ExternalLinkManager] recheckExternal', e);
		}
	}

	/**
	 * 自动核对之后统一收尾：
	 *   - 需要确认（默认）→ 把「高置信度唯一候选」标成 pending，不写笔记
	 *   - 不需要确认 → 直接应用
	 * 返回本次被自动改写的条数。
	 */
	async afterEvaluate(opts) {
		opts = opts || {};
		if (!this.settings.enableAutoFix) return 0;
		if (this.settings.requireConfirmBeforeAutoFix) {
			const n = this.markPending(opts.onlyNote);
			if (n && opts.notify !== false) this.notifyPending(opts.source === 'external' ? '外部文件变动' : '');
			return 0;
		}
		return await this.fixAllFixable({ silent: true, onlyNote: opts.onlyNote });
	}

	/**
	 * 把「可修复且置信度达标」的项标成 pending（待确认）。
	 * 低于阈值的仍留作 fixable（本来就需要人工看），不做区分。
	 * 返回新增的待确认条数。
	 */
	markPending(onlyNote) {
		let n = 0;
		const minScore = Number(this.settings.autoFixMinScore) || 0.6;
		for (const r of this.records) {
			if (onlyNote && r.notePath !== onlyNote) continue;
			if (r.status !== 'fixable' || r.lowConfidence) continue;
			const info = r.candidateInfo || [];
			if (!info.length) continue;
			const best = info[0];
			const tied = info.filter((c) => c.score >= best.score - 0.001);
			if (tied.length !== 1) continue;          // 并列 → 交给用户挑，不算「待确认」
			if (best.score < minScore) continue;      // 置信度不够 → 保持 fixable
			r.status = 'pending';
			r.reason = (r.reason || '') + '｜等确认';
			n++;
		}
		return n;
	}

	/** 用户点「确认」：把待确认项一次性写回笔记 */
	async confirmPending(opts) {
		opts = opts || {};
		const n = await this.fixAllFixable({ silent: true, includePending: true });
		if (!opts.silent) {
			new Notice(n ? `已确认并更新 ${n} 处链接` : '没有待确认的项');
		}
		return n;
	}

	/** 待确认条数 */
	countPending() {
		let n = 0;
		for (const r of this.records) if (r.status === 'pending') n++;
		return n;
	}

	/** 统一提示「有 N 处待确认」，点一下就能打开面板 */
	notifyPending(prefix) {
		const n = this.countPending();
		if (!n) {
			if (prefix) this.notifyChange(`${prefix}，已核对链接`);
			return;
		}
		if (this._lastNotify && Date.now() - this._lastNotify < 3000) return;
		this._lastNotify = Date.now();
		const notice = new Notice(
			`${prefix ? prefix + '，' : ''}检测到 ${n} 处外部引用可以更新 —— 点此打开面板确认`,
			9000
		);
		try {
			notice.noticeEl.addClass('elm-notice-clickable');
			notice.noticeEl.onclick = () => { notice.hide(); this.activateView(); };
		} catch (e) { /* noop */ }
	}

	notifyChange(msg) {
		if (this._lastNotify && Date.now() - this._lastNotify < 3000) return;
		this._lastNotify = Date.now();
		new Notice(msg, 4000);
	}

	/* ------------------------------ 扫描 ------------------------------ */

	getVaultBase() {
		const a = this.app.vault.adapter;
		try {
			if (a && typeof a.getBasePath === 'function') return a.getBasePath();
			if (a && a.basePath) return a.basePath;
		} catch (e) { /* noop */ }
		return null;
	}

	isExcludedNote(vaultPath) {
		const p = '/' + String(vaultPath).replace(/\\/g, '/');
		for (const ex of this.settings.excludePaths) {
			if (!ex) continue;
			const e = '/' + String(ex).replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
			if (p === e || p.startsWith(e + '/')) return true;
		}
		if (this.settings.includePaths && this.settings.includePaths.length) {
			let ok = false;
			for (const inc of this.settings.includePaths) {
				if (!inc) continue;
				const i = '/' + String(inc).replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
				if (p === i || p.startsWith(i + '/')) { ok = true; break; }
			}
			if (!ok) return true;
		}
		return false;
	}

	shouldTreatAsExternal(target) {
		if (!looksExternal(target)) return false;
		const abs = toNativePath(target);
		const base = this.getVaultBase();
		if (base && isSubPath(base, abs)) return false; // 指向仓库内部，交给 Obsidian 自己管

		if (isVaultRelativeSlash(target)) {
			if (isWin()) {
				// Windows 下 /xxx 基本是库内绝对路径，不当作外部
				return !!this.settings.treatAllPosixAbsolute;
			}
			if (this.settings.treatAllPosixAbsolute) return true;
			const roots = this.settings.posixRoots || [];
			return roots.some((r) => r && lower(target).startsWith(lower(r)));
		}
		return true;
	}

	/**
	 * 取当前生效的链接识别正则（带缓存）。
	 *
	 * 规则来自设置里的「链接匹配规则」。如果规则写坏了（编译不过），
	 * 这里会**退回默认规则**并记下错误，让插件继续可用，同时在设置页显示红字。
	 */
	getLinkRegex() {
		const src = String(this.settings.linkPattern || DEFAULT_LINK_PATTERN);
		const flags = normalizeLinkFlags(this.settings.linkFlags);
		const key = src + '\u0000' + flags;
		if (this._linkReKey === key) {
			if (this._linkRe) this._linkRe.lastIndex = 0;
			return this._linkRe;
		}
		this._linkReKey = key;
		const r = compileLinkPattern(src, flags);
		if (!r.re) {
			this.linkPatternError = r.error;
			this._linkRe = compileLinkPattern(DEFAULT_LINK_PATTERN, DEFAULT_LINK_FLAGS).re;
			if (!this._linkErrNoticed) {
				this._linkErrNoticed = true;
				new Notice('「链接匹配规则」有误，已临时改用默认规则：' + r.error, 8000);
			}
		} else {
			this.linkPatternError = '';
			this._linkRe = r.re;
		}
		this._linkRe.lastIndex = 0;
		return this._linkRe;
	}

	/** 规则变了之后清掉缓存，下次扫描用新规则 */
	resetLinkRegex() {
		this._linkReKey = null;
		this._linkRe = null;
		this._linkErrNoticed = false;
	}

	extractExternalLinks(notePath, content) {
		const out = [];
		const re = this.getLinkRegex();
		if (!re) return out;
		re.lastIndex = 0;
		let m;
		let seq = 0;
		let guard = 0;
		while ((m = re.exec(content)) !== null) {
			// 病态规则（例如 .* ）可能匹配到空串导致死循环，这里双保险
			if (!m[0]) { re.lastIndex++; if (re.lastIndex > content.length) break; continue; }
			if (++guard > 50000) break;          // 单篇笔记最多认 5 万条，防卡死
			const full = m[0];
			const g = resolveLinkGroups(m);
			if (g.target == null) continue;      // 规则里没有目标路径组，跳过
			let target = g.target;
			const wrapper = detectWrapper(target);
			if (wrapper) target = target.slice(1, -1).trim();
			if (!this.shouldTreatAsExternal(target)) continue;
			const abs = toNativePath(target);
			out.push({
				notePath,
				linkText: g.text,
				isEmbed: g.bang === '!',
				rawTarget: target,
				wrapper,
				wrapped: !!wrapper,
				markup: full,           // 原始完整标记，改写/删除时用它做精确匹配
				style: detectStyle(target),
				absolutePath: abs,
				basename: safeBasename(abs),
				start: m.index,
				end: m.index + full.length,
				line: lineOf(content, m.index),
				seq: seq++,
			});
		}
		return out;
	}

	makeKey(rec) { return rec.notePath + SEP + rec.rawTarget; }

	reindexRecords() {
		this.recordMap = new Map();
		for (const r of this.records) this.recordMap.set(this.makeKey(r), r);
	}

	async scanAll(opts) {
		opts = opts || {};
		if (this._scanRunning) {
			// 不用锁、也不丢弃请求：记一笔，等当前这次跑完自动补跑
			this._scanAgain = true;
			if (opts.notify) new Notice('正在扫描中…结束后会自动再扫一次');
			return;
		}
		this._scanRunning = true;
		try {
			const files = this.app.vault.getMarkdownFiles().filter((f) => !this.isExcludedNote(f.path));
			const all = [];
			const contents = new Map();
			for (const f of files) {
				let c = '';
				try { c = await this.app.vault.cachedRead(f); } catch (e) { continue; }
				contents.set(f.path, c);
				const links = this.extractExternalLinks(f.path, c);
				for (const l of links) all.push(l);
			}
			await this.evaluateAll(all, contents);
			this.records = all;
			this.reindexRecords();
			// 自动路径：按「是否需要确认」决定直接改写还是只标待确认
			if (opts.fix) await this.afterEvaluate({ auto: true, source: opts.source || 'scan' });
			// 给当前正常的文件补内容指纹，供以后「只改名」时识别
			await this.refreshFingerprints(this.records);
			this.settings.cache = { records: all, scannedAt: Date.now() };
			// 限流落盘：这次扫描可能要写几百 KB，别阻塞 UI
			this.saveSettingsSoon();
			this.updateStatusBar();
			if (opts.refreshView) this.refreshViews();
			if (opts.notify) {
				const broken = all.filter((r) => r.status !== 'ok' && r.status !== 'ignored').length;
				const pend = this.countPending();
				new Notice(`外部引用扫描完成：共 ${all.length} 处，待处理 ${broken} 处` +
					(pend ? `（其中 ${pend} 处待确认）` : ''));
			}
		} finally {
			this._scanRunning = false;
			if (this._scanAgain) {
				this._scanAgain = false;
				window.setTimeout(() => this.scanAll({ silent: true, refreshView: true }), 300);
			}
		}
	}

	async scanFile(file, opts) {
		opts = opts || {};
		if (!file || file.extension !== 'md') return;
		if (this.isExcludedNote(file.path)) return;
		let content = '';
		try { content = await this.app.vault.cachedRead(file); } catch (e) { return; }
		const links = this.extractExternalLinks(file.path, content);
		const contents = new Map([[file.path, content]]);
		await this.evaluateAll(links, contents);
		// 合并进总记录（先合并，再修复，修复逻辑依赖 this.records）
		const others = this.records.filter((r) => r.notePath !== file.path);
		this.records = others.concat(links);
		this.reindexRecords();
		if (opts.fix) await this.afterEvaluate({ auto: true, source: opts.source || 'file', onlyNote: file.path, notify: false });
		// 只刷新本篇笔记引用到的文件：其它记录的指纹没必要在每次敲键盘后重算
		await this.refreshFingerprints(links, { skipCleanup: true });
		this.updateStatusBar();
		if (opts.refreshView) this.refreshViews();
		if (opts.notify) {
			const broken = links.filter((r) => r.status !== 'ok' && r.status !== 'ignored').length;
			new Notice(`本笔记外部引用 ${links.length} 处，待处理 ${broken} 处`);
		}
	}

	/* --------------------------- 状态判定 ----------------------------- */

	async evaluateAll(recs, contents, opts) {
		opts = opts || {};
		// 1) 先判定「存在 / 被忽略」
		const needSearch = [];
		for (const r of recs) {
			r.key = this.makeKey(r);
			r.ignored = this.settings.ignored.indexOf(r.key) >= 0;
			r.note = this.settings.notes[r.key] || '';
			r.exists = exists(r.absolutePath);
			r.kind = r.exists ? (statType(r.absolutePath) || 'file') : (/[\\/]$/.test(r.rawTarget) ? 'folder' : 'file');
			r.monitored = this.isUnderMonitored(r.absolutePath);
			r.candidates = [];
			r.candidateInfo = [];
			r.reason = '';
			r.lowConfidence = false;
			if (r.ignored) { r.status = 'ignored'; continue; }
			if (r.exists) { r.status = 'ok'; continue; }
			needSearch.push(r);
		}
		if (!needSearch.length) return;

		// 2) 用户名 / 盘符重映射（成本极低，先做）
		const stillMissing = [];
		for (const r of needSearch) {
			const home = this.settings.remapUserProfile ? this.remapUserProfile(r.absolutePath) : null;
			if (home && home !== r.absolutePath && exists(home)) {
				r.status = 'fixable';
				r.candidates = [home];
				r.reason = '用户目录（用户名）变更';
				continue;
			}
			const drv = this.remapDrive(r.absolutePath);
			if (drv && drv !== r.absolutePath && exists(drv)) {
				r.status = 'fixable';
				r.candidates = [drv];
				r.reason = '盘符变更';
				continue;
			}
			stillMissing.push(r);
		}
		if (!stillMissing.length) return;

		// 3) 多策略找候选：文件名一致 / 内容指纹一致 / 名称相似（改名）
		const candMap = await this.collectCandidates(stillMissing, opts);
		for (const r of stillMissing) {
			const list = (candMap.get(r) || []).filter((c) => c.score >= 0.35);
			if (!list.length) {
				r.status = 'missing';
				r.candidates = [];
				r.candidateInfo = [];
				continue;
			}
			r.candidateInfo = list.slice(0, 12);
			r.candidates = r.candidateInfo.map((c) => c.path);
			const best = list[0];
			const t = statType(best.path);
			if (t) r.kind = t; // 用候选的真实类型修正「文件 / 文件夹」
			const tied = list.filter((c) => c.score >= best.score - 0.001);
			const detail = `${best.reason}（置信度 ${best.score.toFixed(2)}）`;
			if (tied.length === 1 && best.score >= this.settings.autoFixMinScore) {
				r.status = 'fixable';
				r.reason = detail;
			} else if (tied.length === 1) {
				r.status = 'fixable';
				r.reason = detail + '，低于自动修复阈值，需确认';
				r.lowConfidence = true;
			} else {
				r.status = 'ambiguous';
				r.reason = `有 ${tied.length} 个候选（最佳：${best.reason}），需人工确认`;
			}
		}
	}

	/**
	 * 汇总一个记录的所有候选来源，按路径去重、按分数排序。
	 * 返回 Map<record, [{path, score, reason}]>
	 */
	async collectCandidates(recs, opts) {
		const out = new Map();
		if (!recs || !recs.length) return out;
		opts = opts || {};
		// 搜索根目录只求值一次（里面带 fs.existsSync，别放进循环）。
		// opts.roots 用于「外部变动核对」——只搜发生变动的那一个文件夹，别扩散到其它监控目录。
		const roots = (opts.roots && opts.roots.length) ? opts.roots : this.getSearchRoots();

		// A) 文件名完全一致
		const byName = await this.findCandidates(recs, roots, opts);
		// B) 内容指纹一致（识别「只改了名、内容没变」）
		const byContent = await this.findByContent(recs, roots, opts);
		// C) 名称相似（改名）—— 成本最高，只在 A/B 都没结果时才做
		const needRename = recs.filter((r) => {
			if ((byName.get(lower(r.basename)) || []).length) return false;
			if ((byContent.get(lower(r.absolutePath)) || []).length) return false;
			return true;
		});
		const byRenamed = needRename.length ? await this.findRenamedCandidates(needRename, roots, opts) : new Map();

		for (const r of recs) {
			const m = new Map();
			const add = (p, score, reason) => {
				if (!p) return;
				// 防御性过滤：候选必须落在配置的搜索范围内，
				// 否则宁可没有候选，也不要把用户没监控的位置塞进推荐列表。
				if (!isInRoots(p, roots)) return;
				const k = lower(p);
				const cur = m.get(k);
				if (!cur || score > cur.score) m.set(k, { path: p, score: Math.min(1, score), reason });
			};
			for (const p of byName.get(lower(r.basename)) || []) {
				add(p, this.scoreCandidate(r.absolutePath, p), '文件名一致');
			}
			for (const c of byContent.get(lower(r.absolutePath)) || []) {
				add(c.path, c.score, c.reason);
			}
			for (const c of byRenamed.get(lower(r.basename)) || []) {
				add(c.path, c.score, `名称相似 ${c.nameSim.toFixed(2)}（疑似改名）`);
			}
			const list = Array.from(m.values()).sort((a, b) => b.score - a.score);
			if (list.length) out.set(r, list);
		}
		return out;
	}

	/** 供 UI 按需重算某一条记录的候选（「重新指向」用） */
	async candidatesForRecord(rec) {
		const map = await this.collectCandidates([rec]);
		const list = map.get(rec) || [];
		rec.candidateInfo = list.slice(0, 12);
		rec.candidates = rec.candidateInfo.map((c) => c.path);
		return rec.candidateInfo;
	}

	/**
	 * 路径是否在「监控文件夹」内 —— 这是唯一的范围判定。
	 *
	 * 「范围内」= 链接目标落在某个启用的监控文件夹里：会被实时监听，改名/移动能被发现。
	 * 「范围外」= 扫描仓库时在 Markdown 里扫到了外部链接，但目标不在任何监控文件夹里。
	 */
	isUnderMonitored(p) {
		if (!p) return false;
		for (const f of this.settings.monitoredFolders) {
			if (f && f.enabled !== false && f.path && isSubPath(f.path, p)) return true;
		}
		return false;
	}

	/** 命中该路径的监控文件夹（用于显示归属），没命中返回 null */
	matchedMonitoredFolder(p) {
		if (!p) return null;
		let best = null;
		for (const f of this.settings.monitoredFolders) {
			if (!f || f.enabled === false || !f.path) continue;
			if (!isSubPath(f.path, p)) continue;
			// 嵌套时取最具体（路径最长）的那个
			if (!best || String(f.path).length > String(best.path).length) best = f;
		}
		return best;
	}

	remapUserProfile(p) {
		if (!os) return null;
		const home = os.homedir();
		if (!home) return null;
		// C:\Users\xxx\...  ->  <home>\...
		let m = String(p).match(/^([A-Za-z]:\\Users\\)([^\\]+)(\\[\s\S]*)?$/);
		if (m) {
			const cur = safeBasename(home);
			if (lower(m[2]) !== lower(cur)) return joinPath(home, (m[3] || '').replace(/^\\/, ''));
			return null;
		}
		m = String(p).match(/^([A-Za-z]:\\Documents and Settings\\)([^\\]+)(\\[\s\S]*)?$/);
		if (m) return joinPath(home, (m[3] || '').replace(/^\\/, ''));
		m = String(p).match(/^\/(?:home|Users)\/([^/]+)(\/[\s\S]*)?$/);
		if (m) {
			const cur = safeBasename(home);
			if (lower(m[1]) !== lower(cur)) return (m[2] || '') ? home + m[2] : home;
		}
		return null;
	}

	remapDrive(p) {
		const map = this.parseDriveRemap();
		if (!map.length) return null;
		for (const [from, to] of map) {
			const re = new RegExp('^' + from + '(?=[\\\\/])', 'i');
			if (re.test(p)) {
				const rest = String(p).slice(from.length);
				return to + rest;
			}
		}
		return null;
	}

	parseDriveRemap() {
		const out = [];
		const lines = String(this.settings.driveRemap || '').split(/\r?\n/);
		for (const line of lines) {
			const t = line.trim();
			if (!t) continue;
			const m = t.match(/^([A-Za-z]:)\s*(?:=|->|→|=>)\s*([A-Za-z]:)/);
			if (m) out.push([m[1], m[2]]);
		}
		return out;
	}

	/**
	 * 候选路径打分（0~1）
	 *  - 文件名一致只是入场券（0.35 基础分）
	 *  - 保留的「父级目录后缀」越多分越高（这才是真正的证据）
	 *  - 新旧目录互为父子（例如移进子文件夹）额外加分
	 */
	scoreCandidate(oldPath, cand) {
		const a = segments(oldPath).map(lower);
		const b = segments(cand).map(lower);
		if (!a.length || !b.length) return 0;
		if (lower(oldPath) === lower(cand)) return 1;

		let common = 0;
		while (common < a.length && common < b.length &&
			a[a.length - 1 - common] === b[b.length - 1 - common]) common++;

		const oldParentLen = a.length - 1;             // 旧路径的父级段数
		const parentCommon = Math.max(0, common - 1);  // 匹配上的父级段数（不含文件名）
		let score = oldParentLen === 0
			? 1
			: 0.35 + 0.65 * Math.min(1, parentCommon / oldParentLen);

		const oldDir = lower(safeDirname(oldPath));
		const newDir = lower(safeDirname(cand));
		if (oldDir && newDir) {
			const sep = isWin() ? '\\' : '/';
			const nested = newDir.startsWith(oldDir + sep) || oldDir.startsWith(newDir + sep) ||
				newDir.startsWith(oldDir + '/') || oldDir.startsWith(newDir + '/');
			if (nested) score += 0.3;
		}
		if (a[0] && b[0] && a[0] === b[0]) score += 0.03; // 同盘
		return Math.min(1, score);
	}

	/**
	 * 允许搜索的根目录 = 启用的监控文件夹（+ 可选的仓库自身）。
	 *
	 * 只有一份范围，就叫「监控文件夹」：
	 *   - 这里列出的目录会被 fs.watch 监听 → 变动能被发现
	 *   - 找新位置时也只在这些目录里翻
	 *   - 因此「范围内 / 范围外」= 「链接目标是否落在监控文件夹里」
	 * 不要再引入任何「只搜索不监听」的目录，否则两套口径会打架。
	 */
	getSearchRoots() {
		const roots = [];
		for (const f of this.settings.monitoredFolders) {
			if (f && f.enabled !== false && f.path) roots.push(f.path);
		}
		if (this.settings.alsoSearchVault) {
			const b = this.getVaultBase();
			if (b) roots.push(b);
		}
		// 不要在这里加 os.homedir() 之类的系统目录——那会让推荐列表里出现
		// 用户根本没监控的位置（例如桌面上碰巧同名的文件）。
		return uniqCI(roots).filter((r) => exists(r));
	}

	/** 候选是否落在允许的范围内（防御性过滤，避免任何路径混进来） */
	isInSearchScope(p) {
		if (!p) return false;
		return isInRoots(p, this.getSearchRoots());
	}

	/** 给 UI 用：当前范围的可读描述 */
	describeSearchScope() {
		const roots = this.getSearchRoots();
		if (!roots.length) return '未配置（请先添加监控文件夹）';
		return roots.join('、');
	}

	/**
	 * 为一批「已失效」记录查找同名文件的新位置。
	 * 优化点：
	 *   1. 只搜索这些记录用到的文件名，不是建全量索引
	 *   2. 找到就提前结束，不再遍历后续（更慢的）根目录
	 *   3. 结果按文件名持久化缓存，下次直接命中（失效路径会被自动剔除）
	 * 返回 Map<小写文件名, 路径数组>
	 */
	async findCandidates(recs, rootsArg, opts) {
		const result = new Map();
		if (!recs || !recs.length) return result;
		const roots = rootsArg || this.getSearchRoots();
		const wanted = uniqCI(recs.map((r) => lower(r.basename))).filter(Boolean);
		if (!wanted.length) return result;

		if (!this.settings.indexCache || typeof this.settings.indexCache !== 'object') this.settings.indexCache = {};
		const cache = this.settings.indexCache;

		// 1) 命中缓存
		//    注意：缓存里可能残留「上一次搜索范围」里的路径（比如早期版本搜过用户主目录）。
		//    必须同时满足「存在」且「在当前搜索范围内」，否则不仅候选是错的，
		//    还会因为误判为「已找到」而跳过真正的遍历，导致正确的候选永远出不来。
		const remain = new Set();
		for (const name of wanted) {
			const c = cache[name];
			if (Array.isArray(c) && c.length) {
				const alive = c.filter((p) => exists(p) && isInRoots(p, roots));
				if (alive.length) { result.set(name, alive); continue; }
				delete cache[name]; // 缓存已失效或已不在范围内
			}
			remain.add(name);
		}
		if (!remain.size) return result;

		// 2) 遍历搜索根目录
		const walkOpts = {
			maxDepth: Number(this.settings.maxSearchDepth) || 5,
			maxFiles: walkCap(this.settings, opts),
		};
		for (const root of roots) {
			await walkDir(root, walkOpts, (full, name) => {
				const k = lower(name);
				if (!remain.has(k)) return;
				if (!result.has(k)) result.set(k, []);
				const arr = result.get(k);
				if (arr.length < 50) arr.push(full);
			});
			for (const k of Array.from(remain)) if (result.has(k)) remain.delete(k);
			if (!remain.size) break; // 全部找到，提前结束
		}

		// 3) 写回缓存（只缓存找到的，体积很小）
		let changed = false;
		for (const name of wanted) {
			const v = result.get(name);
			if (v && v.length) { cache[name] = v.slice(0, 50); changed = true; }
		}
		if (changed) this.saveSettingsSoon();
		return result;
	}

	clearCandidateCache() {
		this.settings.indexCache = {};
		return this.saveSettings();
	}

	/* --------------------------- 内容指纹 ----------------------------- */

	hashMaxBytes() {
		return Math.max(1, Number(this.settings.hashMaxSizeMB) || 64) * 1024 * 1024;
	}

	/**
	 * 给「当前正常」的外部文件记录内容指纹。
	 * 只对链接引用到的文件算（数量很小），且 size + mtime 没变就复用旧指纹，
	 * 所以后续扫描几乎零开销。
	 */
	async refreshFingerprints(recs, opts) {
		opts = opts || {};
		if (!this.settings.detectByContent || !crypto) return;
		if (!this.settings.fileIndex || typeof this.settings.fileIndex !== 'object') this.settings.fileIndex = {};
		const idx = this.settings.fileIndex;
		const maxBytes = this.hashMaxBytes();
		const alive = new Set();
		let changed = false;
		let lastYield = Date.now();

		for (const r of recs) {
			if (!r || !r.absolutePath) continue;
			alive.add(lower(r.absolutePath));
			if (r.status !== 'ok' || r.kind !== 'file') continue;
			let st;
			// 异步 stat：同步 statSync 会在记录多的时候卡住主线程
			try { st = await fs.promises.stat(r.absolutePath); } catch (e) { continue; }
			if (!st.isFile() || st.size > maxBytes) continue;
			const key = lower(r.absolutePath);
			const prev = idx[key];
			if (prev && prev.hash && prev.size === st.size && prev.mtimeMs === st.mtimeMs) {
				prev.at = Date.now();
				continue;
			}
			const h = await fileHash(r.absolutePath, this.settings.hashAlgo);
			if (!h) continue;
			idx[key] = { path: r.absolutePath, size: st.size, mtimeMs: st.mtimeMs, hash: h, at: Date.now() };
			changed = true;
			if (Date.now() - lastYield > 16) { lastYield = Date.now(); await sleep(0); }
		}

		// 清理：文件已不存在、且不再被任何记录引用的旧指纹。
		// 只在「传进来的是全量记录」时才做——否则 alive 集合不全，会误删别的笔记的指纹。
		const keys = Object.keys(idx);
		if (!opts.skipCleanup && keys.length > 100) {
			const cutoff = Date.now() - 90 * 24 * 3600 * 1000;
			for (const k of keys) {
				if (alive.has(k)) continue;
				const e = idx[k];
				if (e && e.path && !exists(e.path) && (!e.at || e.at < cutoff)) {
					delete idx[k];
					changed = true;
				}
			}
		}
		if (changed) this.saveSettingsSoon();
	}

	/**
	 * 按内容指纹找新位置。
	 * 先用「文件大小」把候选缩到极小集合，再逐个算指纹比对 ——
	 * 这样即使文件被彻底改名（file1 → 完全不相干的名字）也能认出来。
	 */
	async findByContent(recs, rootsArg, opts) {
		const out = new Map();
		if (!this.settings.detectByContent || !crypto) return out;
		const roots = rootsArg || this.getSearchRoots();
		const idx = this.settings.fileIndex || {};
		const maxBytes = this.hashMaxBytes();

		const tasks = [];
		for (const r of recs) {
			const fp = idx[lower(r.absolutePath)];
			if (fp && fp.hash && fp.size != null && fp.size <= maxBytes) tasks.push({ rec: r, fp });
		}
		if (!tasks.length) return out;

		const sizes = new Set(tasks.map((t) => t.fp.size));
		const sameSize = new Map(); // size -> [{path, mtimeMs}]
		const walkOpts = {
			maxDepth: Number(this.settings.maxSearchDepth) || 5,
			maxFiles: walkCap(this.settings, opts),
		};
		// 先把范围内的文件路径收集起来（walkDir 本身是异步的），
		// 再用异步 stat 取大小 —— 不要在这里用 statSync，
		// 大目录下成千上万次同步 stat 会把 Obsidian 主线程卡死。
		const found = [];
		for (const root of roots) {
			await walkDir(root, walkOpts, (full) => { found.push(full); });
		}
		let lastYield = Date.now();
		for (const full of found) {
			let st;
			try { st = await fs.promises.stat(full); } catch (e) { continue; }
			if (!st.isFile() || !sizes.has(st.size)) continue;
			if (!sameSize.has(st.size)) sameSize.set(st.size, []);
			const arr = sameSize.get(st.size);
			if (arr.length < 200) arr.push({ path: full, mtimeMs: st.mtimeMs });
			if (Date.now() - lastYield > 16) { lastYield = Date.now(); await sleep(0); }
		}

		const algo = this.settings.hashAlgo || 'sha256';
		for (const t of tasks) {
			const cands = sameSize.get(t.fp.size) || [];
			if (!cands.length) continue;
			const hits = [];
			for (const c of cands) {
				if (lower(c.path) === lower(t.rec.absolutePath)) continue;
				const h = await fileHash(c.path, algo);
				if (h && h === t.fp.hash) {
					hits.push({ path: c.path, score: 1, reason: '内容完全相同（指纹一致）' });
				}
			}
			if (hits.length) out.set(lower(t.rec.absolutePath), hits);
		}
		return out;
	}

	/**
	 * 父级目录路径的重合度（0~1）：用于「改名」场景。
	 * 注意两边都要取「父目录」再比 —— 候选自身就是那个被改名的目录，
	 * 拿它当路径末段去比会永远比不中。
	 */
	dirScore(oldPath, cand) {
		const a = segments(safeDirname(oldPath)).map(lower);
		const b = segments(safeDirname(cand)).map(lower);
		if (!a.length) return 1;
		let common = 0;
		while (common < a.length && common < b.length &&
			a[a.length - 1 - common] === b[b.length - 1 - common]) common++;
		return common / a.length;
	}

	/**
	 * 改名匹配：目标被改名（file1 → file11、xxx.txt → xxx1.txt）时文件名对不上，
	 * 只能靠「名称相似度 + 父目录重合度」来猜。**文件和文件夹都参与匹配。**
	 * 门槛卡得很死（名称相似度 ≥ 0.85 且父目录重合度 ≥ 0.5），并且先用
	 * 「首字符一致 + 长度差 ≤ 8」做廉价预筛，避免对几万个文件算编辑距离。
	 */
	async findRenamedCandidates(recs, rootsArg, opts) {
		const out = new Map();
		if (!recs || !recs.length) return out;
		const roots = rootsArg || this.getSearchRoots();

		const refs = recs.map((r) => {
			const n = lower(r.basename);
			return { rec: r, name: n, first: n.charCodeAt(0), len: n.length, hits: new Map() };
		});

		const consider = (full, name) => {
			const n = lower(name);
			const first = n.charCodeAt(0);
			const len = n.length;
			for (const rf of refs) {
				if (n === rf.name) continue;                       // 完全同名走精确匹配那条路
				if (first !== rf.first) continue;                  // 廉价预筛 1：首字符
				if (Math.abs(len - rf.len) > 8) continue;          // 廉价预筛 2：长度
				const ns = nameSimilarity(rf.name, n);
				if (ns < 0.85) continue;
				const ds = this.dirScore(rf.rec.absolutePath, full);
				if (ds < 0.5) continue;
				const a = segments(rf.rec.absolutePath).map(lower);
				const b = segments(full).map(lower);
				let score = 0.35 * ns + 0.65 * ds;
				if (a[0] && b[0] && a[0] === b[0]) score += 0.03;
				rf.hits.set(lower(full), { path: full, score: Math.min(1, score), nameSim: ns });
			}
		};

		const walkOpts = {
			maxDepth: Number(this.settings.maxSearchDepth) || 5,
			maxFiles: walkCap(this.settings, opts),
		};
		for (const root of roots) {
			// 文件和文件夹都要看
			await walkDir(root, walkOpts, (full, name) => consider(full, name), (full, name) => consider(full, name));
		}

		for (const rf of refs) {
			if (!rf.hits.size) continue;
			out.set(rf.name, Array.from(rf.hits.values()).sort((x, y) => y.score - x.score));
		}
		return out;
	}

	/* ------------------------------ 修复 ------------------------------ */

	async fixAllFixable(opts) {
		opts = opts || {};
		let n = 0;
		const minScore = Number(this.settings.autoFixMinScore) || 0.6;
		const list = this.records.filter((r) => {
			if (opts.onlyNote && r.notePath !== opts.onlyNote) return false;
			// pending = 用户已确认过的「高置信度唯一候选」；fixable = 其它可修复项
			const wantPending = opts.includePending && r.status === 'pending';
			if (r.status !== 'fixable' && !wantPending) return false;
			const info = r.candidateInfo || [];
			if (!info.length) return false;
			// 关键：只看「并列最高分是否唯一」，不看候选总数。
			// 一条记录可以带多个低分候选，只要第一名明显领先就可以自动应用。
			const best = info[0];
			const tied = info.filter((c) => c.score >= best.score - 0.001);
			if (tied.length !== 1) return false;
			// pending 是用户点过确认的，阈值已经在那一步卡过了
			if (!wantPending && !opts.force && best.score < minScore) return false;
			return true;
		});
		for (const r of list) {
			const reason = r.status === 'pending' ? '用户确认后更新' : (r.reason || '自动修复');
			const ok = await this.applyFix(r, r.candidateInfo[0].path, reason);
			if (ok) n++;
		}
		if (n > 0) {
			this.updateStatusBar();
			this.refreshViews();
			if (!opts.silent) new Notice(`已修复 ${n} 处外部引用`);
		}
		return n;
	}

	/** 记录在笔记中的原始标记（用于精确匹配；优先用扫描时抓到的原文） */
	oldMarkupOf(rec) {
		if (rec.markup) return rec.markup;
		return buildMarkup(rec.isEmbed, rec.linkText, rec.rawTarget, rec.wrapper, false);
	}

	/** 把记录的目标路径改到 newPath（写回笔记） */
	async applyFix(rec, newPath, reason) {
		const file = this.app.vault.getAbstractFileByPath(rec.notePath);
		if (!(file instanceof TFile)) return false;
		const style = rec.style || detectStyle(rec.rawTarget);
		const target = formatTarget(newPath, style);
		const oldFull = this.oldMarkupOf(rec);
		const newFull = buildMarkup(rec.isEmbed, rec.linkText, target, rec.wrapper, this.settings.wrapPathsWithSpaces);
		return this.replaceInNote(file, rec, oldFull, newFull, reason, newPath);
	}

	/** 用户手动编辑映射（改链接文本 / 改目标路径） */
	async applyEdit(rec, newText, newPath, reason) {
		const file = this.app.vault.getAbstractFileByPath(rec.notePath);
		if (!(file instanceof TFile)) return false;
		const style = rec.style || detectStyle(rec.rawTarget);
		const target = formatTarget(newPath, style);
		const oldFull = this.oldMarkupOf(rec);
		const newFull = buildMarkup(rec.isEmbed, newText, target, rec.wrapper, this.settings.wrapPathsWithSpaces);
		return this.replaceInNote(file, rec, oldFull, newFull, reason || '手动编辑', newPath, newText);
	}

	/** 从笔记中删除：整条链接（含显示文字）一起删掉 */
	async removeLink(rec) {
		const file = this.app.vault.getAbstractFileByPath(rec.notePath);
		if (!(file instanceof TFile)) return false;
		const oldFull = this.oldMarkupOf(rec);
		let removed = 0;
		await this.withWrite(file.path, async () => {
			await this.app.vault.process(file, (data) => {
				const lines = data.split('\n');
				// 情况 1：整行就是这条链接（可能带前后空白）→ 整行删掉
				for (let i = 0; i < lines.length; i++) {
					if (lines[i].trim() === oldFull) {
						lines.splice(i, 1);
						// 删完如果上下都是空行，合并成一个（避免留下双空行）
						if (i > 0 && i < lines.length &&
							lines[i - 1].trim() === '' && lines[i].trim() === '') {
							lines.splice(i, 1);
						}
						removed = 1;
						return lines.join('\n');
					}
				}
				// 情况 2：行内还有别的内容 → 只摘掉标记，并清理连接处的多余空格
				for (let i = 0; i < lines.length; i++) {
					const at = lines[i].indexOf(oldFull);
					if (at < 0) continue;
					const before = lines[i].slice(0, at);
					const after = lines[i].slice(at + oldFull.length);
					let joined;
					if (before.trim() === '') joined = after.replace(/^[ \t]+/, '');
					else if (after.trim() === '') joined = before.replace(/[ \t]+$/, '');
					else if (/[ \t]$/.test(before) && /^[ \t]/.test(after)) {
						joined = before.replace(/[ \t]+$/, '') + after;
					} else joined = before + after;
					lines[i] = joined.replace(/[ \t]+$/, '');
					if (lines[i].trim() === '') lines.splice(i, 1);
					removed = 1;
					return lines.join('\n');
				}
				return data;
			});
		});
		if (!removed) {
			new Notice('未能在笔记中定位到该链接，可能已被修改：' + rec.notePath);
			return false;
		}
		this.records = this.records.filter((x) => x !== rec);
		this.reindexRecords();
		this.recordChange(rec, rec.absolutePath, '(整条已删除)', '删除链接');
		await this.saveSettings();
		this.updateStatusBar();
		this.refreshViews();
		return true;
	}

	/** 在笔记中插入一条新链接 */
	async addLink(notePath, linkText, targetPath, opts) {
		opts = opts || {};
		const file = this.app.vault.getAbstractFileByPath(notePath);
		if (!(file instanceof TFile)) return false;
		const style = isWin() ? 'windows' : 'posix';
		let target = formatTarget(targetPath, style);
		const wrap = this.settings.wrapPathsWithSpaces && /\s/.test(target);
		const md = '[' + (linkText || safeBasename(targetPath)) + '](' + (wrap ? '<' + target + '>' : target) + ')';
		await this.withWrite(file.path, async () => {
			await this.app.vault.process(file, (data) => {
				const nl = data.endsWith('\n') || data.length === 0 ? '' : '\n';
				return data + nl + (opts.newline === false ? '' : '\n') + md + '\n';
			});
		});
		await this.scanFile(file, { silent: true });
		this.refreshViews();
		return true;
	}

	/** 把内容写回笔记（先精确匹配，匹配不到则退化为按行查找） */
	async replaceInNote(file, rec, oldFull, newFull, reason, newPath, newText) {
		if (oldFull === newFull) return false;
		let replaced = 0;
		await this.withWrite(file.path, async () => {
			await this.app.vault.process(file, (data) => {
				if (data.indexOf(oldFull) >= 0) {
					replaced = data.split(oldFull).length - 1;
					return data.split(oldFull).join(newFull);
				}
				// 退化：按行内 oldTarget 定位
				const lines = data.split('\n');
				const idx = Math.max(0, (rec.line || 1) - 1);
				for (let d = 0; d < lines.length; d++) {
					const i = idx + d;
					if (i < lines.length && lines[i].indexOf(rec.rawTarget) >= 0) {
						lines[i] = lines[i].split(rec.rawTarget).join(
							newFull.slice(newFull.indexOf('(') + 1, newFull.length - 1)
						);
						replaced = 1;
						return lines.join('\n');
					}
					const j = idx - d;
					if (d > 0 && j >= 0 && lines[j].indexOf(rec.rawTarget) >= 0) {
						lines[j] = lines[j].split(rec.rawTarget).join(
							newFull.slice(newFull.indexOf('(') + 1, newFull.length - 1)
						);
						replaced = 1;
						return lines.join('\n');
					}
				}
				return data;
			});
		});
		if (!replaced) {
			new Notice('未能在笔记中定位到原链接，可能已被修改：' + rec.notePath);
			return false;
		}
		// 更新内存记录
		const oldPath = rec.absolutePath;
		const oldKey = rec.key;
		{
			const inner = newFull.slice(newFull.indexOf('(') + 1, newFull.length - 1);
			const w = detectWrapper(inner);
			rec.wrapper = w;
			rec.wrapped = !!w;
			rec.rawTarget = w ? inner.slice(1, -1).trim() : inner;
			rec.markup = newFull;
		}
		if (newText != null) rec.linkText = newText;
		if (newPath) {
			rec.absolutePath = newPath;
			rec.basename = safeBasename(newPath);
			rec.exists = exists(newPath);
			rec.status = rec.exists ? 'ok' : 'missing';
			rec.candidates = [];
			rec.reason = '';
		}
		rec.key = this.makeKey(rec);
		// 备注随 key 迁移，避免编辑后丢失
		if (oldKey && oldKey !== rec.key && this.settings.notes && this.settings.notes[oldKey] != null) {
			this.settings.notes[rec.key] = this.settings.notes[oldKey];
			delete this.settings.notes[oldKey];
			rec.note = this.settings.notes[rec.key];
		}
		this.recordChange(rec, oldPath, newPath || rec.absolutePath, reason);
		this.reindexRecords();
		this.updateStatusBar();
		await this.saveSettings();
		await this.writeChangeLog(rec, oldPath, newPath || rec.absolutePath, reason);
		this.refreshViews();
		return true;
	}

	/** 记录一条变更历史（持久化，最多 300 条） */
	recordChange(rec, from, to, reason) {
		if (!Array.isArray(this.settings.recentChanges)) this.settings.recentChanges = [];
		this.settings.recentChanges.push({
			at: ts(), note: rec.notePath, text: rec.linkText, from: from, to: to, reason: reason || '',
		});
		if (this.settings.recentChanges.length > 300) {
			this.settings.recentChanges = this.settings.recentChanges.slice(-300);
		}
	}

	changesFor(notePath, limit) {
		const all = (this.settings.recentChanges || []).filter((c) => c.note === notePath);
		return all.slice(-(limit || 5)).reverse();
	}

	async withWrite(notePath, fn) {
		this.writing.add(notePath);
		try { await fn(); } finally {
			window.setTimeout(() => this.writing.delete(notePath), 1200);
		}
	}

	/** 变更日志的仓库内路径：没配置就用插件自己的目录 */
	changeLogFullPath() {
		const custom = (this.settings.changeLogPath || '').trim();
		if (custom) return normalizePath(custom);
		const dir = (this.manifest && this.manifest.dir) || ('.obsidian/plugins/' + ((this.manifest && this.manifest.id) || 'external-link-manager'));
		return normalizePath(dir + '/change-log.md');
	}

	async writeChangeLog(rec, from, to, reason) {
		if (!this.settings.writeChangeLog) return;
		try {
			const p = this.changeLogFullPath();
			const line = `- ${ts()} | [[${rec.notePath.replace(/\.md$/, '')}]] | \`${from}\` → \`${to}\` | ${reason || ''}\n`;
			const af = this.app.vault.getAbstractFileByPath(p);
			if (af instanceof TFile) {
				await this.app.vault.modify(af, await this.app.vault.read(af) + line);
			} else {
				await this.app.vault.create(p, '# 外部引用变更日志\n\n' + line);
			}
		} catch (e) { /* 日志失败不影响主流程 */ }
	}

	/* --------------------------- 打开 / 定位 --------------------------- */

	async openNoteAtLine(notePath, line) {
		const file = this.app.vault.getAbstractFileByPath(notePath);
		if (!(file instanceof TFile)) { new Notice('笔记不存在：' + notePath); return; }
		const leaf = this.app.workspace.getLeaf(false);
		await leaf.openFile(file, { eState: { line: Math.max(0, (line || 1) - 1) } });
	}

	openExternal(p) {
		try {
			if (electron && electron.shell) {
				if (electron.shell.openPath) { electron.shell.openPath(p); return; }
				if (electron.shell.openExternal) { electron.shell.openExternal('file:///' + p.replace(/\\/g, '/')); return; }
			}
		} catch (e) { /* noop */ }
		new Notice('无法打开：' + p);
	}

	revealExternal(p) {
		try {
			if (electron && electron.shell && electron.shell.showItemInFolder) {
				electron.shell.showItemInFolder(p);
				return;
			}
			if (electron && electron.shell && electron.shell.openPath) {
				electron.shell.openPath(safeDirname(p));
				return;
			}
		} catch (e) { /* noop */ }
		new Notice('无法定位：' + p);
	}

	/* ------------------------------ 忽略 ------------------------------ */

	toggleIgnore(rec) {
		const k = rec.key || this.makeKey(rec);
		const i = this.settings.ignored.indexOf(k);
		if (i >= 0) { this.settings.ignored.splice(i, 1); rec.status = rec.exists ? 'ok' : 'missing'; }
		else { this.settings.ignored.push(k); rec.status = 'ignored'; }
		this.saveSettings();
		this.refreshViews();
	}

	/* ------------------------------ 插入 ------------------------------ */

	openInsertModal(editor) {
		new FsBrowserModal(this.app, this, {
			mode: 'both',
			title: '选择要插入的外部文件/文件夹',
			onChoose: (p, kind) => {
				const style = isWin() ? 'windows' : 'posix';
				let target = formatTarget(p, style);
				const wrap = this.settings.wrapPathsWithSpaces && /\s/.test(target);
				const md = '[' + safeBasename(p) + '](' + (wrap ? '<' + target + '>' : target) + ')';
				if (editor) editor.replaceSelection(md);
			},
		}).open();
	}

	/* ------------------------------ 导出 ------------------------------ */

	async exportCsv() {
		const head = ['状态', '笔记', '行号', '链接文本', '目标路径', '类型', '范围', '命中监控文件夹', '推荐候选', '说明'];
		const rows = [head.map(csvCell).join(EXPORT_SEP)];
		for (const r of this.sortedRecords()) {
			const cands = (r.candidateInfo || [])
				.map((c) => `${c.path} (${Number(c.score).toFixed(2)} ${c.reason || ''})`)
				.join(' | ');
			const mf = r.monitored ? this.matchedMonitoredFolder(r.absolutePath) : null;
			rows.push([
				statusLabel(r.status), r.notePath, r.line, r.linkText, r.absolutePath,
				r.kind === 'folder' ? '文件夹' : '文件',
				r.monitored ? '监控文件夹内' : '监控文件夹外',
				mf ? (mf.label ? `${mf.label} (${mf.path})` : mf.path) : '',
				cands, r.reason || '',
			].map(csvCell).join(EXPORT_SEP));
		}
		// 目标表格软件当前按非逗号的区域分隔符打开 CSV，因此英文逗号留在同一单元格。
		// 使用 tab 分列并继续用 UTF-16 LE + BOM（FF FE）防止中文乱码；不加 sep 指令行。
		// 文件名仍为 .csv 以保持原有工作流，Excel/WPS 直接打开即可按 tab 分列。
		// 桌面端直接写字节；备用时用 createBinary，保证编码和 BOM 完全相同。
		const csv = rows.join('\r\n') + '\r\n';
		const bytes = Buffer.from('\ufeff' + csv, 'utf16le');
		const name = `外部引用报告-${stamp()}.csv`;
		const base = this.getVaultBase();
		let written = false;

		if (base && fs) {
			try {
				const full = nodePath ? nodePath.join(base, name) : base + '/' + name;
				fs.writeFileSync(full, bytes);
				written = true;
			} catch (e) { written = false; }
		}
		if (!written) {
			try {
				if (typeof this.app.vault.createBinary !== 'function') {
					throw new Error('当前 Obsidian API 不支持二进制文件创建，无法保证 CSV 编码');
				}
				const data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
				await this.app.vault.createBinary(normalizePath(name), data);
				written = true;
			} catch (e) {
				new Notice('导出失败：' + e.message);
				return;
			}
		}

		new Notice('已导出：' + name);
		await sleep(400); // 等 Obsidian 索引到新文件
		const f = this.app.vault.getAbstractFileByPath(normalizePath(name));
		if (f instanceof TFile) this.app.workspace.getLeaf(true).openFile(f);
	}

	sortedRecords() {
		const order = { missing: 0, ambiguous: 1, fixable: 2, ok: 3, ignored: 4 };
		return this.records.slice().sort((a, b) => {
			const d = (order[a.status] == null ? 9 : order[a.status]) - (order[b.status] == null ? 9 : order[b.status]);
			if (d !== 0) return d;
			return String(a.notePath).localeCompare(String(b.notePath));
		});
	}
}

/* ============================== 状态文案 ================================= */

function statusLabel(s) {
	switch (s) {
		case 'ok': return '正常';
		case 'missing': return '文件丢失';
		case 'ambiguous': return '多个候选';
		case 'fixable': return '可修复';
		case 'pending': return '待确认';
		case 'ignored': return '已忽略';
		default: return s || '未知';
	}
}

/* =========================== 管理面板视图 =============================== */

class ExternalLinkManagerView extends ItemView {
	constructor(leaf, plugin) {
		super(leaf);
		this.plugin = plugin;
		this.filterText = '';
		this.filterStatus = 'all';
		this.filterMonitored = 'all';
	}

	getViewType() { return VIEW_TYPE; }
	getDisplayText() { return '外部引用管理'; }
	getIcon() { return 'link-2'; }

	async onOpen() { this.render(); }
	async onClose() { }

	render() {
		const root = this.contentEl;
		root.empty();
		root.addClass('elm-root');

		const p = this.plugin;
		const records = p.records || [];
		const counts = {
			all: records.length,
			missing: 0, ambiguous: 0, fixable: 0, pending: 0, ok: 0, ignored: 0,
		};
		for (const r of records) counts[r.status] = (counts[r.status] || 0) + 1;

		/* ---- 顶部工具条 ---- */
		const bar = root.createDiv('elm-toolbar');
		bar.createEl('div', { cls: 'elm-title', text: '外部引用管理' });

		const btns = bar.createDiv('elm-btns');
		const mk = (label, cls, fn, title) => {
			const b = btns.createEl('button', { cls: 'elm-btn ' + (cls || ''), text: label });
			if (title) b.title = title;
			b.onclick = fn;
			return b;
		};
		mk('扫描', '', async () => { new Notice('开始扫描…'); await p.scanAll({ notify: true, refreshView: true }); });
		if (counts.pending > 0) {
			mk(`确认全部待确认项 (${counts.pending})`, 'mod-cta', async () => {
				await p.confirmPending({});
			}, '把标记为「待确认」的链接一次性写回笔记');
		}
		mk('修复可修复项', 'mod-cta', async () => {
			await p.scanAll({ silent: true });
			// 打开推荐列表，让你逐条挑
			const todo = p.records.filter((r) => r.status === 'pending' || r.status === 'fixable' || r.status === 'ambiguous');
			if (!todo.length) { new Notice('没有待修复项'); return; }
			new FixAllModal(this.app, p, todo).open();
		}, '列出所有失效链接的推荐新位置，逐条选择后应用');
		mk('一键修复高置信度', '', async () => {
			await p.scanAll({ silent: true });
			const n = await p.fixAllFixable({ force: false, includePending: true });
			new Notice(n ? `已修复 ${n} 处高置信度链接` : '没有可自动修复的项（可点「修复可修复项」手动挑）');
		}, '只应用置信度达标且唯一的候选，不做任何猜测');
		mk('清空缓存', '', async () => {
			await p.clearCandidateCache();
			new Notice('候选路径缓存已清空，下次扫描将重新查找外部文件位置');
		}, '清空「文件名 → 磁盘路径」的查找缓存');
		mk('新增映射', '', () => new AddMappingModal(this.app, p).open());
		mk('导出 CSV', '', () => p.exportCsv());
		mk('设置', '', () => {
			this.app.setting.open();
			this.app.setting.openTabById(p.manifest.id);
		});

		/* ---- 筛选行 ---- */
		const filters = root.createDiv('elm-filters');
		const search = filters.createEl('input', { cls: 'elm-search', type: 'text' });
		search.placeholder = '搜索笔记 / 链接文本 / 路径…';
		search.value = this.filterText;
		search.oninput = () => { this.filterText = search.value; this.renderBody(bodyWrap, counts); };

		const sel = filters.createEl('select', { cls: 'dropdown' });
		[['all', `全部 (${counts.all})`],
		['problem', `待处理 (${(counts.missing || 0) + (counts.ambiguous || 0) + (counts.fixable || 0) + (counts.pending || 0)})`],
		['pending', `待确认 (${counts.pending || 0})`],
		['fixable', `可修复 (${counts.fixable || 0})`],
		['ambiguous', `多候选 (${counts.ambiguous || 0})`],
		['missing', `丢失 (${counts.missing || 0})`],
		['ok', `正常 (${counts.ok || 0})`],
		['ignored', `已忽略 (${counts.ignored || 0})`]].forEach(([v, t]) => {
			const o = sel.createEl('option', { value: v, text: t });
			if (v === this.filterStatus) o.selected = true;
		});
		sel.onchange = () => { this.filterStatus = sel.value; this.renderBody(bodyWrap, counts); };

		const sel2 = filters.createEl('select', { cls: 'dropdown' });
		sel2.title = '按「链接指向的位置是否在监控文件夹内」筛选。\n' +
			'范围内 = 在监控文件夹里，变动会被实时发现；\n' +
			'范围外 = 笔记里有这个外部链接，但目标不在任何监控文件夹里。';
		let inScope = 0;
		for (const r of records) if (r.monitored) inScope++;
		const outScope = records.length - inScope;
		[['all', `全部 (${records.length})`],
		['in', `监控文件夹内 (${inScope})`],
		['out', `监控文件夹外 (${outScope})`]].forEach(([v, t]) => {
			const o = sel2.createEl('option', { value: v, text: t });
			if (v === this.filterMonitored) o.selected = true;
		});
		sel2.onchange = () => { this.filterMonitored = sel2.value; this.renderBody(bodyWrap, counts); };

		/* ---- 表体 ---- */
		const bodyWrap = root.createDiv('elm-body');
		this.renderBody(bodyWrap, counts);

		/* ---- 最近变更 ---- */
		const changes = (p.settings.recentChanges || []).slice(-12).reverse();
		if (changes.length) {
			const det = root.createEl('details', { cls: 'elm-changes' });
			det.createEl('summary', { text: `最近变更（${(p.settings.recentChanges || []).length} 条，显示最新 12 条）` });
			const ul = det.createEl('ul');
			for (const c of changes) {
				const li = ul.createEl('li');
				li.createEl('span', { cls: 'elm-changes-time', text: c.at });
				const a2 = li.createEl('a', { cls: 'elm-note-link', text: c.note });
				a2.onclick = (e) => { e.preventDefault(); p.openNoteAtLine(c.note, 1); };
				li.createEl('div', { cls: 'elm-changes-path', text: `${c.from}  →  ${c.to}` });
				if (c.reason) li.createEl('div', { cls: 'elm-changes-reason', text: c.reason });
			}
		}

		/* ---- 底部状态 ---- */
		const foot = root.createDiv('elm-foot');
		const last = p.settings.cache && p.settings.cache.scannedAt
			? new Date(p.settings.cache.scannedAt).toLocaleString() : '—';
		foot.setText(`共 ${counts.all} 条映射 · 上次扫描 ${last}` +
			(p.scanning ? ' · 正在扫描…' : '') +
			` · 监控目录 ${(p.settings.monitoredFolders || []).filter((f) => f.enabled !== false).length} 个`);
	}

	filtered() {
		const p = this.plugin;
		const q = lower(this.filterText).trim();
		return p.sortedRecords().filter((r) => {
			if (this.filterStatus === 'problem') {
				if (r.status === 'ok' || r.status === 'ignored') return false;
			} else if (this.filterStatus !== 'all' && r.status !== this.filterStatus) return false;

			if (this.filterMonitored === 'in' && !r.monitored) return false;
			if (this.filterMonitored === 'out' && r.monitored) return false;

			if (q) {
				const hay = lower([r.notePath, r.linkText, r.absolutePath, r.rawTarget, r.reason].join(' '));
				if (hay.indexOf(q) < 0) return false;
			}
			return true;
		});
	}

	renderBody(wrap, counts) {
		wrap.empty();
		const p = this.plugin;
		const list = this.filtered();

		if (!list.length) {
			wrap.createDiv({ cls: 'elm-empty', text: '没有匹配的记录。若刚安装插件，请先点「扫描」。' });
			return;
		}

		const table = wrap.createEl('table', { cls: 'elm-table' });
		const thead = table.createEl('thead');
		const hr = thead.createEl('tr');
		['状态', '笔记', '链接文本', '当前路径', '说明', '操作'].forEach((t) => hr.createEl('th', { text: t }));

		const tbody = table.createEl('tbody');
		for (const r of list) {
			const tr = tbody.createEl('tr');
			tr.addClass('elm-row-' + r.status);

			// 状态
			const tdS = tr.createEl('td');
			const badge = tdS.createEl('span', { cls: 'elm-badge elm-badge-' + r.status, text: statusLabel(r.status) });
			if (r.status === 'fixable' && r.lowConfidence) badge.title = '相似度较低，需手动确认';
			if (r.status === 'pending') badge.title = '自动检测到可更新，等你点「确认更新」才会写入笔记';

			// 笔记
			const tdN = tr.createEl('td', { cls: 'elm-cell-note' });
			const a = tdN.createEl('a', { cls: 'elm-note-link', text: r.notePath + ':' + r.line });
			a.onclick = (e) => { e.preventDefault(); p.openNoteAtLine(r.notePath, r.line); };
			a.title = '打开笔记并跳到该行';

			// 链接文本
			const tdT = tr.createEl('td', { cls: 'elm-cell-text' });
			tdT.setText(r.linkText || '(无)');
			tdT.title = '点击可编辑';
			tdT.onclick = () => new EditMappingModal(this.app, p, r).open();

			// 当前路径
			const tdP = tr.createEl('td', { cls: 'elm-cell-path' });
			const pathLine = tdP.createDiv({ cls: 'elm-path' });
			pathLine.setText(r.absolutePath);
			pathLine.title = r.absolutePath;
			pathLine.onclick = () => {
				navigator.clipboard && navigator.clipboard.writeText(r.absolutePath);
				new Notice('已复制路径');
			};
			if (r.status !== 'ok' && r.candidates && r.candidates.length === 1 && r.candidates[0] !== r.absolutePath) {
				const c = tdP.createDiv({ cls: 'elm-cand' });
				c.createEl('span', { text: '→ ' });
				const ca = c.createEl('span', { cls: 'elm-cand-path', text: r.candidates[0] });
				ca.title = '候选新位置，点击可直接应用';
				ca.onclick = async () => {
					await p.applyFix(r, r.candidates[0], r.reason || '手动应用候选');
					new Notice('已更新链接');
				};
			}
			if (r.candidates && r.candidates.length) {
				const c = tdP.createDiv({ cls: 'elm-cand' });
				c.createEl('span', { text: `${r.candidates.length} 个候选 ` });
				const b = c.createEl('button', { cls: 'elm-mini', text: '推荐列表…' });
				b.onclick = () => new RepointModal(this.app, p, r).open();
			}
			// 范围标记：唯一的判定标准就是「目标是否在监控文件夹里」
			if (r.monitored) {
				const mf = p.matchedMonitoredFolder(r.absolutePath);
				const label = mf ? (mf.label || safeBasename(mf.path)) : '';
				const tag = tdP.createEl('span', { cls: 'elm-tag', text: label ? `监控中 · ${label}` : '监控中' });
				tag.title = '在监控文件夹内：' + (mf ? mf.path : '') +
					'\n这个目录里的增删改会被实时发现。';
			} else {
				const tag = tdP.createEl('span', { cls: 'elm-tag elm-tag-out', text: '范围外' });
				tag.title = '笔记里有这个外部链接，但目标不在任何「监控文件夹」内。' +
					'\n被改名/移动时插件发现不了（也不会去这些位置找）。' +
					'\n想让它被监控，就把它所在的目录加成监控文件夹。';
			}

			// 说明
			const tdR = tr.createEl('td', { cls: 'elm-cell-reason' });
			tdR.setText(r.reason || (r.kind === 'folder' ? '文件夹' : ''));
			if (r.note) tdR.createEl('div', { cls: 'elm-note-cmt', text: '备注：' + r.note });

			// 操作
			const tdA = tr.createEl('td', { cls: 'elm-cell-actions' });
			const mini = (label, title, fn, cls) => {
				const b = tdA.createEl('button', { cls: 'elm-mini ' + (cls || ''), text: label });
				b.title = title;
				b.onclick = fn;
				return b;
			};
			if (r.exists) {
				mini('打开', '用系统默认程序打开该外部文件', () => p.openExternal(r.absolutePath));
				mini('定位', '在文件资源管理器中显示', () => p.revealExternal(r.absolutePath));
			}
			if (r.status === 'pending' && r.candidateInfo && r.candidateInfo.length) {
				mini('确认更新', '按推荐位置改写笔记里的链接（自动检测不会替你改，需要你点这里）', async () => {
					await p.applyFix(r, r.candidateInfo[0].path, '用户确认后更新');
					new Notice('已更新链接');
				}, 'mod-cta');
			}
			if (r.status === 'fixable' && r.candidateInfo && r.candidateInfo.length) {
				mini('应用', '把笔记里的链接改到推荐度最高的位置', async () => {
					await p.applyFix(r, r.candidateInfo[0].path, r.candidateInfo[0].reason || '手动修复');
					new Notice('已更新链接');
				}, 'mod-cta');
			}
			mini('重新指向', '先看推荐列表，也可以自己浏览/输入新路径', () => {
				new RepointModal(this.app, p, r).open();
			});
			mini('编辑', '编辑链接文本 / 目标路径 / 备注', () => new EditMappingModal(this.app, p, r).open());
			mini(r.status === 'ignored' ? '取消忽略' : '忽略', '忽略后不再提示该条', () => p.toggleIgnore(r));
			mini('删除', '从笔记中删除整条链接（含显示文字）', () => {
				new ConfirmModal(this.app, '确认删除', `将把整条链接从《${r.notePath}》第 ${r.line} 行删除：\n\n${r.markup || r.rawTarget}\n\n（链接文字也一起删除；若该行没有别的内容，整行一并删除）`, async () => {
					const ok = await p.removeLink(r);
					if (ok) new Notice('已从笔记中删除该链接');
				}).open();
			}, 'mod-warning');
		}
	}
}

/* ============================== 通用弹窗 ================================= */

/**
 * 带检索的下拉输入框。
 * 原生 <select> 在几百篇笔记时根本没法找，所以自己实现：
 * 输入即过滤（路径 / 文件名 / 中文子串都行），命中前缀的排在前面。
 */
class SuggestInput {
	constructor(containerEl, opts) {
		this.opts = opts || {};
		this.items = this.opts.items || [];
		this.value = this.opts.value || '';
		this.el = containerEl.createDiv('elm-suggest');
		this.input = this.el.createEl('input', { type: 'text', cls: 'elm-suggest-input' });
		this.input.placeholder = this.opts.placeholder || '输入关键字检索…';
		this.input.value = this.value;
		this.listEl = this.el.createDiv('elm-suggest-list');
		this.listEl.style.display = 'none';

		this.input.addEventListener('input', () => {
			this.value = this.input.value;
			if (this.opts.onChange) this.opts.onChange(this.value);
			this.renderList();
		});
		this.input.addEventListener('focus', () => this.renderList());
		this.input.addEventListener('blur', () => {
			window.setTimeout(() => { this.listEl.style.display = 'none'; }, 160);
		});
		this.input.addEventListener('keydown', (e) => {
			if (e.key === 'Escape') { this.listEl.style.display = 'none'; this.input.blur(); }
		});
		this.renderList();
	}

	setValue(v) {
		this.value = v;
		this.input.value = v;
		if (this.opts.onChange) this.opts.onChange(v);
	}

	renderList() {
		const q = lower(this.value).trim();
		let list;
		if (q) {
			const hits = [];
			for (const it of this.items) {
				const label = lower(it.label);
				const sub = lower(it.sub || '');
				const iLabel = label.indexOf(q);
				const iSub = sub.indexOf(q);
				if (iLabel < 0 && iSub < 0) continue;
				// 文件名前缀命中 > 路径中出现 > 仅路径命中
				let rank = 3;
				if (iLabel === 0) rank = 0;
				else if (iLabel > 0) rank = 1;
				else if (iSub >= 0) rank = 2;
				hits.push({ it, rank, at: iLabel >= 0 ? iLabel : iSub });
			}
			hits.sort((a, b) => (a.rank - b.rank) || (a.at - b.at) || a.it.label.localeCompare(b.it.label));
			list = hits.map((h) => h.it).slice(0, 80);
		} else {
			list = this.items.slice(0, 80);
		}

		this.listEl.empty();
		if (!list.length) {
			this.listEl.createDiv({ cls: 'elm-suggest-empty', text: '没有匹配的笔记' });
			this.listEl.style.display = 'block';
			return;
		}
		for (const it of list) {
			const row = this.listEl.createDiv('elm-suggest-item');
			row.createEl('span', { cls: 'elm-suggest-label', text: it.label });
			if (it.sub) row.createEl('span', { cls: 'elm-suggest-sub', text: it.sub });
			// 用 mousedown + preventDefault，避免 input 先失焦导致点不中
			row.onmousedown = (e) => {
				e.preventDefault();
				this.setValue(it.value);
				this.listEl.style.display = 'none';
			};
		}
		this.listEl.style.display = 'block';
	}
}

class ConfirmModal extends Modal {
	constructor(app, title, message, onOk) {
		super(app);
		this.titleText = title;
		this.message = message;
		this.onOk = onOk;
	}
	onOpen() {
		const { contentEl } = this;
		contentEl.createEl('h3', { text: this.titleText });
		const pre = contentEl.createEl('div', { cls: 'elm-confirm-msg' });
		pre.setText(this.message);
		const row = contentEl.createDiv('elm-modal-btns');
		const ok = row.createEl('button', { cls: 'mod-warning', text: '确定' });
		ok.onclick = async () => { this.close(); await this.onOk(); };
		const cancel = row.createEl('button', { text: '取消' });
		cancel.onclick = () => this.close();
	}
	onClose() { this.contentEl.empty(); }
}

/** 编辑一条映射：链接文本 / 目标路径 / 备注 */
class EditMappingModal extends Modal {
	constructor(app, plugin, rec) {
		super(app);
		this.plugin = plugin;
		this.rec = rec;
		this.text = rec.linkText;
		this.path = rec.absolutePath;
		this.comment = rec.note || '';
	}
	onOpen() {
		const { contentEl } = this;
		contentEl.createEl('h3', { text: '编辑外部引用映射' });
		contentEl.createEl('div', { cls: 'elm-modal-sub', text: this.rec.notePath + ' : ' + this.rec.line });

		let pathInput = null;
		new Setting(contentEl)
			.setName('链接文本')
			.setDesc('Markdown 中方括号里的显示文字')
			.addText((t) => t.setValue(this.text).onChange((v) => { this.text = v; }));

		new Setting(contentEl)
			.setName('目标路径')
			.setDesc('磁盘绝对路径；可点右侧按钮浏览，也可直接从系统拖文件/文件夹进来。改动会同步写回笔记')
			.addText((t) => {
				pathInput = t.inputEl;
				t.setValue(this.path).onChange((v) => { this.path = v; });
				t.inputEl.addClass('elm-input-wide');
				attachPathDrop(t.inputEl, { onPath: (p) => { this.path = p; } });
			})
			.addExtraButton((b) => b.setIcon('folder-open').setTooltip('浏览…').onClick(() => {
				new FsBrowserModal(this.app, this.plugin, {
					mode: 'both',
					title: '选择目标',
					startPath: this.path,
					onChoose: (p) => {
						this.path = p;
						if (pathInput) pathInput.value = p;
					},
				}).open();
			}));

		new Setting(contentEl)
			.setName('备注')
			.setDesc('只保存在插件数据里，不写入笔记')
			.addText((t) => t.setValue(this.comment).onChange((v) => { this.comment = v; }));

		const info = contentEl.createDiv('elm-modal-info');
		const hist = this.plugin.changesFor(this.rec.notePath, 5);
		info.setText('原始写法：' + this.rec.rawTarget + '\n状态：' + statusLabel(this.rec.status) +
			(hist.length ? '\n本笔记最近变更：\n' + hist.map((h) => `  ${h.at}  ${h.from} → ${h.to}（${h.reason}）`).join('\n') : ''));

		const row = contentEl.createDiv('elm-modal-btns');
		const save = row.createEl('button', { cls: 'mod-cta', text: '保存并写回笔记' });
		save.onclick = async () => {
			this.plugin.settings.notes[this.rec.key] = this.comment;
			await this.plugin.saveSettings();
			const changed = this.text !== this.rec.linkText ||
				lower(this.path) !== lower(this.rec.absolutePath);
			if (changed) {
				const ok = await this.plugin.applyEdit(this.rec, this.text, this.path, '手动编辑映射');
				new Notice(ok ? '已更新并写回笔记' : '未写入（内容可能未变化）');
			} else {
				this.plugin.refreshViews();
				new Notice('已保存备注');
			}
			this.close();
		};
		const cancel = row.createEl('button', { text: '取消' });
		cancel.onclick = () => this.close();
	}
	onClose() { this.contentEl.empty(); }
}

/** 新增一条映射 */
class AddMappingModal extends Modal {
	constructor(app, plugin) {
		super(app);
		this.plugin = plugin;
		this.notePath = '';
		this.text = '';
		this.path = '';
	}
	onOpen() {
		const { contentEl } = this;
		contentEl.addClass('elm-add-modal');
		contentEl.createEl('h3', { text: '新增外部引用映射' });
		contentEl.createEl('div', { cls: 'elm-modal-sub', text: '会在指定笔记末尾追加一条指向外部文件/文件夹的链接' });

		// 默认填入当前打开的笔记
		if (!this.notePath) {
			const af = this.app.workspace.getActiveFile && this.app.workspace.getActiveFile();
			if (af) this.notePath = af.path;
		}

		// 可检索的笔记选择：原生下拉在几百篇笔记时根本没法找
		const items = this.app.vault.getMarkdownFiles().map((f) => {
			const i = f.path.lastIndexOf('/');
			return {
				value: f.path,
				label: i >= 0 ? f.path.slice(i + 1) : f.path,
				sub: i >= 0 ? f.path.slice(0, i) : '',
			};
		}).sort((a, b) => a.label.localeCompare(b.label));

		const noteSetting = new Setting(contentEl)
			.setName('写入笔记')
			.setDesc('输入文件名或路径的一部分即可检索，从下拉里选一篇');
		this.noteSuggest = new SuggestInput(noteSetting.controlEl, {
			items,
			value: this.notePath,
			placeholder: `共 ${items.length} 篇，输入关键字检索…`,
			onChange: (v) => { this.notePath = v; },
		});
		this.notePath = this.noteSuggest.value;

		let textInput = null;
		let pathInput = null;

		new Setting(contentEl)
			.setName('链接文本')
			.setDesc('留空则使用文件名')
			.addText((t) => {
				textInput = t.inputEl;
				t.setValue(this.text).onChange((v) => { this.text = v; });
			});

		new Setting(contentEl)
			.setName('外部路径')
			.setDesc('磁盘绝对路径；可点右侧按钮浏览，也可直接从系统把文件/文件夹拖进来')
			.addText((t) => {
				pathInput = t.inputEl;
				t.setValue(this.path).onChange((v) => { this.path = v; });
				t.inputEl.addClass('elm-input-wide');
				attachPathDrop(t.inputEl, {
					onPath: (p) => {
						this.path = p;
						if (!this.text) {
							this.text = safeBasename(p);
							if (textInput) textInput.value = this.text;
						}
					},
				});
			})
			.addExtraButton((b) => b.setIcon('folder-open').setTooltip('浏览…').onClick(() => {
				new FsBrowserModal(this.app, this.plugin, {
					mode: 'both',
					title: '选择外部文件/文件夹',
					startPath: this.path,
					onChoose: (p) => {
						this.path = p;
						if (!this.text) this.text = safeBasename(p);
						if (pathInput) pathInput.value = this.path;
						if (textInput) textInput.value = this.text;
					},
				}).open();
			}));

		const row = contentEl.createDiv('elm-modal-btns');
		const ok = row.createEl('button', { cls: 'mod-cta', text: '插入链接' });
		ok.onclick = async () => {
			const notePath = String(this.notePath || '').trim();
			if (!notePath) { new Notice('请先选择或输入笔记'); return; }
			const af = this.app.vault.getAbstractFileByPath(normalizePath(notePath));
			if (!(af instanceof TFile)) { new Notice('找不到该笔记：' + notePath); return; }
			if (!this.path) { new Notice('请填写外部路径'); return; }
			if (!exists(this.path)) {
				new ConfirmModal(this.app, '路径不存在', `目标路径当前不存在：\n\n${this.path}\n\n仍然插入吗？`, async () => {
					await this.plugin.addLink(notePath, this.text, this.path);
					new Notice('已插入链接');
				}).open();
				return;
			}
			await this.plugin.addLink(notePath, this.text, this.path);
			new Notice('已插入链接');
			this.close();
		};
		const cancel = row.createEl('button', { text: '取消' });
		cancel.onclick = () => this.close();
	}
	onClose() { this.contentEl.empty(); }
}

/** 渲染一条候选：分数 + 理由 + 路径 + 操作按钮 */
function renderCandidateRow(listEl, plugin, rec, c, opts) {
	opts = opts || {};
	const item = listEl.createDiv('elm-cand-item');
	const score = item.createEl('span', { cls: 'elm-cand-score', text: Number(c.score).toFixed(2) });
	score.title = '置信度';
	const mid = item.createDiv('elm-cand-mid');
	const reason = mid.createEl('div', { cls: 'elm-cand-reason', text: c.reason || '' });
	reason.title = c.reason || '';
	const pth = mid.createEl('div', { cls: 'elm-cand-full', text: c.path });
	pth.title = c.path;
	if (opts.radio) {
		const rb = item.createEl('input', { type: 'radio', cls: 'elm-cand-radio' });
		rb.name = opts.radio;
		rb.checked = !!opts.checked;
		rb.onchange = () => { if (rb.checked && opts.onPick) opts.onPick(c.path); };
		item.onclick = (e) => {
			if (e.target === rb) return;
			rb.checked = true;
			if (opts.onPick) opts.onPick(c.path);
		};
	}
	const apply = item.createEl('button', { cls: 'mod-cta elm-mini', text: '应用' });
	apply.onclick = async (e) => {
		e.stopPropagation();
		await plugin.applyFix(rec, c.path, c.reason || '从推荐列表选定');
		new Notice('已更新链接');
		if (opts.onApplied) opts.onApplied();
	};
	const open = item.createEl('button', { cls: 'elm-mini', text: '打开' });
	open.onclick = (e) => { e.stopPropagation(); plugin.openExternal(c.path); };
	const rev = item.createEl('button', { cls: 'elm-mini', text: '定位' });
	rev.onclick = (e) => { e.stopPropagation(); plugin.revealExternal(c.path); };
	return item;
}

/**
 * 「重新指向」：先给推荐列表，选不出来再手动浏览 / 输入。
 * 推荐来源：文件名一致 / 内容指纹一致 / 名称相似（疑似改名）。
 */
class RepointModal extends Modal {
	constructor(app, plugin, rec) {
		super(app);
		this.plugin = plugin;
		this.rec = rec;
		this.cands = (rec.candidateInfo || []).slice();
		this.manual = '';
	}
	onOpen() {
		const { contentEl } = this;
		contentEl.addClass('elm-repoint');
		contentEl.createEl('h3', { text: '重新指向：' + (this.rec.basename || this.rec.rawTarget) });
		contentEl.createEl('div', {
			cls: 'elm-modal-sub',
			text: `${this.rec.notePath} : ${this.rec.line}\n原路径（已失效）：${this.rec.absolutePath}`,
		});

		/* ---- 推荐列表 ---- */
		const head = contentEl.createDiv('elm-section-head');
		head.createEl('span', { text: '推荐新位置' });
		const recompute = head.createEl('button', { cls: 'elm-mini', text: '重新计算' });
		recompute.onclick = async () => {
			recompute.setText('计算中…');
			recompute.disabled = true;
			this.cands = await this.plugin.candidatesForRecord(this.rec);
			this.onOpen.call(this);
			this.close();
			new RepointModal(this.app, this.plugin, this.rec).open();
		};

		const list = contentEl.createDiv('elm-cand-list');
		if (!this.cands.length) {
			list.createDiv({ cls: 'elm-empty', text: '没有找到推荐位置。可以在下面手动浏览或输入路径。' });
		} else {
			for (const c of this.cands) {
				renderCandidateRow(list, this.plugin, this.rec, c, {
					onApplied: () => { this.plugin.refreshViews(); this.close(); },
				});
			}
		}
		contentEl.createDiv({
			cls: 'elm-scope-hint',
			text: '监控文件夹：' + this.plugin.describeSearchScope(),
		});

		/* ---- 手动 ---- */
		const head2 = contentEl.createDiv('elm-section-head');
		head2.createEl('span', { text: '手动指定' });
		const bar = contentEl.createDiv('elm-manual-bar');
		const inp = bar.createEl('input', { type: 'text', cls: 'elm-input-wide' });
		inp.placeholder = '磁盘绝对路径，或点右侧「浏览…」，也可从系统拖入';
		inp.value = this.rec.absolutePath || '';
		inp.oninput = () => { this.manual = inp.value; };
		attachPathDrop(inp, { onPath: (p) => { this.manual = p; } });
		const browse = bar.createEl('button', { text: '浏览…' });
		browse.onclick = () => {
			new FsBrowserModal(this.app, this.plugin, {
				mode: 'both',
				title: '选择新的外部文件/文件夹',
				startPath: inp.value || this.rec.absolutePath,
				onChoose: (np) => { inp.value = np; this.manual = np; },
			}).open();
		};

		const row = contentEl.createDiv('elm-modal-btns');
		const ok = row.createEl('button', { cls: 'mod-cta', text: '应用手动路径' });
		ok.onclick = async () => {
			const v = (this.manual || inp.value || '').trim();
			if (!v) { new Notice('请先填写或选择路径'); return; }
			if (!exists(v)) {
				new Notice('该路径不存在，仍已写入（请确认）', 4000);
			}
			await this.plugin.applyEdit(this.rec, this.rec.linkText, v, '手动重新指向');
			new Notice('已更新链接');
			this.plugin.refreshViews();
			this.close();
		};
		const cancel = row.createEl('button', { text: '取消' });
		cancel.onclick = () => this.close();
	}
	onClose() { this.contentEl.empty(); }
}

/**
 * 「修复可修复项」：把所有待修复项 + 各自推荐列表一次性列出来，
 * 逐条选（默认选每个的第一推荐），然后批量应用。
 */
class FixAllModal extends Modal {
	constructor(app, plugin, records) {
		super(app);
		this.plugin = plugin;
		this.records = records;
		this.picks = new Map();
		for (const r of records) {
			const list = r.candidateInfo || [];
			this.picks.set(r, list.length ? list[0].path : null);
		}
	}
	onOpen() {
		const { contentEl } = this;
		contentEl.addClass('elm-fixall');
		contentEl.createEl('h3', { text: `待修复的外部引用（${this.records.length} 条）` });
		contentEl.createEl('div', {
			cls: 'elm-modal-sub',
			text: '每条默认选中推荐度最高的位置，可改成别的候选或跳过。点「应用选中项」后才会写回笔记。',
		});

		const wrap = contentEl.createDiv('elm-fixall-list');
		for (const r of this.records) {
			const card = wrap.createDiv('elm-fixall-card');
			const top = card.createDiv('elm-fixall-top');
			const badge = top.createEl('span', { cls: 'elm-badge elm-badge-' + r.status, text: statusLabel(r.status) });
			const title = top.createEl('span', { cls: 'elm-fixall-title' });
			const a = title.createEl('a', { cls: 'elm-note-link', text: `${r.notePath}:${r.line}` });
			a.onclick = (e) => { e.preventDefault(); this.plugin.openNoteAtLine(r.notePath, r.line); };
			title.createEl('span', { cls: 'elm-fixall-link', text: ` [${r.linkText}]` });
			card.createDiv({ cls: 'elm-fixall-old', text: '原路径：' + r.absolutePath });

			const list = card.createDiv('elm-cand-list');
			const group = 'fixall-' + Math.random().toString(36).slice(2);
			const list2 = r.candidateInfo || [];
			if (!list2.length) {
				list.createDiv({ cls: 'elm-empty', text: '没有推荐位置' });
			}
			for (const c of list2) {
				renderCandidateRow(list, this.plugin, r, c, {
					radio: group,
					checked: this.picks.get(r) === c.path,
					onPick: (pth) => { this.picks.set(r, pth); },
					onApplied: () => { this.plugin.refreshViews(); this.close(); },
				});
			}
			// 跳过 / 重新指向
			const skipRow = card.createDiv('elm-fixall-skip');
			const rb = skipRow.createEl('input', { type: 'radio', cls: 'elm-cand-radio' });
			rb.name = group;
			rb.checked = !this.picks.get(r);
			rb.onchange = () => { if (rb.checked) this.picks.set(r, null); };
			const lbl = skipRow.createEl('span', { text: '跳过这条' });
			lbl.onclick = () => { rb.checked = true; this.picks.set(r, null); };
			const rep = skipRow.createEl('button', { cls: 'elm-mini', text: '手动重新指向…' });
			rep.onclick = () => { this.close(); new RepointModal(this.app, this.plugin, r).open(); };
		}

		const row = contentEl.createDiv('elm-modal-btns');
		const n = Array.from(this.picks.values()).filter(Boolean).length;
		const ok = row.createEl('button', { cls: 'mod-cta', text: `应用选中的 ${n} 项` });
		ok.onclick = async () => {
			let done = 0;
			for (const [r, pth] of this.picks) {
				if (!pth) continue;
				const cand = (r.candidateInfo || []).find((c) => c.path === pth);
				const okOne = await this.plugin.applyFix(r, pth, (cand && cand.reason) || '批量修复');
				if (okOne) done++;
			}
			new Notice(done ? `已更新 ${done} 处链接` : '没有可应用的项');
			this.plugin.refreshViews();
			this.close();
		};
		const cancel = row.createEl('button', { text: '取消' });
		cancel.onclick = () => this.close();
	}
	onClose() { this.contentEl.empty(); }
}

/** 文件系统浏览器（Obsidian 无原生目录选择器，自己实现） */
class FsBrowserModal extends Modal {
	constructor(app, plugin, opts) {
		super(app);
		this.plugin = plugin;
		this.opts = opts || {};
		this.mode = this.opts.mode || 'both'; // file | folder | both
		this.cwd = (this.opts.startPath && isDir(this.opts.startPath))
			? this.opts.startPath
			: (this.opts.startPath ? safeDirname(this.opts.startPath) : null) || (os ? os.homedir() : (isWin() ? 'C:\\' : '/'));
		if (!exists(this.cwd)) this.cwd = isWin() ? 'C:\\' : '/';
	}
	onOpen() {
		const { contentEl } = this;
		contentEl.addClass('elm-browser');
		contentEl.createEl('h3', { text: this.opts.title || '选择路径' });
		this.renderBody(contentEl);
	}
	renderBody(contentEl) {
		contentEl.empty();
		contentEl.createEl('h3', { text: this.opts.title || '选择路径' });

		const bar = contentEl.createDiv('elm-browser-bar');
		const up = bar.createEl('button', { text: '↑ 上一级' });
		up.onclick = () => {
			const parent = safeDirname(this.cwd);
			if (parent && parent !== this.cwd) { this.cwd = parent; this.renderBody(contentEl); }
		};
		const inp = bar.createEl('input', { cls: 'elm-browser-input', type: 'text' });
		inp.value = this.cwd;
		inp.title = '可以直接输入路径回车前往；也可以把系统里的文件夹拖到这里';
		inp.onkeydown = (e) => {
			if (e.key === 'Enter') {
				const v = inp.value.trim();
				if (isDir(v)) { this.cwd = v; this.renderBody(contentEl); }
				else if (exists(v)) this.choose(v);
			}
		};
		attachPathDrop(inp, {
			onPath: (p) => {
				if (isDir(p)) { this.cwd = p; this.renderBody(contentEl); }
				else if (this.mode === 'folder') {
					const d = safeDirname(p);
					if (d && isDir(d)) { this.cwd = d; this.renderBody(contentEl); }
				} else {
					this.choose(p);
				}
			},
		});
		const go = bar.createEl('button', { text: '前往' });
		go.onclick = () => {
			const v = inp.value.trim();
			if (isDir(v)) { this.cwd = v; this.renderBody(contentEl); }
			else if (exists(v)) this.choose(v);
			else new Notice('路径不存在');
		};

		if (isWin()) {
			const drives = bar.createDiv('elm-drives');
			for (let i = 65; i <= 90; i++) {
				const d = String.fromCharCode(i) + ':\\';
				if (!exists(d)) continue;
				const b = drives.createEl('button', { cls: 'elm-mini', text: String.fromCharCode(i) + ':' });
				b.onclick = () => { this.cwd = d; this.renderBody(contentEl); };
			}
		}

		if (this.mode !== 'file') {
			const pickRow = contentEl.createDiv('elm-browser-pick');
			const b = pickRow.createEl('button', { cls: 'mod-cta', text: '选择当前文件夹' });
			b.onclick = () => this.choose(this.cwd);
		}

		const listEl = contentEl.createDiv('elm-browser-list');
		let entries = [];
		try {
			entries = fs.readdirSync(this.cwd, { withFileTypes: true });
		} catch (e) {
			listEl.createDiv({ cls: 'elm-empty', text: '无法读取：' + e.message });
			return;
		}
		entries.sort((a, b) => {
			const ad = a.isDirectory() ? 0 : 1;
			const bd = b.isDirectory() ? 0 : 1;
			if (ad !== bd) return ad - bd;
			return a.name.localeCompare(b.name);
		});
		for (const ent of entries) {
			if (ent.name.startsWith('.') && ent.name !== '.') continue;
			const full = joinPath(this.cwd, ent.name);
			const item = listEl.createDiv('elm-browser-item');
			if (ent.isDirectory()) {
				item.addClass('is-dir');
				item.createEl('span', { cls: 'elm-ico', text: '📁' });
				item.createEl('span', { text: ent.name });
				item.onclick = () => { this.cwd = full; this.renderBody(contentEl); };
			} else {
				item.createEl('span', { cls: 'elm-ico', text: '📄' });
				item.createEl('span', { text: ent.name });
				if (this.mode !== 'folder') {
					item.onclick = () => this.choose(full);
				} else {
					item.addClass('is-disabled');
				}
			}
		}
	}
	choose(p) {
		this.close();
		if (this.opts.onChoose) this.opts.onChoose(p, isDir(p) ? 'folder' : 'file');
	}
	onClose() { this.contentEl.empty(); }
}

/* ============================== 设置页 =================================== */

class ExternalLinkManagerSettingTab extends PluginSettingTab {
	constructor(app, plugin) {
		super(app, plugin);
		this.plugin = plugin;
	}
	display() {
		const { containerEl } = this;
		const p = this.plugin;
		containerEl.empty();
		containerEl.addClass('elm-settings');

		containerEl.createEl('h2', { text: '外部引用管理' });
		containerEl.createEl('div', {
			cls: 'elm-hint',
			text: '管理 Markdown 中指向仓库外部（磁盘绝对路径）的文件/文件夹链接。修改会自动保存。',
		});

		/* ---------- 监控文件夹 ---------- */
		containerEl.createEl('h3', { text: '监控的外部文件夹' });
		containerEl.createEl('div', {
			cls: 'elm-hint',
			text: '这些目录会：① 被实时监听（文件增删改后自动核对链接）；② 作为「按文件名找新位置」的搜索范围。',
		});
		containerEl.createEl('div', {
			cls: 'elm-hint',
			text: '只有这里的目录算「范围内」—— 笔记里引用的文件/文件夹落在这里，才会在面板里标成「监控中」，' +
				'被改名/移动时插件才可能发现。其余位置一律算「范围外」。',
		});

		const listEl = containerEl.createDiv('elm-folder-list');
		const renderList = () => {
			listEl.empty();
			const arr = p.settings.monitoredFolders;
			if (!arr.length) listEl.createDiv({ cls: 'elm-empty', text: '还没有添加监控文件夹。' });
			arr.forEach((f, i) => {
				const row = listEl.createDiv('elm-folder-row');
				const pathInp = row.createEl('input', { cls: 'elm-input-wide', type: 'text' });
				pathInp.value = f.path || '';
				pathInp.placeholder = '例如 D:\\资料\\共享文档（也可从系统拖文件夹进来）';
				pathInp.onchange = async () => { f.path = pathInp.value.trim(); await p.saveSettings(); p.setupWatchers(); };
				attachPathDrop(pathInp, {
					folderOnly: true,
					onPath: async (np) => { f.path = np; await p.saveSettings(); p.setupWatchers(); },
				});

				const labelInp = row.createEl('input', { cls: 'elm-input-sm', type: 'text' });
				labelInp.value = f.label || '';
				labelInp.placeholder = '标签(可选)';
				labelInp.onchange = async () => { f.label = labelInp.value.trim(); await p.saveSettings(); };

				const mkToggle = (text, get, set, title) => {
					const wrap = row.createDiv('elm-inline-toggle');
					const cb = wrap.createEl('input', { type: 'checkbox' });
					cb.checked = get();
					cb.title = title || text;
					cb.onchange = async () => { set(cb.checked); await p.saveSettings(); p.setupWatchers(); };
					wrap.createEl('span', { text });
				};
				mkToggle('启用', () => f.enabled !== false, (v) => { f.enabled = v; }, '关闭后不监控、不搜索');
				mkToggle('递归', () => f.recursive !== false, (v) => { f.recursive = v; }, '是否包含子目录');

				const browse = row.createEl('button', { text: '浏览…' });
				browse.onclick = () => new FsBrowserModal(this.app, p, {
					mode: 'folder', title: '选择要监控的文件夹', startPath: f.path,
					onChoose: async (np) => { f.path = np; await p.saveSettings(); p.setupWatchers(); renderList(); },
				}).open();

				const del = row.createEl('button', { cls: 'mod-warning', text: '移除' });
				del.onclick = async () => { arr.splice(i, 1); await p.saveSettings(); p.setupWatchers(); renderList(); };
			});
		};
		renderList();

		new Setting(containerEl).addButton((b) => b.setButtonText('＋ 添加监控文件夹').onClick(async () => {
			new FsBrowserModal(this.app, p, {
				mode: 'folder', title: '选择要监控的文件夹',
				onChoose: async (np) => {
					p.settings.monitoredFolders.push({ path: np, label: '', recursive: true, enabled: true });
					await p.saveSettings();
					p.setupWatchers();
					renderList();
				},
			}).open();
		}));

		/* ---------- 范围说明 ---------- */
		containerEl.createEl('h3', { text: '范围' });
		containerEl.createEl('div', {
			cls: 'elm-hint',
			text: '插件只有一个范围，就是上面那些「监控文件夹」。找新位置、判断「范围内 / 范围外」，全都以它为准。' +
				'插件不会去搜系统其他位置（用户主目录、桌面、文档等）。',
		});
		containerEl.createEl('div', {
			cls: 'elm-hint',
			text: '「范围外」= 扫描仓库时，某篇 Markdown 里存在外部文件/文件夹链接，但链接指向的位置不在任何监控文件夹内。' +
				'这类引用不会被实时监听，被改名/移动时插件发现不了。',
		});

		new Setting(containerEl)
			.setName('当前范围')
			.setDesc(p.describeSearchScope())
			.addExtraButton((b) => b.setIcon('refresh-cw').setTooltip('刷新').onClick(() => {
				this.display();
			}));

		new Setting(containerEl)
			.setName('同时搜索本仓库')
			.setDesc('外部文件被移进仓库时使用。默认关闭。注意仓库自身也不属于「监控文件夹」，' +
				'所以从仓库里找到的目标在面板里同样显示「范围外」。')
			.addToggle((t) => t.setValue(!!p.settings.alsoSearchVault).onChange(async (v) => {
				p.settings.alsoSearchVault = v; await p.saveSettings();
			}));

		/* ---------- 链接匹配规则 ---------- */
		containerEl.createEl('h3', { text: '链接匹配规则' });
		containerEl.createEl('div', {
			cls: 'elm-hint',
			text: '插件用这条正则从 Markdown 里抓「外部链接」。默认规则匹配 [文字](路径) 和 ![文字](路径)。',
		});
		containerEl.createEl('div', {
			cls: 'elm-hint',
			text: '捕获组约定：第 1 组 = 前缀（!，用来判断是不是嵌入）、第 2 组 = 链接文字、第 3 组 = 目标路径。' +
				'也可以改用命名捕获组 (?<bang>…)(?<text>…)(?<target>…)，顺序就随意了。',
		});
		containerEl.createEl('div', {
			cls: 'elm-hint',
			text: '这里只影响「识别 / 扫描」。写回笔记时统一输出标准 [文字](路径) 形式。' +
				'另外：带引号的 [文字]("路径") 是错误写法，插件刻意不认 —— 想支持请自行改规则。',
		});

		const ruleWrap = containerEl.createDiv('elm-rule');

		const patInp = ruleWrap.createEl('textarea', { cls: 'elm-input-wide elm-mono' });
		patInp.rows = 3;
		patInp.value = p.settings.linkPattern;
		patInp.spellcheck = false;
		patInp.placeholder = DEFAULT_LINK_PATTERN;

		const flagRow = ruleWrap.createDiv('elm-inline-row');
		flagRow.createEl('span', { cls: 'elm-hint', text: '标志：' });
		const flagInp = flagRow.createEl('input', { cls: 'elm-input-xs elm-mono', type: 'text' });
		flagInp.value = p.settings.linkFlags;
		flagInp.title = '允许 g i m s u（g 会自动补上）';

		const statusEl = ruleWrap.createDiv('elm-rule-status');

		const testWrap = ruleWrap.createDiv('elm-rule-test');
		testWrap.createEl('div', { cls: 'elm-hint', text: '试一下（实时）：把要检验的 Markdown 粘进来' });
		const sampleInp = testWrap.createEl('textarea', { cls: 'elm-input-wide elm-mono' });
		sampleInp.rows = 4;
		sampleInp.value = DEFAULT_LINK_RULE_SAMPLE;
		sampleInp.spellcheck = false;
		const testOut = testWrap.createDiv('elm-rule-test-out');

		const refreshRule = () => {
			const info = analyzeLinkPattern(p.settings.linkPattern, p.settings.linkFlags);
			statusEl.empty();
			if (!info.ok) {
				statusEl.createEl('span', { cls: 'elm-rule-bad', text: '✗ 规则无效：' + info.error });
			} else if (!info.hasTarget) {
				statusEl.createEl('span', { cls: 'elm-rule-warn', text: '⚠ 规则能用，但取不到「目标路径」：需要第 3 个捕获组，或一个名为 target 的命名组。' });
			} else {
				statusEl.createEl('span', { cls: 'elm-rule-ok', text: '✓ 规则有效（' + info.groups + ' 个捕获组' + (info.named ? '，含命名组' : '') + '）' });
			}
			statusEl.createEl('code', { cls: 'elm-mono elm-rule-preview', text: '/' + p.settings.linkPattern + '/' + p.settings.linkFlags });
			renderRuleTest(testOut, p.settings.linkPattern, p.settings.linkFlags, sampleInp.value, p);
		};

		const commitRule = async (rescan) => {
			p.settings.linkPattern = patInp.value;
			p.settings.linkFlags = normalizeLinkFlags(flagInp.value);
			flagInp.value = p.settings.linkFlags;
			p.resetLinkRegex();
			await p.saveSettings();
			refreshRule();
			if (rescan) {
				new Notice('规则已更新，正在重新扫描…');
				await p.scanAll({});
				new Notice('重新扫描完成');
			}
		};

		patInp.onchange = () => commitRule(false);
		flagInp.onchange = () => commitRule(false);
		sampleInp.oninput = () => refreshRule();

		new Setting(containerEl)
			.setDesc('改完规则记得重新扫描一次，面板里的结果才会跟着变。')
			.addButton((b) => b.setButtonText('保存并重新扫描').setCta().onClick(() => commitRule(true)))
			.addButton((b) => b.setButtonText('恢复默认规则').onClick(async () => {
				patInp.value = DEFAULT_LINK_PATTERN;
				flagInp.value = DEFAULT_LINK_FLAGS;
				await commitRule(false);
			}));

		refreshRule();

		/* ---------- 自动化 ---------- */
		containerEl.createEl('h3', { text: '自动化' });
		const toggle = (name, desc, key, after) => new Setting(containerEl)
			.setName(name).setDesc(desc)
			.addToggle((t) => t.setValue(!!p.settings[key]).onChange(async (v) => {
				p.settings[key] = v; await p.saveSettings();
				if (after) after();
			}));

		toggle('启用自动修复（总开关）', '关掉后插件只读不写，连「待确认」都不会标', 'enableAutoFix');
		new Setting(containerEl)
			.setName('自动改写前需要我确认')
			.setDesc('开启（推荐）：外部文件改名 / 移动后，插件只在面板里标成「待确认」，绝不自己动你的笔记，你点「确认更新」才写。关闭：高置信度唯一候选会直接改写，不问你。')
			.addToggle((t) => t.setValue(p.settings.requireConfirmBeforeAutoFix !== false).onChange(async (v) => {
				p.settings.requireConfirmBeforeAutoFix = v;
				await p.saveSettings();
				if (v) {
					// 从「自动」切到「确认」时，把还没落地的可修复项也标成待确认
					p.markPending();
					p.refreshViews();
				}
			}));
		toggle('打开笔记时检查', '打开一篇笔记时核对它的外部引用', 'autoFixOnFileOpen');
		toggle('外部文件变动时核对', '监控目录里发生增删改后自动核对链接', 'autoFixOnExternalChange');
		toggle('笔记变动时刷新记录', '笔记被修改后重新解析它的外部引用', 'autoFixOnVaultChange');
		toggle('实时监控外部目录', '使用系统文件监听（部分网络盘可能不支持）。监听只入队、不加锁、不打开文件', 'watchExternalFolders', () => p.setupWatchers());

		new Setting(containerEl)
			.setName('外部变动后的响应延迟')
			.setDesc('监控目录「安静」这么久之后才去核对链接。调大可以明显减少批量改文件时的卡顿（改文件期间完全不扫描，改完才扫一次）。单位：毫秒')
			.addText((t) => {
				t.inputEl.type = 'number';
				t.inputEl.addClass('elm-input-sm');
				t.setValue(String(p.settings.externalChangeDelayMs || 3000));
				t.onChange(async (v) => {
					const n = parseInt(v, 10);
					p.settings.externalChangeDelayMs = Number.isFinite(n) ? Math.min(60000, Math.max(500, n)) : 3000;
					await p.saveSettings();
				});
			});

		new Setting(containerEl)
			.setName('定时全量扫描')
			.setDesc('0 表示关闭。单位：分钟')
			.addText((t) => {
				t.inputEl.type = 'number';
				t.setValue(String(p.settings.scanIntervalMinutes || 0));
				t.onChange(async (v) => {
					p.settings.scanIntervalMinutes = Math.max(0, parseInt(v, 10) || 0);
					await p.saveSettings();
					p.setupInterval();
				});
			});

		/* ---------- 匹配策略 ---------- */
		containerEl.createEl('h3', { text: '匹配策略' });
		new Setting(containerEl)
			.setName('自动修复最低相似度')
			.setDesc('0.35 ~ 1.0。低于该值只提示不自动改（默认 0.6）')
			.addSlider((s) => s.setLimits(0.35, 1, 0.05).setValue(Number(p.settings.autoFixMinScore) || 0.6)
				.setDynamicTooltip()
				.onChange(async (v) => { p.settings.autoFixMinScore = v; await p.saveSettings(); }));

		new Setting(containerEl)
			.setName('搜索最大深度')
			.setDesc('遍历监控目录时的子目录层数，越大越慢')
			.addText((t) => {
				t.inputEl.type = 'number';
				t.setValue(String(p.settings.maxSearchDepth));
				t.onChange(async (v) => { p.settings.maxSearchDepth = Math.max(1, parseInt(v, 10) || 5); await p.saveSettings(); });
			});

		new Setting(containerEl)
			.setName('搜索最大文件数')
			.setDesc('超过则停止遍历，防止卡顿')
			.addText((t) => {
				t.inputEl.type = 'number';
				t.setValue(String(p.settings.maxSearchFiles));
				t.onChange(async (v) => { p.settings.maxSearchFiles = Math.max(1000, parseInt(v, 10) || 20000); await p.saveSettings(); });
			});

		/* ---------- 内容指纹 ---------- */
		containerEl.createEl('h3', { text: '内容指纹（识别「只改了名、内容没变」）' });
		containerEl.createEl('div', {
			cls: 'elm-hint',
			text: '给链接引用到的外部文件记录内容指纹。文件被改名后，即使名字完全对不上，也能靠指纹认出来。只对链接引用到的文件计算，开销很小。',
		});
		toggle('启用内容指纹匹配', '关掉后只能靠文件名 / 名称相似度匹配', 'detectByContent');

		new Setting(containerEl)
			.setName('指纹算法')
			.setDesc('sha256 最稳；md5 更快')
			.addDropdown((d) => {
				d.addOption('sha256', 'SHA-256（推荐）');
				d.addOption('md5', 'MD5（更快）');
				d.setValue(p.settings.hashAlgo || 'sha256');
				d.onChange(async (v) => {
					p.settings.hashAlgo = v;
					p.settings.fileIndex = {}; // 换算法要重算
					await p.saveSettings();
				});
			});

		new Setting(containerEl)
			.setName('指纹最大文件大小')
			.setDesc('单位 MB。超过此大小的文件不算指纹（避免读取超大文件）')
			.addText((t) => {
				t.inputEl.type = 'number';
				t.setValue(String(p.settings.hashMaxSizeMB || 64));
				t.onChange(async (v) => {
					p.settings.hashMaxSizeMB = Math.max(1, parseInt(v, 10) || 64);
					await p.saveSettings();
				});
			});

		new Setting(containerEl)
			.setName('清除全部内容指纹')
			.setDesc(`当前已记录 ${Object.keys(p.settings.fileIndex || {}).length} 条。下次扫描会重新采集`)
			.addButton((b) => b.setButtonText('清除').onClick(async () => {
				p.settings.fileIndex = {};
				await p.saveSettings();
				new Notice('内容指纹已清除');
				this.display();
			}));

		/* ---------- 扫描范围 ---------- */
		containerEl.createEl('h3', { text: '扫描范围（仓库内）' });
		new Setting(containerEl)
			.setName('包含路径')
			.setDesc('留空 = 全部笔记。每行一个仓库内路径前缀')
			.addTextArea((t) => {
				t.inputEl.rows = 3;
				t.inputEl.addClass('elm-input-wide');
				t.setValue((p.settings.includePaths || []).join('\n'));
				t.onChange(async (v) => {
					p.settings.includePaths = v.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
					await p.saveSettings();
				});
			});
		new Setting(containerEl)
			.setName('排除路径')
			.setDesc('每行一个仓库内路径前缀')
			.addTextArea((t) => {
				t.inputEl.rows = 3;
				t.inputEl.addClass('elm-input-wide');
				t.setValue((p.settings.excludePaths || []).join('\n'));
				t.onChange(async (v) => {
					p.settings.excludePaths = v.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
					await p.saveSettings();
				});
			});

		/* ---------- 路径处理 ---------- */
		containerEl.createEl('h3', { text: '路径处理' });
		toggle('用户名变更时自动重映射', '例如 C:\\Users\\旧名\\... → C:\\Users\\当前名\\...', 'remapUserProfile');
		toggle('路径含空格时用尖括号包裹', '写成 [文本](<C:\\a b\\c.txt>)，避免 Markdown 解析歧义', 'wrapPathsWithSpaces');

		new Setting(containerEl)
			.setName('盘符映射')
			.setDesc('每行一条，格式 D:=C:  或  D: -> E:')
			.addTextArea((t) => {
				t.inputEl.rows = 3;
				t.inputEl.addClass('elm-input-wide');
				t.setValue(p.settings.driveRemap || '');
				t.onChange(async (v) => { p.settings.driveRemap = v; await p.saveSettings(); });
			});

		new Setting(containerEl)
			.setName('POSIX 绝对路径根目录')
			.setDesc('只有以这些前缀开头的 /xxx 才被当作外部路径（避免误判 Obsidian 的库内绝对链接）')
			.addTextArea((t) => {
				t.inputEl.rows = 3;
				t.inputEl.addClass('elm-input-wide');
				t.setValue((p.settings.posixRoots || []).join('\n'));
				t.onChange(async (v) => {
					p.settings.posixRoots = v.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
					await p.saveSettings();
				});
			});

		toggle('把所有 / 开头路径都当作外部路径', '一般不要开', 'treatAllPosixAbsolute');

		/* ---------- 记录与日志 ---------- */
		containerEl.createEl('h3', { text: '记录与日志' });
		toggle('写入变更日志', '每次自动/手动改写链接都记一笔', 'writeChangeLog');
		new Setting(containerEl)
			.setName('变更日志路径')
			.setDesc('相对仓库根目录。留空 = 写到插件自己的目录下（推荐）')
			.addText((t) => t.setValue(p.settings.changeLogPath || '').onChange(async (v) => {
				p.settings.changeLogPath = v.trim(); await p.saveSettings();
			}));

		toggle('在状态栏显示待处理数量', '点击状态栏可打开管理面板', 'showStatusBar', () => {
			if (p.settings.showStatusBar) p.setupStatusBar();
			else if (p.statusEl) { p.statusEl.remove(); p.statusEl = null; }
		});

		/* ---------- 维护 ---------- */
		containerEl.createEl('h3', { text: '维护' });
		new Setting(containerEl)
			.setName('立即扫描并修复')
			.setDesc('扫描全库，并按当前策略修复')
			.addButton((b) => b.setButtonText('开始').setCta().onClick(async () => {
				await p.scanAll({ notify: true, refreshView: true });
				await p.fixAllFixable({ force: true, includePending: true });
			}))
			.addButton((b) => b.setButtonText('清空路径缓存').onClick(async () => {
				await p.clearCandidateCache();
				new Notice('候选路径缓存已清空');
			}));

		new Setting(containerEl)
			.setName('清除已忽略记录')
			.setDesc(`当前已忽略 ${(p.settings.ignored || []).length} 条`)
			.addButton((b) => b.setButtonText('清除').onClick(async () => {
				p.settings.ignored = [];
				await p.saveSettings();
				await p.scanAll({ silent: true, refreshView: true });
				new Notice('已清除忽略列表');
				this.display();
			}));

		new Setting(containerEl)
			.setName('恢复默认设置')
			.setDesc('不会删除笔记内容')
			.addButton((b) => b.setButtonText('恢复').setWarning().onClick(async () => {
				new ConfirmModal(this.app, '确认恢复默认设置', '所有插件设置（含监控目录、忽略列表）将被重置。', async () => {
					p.settings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
					await p.saveSettings();
					p.setupWatchers();
					p.setupInterval();
					this.display();
					new Notice('已恢复默认设置');
				}).open();
			}));
	}
}

/* ============================== 导出 ==================================== */

module.exports = ExternalLinkManagerPlugin;

/* 供无头测试调用的纯函数（Obsidian 加载插件时不会读这两个字段） */
module.exports.__test = { pathsFromDrop, attachPathDrop };

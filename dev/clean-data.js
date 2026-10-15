/* 一次性维护脚本：清理 data.json 里的遗留缓存（会写文件，谨慎使用）
 * 用法：node clean-data.js "<插件目录>" ["<监控文件夹路径>"]
 *   第二个参数可选；给了才会清理「落在监控范围之外」的陈旧候选缓存。
 */
'use strict';

const fs = require('fs');
const nodePath = require('path');

const DIR = (process.argv[2] || '').trim();
if (!DIR) {
	console.error('用法：node clean-data.js "<插件目录>" ["<监控文件夹路径>"]');
	console.error('例如：node clean-data.js "D:\\\\Notes\\\\vault\\\\.obsidian\\\\plugins\\\\external-link-manager"');
	process.exit(1);
}
const FILE = nodePath.join(DIR, 'data.json');
if (!fs.existsSync(FILE)) {
	console.error('找不到 data.json：' + FILE);
	process.exit(1);
}

const SCOPE = (process.argv[3] || '').trim();

const before = fs.statSync(FILE).size;
const d = JSON.parse(fs.readFileSync(FILE, 'utf8'));
const s = d.settings || {};
const log = [];

if ('alsoSearchUserProfile' in s) {
	delete s.alsoSearchUserProfile;
	log.push('移除 alsoSearchUserProfile（旧版默认 true，会把用户主目录纳入搜索）');
}

if (s.indexCache && s.indexCache['@dirs']) {
	log.push('移除 @dirs（' + s.indexCache['@dirs'].length + ' 条目录缓存，旧版遗留）');
	delete s.indexCache['@dirs'];
}

for (const k of Object.keys(s.indexCache || {})) {
	const v = s.indexCache[k];
	if (Array.isArray(v) && v.length > 50) {
		s.indexCache[k] = v.slice(0, 50);
		log.push('截断 indexCache[' + k + '] ' + v.length + ' -> 50');
	}
}

// 清掉落在监控范围之外的陈旧候选缓存（只有在传了监控文件夹路径时才做）
// 注意：比较前统一分隔符 —— 命令行传进来的 Windows 路径可能是 / 或 \ 混用
const norm = (x) => String(x == null ? '' : x).replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase();
if (SCOPE) {
	const scopeLow = norm(SCOPE);
	for (const k of Object.keys(s.indexCache || {})) {
		const v = s.indexCache[k] || [];
		const bad = v.filter((x) => !norm(x).startsWith(scopeLow));
		if (bad.length) {
			const keep = v.filter((x) => norm(x).startsWith(scopeLow));
			if (keep.length) s.indexCache[k] = keep;
			else delete s.indexCache[k];
			log.push('清掉范围外缓存 key=' + JSON.stringify(k) + '（' + bad.length + ' 条）');
		}
	}
}

fs.writeFileSync(FILE, JSON.stringify(d), 'utf8');
const after = fs.statSync(FILE).size;

console.log(log.length ? log.join('\n') : '(无需清理)');
console.log('\n体积：' + before + ' -> ' + after + ' 字节');

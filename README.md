# 阅读器 V1

一个**个人自用**的 EPUB 阅读器（PWA）。核心是：在划线的当下**原地**写下想法，数据全部存在本地，关掉再打开还在。

按 [reader-prd-v1.md](reader-prd-v1.md) 实现。

## 技术栈

- **React + Vite + TypeScript**
- **EPUB 渲染**：[foliate-js](https://github.com/johnfactotum/foliate-js)（已 vendored 到 `public/foliate-js/`，按原始 ES 模块运行时加载，未经打包）
- **本地存储**：IndexedDB（经 `idb` 封装）
- **PWA**：`vite-plugin-pwa`（manifest + service worker，可添加到主屏全屏运行、离线打开）
- **后端**：无，纯前端纯本地

## 运行

```bash
npm install
npm run dev       # 开发： http://localhost:5173
# 或
npm run build && npm run preview   # 生产预览： http://localhost:4173
```

> PWA / Service Worker 只在 `build` 后生效（`dev` 下默认关闭）。要测试「添加到主屏 + 离线」，请用 `npm run build && npm run preview`，并在手机浏览器打开预览地址（iOS 需 HTTPS 或 `localhost`；局域网测试可用 `npm run preview -- --host` 配合反向代理 / 隧道提供 HTTPS）。

## 测试用书

仓库里有一个脚本生成的最小 EPUB，导入它即可走通全流程：

```bash
node scripts/make-sample-epub.mjs   # 生成 sample.epub
```

## 功能与验收对照（PRD §7）

1. 导入 EPUB、点击左右区域翻页、目录（☰）可跳转 — ✅
2. 关闭后重开回到上次位置（CFI 持久化，翻页即保存）— ✅
3. 选中文字 → 选区上方弹出「划线并写想法」按钮 → 点击后原地弹出输入框、自动聚焦 — ✅
4. 写想法 + 选标签保存，刷新后高亮与想法都在 — ✅
5. 想法留空也能保存（仅高亮）— ✅
6. 点击已有高亮可重新编辑想法 / 标签 — ✅
7. 笔记面板（✦）列出本书全部划线（按书中顺序），点击跳回原文 — ✅
8. 书架长按/悬停卡片右上角 × 删除整本（含其划线，删除前确认）— ✅
9. 书架「导出数据」导出全部为 JSON — ✅
10. 添加到 iOS 主屏全屏运行、离线打开已导入的书 — ✅（manifest `display: standalone` + SW 预缓存应用壳；书数据在 IndexedDB）

## 外观与排版（设置）

阅读界面右上角 **Aa** 打开设置(底部弹出),可实时调整并自动记住:

- **主题**:纸张(暖白)/ 护眼(米黄)/ 夜间(深色)。正文背景由主题统一控制,**不再跟随系统深色模式**,所以外壳和正文颜色始终一致。
- **排版**:流式滚动(默认,上下连续滚动)/ 左右翻页(点击屏幕两侧翻页)。
- **字号 / 行距**:逐级加减。

主题色既驱动 App 外壳(CSS 变量),也注入到 foliate 的正文 iframe([src/lib/settings.ts](src/lib/settings.ts) 是唯一颜色来源)。

> **关于 iPad / Apple Pencil**:划线基于「选中文字」(这样才能记住精确位置)。用**手指长按选中**一段文字,选区上方就会弹出「划线」按钮。Apple Pencil 在 Safari 网页里默认用于滚动/书写,不保证能直接选中网页文字;真正的「Pencil 涂抹高亮」是另一套手绘方案,与文本定位机制冲突,第一版不做。

## 交互说明（命根子）

- **划线**：在正文中选中一段文字，选区上方出现「✍️ 划线并写想法」按钮。点击它会立刻把高亮持久化，并在原地弹出输入框（已自动聚焦，可直接打字）。
  - 之所以多一步「点按钮」而不是选中即弹窗，是因为触屏上「选区是否结束」无法可靠判断，这样最稳、也避免拖动选区时反复弹窗。详见 [Reader.tsx](src/components/Reader.tsx) 注释。
- 输入框里可写想法（可空）、可选一个标签（`金句 / 疑问 / 启发 / 反对 / 待查`），`保存` / `取消` / `删除划线`。
- `Cmd/Ctrl + Enter` 快速保存，`Esc` 取消。
- 不同标签对应不同高亮颜色。

## 数据导出格式

`导出数据` 生成 `reader-export-YYYY-MM-DD.json`，包含所有书的元信息（不含 EPUB 文件本体与封面二进制）和**全部划线 + 想法 + 标签**——笔记是核心资产，必须能备份。第一版不做导入。

## 目录结构

```
public/foliate-js/   vendored 的 foliate-js（GPL-3.0，见其 LICENSE）
src/
  lib/
    db.ts            IndexedDB 数据层（books / highlights / 导出）
    foliate.ts       foliate-js 运行时加载与封装
    geometry.ts      选区 → 屏幕坐标映射 + 弹窗定位
    tags.ts          标签与颜色
    types.ts         数据模型
  components/
    Bookshelf.tsx    书架（导入 / 删除 / 导出）
    Reader.tsx       阅读器（渲染 / 翻页 / 选区 / 高亮 / 持久化）★命根子
    HighlightEditor.tsx  原地想法输入框
    TocPanel / NotesPanel / SidePanel
scripts/
  generate-icons.mjs    生成 PWA 图标
  make-sample-epub.mjs  生成测试用 EPUB
```

## 已知取舍 / 假设

- 第一版只做 EPUB，不做 PDF（PRD 非目标）。
- 坐标映射假设书内容为可重排（reflowable）分页布局；固定版式（pre-paginated）EPUB 的弹窗定位未特别适配。
- 不实现任何 AI / 复习 / 书评 / 报告 / 账号 / 云同步等后续版本功能（PRD §4）。

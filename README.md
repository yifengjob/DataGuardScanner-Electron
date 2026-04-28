# DataGuard Scanner - Electron版本

<div align="center">

![Version](https://img.shields.io/badge/version-1.0.5-blue.svg)
![License](https://img.shields.io/badge/license-AGPL--3.0-green.svg)
![Electron](https://img.shields.io/badge/Electron-28.x-47848F.svg)
![Vue](https://img.shields.io/badge/Vue-3.x-4FC08D.svg)
![Node.js](https://img.shields.io/badge/Node.js-20+-339933.svg)

**一款强大的跨平台敏感数据检测工具，帮助您快速发现和定位文件中的隐私信息**

[功能特性](#功能特性) • [技术栈](#技术栈) • [安装指南](#安装指南) • [使用说明](#使用说明)

</div>

---

## 📖 项目简介

DataGuard Scanner 是一款基于 Electron 和 Vue 3 构建的跨平台桌面应用程序，专门用于扫描和检测文件系统中的敏感数据。它能够智能识别身份证号、手机号、邮箱、银行卡号、地址、IP 地址和密码等隐私信息，并提供可视化的高亮预览和报告导出功能。

### 核心优势

- 🔍 **智能检测**：采用正则表达式 + 校验算法（Luhn、身份证校验码）确保准确性
- ⚡ **高性能**：基于 Node.js 后端，支持并发扫描
- 🎯 **多格式支持**：支持文本文件、PDF、Excel 等多种格式
- 🌐 **跨平台**：完美支持 Windows、macOS 和 Linux
- 📊 **可视化报告**：支持 CSV、JSON、Excel 三种格式导出扫描结果
- 🔒 **安全可靠**：本地运行，数据不上传，保护隐私安全

---

## ✨ 功能特性

### 1. 敏感数据类型检测

| 类型 | 说明 | 默认启用 | 校验方式 |
|------|------|---------|---------|
| 🆔 身份证号 | 18位中国居民身份证 | ✅ | 校验码 + 日期验证 |
| 📱 手机号 | 中国大陆11位手机号 | ✅ | 号段验证 + 边界检查 |
| 📧 电子邮箱 | 标准邮箱格式 | ✅ | 正则匹配 |
| 💳 银行卡号 | 借记卡/信用卡 | ✅ | Luhn算法校验 |
| 🏠 地址 | 中国行政区划地址 | ✅ | 严格模式匹配 |
| 🌐 IPv4地址 | IP地址格式 | ✅ | 范围验证(0-255) |
| 🔑 密码 | password/pwd等关键词 | ✅ | 模式匹配 |
| 👤 中文姓名 | 2-4个连续汉字 | ❌ | 正则匹配（易误报） |

### 2. 文件格式支持

#### 文本文件
- 基础格式：`.txt`, `.log`, `.md`, `.ini`, `.conf`, `.cfg`, `.env`
- 代码文件：`.js`, `.ts`, `.py`, `.java`, `.c`, `.cpp`, `.go`, `.rs`, `.php`, `.rb`, `.swift`
- 配置文件：`.csv`, `.json`, `.xml`, `.yaml`, `.yml`, `.properties`, `.toml`

#### 文档文件
- PDF 文档（使用 `pdf-parse` 库解析）
- Excel 表格（实验性支持）

### 3. 核心功能

- 🗂️ **目录树浏览**：懒加载目录结构，性能优化
- 🔎 **智能扫描**：自定义扫描路径，文件类型筛选，实时进度显示
- 👁️ **文件预览**：内容高亮显示敏感数据，不同颜色标识不同类型
- 📈 **结果管理**：表格展示扫描结果，统计各类敏感数据数量
- 📤 **报告导出**：CSV、JSON、Excel 三种格式
- 🗑️ **文件删除**：移入回收站或永久删除
- ⚙️ **配置管理**：自动保存用户配置，主题设置
- 🛡️ **环境检查**：启动时自动检测系统环境
- 📝 **日志系统**：实时记录扫描过程

---

## 🛠️ 技术栈

### 前端技术
- **框架**：Vue 3 (Composition API)
- **状态管理**：Pinia
- **构建工具**：Vite 6.x
- **语言**：TypeScript 5.x
- **UI**：原生 CSS（无第三方 UI 库）

### 后端技术
- **框架**：Electron 28.x
- **语言**：Node.js + TypeScript
- **文件系统**：fs, walkdir
- **序列化**：JSON

### 核心依赖库

| 库名 | 版本 | 用途 |
|------|------|------|
| `electron` | 28.x | 桌面应用框架 |
| `vue` | 3.x | 前端框架 |
| `pinia` | 2.x | 状态管理 |
| `vite` | 6.x | 构建工具 |
| `typescript` | 5.x | 类型系统 |
| `pdf-parse` | 1.x | PDF 文本提取 |
| `exceljs` | 4.x | Excel 文件读写 |
| `walkdir` | 0.4.x | 目录遍历 |
| `trash` | 9.x | 文件回收站操作 |
| `chrono-node` | 2.x | 时间处理 |

### 包管理器
- **前端**：pnpm（推荐）或 npm
- **后端**：npm/pnpm

---

## 📦 安装指南

### 系统要求

- **Node.js**: 20.x 或更高版本
- **pnpm**: 8.x 或更高版本

#### Windows
- Windows 10 (版本 1809+) 或 Windows 11

#### macOS
- macOS 10.15 (Catalina) 或更高版本

#### Linux
- Ubuntu 20.04+、Debian 11+、Fedora 35+

### 从源码构建

#### 前置条件
1. 安装 [Node.js](https://nodejs.org/)（20+ 推荐）
2. 安装 [pnpm](https://pnpm.io/installation)

```bash
# 安装 pnpm
npm install -g pnpm
```

#### 构建步骤

```bash
# 1. 克隆仓库
git clone <repository-url>
cd DataGuardScanner

# 2. 安装依赖
pnpm install

# 3. 复制前端代码（从Tauri项目）
cp -r /path/to/tauri-project/frontend/src/* frontend/src/

# 4. 修改API引用
# 将所有文件中的 'tauri-api' 替换为 'electron-api'

# 5. 开发模式运行
pnpm dev

# 6. 生产模式构建
pnpm build
```

#### 构建安装包

```bash
# 构建安装包（根据系统生成对应格式）
pnpm build
```

生成的安装包位于 `release/`：
- **Windows**: `.exe` (NSIS安装程序) 或 portable (绿色版)
- **macOS**: `.dmg` (磁盘镜像) 或 `.zip` (压缩包)
- **Linux**: `.AppImage` (便携式应用) 或 `.deb` (Debian/Ubuntu包)

### 跨平台打包指南

#### 前置准备

1. **准备应用图标**
   - 将图标文件放入 `build/` 目录
   - Windows: `icon.ico` (256x256, 多尺寸ICO格式)
   - macOS: `icon.icns` (包含16x16到1024x1024多个尺寸)
   - Linux: `icon.png` (512x512 PNG格式)

2. **安装依赖**
   ```bash
   pnpm install
   ```

#### 在 macOS 上打包所有平台

```bash
# 1. 构建前端
pnpm build:renderer

# 2. 编译TypeScript
npx tsc -p tsconfig.main.json

# 3. 打包当前平台 (macOS)
pnpm build

# 4. 打包 Windows (需要 Wine)
pnpm build --win

# 5. 打包 Linux
pnpm build --linux
```

#### 在 Windows 上打包所有平台

```powershell
# 打包 Windows
pnpm build

# 打包 macOS (需要 macOS 环境)
pnpm build --mac

# 打包 Linux
pnpm build --linux
```

#### 在 Linux 上打包所有平台

```bash
# 打包 Linux
pnpm build

# 打包 Windows
pnpm build --win

# 打包 macOS (需要 macOS 环境)
pnpm build --mac
```

#### 使用 CI/CD 自动化打包

推荐使用 GitHub Actions 或其他 CI/CD 工具进行自动化打包：

```yaml
# .github/workflows/build.yml 示例
name: Build and Release

on:
  push:
    tags: ['v*']

jobs:
  build:
    strategy:
      matrix:
        os: [windows-latest, macos-latest, ubuntu-latest]
    
    runs-on: ${{ matrix.os }}
    
    steps:
      - uses: actions/checkout@v3
      
      - name: Setup Node.js
        uses: actions/setup-node@v3
        with:
          node-version: '20'
      
      - name: Install pnpm
        run: npm install -g pnpm
      
      - name: Install dependencies
        run: pnpm install
      
      - name: Build
        run: pnpm build
      
      - name: Upload artifacts
        uses: actions/upload-artifact@v3
        with:
          name: ${{ matrix.os }}-build
          path: release/
```

### 打包配置说明

在 `package.json` 的 `build` 字段中配置：

```json
{
  "build": {
    "appId": "com.dataguard.scanner",
    "productName": "DataGuard Scanner",
    "directories": {
      "output": "release"
    },
    "files": [
      "dist/**/*",
      "frontend/dist/**/*",
      "node_modules/**/*"
    ],
    "win": {
      "target": ["nsis", "portable"],
      "icon": "build/icon.ico"
    },
    "mac": {
      "target": ["dmg", "zip"],
      "category": "public.app-category.developer-tools",
      "icon": "build/icon.icns"
    },
    "linux": {
      "target": ["AppImage", "deb"],
      "category": "Development",
      "icon": "build/icon.png"
    }
  }
}
```

### 常见问题

**Q: 打包后应用图标不显示？**
A: 确保 `build/` 目录中有正确格式的图标文件，并且路径配置正确。

**Q: 如何减小安装包体积？**
A: 
- 移除不必要的依赖
- 使用 `electron-builder` 的 `asar` 压缩
- 排除开发依赖 (`devDependencies`)

**Q: 打包时提示缺少某些模块？**
A: 确保运行了 `pnpm install`，并且 `package.json` 中的依赖配置正确。

---

## 📖 使用说明

### 快速开始

1. **启动应用**
   ```bash
   pnpm dev
   ```

2. **选择扫描路径**
   - 在左侧目录树中勾选要扫描的文件夹
   - 支持多选和全选

3. **配置扫描选项**
   - 点击顶部菜单栏"设置"
   - 选择要检测的敏感数据类型
   - 配置文件类型过滤器

4. **开始扫描**
   - 点击"开始扫描"按钮
   - 实时查看扫描进度

5. **查看结果**
   - 右侧表格显示包含敏感数据的文件
   - 双击文件行预览内容
   - 敏感信息会以不同颜色高亮显示

6. **导出报告**
   - 点击"导出报告"按钮
   - 选择格式（CSV/JSON/Excel）

---

## 🔧 开发指南

### 项目结构

```
DataGuardScanner/
├── src/                    # Electron 主进程
│   ├── main.ts            # 主入口
│   ├── preload.ts         # Preload脚本
│   ├── types.ts           # TypeScript类型定义
│   ├── scan-state.ts      # 扫描状态管理
│   ├── directory-tree.ts  # 目录树
│   ├── scanner.ts         # 扫描引擎
│   ├── sensitive-detector.ts  # 敏感数据检测
│   ├── file-parser.ts     # 文件解析器
│   ├── file-operations.ts # 文件操作
│   ├── report-exporter.ts # 报告导出
│   ├── config-manager.ts  # 配置管理
│   └── environment-check.ts  # 环境检查
│
├── frontend/              # 前端 Vue 应用
│   ├── src/
│   │   ├── components/    # Vue 组件
│   │   ├── stores/        # Pinia 状态管理
│   │   ├── types/         # TypeScript 类型定义
│   │   ├── utils/         # 工具函数
│   │   │   ├── electron-api.ts  # Electron API封装
│   │   │   └── theme.ts   # 主题管理
│   │   ├── App.vue        # 主应用组件
│   │   └── main.ts        # 入口文件
│   ├── package.json
│   └── vite.config.ts
│
├── package.json           # 根级别 npm 脚本
├── tsconfig.main.json     # 主进程TS配置
└── README.md
```

### 开发工作流

#### 开发模式

```bash
# 启动开发服务器（热重载）
pnpm dev
```

这会同时启动：
- 前端 Vite 开发服务器（http://localhost:1420）
- Electron 应用窗口

#### 代码规范

**TypeScript 代码：**
```bash
# 类型检查
tsc --noEmit

# 格式化（如果配置了 Prettier）
prettier --write "src/**/*.ts"
```

---

## 📊 性能优化

### 已实现的优化

1. **异步扫描**：使用 Node.js 异步 I/O
2. **懒加载目录树**：只加载展开的目录节点
3. **文件大小限制**：跳过大文件，避免内存溢出
4. **智能路径去重**：避免重复扫描父子路径

### 调优建议

- **并发数调整**：根据 CPU 核心数调整扫描并发
- **文件大小限制**：根据实际需求调整最大文件大小
- **PDF 单独限制**：PDF 解析较慢，单独设置限制

---

## 🔐 安全说明

### 数据处理
- ✅ 所有扫描在本地完成，数据不会上传
- ✅ 配置文件存储在本地
- ✅ 不使用网络通信

### 权限需求
- **文件系统读取**：扫描选定目录
- **文件系统写入**：保存配置和导出报告
- **删除文件**：用户主动触发的删除操作

---

## 📝 更新日志

### v1.0.5 (当前版本)
- ✅ 从 Tauri2 迁移到 Electron
- ✅ 完整的敏感数据扫描功能
- ✅ 支持多种文件格式解析
- ✅ 跨平台桌面应用
- ✅ 支持 CSV/JSON/Excel 报告导出

---

## 📄 许可证

本项目采用 AGPL-3.0 license 许可证

---

## 🙏 致谢

感谢以下开源项目的支持：

- [Electron](https://www.electronjs.org/) - 优秀的跨平台桌面应用框架
- [Vue.js](https://vuejs.org/) - 渐进式 JavaScript 框架
- [pdf-parse](https://www.npmjs.com/package/pdf-parse) - PDF 文本提取库
- [exceljs](https://www.npmjs.com/package/exceljs) - Excel 文件读写库

---

## 📞 联系方式

- 📧 Email: yifengjob@qq.com

---

<div align="center">

**⭐ 如果这个项目对您有帮助，请给我一个 Star！**

Made with ❤️ by YiFeng

</div>

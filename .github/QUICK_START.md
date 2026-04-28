# 🚀 GitHub Actions 快速开始指南

## 5 分钟发布应用

### 步骤 1: 推送代码到 GitHub

```bash
# 确保代码已提交
git add .
git commit -m "chore: add GitHub Actions workflow"
git push origin main
```

### 步骤 2: 创建版本标签

```bash
# 更新 package.json 中的版本号
# 例如: "version": "1.0.6"

# 创建并推送标签
git tag v1.0.6
git push origin v1.0.6
```

### 步骤 3: 等待自动构建

访问: `https://github.com/你的用户名/DataGuardScanner/actions`

您会看到三个并行运行的工作流：
- ✅ Build macOS
- ✅ Build Windows  
- ✅ Build Linux

### 步骤 4: 下载 Release

构建完成后（约 5-8 分钟）：

1. 访问仓库主页
2. 点击右侧的 **Releases**
3. 找到最新的 Release (v1.0.6)
4. 下载对应平台的安装包

---

## 📦 生成的文件

### macOS
- `DataGuard Scanner 1.0.6.dmg` - 拖拽安装
- `DataGuard Scanner 1.0.6.zip` - 解压即用

### Windows
- `DataGuard Scanner Setup 1.0.6.exe` - 双击安装
- `DataGuard Scanner 1.0.6 portable.exe` - 无需安装

### Linux
- `DataGuard Scanner 1.0.6.AppImage` - 添加执行权限后运行
- `DataGuard Scanner_1.0.6_amd64.deb` - `sudo dpkg -i` 安装

---

## ⚡ 常用命令速查

### 发布新版本

```bash
# 1. 更新版本号 (package.json)
# 2. 提交
git add package.json
git commit -m "chore: bump version to X.X.X"

# 3. 打标签
git tag vX.X.X
git push origin vX.X.X

# 完成！等待自动构建和发布
```

### 仅测试构建（不发布）

```bash
# 推送到 main 分支
git push origin main

# 在 Actions 页面下载 Artifacts
```

### 查看构建状态

```bash
# 命令行查看（需要 gh CLI）
gh run list

# 或访问网页
open https://github.com/你的用户名/DataGuardScanner/actions
```

---

## 🔧 故障排除

### 构建失败？

1. **检查日志**
   ```bash
   # 使用 gh CLI 查看日志
   gh run view --log
   ```

2. **本地测试**
   ```bash
   # 清理并重新构建
   rm -rf node_modules dist frontend/dist
   pnpm install
   pnpm build
   ```

3. **常见问题**
   - 图标文件缺失 → 检查 `build/` 目录
   - TypeScript 错误 → 运行 `npx tsc -p tsconfig.main.json`
   - 前端构建失败 → 运行 `cd frontend && pnpm build`

### 没有创建 Release？

确认：
- ✅ Tag 格式正确（必须以 `v` 开头，如 `v1.0.6`）
- ✅ Tag 已推送到 GitHub
- ✅ 工作流有 `contents: write` 权限

---

## 💡 提示

### 首次使用

第一次推送 tag 时，GitHub 需要下载 Electron 二进制文件（~100MB），可能需要额外 2-3 分钟。

### 后续构建

由于缓存，后续构建会更快（约 3-5 分钟）。

### 并行构建

三个平台同时构建，总时间取决于最慢的平台（通常是 macOS）。

---

<div align="center">

**就这么简单！享受自动化构建带来的便利！** ✨

</div>

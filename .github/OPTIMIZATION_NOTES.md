# GitHub Actions 配置优化说明

## ✅ 已完成的优化

根据 Tauri 版本的最佳实践，对 Electron 的 GitHub Actions 配置进行了全面优化。

---

## 🔄 主要改进

### 1. Action 版本更新

| Action | 原版本 | 新版本 | 说明 |
|--------|--------|--------|------|
| actions/checkout | v4 | **v6** | 最新的代码检出动作 |
| actions/setup-node | v4/v5 | **v5** | 统一的 Node.js 设置版本 |
| pnpm/action-setup | v2 | **v5** | 最新的 pnpm 安装动作 |
| actions/upload-artifact | v4 | **v7** | 最新的上传动作 |
| actions/download-artifact | v4 | **v8** | 最新的下载动作 |
| softprops/action-gh-release | v1 | v1 | 保持不变（稳定版本）|

### 2. 构建策略优化

#### 之前：三个独立的 Job
```yaml
jobs:
  build-macos:    # 串行执行
  build-windows:  # 串行执行
  build-linux:    # 串行执行
```

#### 现在：Matrix 策略（并行执行）
```yaml
jobs:
  build:
    strategy:
      fail-fast: false
      matrix:
        include:
          - os: windows-latest
            platform: windows-x64
          - os: ubuntu-22.04
            platform: linux-x64
          - os: macos-13
            platform: macos-intel
          - os: macos-latest
            platform: macos-arm
```

**优势**:
- ✅ 四个平台同时构建（更快）
- ✅ 统一的配置管理
- ✅ 更容易添加新平台
- ✅ fail-fast: false 确保所有平台都尝试构建

### 3. macOS 架构支持

#### 新增 Apple Silicon (ARM) 支持
```yaml
# macOS Intel (x86_64)
- os: macos-13
  platform: macos-intel
  
# macOS Apple Silicon (ARM64)
- os: macos-latest
  platform: macos-arm
```

**注意**: 
- `macos-13` 是 Intel 架构
- `macos-latest` (macos-14) 是 ARM 架构

### 4. 触发条件简化

#### 之前
```yaml
on:
  push:
    branches: [main]
    tags: ['v*']
  pull_request:
    branches: [main]
```

#### 现在
```yaml
on:
  push:
    tags: ['v*']
  workflow_dispatch:  # 允许手动触发
```

**原因**:
- 只在打标签时自动发布（更可控）
- 添加手动触发（方便测试）
- 移除了 PR 和 main 分支触发（减少不必要的构建）

### 5. 缓存配置优化

#### 添加 cache-dependency-path
```yaml
- name: Setup Node.js
  uses: actions/setup-node@v5
  with:
    node-version: '18'
    cache: 'pnpm'
    cache-dependency-path: pnpm-lock.yaml  # ← 新增
```

**优势**: 更精确的缓存键，避免无效缓存

### 6. Release 流程分离

#### 之前：每个平台单独创建 Release
```yaml
# 在 build-macos, build-windows, build-linux 中都有
- name: Create Release (on tag)
  if: startsWith(github.ref, 'refs/tags/')
```

#### 现在：统一的 Release Job
```yaml
release:
  needs: build
  if: startsWith(github.ref, 'refs/tags/v')
  runs-on: ubuntu-latest
  
  steps:
    - name: Download all artifacts
      uses: actions/download-artifact@v8
      
    - name: Create Release
      uses: softprops/action-gh-release@v1
```

**优势**:
- ✅ 只创建一个 Release（避免冲突）
- ✅ 所有平台的文件都在同一个 Release 中
- ✅ 更清晰的流程

### 7. Artifact 命名规范

#### 之前
```yaml
name: macos-build
name: windows-build
name: linux-build
```

#### 现在
```yaml
name: dataguard-scanner-${{ matrix.platform }}
# 例如: dataguard-scanner-windows-x64
```

**优势**: 更清晰的命名，包含平台信息

### 8. 错误处理增强

```yaml
- name: Upload Windows artifacts
  uses: actions/upload-artifact@v7
  with:
    if-no-files-found: error  # ← 如果没有文件则失败
```

**优势**: 及时发现构建问题

---

## 📊 对比总结

| 特性 | 之前 | 现在 |
|------|------|------|
| Action 版本 | 混合 (v2-v5) | 最新 (v5-v8) |
| 构建方式 | 3个独立 Job | Matrix 策略 |
| 并行度 | 部分并行 | 完全并行 |
| macOS 架构 | 仅 Intel | Intel + ARM |
| 触发条件 | main + tags + PR | tags + manual |
| Release 创建 | 每个平台单独 | 统一创建 |
| 缓存优化 | 基础 | 增强 |
| 错误检测 | 弱 | 强 |

---

## 🎯 使用方式

### 发布新版本（推荐）

```bash
# 1. 更新版本号
# package.json: "version": "1.0.6"

# 2. 提交并打标签
git add package.json
git commit -m "chore: bump version to 1.0.6"
git tag v1.0.6
git push origin v1.0.6

# 3. 等待自动构建和发布（约 5-8 分钟）
```

### 手动触发构建（测试用）

1. 访问仓库的 **Actions** 页面
2. 点击 **"Build and Release"** 工作流
3. 点击 **"Run workflow"** 按钮
4. 选择分支（通常是 main）
5. 点击 **"Run workflow"**

---

## 📦 构建产物

### Artifacts（保留90天）

每次构建生成 4 个 Artifacts：
- `dataguard-scanner-windows-x64`
- `dataguard-scanner-linux-x64`
- `dataguard-scanner-macos-intel`
- `dataguard-scanner-macos-arm`

### GitHub Release（永久保存）

推送 tag 后，Release 包含：
- Windows: `.exe` (NSIS + Portable)
- Linux: `.AppImage`, `.deb`
- macOS: `.dmg`, `.zip` (Intel + ARM)

---

## ⚙️ 配置亮点

### 1. Matrix 策略
```yaml
strategy:
  fail-fast: false  # 一个平台失败不影响其他平台
  matrix:
    include:
      # 定义所有平台和配置
```

### 2. 条件执行
```yaml
- name: Upload Windows artifacts
  if: startsWith(matrix.platform, 'windows')
```

### 3. 依赖关系
```yaml
release:
  needs: build  # 等待所有构建完成
  if: startsWith(github.ref, 'refs/tags/v')
```

---

## 🔍 验证清单

### Action 版本
- [x] actions/checkout@v6
- [x] actions/setup-node@v5
- [x] pnpm/action-setup@v5
- [x] actions/cache@v4
- [x] actions/upload-artifact@v7
- [x] actions/download-artifact@v8
- [x] softprops/action-gh-release@v1

### 平台覆盖
- [x] Windows x64
- [x] Linux x64
- [x] macOS Intel
- [x] macOS ARM

### 功能完整性
- [x] pnpm 缓存
- [x] 前端构建
- [x] TypeScript 编译
- [x] Electron 打包
- [x] Artifact 上传
- [x] Release 创建

---

## 💡 最佳实践

### 1. 版本号管理
始终在 `package.json` 中维护正确的版本号

### 2. Tag 格式
使用语义化版本：`v1.0.6`（必须有 `v` 前缀）

### 3. 手动触发
在正式发布前，可以手动触发测试构建

### 4. 监控构建
访问 Actions 页面查看实时进度

---

## 🚀 下一步

### 可选增强

1. **代码签名**
   ```yaml
   env:
     CSC_LINK: ${{ secrets.CSC_LINK }}
     WIN_CSC_LINK: ${{ secrets.WIN_CSC_LINK }}
   ```

2. **通知集成**
   - Slack 通知
   - Discord 通知
   - Email 通知

3. **自动化测试**
   ```yaml
   - name: Run tests
     run: pnpm test
   ```

4. **Docker 镜像**
   ```yaml
   - name: Build Docker image
     run: docker build -t dataguard-scanner .
   ```

---

## 📞 故障排除

### 构建失败？

1. **检查日志**
   - 访问 Actions 页面
   - 点击失败的步骤
   - 查看详细错误

2. **常见问题**
   - ❌ Action 版本不存在 → 检查版本号是否正确
   - ❌ 权限不足 → 确认 GITHUB_TOKEN 有 write 权限
   - ❌ 缓存失效 → 清除缓存重试

3. **本地测试**
   ```bash
   rm -rf node_modules dist frontend/dist
   pnpm install
   pnpm build
   ```

---

<div align="center">

**配置已优化完成！现在可以使用最新版本的 Actions 进行高效构建了！** 🎉

</div>

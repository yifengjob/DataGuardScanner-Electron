<template>
  <div class="directory-tree">
    <div class="tree-header">
      <h3>扫描路径</h3>
      <div class="tree-actions">
        <button class="btn-small" @click="handleSelectAll">全选</button>
        <button class="btn-small" @click="handleDeselectAll">全不选</button>
        <button class="btn-small" @click="handleExpandAll">展开</button>
        <button class="btn-small" @click="handleCollapseAll">折叠</button>
      </div>
    </div>
    
    <div class="tree-content">
      <!-- 【C1 优化】加载中状态 -->
      <div v-if="loading" class="loading-state">
        <div class="loading-spinner"></div>
        <div class="loading-text">正在加载目录...</div>
      </div>
      
      <!-- 空状态 -->
      <div v-else-if="rootNodes.length === 0" class="empty-state">
        <p>暂无可扫描的目录</p>
      </div>
      
      <!-- 目录树 -->
      <TreeNode
        v-else
        v-for="node in rootNodes"
        :key="node.path"
        :node="node"
        :level="0"
        :all-nodes-map="allNodesMap"
        @toggle="handleToggleNode"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import {onMounted, ref} from 'vue'
import {useAppStore} from '../stores/app'
import TreeNode from './TreeNode.vue'
import type {DirectoryNode} from '../types'
import {getDirectoryTree} from '../utils/electron-api'

const appStore = useAppStore()
const rootNodes = ref<DirectoryNode[]>([])
const allNodesMap = ref<Map<string, DirectoryNode>>(new Map())
// 【C1 优化】加载状态
const loading = ref(false)

// 加载根目录
onMounted(async () => {
  // 【C1 优化】设置加载状态
  loading.value = true
  
  try {
    // 检测操作系统
    const isWindows = navigator.userAgent.toLowerCase().includes('win')
    
    if (isWindows) {
      // Windows: 获取所有磁盘驱动器
      // 常见的驱动器列表，按字母顺序
      const possibleDrives = [
        'A:', 'B:', 'C:', 'D:', 'E:', 'F:', 'G:', 'H:', 'I:', 'J:',
        'K:', 'L:', 'M:', 'N:', 'O:', 'P:', 'Q:', 'R:', 'S:', 'T:',
        'U:', 'V:', 'W:', 'X:', 'Y:', 'Z:'
      ]
      
      const allNodes: DirectoryNode[] = []
      
      // 并行检查所有可能的驱动器
      const drivePromises = possibleDrives.map(async (drive) => {
        try {
          const nodes = await getDirectoryTree(drive + '\\')
          if (nodes.length > 0) {
            // 为每个驱动器创建一个父节点
            return {
              path: drive + '\\',
              name: drive,
              isDir: true,
              isHidden: false,
              hasChildren: true,
              children: nodes
            } as DirectoryNode
          }
        } catch (error) {
          // 驱动器不存在或无权限，跳过
        }
        return null
      })
      
      // 等待所有检查结果
      const results = await Promise.all(drivePromises)
      
      // 收集有效的驱动器节点
      results.forEach(result => {
        if (result) {
          allNodes.push(result)
        }
      })
      
      rootNodes.value = allNodes
    } else {
      // macOS/Linux: 使用根目录 /
      rootNodes.value = await getDirectoryTree('/')
    }
    
    // 构建所有节点的映射表
    buildNodesMap(rootNodes.value)
    
    // 默认全选
    appStore.selectAllDirectories(rootNodes.value)
  } catch (error) {
    console.error('加载目录树失败:', error)
  } finally {
    // 【C1 优化】清除加载状态
    loading.value = false
  }
})

// 递归构建节点映射表
function buildNodesMap(nodes: DirectoryNode[]) {
  nodes.forEach(node => {
    allNodesMap.value.set(node.path, node)
    if (node.children && node.children.length > 0) {
      buildNodesMap(node.children)
    }
  })
}

const handleSelectAll = () => {
  appStore.selectAllDirectories(rootNodes.value)
}

const handleDeselectAll = () => {
  appStore.deselectAllDirectories()
}

const handleToggleNode = (path: string) => {
  appStore.smartToggleNode(path, allNodesMap.value)
}

const handleExpandAll = () => {
  // TODO: 实现展开全部
}

const handleCollapseAll = () => {
  // TODO: 实现折叠全部
}
</script>

<style scoped>
.directory-tree {
  flex: 1;
  display: flex;
  flex-direction: column;
  border-bottom: 1px solid var(--border-color);
  overflow: hidden;
}

.tree-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px;
  background-color: var(--toolbar-bg);
  border-bottom: 1px solid var(--border-color);
}

.tree-header h3 {
  font-size: 14px;
  font-weight: 600;
}

.tree-actions {
  display: flex;
  gap: 5px;
}

.btn-small {
  padding: 3px 8px;
  font-size: 12px;
  border: 1px solid var(--border-color);
  background-color: var(--bg-color);
  color: var(--text-color);
  border-radius: 3px;
  cursor: pointer;
}

.btn-small:hover {
  background-color: var(--bg-hover);
}

.tree-content {
  flex: 1;
  overflow: auto;  /* 同时支持水平和垂直滚动 */
  padding: 8px;
}

/* 【C1 优化】加载状态样式 */
.loading-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 200px;
  gap: 12px;
}

.loading-spinner {
  width: 32px;
  height: 32px;
  border: 3px solid var(--border-color);
  border-top: 3px solid var(--primary-color);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  0% { transform: rotate(0deg); }
  100% { transform: rotate(360deg); }
}

.loading-text {
  font-size: 14px;
  color: var(--text-secondary);
}

/* 空状态样式 */
.empty-state {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 200px;
  color: var(--text-secondary);
  font-size: 14px;
}
</style>

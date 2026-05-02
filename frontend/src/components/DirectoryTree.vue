<template>
  <div class="directory-tree">
    <div class="tree-header">
      <h3>扫描路径</h3>
      <div class="tree-actions">
        <!-- 全选/全不选切换 -->
        <button 
          class="btn-icon" 
          @click="handleToggleSelectAll"
          :title="isAllSelected ? '全不选' : '全选'"
        >
          <svg class="action-icon" :class="{ 'icon-rotate': isAnimatingSelect }">
            <use :href="isAllSelected ? '#icon-unchecked' : '#icon-check-all'"></use>
          </svg>
        </button>
        
        <!-- 展开/折叠切换 -->
        <button 
          class="btn-icon" 
          @click="handleToggleExpand"
          :title="isAllExpanded ? '折叠全部' : '展开全部'"
        >
          <svg class="action-icon" :class="{ 'icon-rotate': isAnimatingExpand }">
            <use :href="isAllExpanded ? '#icon-collapse' : '#icon-expand'"></use>
          </svg>
        </button>
        
        <!-- 刷新 -->
        <button 
          class="btn-icon" 
          @click="handleRefresh"
          title="刷新目录树"
          :disabled="loading"
        >
          <svg class="action-icon" :class="{ 'icon-spin': loading }">
            <use href="#icon-refresh"></use>
          </svg>
        </button>
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
import {onMounted, ref, watch} from 'vue'
import {useAppStore} from '../stores/app'
import TreeNode from './TreeNode.vue'
import type {DirectoryNode} from '../types'
import {getDirectoryTree} from '../utils/electron-api'

const appStore = useAppStore()
const rootNodes = ref<DirectoryNode[]>([])
const allNodesMap = ref<Map<string, DirectoryNode>>(new Map())
// 【C1 优化】加载状态
const loading = ref(false)
// 【新增】全选状态
const isAllSelected = ref(true)
// 【新增】展开状态
const isAllExpanded = ref(false)
// 【新增】动画状态
const isAnimatingSelect = ref(false)
const isAnimatingExpand = ref(false)

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

// 【新增】切换全选/全不选
const handleToggleSelectAll = () => {
  // 触发动画
  isAnimatingSelect.value = true
  setTimeout(() => {
    isAnimatingSelect.value = false
  }, 300)
  
  if (isAllSelected.value) {
    // 当前是全选状态，执行全不选
    appStore.deselectAllDirectories()
    isAllSelected.value = false
  } else {
    // 当前是全不选状态，执行全选
    appStore.selectAllDirectories(rootNodes.value)
    isAllSelected.value = true
  }
}

// 【修改】监听 store 中的选中状态变化
watch(
  () => appStore.selectedDirectories.size,
  (newSize) => {
    // 如果选中的目录数量等于总目录数量，则为全选状态
    const totalPaths = countTotalPaths(rootNodes.value)
    isAllSelected.value = newSize === totalPaths && totalPaths > 0
  },
  { immediate: true }
)

// 【辅助方法】计算总路径数
const countTotalPaths = (nodes: DirectoryNode[]): number => {
  let count = 0
  nodes.forEach(node => {
    count++
    if (node.children && node.children.length > 0) {
      count += countTotalPaths(node.children)
    }
  })
  return count
}

const handleToggleNode = (path: string) => {
  appStore.smartToggleNode(path, allNodesMap.value)
}

// 【新增】切换展开/折叠全部
const handleToggleExpand = () => {
  // 触发动画
  isAnimatingExpand.value = true
  setTimeout(() => {
    isAnimatingExpand.value = false
  }, 300)
  
  if (isAllExpanded.value) {
    // 当前是展开状态，执行折叠
    collapseAllNodes(rootNodes.value)
    isAllExpanded.value = false
  } else {
    // 当前是折叠状态，执行展开
    expandAllNodes(rootNodes.value)
    isAllExpanded.value = true
  }
}

// 【辅助方法】递归展开所有节点
const expandAllNodes = (nodes: DirectoryNode[]) => {
  nodes.forEach(node => {
    if (node.children && node.children.length > 0) {
      node.expanded = true
      expandAllNodes(node.children)
    }
  })
}

// 【辅助方法】递归折叠所有节点
const collapseAllNodes = (nodes: DirectoryNode[]) => {
  nodes.forEach(node => {
    if (node.children && node.children.length > 0) {
      node.expanded = false
      collapseAllNodes(node.children)
    }
  })
}

// 【新增】刷新目录树
const handleRefresh = async () => {
  if (loading.value) return
  
  loading.value = true
  
  try {
    // 检测操作系统
    const isWindows = navigator.userAgent.toLowerCase().includes('win')
    
    if (isWindows) {
      // Windows: 获取所有磁盘驱动器
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
    
    // 重新构建所有节点的映射表
    allNodesMap.value.clear()
    buildNodesMap(rootNodes.value)
    
    // 默认全选
    appStore.selectAllDirectories(rootNodes.value)
    isAllSelected.value = true
    
    // 重置展开状态
    isAllExpanded.value = false
  } catch (error) {
    console.error('刷新目录树失败:', error)
  } finally {
    loading.value = false
  }
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
  gap: 8px;
}

/* 【新增】图标按钮样式 */
.btn-icon {
  padding: 6px;
  border: 1px solid var(--border-color);
  background-color: var(--bg-color);
  color: var(--text-color);
  border-radius: 4px;
  cursor: pointer;
  transition: all 0.2s ease;
  display: flex;
  align-items: center;
  justify-content: center;
  min-width: 32px;
  min-height: 32px;
}

.btn-icon:hover:not(:disabled) {
  background-color: var(--bg-hover);
  border-color: var(--primary-color);
  transform: translateY(-1px);
  box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
}

.btn-icon:active:not(:disabled) {
  transform: translateY(0);
}

.btn-icon:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.action-icon {
  width: 18px;
  height: 18px;
  fill: currentColor;
  transition: transform 0.3s ease;
}

/* 【新增】旋转动画（切换图标时） */
.icon-rotate {
  animation: rotateIcon 0.3s ease;
}

@keyframes rotateIcon {
  0% {
    transform: rotate(0deg) scale(1);
  }
  50% {
    transform: rotate(180deg) scale(1.2);
  }
  100% {
    transform: rotate(360deg) scale(1);
  }
}

/* 【新增】刷新旋转动画 */
.icon-spin {
  animation: spinIcon 0.8s linear infinite;
}

@keyframes spinIcon {
  0% { transform: rotate(0deg); }
  100% { transform: rotate(360deg); }
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

<template>
  <div class="modal-overlay" @click.self="$emit('close')" :class="{ visible: visible }">
    <div class="modal-container">
      <div class="modal-header">
        <h3>文件预览</h3>
        <button class="close-btn" @click="$emit('close')">×</button>
      </div>
      
      <div class="modal-body">
        <div v-if="loading" class="loading-container">
          <div class="loading-spinner"></div>
          <div class="loading-text">加载中...</div>
          <div class="loading-hint">正在读取文件内容，请稍候</div>
        </div>
        <div v-else-if="error" class="error" :class="errorSeverity">
          <div class="error-icon">{{ errorIcon }}</div>
          <div class="error-title">{{ errorTitle }}</div>
          <div class="error-text">{{ errorSuggestion }}</div>
        </div>
        <div v-else class="preview-content">
          <pre v-html="highlightedContent"></pre>
        </div>
      </div>
      
      <div class="modal-footer">
        <button class="btn" :disabled="loading" @click="handleOpenFile">打开文件</button>
        <button class="btn" :disabled="loading" @click="handleCopyContent">复制内容</button>
        <button class="btn btn-primary" @click="handleClose">{{ loading ? '取消' : '关闭' }}</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { previewFile, openFile, cancelPreview, showMessage } from '../utils/electron-api'
import { highlightText } from '../utils/format'
import { getFriendlyErrorMessage, getErrorSeverity } from '../utils/error-handler'

const props = defineProps<{
  filePath: string
  visible: boolean
}>()

const emit = defineEmits<{
  close: []
}>()

const loading = ref(false)
const error = ref('')
const content = ref('')
const highlights = ref<Array<{start: number, end: number, type_id: string, type_name: string}>>([])
const currentTaskId = ref<number | null>(null)  // 当前任务 ID
const errorSeverity = ref<'info' | 'warning' | 'error'>('error')  // 【C2优化】错误严重程度

// 【C2优化】错误图标
const errorIcon = computed(() => {
  switch (errorSeverity.value) {
    case 'info': return 'ℹ️'
    case 'warning': return '⚠️'
    case 'error': return '❌'
    default: return '⚠️'
  }
})

// 【C2优化】错误标题
const errorTitle = computed(() => {
  if (!error.value) return ''
  const lines = error.value.split('\n\n')
  return lines[0] || '未知错误'
})

// 【C2优化】错误建议
const errorSuggestion = computed(() => {
  if (!error.value) return ''
  const lines = error.value.split('\n\n')
  return lines[1] || ''
})

const highlightedContent = computed(() => {
  if (!content.value) return ''
  return highlightText(content.value, highlights.value)
})

// 监听 visible 和 filePath 的组合变化
watch([() => props.visible, () => props.filePath], async ([isVisible, newPath]) => {
  if (isVisible && newPath) {
    // 窗口打开且有文件路径时，立即加载
    // 使用 requestAnimationFrame 确保在下一帧才设置 loading，让窗口先显示
    requestAnimationFrame(() => {
      loading.value = true
      error.value = ''
      content.value = ''
      highlights.value = []
      loadFile(newPath)
    })
  } else if (!isVisible) {
    // 窗口关闭时，取消当前任务并清空状态
    // 【方案 B】取消正在进行的预览任务（传入 taskId）
    if (currentTaskId.value !== null) {
      try {
        await cancelPreview(currentTaskId.value)  // ✅ 传入 taskId
      } catch (err) {
        // 忽略错误
      }
      currentTaskId.value = null
    }
    
    // 清空状态
    loading.value = false
    error.value = ''
    content.value = ''
    highlights.value = []
  }
}, { immediate: true })

async function loadFile(filePath: string) {
  const taskId = Date.now()  // 使用时间戳作为任务标识
  currentTaskId.value = taskId
  
  try {
    const result = await previewFile(filePath)
    
    // 检查是否在加载过程中被取消（通过比较 task_id）
    if (currentTaskId.value !== taskId) {
      return
    }
    
    // 检查是否有错误
    if (result.error) {
      // 【C2优化】使用友好错误提示
      error.value = getFriendlyErrorMessage(result.error)
      errorSeverity.value = getErrorSeverity(result.error)
      return
    }
    
    content.value = result.content || ''
    highlights.value = result.highlights || []
  } catch (err) {
    // 如果是取消错误，不显示错误信息
    if (String(err).includes('已取消')) {
      return
    }
    // 【C2优化】使用友好错误提示
    error.value = getFriendlyErrorMessage(err)
    errorSeverity.value = getErrorSeverity(err)
  } finally {
    // 总是清除 loading 状态（无论是否被取消）
    // 但只在当前任务是最新任务时才清除 currentTaskId
    loading.value = false
    if (currentTaskId.value === taskId) {
      currentTaskId.value = null
    }
  }
}

const handleOpenFile = async () => {
  if (props.filePath) {
    await openFile(props.filePath)
  }
}

const handleCopyContent = async () => {
  try {
    await navigator.clipboard.writeText(content.value)
    // 【P1 修复】使用 Electron 对话框替代 alert
    await showMessage('✅ 已复制到剪贴板', { type: 'info' })
  } catch (err) {
    // 【P1 修复】使用 Electron 对话框替代 alert
    await showMessage(getFriendlyErrorMessage(err), { type: 'error' })
  }
}

// 【方案 B】处理关闭/取消
const handleClose = () => {
  if (loading.value && currentTaskId.value !== null) {
    // 正在加载时，点击“取消”按钮
    // 立即关闭对话框，后台继续取消任务
    emit('close')
    // 不等待取消完成，避免阻塞 UI
    cancelPreview(currentTaskId.value).catch(() => {})
  } else {
    // 正常关闭
    emit('close')
  }
}
</script>

<style scoped>
.modal-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background-color: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
  /* 默认隐藏 */
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.2s ease-out;
}

.modal-overlay.visible {
  opacity: 1;
  pointer-events: auto;
}

.modal-container {
  background-color: var(--modal-bg);
  color: var(--text-color);
  border-radius: 8px;
  width: min(80%, 900px);
  height: min(80%, 700px);
  min-width: 600px;
  min-height: 400px;
  display: flex;
  flex-direction: column;
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3);
  /* 动画效果 */
  transform: scale(0.95) translateY(10px);
  opacity: 0;
  transition: transform 0.25s cubic-bezier(0.34, 1.56, 0.64, 1), 
              opacity 0.2s ease-out;
}

.modal-overlay.visible .modal-container {
  transform: scale(1) translateY(0);
  opacity: 1;
}

.modal-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 16px 20px;
  border-bottom: 1px solid var(--border-color);
}

.modal-header h3 {
  font-size: 16px;
  font-weight: 600;
}

.close-btn {
  background: none;
  border: none;
  font-size: 28px;
  cursor: pointer;
  color: #999;
  line-height: 1;
  transition: all 0.2s ease;
  width: 32px;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 4px;
}

.close-btn:hover {
  color: var(--text-color);
  background-color: var(--bg-hover);
  transform: rotate(90deg);
}

.modal-body {
  flex: 1;
  overflow: auto;
  padding: 20px;
}

.error {
  text-align: center;
  padding: 40px;
  color: var(--text-secondary);
}

.loading-container {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  gap: 16px;
}

.loading-spinner {
  width: 40px;
  height: 40px;
  border: 4px solid var(--border-color);
  border-top: 4px solid var(--primary-color);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  0% { transform: rotate(0deg); }
  100% { transform: rotate(360deg); }
}

.loading-text {
  font-size: 16px;
  color: var(--text-color);
  font-weight: 500;
}

.loading-hint {
  font-size: 13px;
  color: var(--text-secondary);
}

.error {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  gap: 12px;
}

/* 【C2优化】不同严重程度的错误样式 */
.error.info {
  color: var(--primary-color);
}

.error.warning {
  color: #faad14;
}

.error.error {
  color: var(--error-color);
}

.error-icon {
  font-size: 48px;
}

.error-title {
  font-size: 16px;
  font-weight: 600;
  text-align: center;
}

.error-text {
  font-size: 14px;
  text-align: center;
  max-width: 80%;
  white-space: pre-line;
  line-height: 1.6;
}

.preview-content pre {
  margin: 0;
  font-family: 'Consolas', 'Monaco', 'Courier New', monospace;
  font-size: 13px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-wrap: break-word;
}

.modal-footer {
  display: flex;
  gap: 10px;
  justify-content: flex-end;
  padding: 12px 20px;
  border-top: 1px solid var(--border-color);
}

.btn {
  padding: 6px 16px;
  border: 1px solid var(--border-color);
  background-color: var(--bg-color);
  color: var(--text-color);
  border-radius: 4px;
  cursor: pointer;
  font-size: 14px;
  transition: all 0.2s ease;
}

.btn:hover {
  background-color: var(--bg-hover);
  transform: translateY(-1px);
  box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
}

.btn:active {
  transform: translateY(0);
}

.btn-primary {
  background-color: var(--primary-color);
  color: white;
  border-color: var(--primary-color);
  transition: all 0.2s ease;
}

.btn-primary:hover {
  background-color: #40a9ff;
  transform: translateY(-1px);
  box-shadow: 0 2px 8px rgba(24, 144, 255, 0.3);
}

.btn-primary:active {
  transform: translateY(0);
}

/* 【方案 B】禁用状态的按钮样式 */
.btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
  transform: none !important;
  box-shadow: none !important;
}

.btn:disabled:hover {
  background-color: var(--bg-color);
  transform: none;
  box-shadow: none;
}
</style>

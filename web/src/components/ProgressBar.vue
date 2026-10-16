<script setup lang="ts">
defineProps<{ value: number; status?: string }>();
</script>

<template>
  <div class="progress" :class="{ done: status === 'success', failed: status === 'failed' || status === 'canceled' }">
    <div :style="{ width: `${Math.min(100, Math.max(0, value))}%` }"></div>
  </div>
</template>

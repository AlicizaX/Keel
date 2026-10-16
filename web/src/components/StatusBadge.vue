<script setup lang="ts">
import { computed } from 'vue';
import { STATUS_COLORS, STATUS_LABELS } from '../api';

const props = defineProps<{ status: string }>();
const color = computed(() => STATUS_COLORS[props.status] ?? 'gray');
const label = computed(() => STATUS_LABELS[props.status] ?? props.status);
</script>

<template>
  <span class="badge" :class="[color, { running: status === 'running' }]">
    <span class="dot"></span>{{ label }}
  </span>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue';
import { socket } from './ws';

const running = ref(0);
const queued = ref(0);

const onQueue = (q: { queued: number[]; running: number[] }) => {
  queued.value = q.queued.length;
  running.value = q.running.length;
};

onMounted(() => socket.on('queue', onQueue));
onUnmounted(() => socket.off('queue', onQueue));
</script>

<template>
  <div class="layout">
    <aside class="sidebar">
      <div class="brand">
        <span class="mark">K</span>
        <span>Keel</span>
      </div>
      <nav>
        <router-link to="/queue" active-class="active">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 6h16M4 12h16M4 18h10"/></svg>
          构建队列
          <span v-if="running" class="badge blue sm" style="margin-left:auto"><span class="dot"></span>{{ running }}</span>
        </router-link>
        <router-link to="/projects" active-class="active">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>
          项目
        </router-link>
        <router-link to="/artifacts" active-class="active">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M21 8l-9-5-9 5v8l9 5 9-5zM3 8l9 5 9-5M12 13v8"/></svg>
          构建产物
        </router-link>
        <router-link to="/settings" active-class="active">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h0a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
          设置
        </router-link>
      </nav>
      <div class="foot">Unity 构建</div>
    </aside>
    <main class="main">
      <router-view />
    </main>
  </div>
</template>

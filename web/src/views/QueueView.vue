<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { api, fmtDuration, fmtTime, PHASE_LABELS } from '../api';
import { socket } from '../ws';
import StatusBadge from '../components/StatusBadge.vue';
import ProgressBar from '../components/ProgressBar.vue';

const router = useRouter();
const builds = ref<any[]>([]);
const tab = ref<'active' | 'history'>('active');
const loading = ref(true);

const active = computed(() => builds.value.filter((b) => b.status === 'queued' || b.status === 'running'));
const history = computed(() => builds.value.filter((b) => b.status !== 'queued' && b.status !== 'running'));

async function load() {
  builds.value = await api.get('/builds?limit=100');
  loading.value = false;
}

async function cancel(b: any, e: Event) {
  e.stopPropagation();
  try {
    await api.post(`/engine/builds/${b.id}/cancel`);
  } catch (err: any) {
    alert(err.message);
  }
}

async function removeBuild(b: any, e: Event) {
  e.stopPropagation();
  if (!confirm(`确定删除构建 #${b.id}？将同时删除其产物、日志与残留工作区（不可恢复）`)) return;
  try {
    await api.del(`/builds/${b.id}`);
    builds.value = builds.value.filter((x) => x.id !== b.id);
  } catch (err: any) {
    alert(err.message);
  }
}

const onUpdate = (b: any) => {
  const i = builds.value.findIndex((x) => x.id === b.id);
  if (i >= 0) builds.value[i] = { ...builds.value[i], ...b };
  else load();
};

let timer: number;
onMounted(() => {
  load();
  socket.on('build:update', onUpdate);
  timer = window.setInterval(load, 15000);
});
onUnmounted(() => {
  socket.off('build:update', onUpdate);
  clearInterval(timer);
});
</script>

<template>
  <div class="page">
    <div class="page-header">
      <div>
        <h1>构建队列</h1>
        <div class="sub">实时查看排队、进行中的构建与历史记录</div>
      </div>
      <div class="row">
        <button class="btn" :class="{ ghost: tab !== 'active' }" @click="tab = 'active'">进行中 {{ active.length }}</button>
        <button class="btn" :class="{ ghost: tab !== 'history' }" @click="tab = 'history'">历史 {{ history.length }}</button>
      </div>
    </div>

    <div class="card">
      <table class="table" v-if="(tab === 'active' ? active : history).length">
        <thead>
          <tr>
            <th style="width:64px">#</th>
            <th>项目 / 配置</th>
            <th style="width:90px">平台</th>
            <th style="width:110px">状态</th>
            <th style="width:220px">进度</th>
            <th style="width:150px">开始时间</th>
            <th style="width:90px">耗时</th>
            <th style="width:80px"></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="b in tab === 'active' ? active : history" :key="b.id" class="clickable" @click="router.push(`/builds/${b.id}`)">
            <td class="mono">#{{ b.id }}</td>
            <td>
              <div>{{ b.project_name }}</div>
              <div class="faint" style="font-size:12px">{{ b.config_name }}</div>
            </td>
            <td>
              <span class="tag">{{ b.build_target }}</span>
              <span class="tag" style="margin-left:4px">{{ b.runner_name ?? '本机' }}</span>
            </td>
            <td><StatusBadge :status="b.status" /></td>
            <td>
              <ProgressBar :value="b.progress" :status="b.status" />
              <div class="faint" style="font-size:11px;margin-top:4px">
                {{ b.status === 'running' ? (PHASE_LABELS[b.phase] ?? b.phase) : '' }} {{ b.progress }}%
              </div>
            </td>
            <td class="muted mono">{{ fmtTime(b.started_at ?? b.created_at) }}</td>
            <td class="muted mono">{{ fmtDuration(b.started_at, b.finished_at) }}</td>
            <td>
              <button v-if="b.status === 'queued' || b.status === 'running'" class="btn sm danger" @click="cancel(b, $event)">取消</button>
              <button v-else class="btn sm ghost danger" @click="removeBuild(b, $event)">删除</button>
            </td>
          </tr>
        </tbody>
      </table>
      <div v-else class="empty">{{ loading ? '加载中...' : tab === 'active' ? '当前没有排队或进行中的构建' : '暂无历史构建' }}</div>
    </div>
  </div>
</template>

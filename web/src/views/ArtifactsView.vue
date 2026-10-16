<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { api, fmtSize, fmtTime } from '../api';

const list = ref<any[]>([]);
const cleaning = ref(false);

async function load() {
  list.value = await api.get('/artifacts');
}

async function cleanup() {
  cleaning.value = true;
  try {
    const r = await api.post('/artifacts/cleanup');
    alert(`已清理 ${r.cleaned} 份过期产物`);
    load();
  } finally {
    cleaning.value = false;
  }
}

async function cleanOne(a: any) {
  if (!confirm(`确定清理构建 #${a.build_id} 的产物？（任务记录保留，文件不可恢复）`)) return;
  try {
    await api.del(`/artifacts/${a.id}`);
    load();
  } catch (e: any) {
    alert(e.message);
  }
}

onMounted(load);
</script>

<template>
  <div class="page">
    <div class="page-header">
      <div>
        <h1>构建产物</h1>
        <div class="sub">超过保留期的产物会被自动清理，任务记录永久保留</div>
      </div>
      <button class="btn" :disabled="cleaning" @click="cleanup">{{ cleaning ? '清理中...' : '立即清理过期产物' }}</button>
    </div>

    <div class="card">
      <table class="table" v-if="list.length">
        <thead>
          <tr>
            <th style="width:70px">构建</th>
            <th>项目 / 配置</th>
            <th style="width:90px">平台</th>
            <th style="width:100px">大小</th>
            <th style="width:160px">归档时间</th>
            <th style="width:100px">状态</th>
            <th style="width:90px"></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="a in list" :key="a.id">
            <td class="mono">#{{ a.build_id }}</td>
            <td>
              <div>{{ a.project_name }}</div>
              <div class="faint" style="font-size:12px">{{ a.config_name }}</div>
            </td>
            <td><span class="tag">{{ a.build_target }}</span></td>
            <td class="mono muted">{{ fmtSize(a.size) }}</td>
            <td class="mono muted">{{ fmtTime(a.created_at) }}</td>
            <td><span class="badge" :class="a.cleaned ? 'gray' : 'green'"><span class="dot"></span>{{ a.cleaned ? '已清理' : '可下载' }}</span></td>
            <td>
              <div class="row" style="gap:6px">
                <a v-if="!a.cleaned" class="btn sm" :href="`/api/artifacts/${a.id}/download`" download>下载</a>
                <button v-if="!a.cleaned" class="btn sm ghost danger" @click="cleanOne(a)">清理</button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
      <div v-else class="empty">暂无构建产物</div>
    </div>
  </div>
</template>
